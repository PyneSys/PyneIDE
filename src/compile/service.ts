import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import * as vscode from 'vscode';

import type { AuthService } from '../api/auth';
import type { CompileResult, PyneApiClient } from '../api/client';

type Workflow = 'migration' | 'pine-first';

interface CacheEntry {
  pineHash: string;
  outHash: string;
  strict: boolean;
}

const CACHE_KEY = 'pyneide.compileCache';
const GITIGNORE_HINT_KEY = 'pyneide.gitignoreHintShown';
const DEBOUNCE_MS = 800;
const LOCK_RETRY_MS = 1500;
const LOCK_RETRIES = 3;

function sha256(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Compiles .pine documents through the PyneSys API: explicit
 * migration/Pine-first workflow, serial queue (the API holds a per-user
 * compile lock), content-hash cache, diagnostics, quota messages.
 */
export class CompileService {
  private readonly diagnostics = vscode.languages.createDiagnosticCollection('pyne-compile');
  private readonly debounceTimers = new Map<string, NodeJS.Timeout>();
  private readonly sessionWorkflows = new Map<string, Workflow>();
  private readonly generatedWarningShown = new Set<string>();
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly auth: AuthService,
    private readonly output: vscode.OutputChannel
  ) {}

  register(): void {
    this.context.subscriptions.push(
      this.diagnostics,
      vscode.commands.registerCommand('pyneide.compilePine', () => this.compileActiveEditor()),
      vscode.commands.registerCommand('pyneide.showUsage', () => this.showUsage()),
      vscode.workspace.onDidSaveTextDocument((doc) => this.onSave(doc)),
      vscode.workspace.onDidOpenTextDocument((doc) => this.warnIfGenerated(doc))
    );
  }

  private log = (message: string): void => {
    this.output.appendLine(message);
  };

  private cache(): Record<string, CacheEntry> {
    return this.context.globalState.get<Record<string, CacheEntry>>(CACHE_KEY, {});
  }

  private async updateCache(outputPath: string, entry: CacheEntry): Promise<void> {
    const cache = this.cache();
    cache[outputPath] = entry;
    await this.context.globalState.update(CACHE_KEY, cache);
  }

  private async compileActiveEditor(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.languageId !== 'pine') {
      void vscode.window.showWarningMessage('PyneIDE: open a .pine file to compile.');
      return;
    }
    if (editor.document.isDirty) {
      await editor.document.save();
    }
    // A manual compile supersedes any pending save-triggered one.
    const key = editor.document.uri.toString();
    clearTimeout(this.debounceTimers.get(key));
    this.debounceTimers.delete(key);
    await this.enqueueCompile(editor.document, 'manual');
  }

  private onSave(doc: vscode.TextDocument): void {
    if (doc.languageId !== 'pine') return;
    const config = vscode.workspace.getConfiguration('pyneide', doc.uri);
    if (!config.get<boolean>('compileOnSave', true)) return;
    // compile-on-save only applies in Pine-first mode; in migration mode
    // compilation is a deliberate one-time action.
    if (this.knownWorkflow(doc) !== 'pine-first') return;
    const key = doc.uri.toString();
    clearTimeout(this.debounceTimers.get(key));
    this.debounceTimers.set(
      key,
      setTimeout(() => {
        this.debounceTimers.delete(key);
        void this.enqueueCompile(doc, 'save');
      }, DEBOUNCE_MS)
    );
  }

  /** Workflow if already decided (setting or session), undefined otherwise. */
  private knownWorkflow(doc: vscode.TextDocument): Workflow | undefined {
    const configured = vscode.workspace
      .getConfiguration('pyneide', doc.uri)
      .get<string>('pineWorkflow', 'ask');
    if (configured === 'migration' || configured === 'pine-first') return configured;
    return this.sessionWorkflows.get(this.workflowScope(doc));
  }

  private workflowScope(doc: vscode.TextDocument): string {
    return (
      vscode.workspace.getWorkspaceFolder(doc.uri)?.uri.toString() ?? doc.uri.toString()
    );
  }

  private async resolveWorkflow(doc: vscode.TextDocument): Promise<Workflow | undefined> {
    const known = this.knownWorkflow(doc);
    if (known) return known;

    const picked = await vscode.window.showQuickPick(
      [
        {
          label: '$(arrow-right) Migration',
          description: 'Compile once, then continue the work in Python (Pyne)',
          detail: 'The generated .py becomes your editable source; no automatic recompilation.',
          value: 'migration' as Workflow,
        },
        {
          label: '$(pin) Pine-first',
          description: '.pine stays the source of truth',
          detail:
            'The .py is a derived artifact: recompiled on save, manual edits are discouraged.',
          value: 'pine-first' as Workflow,
        },
      ],
      {
        title: 'PyneIDE: how do you want to work with Pine Script in this project?',
        ignoreFocusOut: true,
      }
    );
    if (!picked) return undefined;

    const folder = vscode.workspace.getWorkspaceFolder(doc.uri);
    if (folder) {
      await vscode.workspace
        .getConfiguration('pyneide', doc.uri)
        .update('pineWorkflow', picked.value, vscode.ConfigurationTarget.WorkspaceFolder);
    } else {
      this.sessionWorkflows.set(this.workflowScope(doc), picked.value);
    }
    return picked.value;
  }

  private async enqueueCompile(doc: vscode.TextDocument, trigger: 'manual' | 'save'): Promise<void> {
    const run = async (): Promise<void> => {
      try {
        await this.compileDocument(doc, trigger);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.log(`Compile failed: ${message}`);
        void vscode.window.showErrorMessage(`PyneIDE: compilation failed: ${message}`);
      }
    };
    this.queue = this.queue.then(run);
    await this.queue;
  }

  private async compileDocument(doc: vscode.TextDocument, trigger: 'manual' | 'save'): Promise<void> {
    const workflow = await this.resolveWorkflow(doc);
    if (!workflow) return;

    const client = await this.auth.requireClient();
    if (!client) return;

    const config = vscode.workspace.getConfiguration('pyneide', doc.uri);
    const strict = config.get<boolean>('strictCompile', false);
    const script = doc.getText();
    const pineHash = sha256(`${strict}:${script}`);
    const outputPath = doc.uri.fsPath.replace(/\.pine$/, '.py');
    const cached = this.cache()[outputPath];

    // Local content-hash cache: skip the API when nothing changed.
    if (cached && cached.pineHash === pineHash && fs.existsSync(outputPath)) {
      if (sha256(fs.readFileSync(outputPath, 'utf8')) === cached.outHash) {
        this.log(`Cache hit, skipping compile: ${outputPath}`);
        if (trigger === 'manual') {
          vscode.window.setStatusBarMessage('$(check) Pine output is up-to-date', 3000);
        }
        return;
      }
    }

    // Overwrite protection: never destroy an output we did not generate or
    // that was modified since we generated it (the migration workflow expects
    // the user to continue editing the .py).
    if (fs.existsSync(outputPath)) {
      const outHash = sha256(fs.readFileSync(outputPath, 'utf8'));
      const editedByUser = !cached || cached.outHash !== outHash;
      if (editedByUser) {
        const choice = await vscode.window.showWarningMessage(
          `PyneIDE: ${path.basename(outputPath)} already exists and was not generated by the ` +
            'last compilation (it may contain manual edits). Overwrite it?',
          { modal: true },
          'Overwrite'
        );
        if (choice !== 'Overwrite') return;
      }
    }

    this.log(`Compiling ${doc.uri.fsPath} (strict=${strict}, trigger=${trigger})`);
    const result = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: 'Compiling Pine Script…' },
      () => this.compileWithLockRetry(client, script, strict)
    );

    if (!result.ok) {
      await this.handleCompileError(doc, result);
      return;
    }

    this.diagnostics.delete(doc.uri);
    await vscode.workspace.fs.writeFile(vscode.Uri.file(outputPath), Buffer.from(result.code, 'utf8'));
    await this.updateCache(outputPath, { pineHash, outHash: sha256(result.code), strict });
    this.log(`Compiled OK: ${outputPath}`);
    vscode.window.setStatusBarMessage(`$(check) Pine compiled: ${path.basename(outputPath)}`, 5000);

    if (workflow === 'pine-first') {
      await this.suggestGitignore(doc);
    }
  }

  /** The API serializes compiles per user; retry briefly when the lock is busy. */
  private async compileWithLockRetry(
    client: PyneApiClient,
    script: string,
    strict: boolean
  ): Promise<CompileResult> {
    let result = await client.compile(script, strict);
    for (let attempt = 0; attempt < LOCK_RETRIES; attempt++) {
      if (result.ok || result.status !== 429) break;
      if (!result.detail.error.includes('Another compilation is in progress')) break;
      this.log(`Compile lock busy, retrying in ${LOCK_RETRY_MS} ms`);
      await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
      result = await client.compile(script, strict);
    }
    return result;
  }

  private async handleCompileError(
    doc: vscode.TextDocument,
    result: Extract<CompileResult, { ok: false }>
  ): Promise<void> {
    const { status, detail } = result;
    this.log(`Compile error (HTTP ${status}): ${detail.error}` + (detail.line ? ` [line ${detail.line}]` : ''));

    if (status === 400 && detail.line) {
      // Pine compilation error with a line number -> Problems panel.
      // The API reports no column, so the whole line is marked.
      const line = Math.max(0, Math.min(detail.line - 1, doc.lineCount - 1));
      const range = doc.lineAt(line).range;
      const diagnostic = new vscode.Diagnostic(range, detail.error, vscode.DiagnosticSeverity.Error);
      diagnostic.source = 'PyneComp';
      this.diagnostics.set(doc.uri, [diagnostic]);
      vscode.window.setStatusBarMessage('$(error) Pine compilation failed — see Problems panel', 5000);
      return;
    }
    this.diagnostics.delete(doc.uri);

    if (status === 401) {
      const choice = await vscode.window.showErrorMessage(
        'PyneIDE: your PyneSys API key is invalid or expired.',
        'Sign In'
      );
      if (choice === 'Sign In') await this.auth.signIn();
      return;
    }
    if (status === 402) {
      const choice = await vscode.window.showErrorMessage(
        `PyneIDE: ${detail.error}`,
        'Open PyneSys'
      );
      if (choice === 'Open PyneSys') {
        void vscode.env.openExternal(vscode.Uri.parse('https://app.pynesys.io'));
      }
      return;
    }
    if (status === 429) {
      const wait = result.retryAfterSeconds
        ? ` You can retry in about ${Math.ceil(result.retryAfterSeconds / 60)} minute(s).`
        : '';
      const choice = await vscode.window.showWarningMessage(
        `PyneIDE: ${detail.error}${wait}`,
        'Show API Usage'
      );
      if (choice === 'Show API Usage') await this.showUsage();
      return;
    }
    // 413 and anything else: the API message is already human-readable.
    void vscode.window.showErrorMessage(`PyneIDE: ${detail.error}`);
  }

  private async showUsage(): Promise<void> {
    const client = await this.auth.requireClient();
    if (!client) return;
    try {
      const usage = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: 'Fetching API usage…' },
        () => client.usage()
      );
      const fmt = (label: string, p: { used: number; limit: number; remaining: number; resetAt: string }) =>
        `${label}: ${p.used}/${p.limit} used, ${p.remaining} remaining (resets ${new Date(p.resetAt).toLocaleString()})`;
      void vscode.window.showInformationMessage(
        `PyneSys compile quota — ${fmt('daily', usage.daily)}; ${fmt('hourly', usage.hourly)}`
      );
    } catch (err) {
      void vscode.window.showErrorMessage(
        `PyneIDE: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  /** Warn once per session when a generated (Pine-first) .py is opened. */
  private warnIfGenerated(doc: vscode.TextDocument): void {
    if (!doc.uri.fsPath.endsWith('.py')) return;
    if (this.generatedWarningShown.has(doc.uri.fsPath)) return;
    const entry = this.cache()[doc.uri.fsPath];
    if (!entry) return;
    const pinePath = doc.uri.fsPath.replace(/\.py$/, '.pine');
    if (!fs.existsSync(pinePath)) return;
    const workflow = vscode.workspace
      .getConfiguration('pyneide', doc.uri)
      .get<string>('pineWorkflow', 'ask');
    if (workflow !== 'pine-first') return;
    this.generatedWarningShown.add(doc.uri.fsPath);
    void vscode.window.showWarningMessage(
      `PyneIDE: ${path.basename(doc.uri.fsPath)} is generated from ` +
        `${path.basename(pinePath)} (Pine-first mode) — manual edits will be overwritten on the next compile.`
    );
  }

  /** Suggest gitignoring generated .py files, once per workspace. */
  private async suggestGitignore(doc: vscode.TextDocument): Promise<void> {
    const folder = vscode.workspace.getWorkspaceFolder(doc.uri);
    if (!folder) return;
    const shown = this.context.globalState.get<string[]>(GITIGNORE_HINT_KEY, []);
    if (shown.includes(folder.uri.toString())) return;
    await this.context.globalState.update(GITIGNORE_HINT_KEY, [...shown, folder.uri.toString()]);

    const relOutput = path.relative(folder.uri.fsPath, doc.uri.fsPath.replace(/\.pine$/, '.py'));
    if (relOutput.startsWith('..')) return;
    const pattern = relOutput.split(path.sep).join('/');
    const choice = await vscode.window.showInformationMessage(
      'PyneIDE: in Pine-first mode the generated .py files are derived artifacts — ' +
        'consider adding them to .gitignore.',
      'Add to .gitignore'
    );
    if (choice !== 'Add to .gitignore') return;
    const gitignorePath = path.join(folder.uri.fsPath, '.gitignore');
    const existing = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, 'utf8') : '';
    if (!existing.split('\n').includes(pattern)) {
      fs.writeFileSync(
        gitignorePath,
        existing + (existing.endsWith('\n') || existing === '' ? '' : '\n') + pattern + '\n'
      );
    }
    void vscode.window.showInformationMessage(`PyneIDE: added "${pattern}" to .gitignore.`);
  }
}
