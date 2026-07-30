/**
 * The "Report a Problem" command: note -> (email) -> consent -> send.
 *
 * The script is only ever sent when the user picks the explicit "with my code"
 * option — it is never preselected and never remembered, and there is no
 * setting that could turn it on.
 */
import * as vscode from 'vscode';

import type { AuthService } from '../api/auth';
import type { PyneApiClient } from '../api/client';
import { sha256 } from '../compile/sourcemap';
import { apiTarget, flattenErrorMessage } from '../net/errors';
import { showNetworkError } from '../net/notify';
import { collectReport, type CollectDeps } from './collect';
import { failures, type FailureRecord } from './lastFailure';
import { finalizePayload, type ReportPayload, type ReportSource } from './payload';
import type { ScrubRoots } from './scrub';

const EMAIL_KEY = 'pyneide.reportEmail';
const LAST_REPORT_KEY = 'pyneide.lastReport';

/** Re-sending the same report within this window is answered from memory. */
const DUPLICATE_WINDOW_MS = 60_000;

interface LastReport {
  fingerprint: string;
  at: number;
  reference: string;
}

/** Guards against re-entering the flow (double click, command + toast button). */
let sending = false;

/** What makes two reports "the same" for duplicate suppression. */
function fingerprint(payload: ReportPayload): string {
  return sha256(
    JSON.stringify([
      payload.source,
      payload.summary,
      payload.note ?? '',
      payload.script_sha256 ?? '',
      payload.include_script,
    ])
  );
}

export function registerReportCommand(
  context: vscode.ExtensionContext,
  deps: CollectDeps,
  auth: AuthService,
  output: vscode.OutputChannel
): vscode.Disposable {
  return vscode.commands.registerCommand(
    'pyneide.reportProblem',
    async (failure?: FailureRecord) => {
      if (sending) return;
      sending = true;
      try {
        await runReportFlow(context, deps, auth, output, failure ?? failures.last());
      } finally {
        sending = false;
      }
    }
  );
}

async function runReportFlow(
  context: vscode.ExtensionContext,
  deps: CollectDeps,
  auth: AuthService,
  output: vscode.OutputChannel,
  failure: FailureRecord | undefined
): Promise<void> {
  const source: ReportSource = failure?.kind ?? 'manual';
  const clientVersion = String(context.extension.packageJSON.version ?? 'unknown');
  const { draft, roots, script } = collectReport(deps, source, failure, clientVersion);

  const note = await vscode.window.showInputBox({
    title: 'PyneIDE: Report a Problem',
    prompt: 'What went wrong? (optional — press Enter to continue, Esc to cancel)',
    placeHolder: failure?.summary ?? 'Describe what you were doing',
    ignoreFocusOut: true,
  });
  if (note === undefined) return;
  draft.note = note.trim() || null;

  const { client, authenticated } = await auth.reportClient();

  if (!authenticated) {
    const email = await vscode.window.showInputBox({
      title: 'PyneIDE: Report a Problem',
      prompt: 'Your email (optional, so we can reply)',
      value: context.globalState.get<string>(EMAIL_KEY, ''),
      ignoreFocusOut: true,
    });
    if (email === undefined) return;
    draft.contact_email = email.trim() || null;
  }

  const includeScript = await askConsent(draft, roots, script);
  if (includeScript === undefined) return;

  const payload = finalizePayload(draft, { includeScript, roots });

  const previous = context.globalState.get<LastReport>(LAST_REPORT_KEY);
  if (
    previous &&
    previous.fingerprint === fingerprint(payload) &&
    Date.now() - previous.at < DUPLICATE_WINDOW_MS
  ) {
    void vscode.window.showInformationMessage(
      `PyneIDE: this report was already sent (${previous.reference}).`
    );
    return;
  }

  const reference = await sendReport(client, payload, authenticated, auth.baseUrl(), output);
  if (reference === undefined) return;

  await context.globalState.update(LAST_REPORT_KEY, {
    fingerprint: fingerprint(payload),
    at: Date.now(),
    reference,
  } satisfies LastReport);
  if (draft.contact_email) await context.globalState.update(EMAIL_KEY, draft.contact_email);

  const choice = await vscode.window.showInformationMessage(
    `PyneIDE: report sent. Reference: ${reference}`,
    'Copy Reference'
  );
  if (choice === 'Copy Reference') await vscode.env.clipboard.writeText(reference);
}

