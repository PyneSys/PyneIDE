import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import * as vscode from 'vscode';

import type { AuthService } from '../api/auth';
import type { CompileResult, PyneApiClient } from '../api/client';

interface CacheEntry {
  pineHash: string;
  outHash: string;
  strict: boolean;
}

const CACHE_KEY = 'pyneide.compileCache';
const LOCK_RETRY_MS = 1500;
const LOCK_RETRIES = 3;

function sha256(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Compiles .pine documents through the PyneSys API: serial queue (the API
 * holds a per-user compile lock), content-hash cache, diagnostics, quota
 * messages. Running a .pine always compiles it in the background; the
 * generated .py sits next to it and is free to edit — the only guard is the
 * overwrite prompt when a compile would clobber manual edits.
 */
export class CompileService {
  private readonly diagnostics = vscode.languages.createDiagnosticCollection('pyne-compile');
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
      vscode.commands.registerCommand('pyneide.showUsage', () => this.showUsage())
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

  /**
   * Make sure a fresh .py exists for a .pine document; returns its path.
   * Compiles in the background (the content-hash cache skips the API when
   * nothing changed) and only reports success when the output is fresh —
   * e.g. a declined overwrite prompt aborts the run.
   */
  async ensureCompiledForRun(doc: vscode.TextDocument): Promise<string | undefined> {
    await this.enqueueCompile(doc, 'run');

    const outputPath = doc.uri.fsPath.replace(/\.pine$/, '.py');
    const strict = vscode.workspace
      .getConfiguration('pyneide', doc.uri)
      .get<boolean>('strictCompile', false);
    const pineHash = sha256(`${strict}:${doc.getText()}`);
    const cached = this.cache()[outputPath];
    if (cached && cached.pineHash === pineHash && fs.existsSync(outputPath)) {
      return outputPath;
    }
    return undefined;
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
    await this.enqueueCompile(editor.document, 'manual');
  }

  private async enqueueCompile(doc: vscode.TextDocument, trigger: 'manual' | 'run'): Promise<void> {
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

  private async compileDocument(doc: vscode.TextDocument, trigger: 'manual' | 'run'): Promise<void> {
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
    // that was modified since we generated it (the .py is free to edit and
    // may have become the user's source).
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

}