/**
 * Send the report, offering Retry until it goes out or the user gives up.
 * Returns the reference, or undefined when nothing was sent.
 *
 * Retry matters most here: the usual reason a report cannot be sent is the very
 * network problem the user is trying to report, and losing the typed-up note to
 * a dropped connection would be the worst possible moment to do so.
 */
async function sendReport(
  client: PyneApiClient,
  payload: ReportPayload,
  authenticated: boolean,
  baseUrl: string,
  output: vscode.OutputChannel
): Promise<string | undefined> {
  const target = apiTarget('Sending a problem report', baseUrl);
  for (;;) {
    let thrown: unknown;
    const result = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'PyneIDE: sending problem report…',
      },
      async () => {
        try {
          return await client.submitReport(payload, authenticated);
        } catch (err) {
          thrown = err;
          return { ok: false as const, status: 0, error: flattenErrorMessage(err) };
        }
      }
    );
    if (result.ok) return result.reference;

    let retry = false;
    if (thrown !== undefined) {
      await showNetworkError({
        headline: 'could not send the report',
        error: thrown,
        target,
        retry: () => {
          retry = true;
        },
        showLog: () => output.show(),
      });
    } else {
      // The server answered, just not with a success — its own message stands.
      const choice = await vscode.window.showErrorMessage(
        `PyneIDE: could not send the report: ${result.error}`,
        'Retry',
        'Show Log'
      );
      if (choice === 'Retry') retry = true;
      else if (choice === 'Show Log') output.show();
    }
    if (!retry) return undefined;
  }
}

/**
 * The consent step. Returns whether the script may be sent, or undefined when
 * the user cancelled. "Preview" opens the *maximal* payload (as if the script
 * were included), which is the honest thing to show: the user sees the most
 * that could ever leave the machine, then decides.
 */
async function askConsent(
  draft: ReportPayload,
  roots: ScrubRoots,
  script: { basename: string; lineCount: number } | undefined
): Promise<boolean | undefined> {
  type ConsentItem = vscode.QuickPickItem & { value: boolean | 'preview' };

  for (;;) {
    const items: ConsentItem[] = [];
    if (script) {
      items.push({
        label: '$(check) Send with my code',
        description: `Includes ${script.basename} (${script.lineCount} lines) so the author can reproduce it`,
        value: true,
      });
    }
    items.push(
      {
        label: '$(circle-slash) Send without my code',
        description:
          'Only the error, versions and logs. Source lines are removed from tracebacks too.',
        value: false,
      },
      { label: '$(eye) Preview what will be sent…', value: 'preview' }
    );

    const picked = await vscode.window.showQuickPick(items, {
      title: 'PyneIDE: Report a Problem',
      placeHolder: 'What may we send?',
      ignoreFocusOut: true,
    });
    if (!picked) return undefined;
    if (picked.value !== 'preview') return picked.value;

    await showPreview(draft, roots);
  }
}

async function showPreview(draft: ReportPayload, roots: ScrubRoots): Promise<void> {
  const maximal = finalizePayload(draft, { includeScript: true, roots });
  const document = {
    _preview_note:
      'This is the maximum that would be sent. Choosing "Send without my code" removes ' +
      'the "script" field and the quoted source lines of any traceback; everything else stays.',
    ...maximal,
  };
  const doc = await vscode.workspace.openTextDocument({
    language: 'json',
    content: JSON.stringify(document, null, 2),
  });
  await vscode.window.showTextDocument(doc, { preview: true });
}
