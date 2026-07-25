import * as fs from 'node:fs';
import * as path from 'node:path';

import * as vscode from 'vscode';

import type { AuthService } from '../api/auth';
import type { CompileResult, ConvertResult, PyneApiClient } from '../api/client';
import { detectPineVersion } from '../pineVersion';
import { failures } from '../report/lastFailure';
import { sha256, sourcemapPathFor, type StoredSourcemap } from './sourcemap';

interface CacheEntry {
  pineHash: string;
  outHash: string;
  strict: boolean;
}

const CACHE_KEY = 'pyneide.compileCache';
const LOCK_RETRY_MS = 1500;
const LOCK_RETRIES = 3;

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
    private readonly output: vscode.OutputChannel,
    private readonly pineLs: { readonly serverRunning: boolean }
  ) {}

  register(): void {
    this.context.subscriptions.push(
      this.diagnostics,
      // Compile diagnostics are a snapshot of one API response, not a live
      // analysis: the next compile only happens on Run or an explicit compile
      // command, so without this they would outlive the edit that fixes them.
      vscode.workspace.onDidChangeTextDocument((e) => this.diagnostics.delete(e.document.uri)),
      vscode.commands.registerCommand('pyneide.compilePine', () => this.compileActiveEditor()),
      vscode.commands.registerCommand('pyneide.convertToV6', () => this.convertActiveEditor()),
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

  private async convertActiveEditor(): Promise<void> {
    const doc = vscode.window.activeTextEditor?.document;
    if (!doc || doc.languageId !== 'pine') {
      void vscode.window.showWarningMessage('PyneIDE: open a .pine file to convert.');
      return;
    }
    if (doc.isDirty) {
      await doc.save();
    }
    await this.convertActiveToV6(doc);
  }

  /**
   * Upgrade a Pine v4/v5 document to v6 in place (like TradingView's editor):
   * the .pine content is replaced through a WorkspaceEdit so a plain editor
   * Undo reverts it. Returns true when the file is v6 afterwards (already v6,
   * or just converted), false when conversion was impossible or failed.
   * Conversion is quota-free.
   */
  async convertActiveToV6(doc: vscode.TextDocument): Promise<boolean> {
    const version = detectPineVersion(doc.getText());
    if (version !== undefined && version >= 6) return true;
    if (version === undefined || version < 4) {
      void vscode.window.showErrorMessage(
        'PyneIDE: automatic conversion supports Pine v4 and v5 only — please upgrade this ' +
          'script to v6 manually.'
      );
      return false;
    }

    const client = await this.auth.requireClient();
    if (!client) return false;

    const result = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: 'Converting to Pine v6…' },
      () => client.convertToV6(doc.getText(), version)
    );
    if (!result.ok) {
      await this.handleConvertError(result);
      return false;
    }

    const edit = new vscode.WorkspaceEdit();
    const full = new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length));
    edit.replace(doc.uri, full, result.code);
    if (!(await vscode.workspace.applyEdit(edit))) {
      void vscode.window.showErrorMessage('PyneIDE: failed to write the converted v6 source.');
      return false;
    }
    await doc.save();
    this.log(`Converted ${doc.uri.fsPath} from Pine v${version} to v6`);
    vscode.window.setStatusBarMessage('$(check) Converted to Pine v6', 5000);
    return true;
  }

  private async handleConvertError(result: Extract<ConvertResult, { ok: false }>): Promise<void> {
    const { status, detail } = result;
    this.log(`Convert error (HTTP ${status}): ${detail.error}`);
    if (status === 401) {
      const choice = await vscode.window.showErrorMessage(
        'PyneIDE: your PyneSys API key is invalid or expired.',
        'Sign In'
      );
      if (choice === 'Sign In') await this.auth.signIn();
      return;
    }
    void vscode.window.showErrorMessage(`PyneIDE: conversion failed: ${detail.error}`);
  }

  private async enqueueCompile(doc: vscode.TextDocument, trigger: 'manual' | 'run'): Promise<void> {
    const run = async (): Promise<void> => {
      try {
        await this.compileDocument(doc, trigger);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.log(`Compile failed: ${message}`);
        failures.record({
          kind: 'compile',
          summary: message,
          detail: { trigger, unexpected: true },
          traceback: err instanceof Error ? err.stack : undefined,
          scriptPath: doc.uri.fsPath,
          scriptLanguage: 'pine',
        });
        const choice = await vscode.window.showErrorMessage(
          `PyneIDE: compilation failed: ${message}`,
          'Report a Problem'
        );
        if (choice === 'Report a Problem') {
          await vscode.commands.executeCommand('pyneide.reportProblem');
        }
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
      await this.handleCompileError(doc, result, { strict, trigger });
      return;
    }

    // A v4/v5 source is compiled through an internal v6 conversion, so its
    // sourcemap describes converted lines, not this on-disk file.
    const pineVersion = detectPineVersion(script);
    const convertedSource = pineVersion !== undefined && pineVersion < 6;

    this.diagnostics.delete(doc.uri);
    await vscode.workspace.fs.writeFile(vscode.Uri.file(outputPath), Buffer.from(result.code, 'utf8'));
    await this.writeSourcemap(outputPath, result, convertedSource);
    await this.updateCache(outputPath, { pineHash, outHash: sha256(result.code), strict });
    this.log(`Compiled OK: ${outputPath}`);
    vscode.window.setStatusBarMessage(`$(check) Pine compiled: ${path.basename(outputPath)}`, 5000);

    if (convertedSource) {
      void vscode.window
        .showInformationMessage(
          `PyneIDE: this is Pine v${pineVersion}. Converting to v6 is free (no quota) and ` +
            'enables debugging.',
          'Convert to v6'
        )
        .then((choice) => {
          if (choice === 'Convert to v6') void this.convertActiveToV6(doc);
        });
    }
  }

  /** The API serializes compiles per user; retry briefly when the lock is busy. */
  private async compileWithLockRetry(
    client: PyneApiClient,
    script: string,
    strict: boolean
  ): Promise<CompileResult> {
    let result = await client.compile(script, strict, true);
    for (let attempt = 0; attempt < LOCK_RETRIES; attempt++) {
      if (result.ok || result.status !== 429) break;
      if (!result.detail.error.includes('Another compilation is in progress')) break;
      this.log(`Compile lock busy, retrying in ${LOCK_RETRY_MS} ms`);
      await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
      result = await client.compile(script, strict, true);
    }
    return result;
  }

  /**
   * Persist the compiler's sourcemap next to the output as `<output>.map`,
   * stamped with the .py content hash so a later manual edit of the .py
   * invalidates it. A response without a sourcemap (older server) removes any
   * existing map instead — a stale map must not outlive the code it mapped.
   */
  private async writeSourcemap(
    outputPath: string,
    result: Extract<CompileResult, { ok: true }>,
    convertedSource: boolean
  ): Promise<void> {
    const mapPath = sourcemapPathFor(outputPath);
    if (result.sourcemap) {
      const stored: StoredSourcemap = {
        ...result.sourcemap,
        py_sha256: sha256(result.code),
        ...(convertedSource ? { converted_source: true } : {}),
      };
      await vscode.workspace.fs.writeFile(
        vscode.Uri.file(mapPath),
        Buffer.from(JSON.stringify(stored), 'utf8')
      );
    } else if (fs.existsSync(mapPath)) {
      await vscode.workspace.fs.delete(vscode.Uri.file(mapPath));
      this.log(`Removed stale sourcemap (server sent none): ${mapPath}`);
    }
  }

  private async handleCompileError(
    doc: vscode.TextDocument,
    result: Extract<CompileResult, { ok: false }>,
    ctx: { strict: boolean; trigger: 'manual' | 'run' }
  ): Promise<void> {
    const { status, detail } = result;
    this.log(`Compile error (HTTP ${status}): ${detail.error}` + (detail.line ? ` [line ${detail.line}]` : ''));

    // Recorded before any branching, so even the Problems-panel path (400 with
    // a line number, no toast) can be reported later from the status bar menu.
    failures.record({
      kind: 'compile',
      summary: detail.error,
      detail: { status, line: detail.line, file: detail.file, ...ctx },
      scriptPath: doc.uri.fsPath,
      scriptLanguage: 'pine',
    });

    if (status === 400 && detail.line) {
      // Pine compilation error with a line number -> Problems panel, but only
      // as a fallback: a running Pine LS already reports the same error live,
      // and duplicating it there would just show every message twice.
      if (!this.pineLs.serverRunning) {
        // The API reports no column, so the whole line is marked.
        const line = Math.max(0, Math.min(detail.line - 1, doc.lineCount - 1));
        const range = doc.lineAt(line).range;
        const diagnostic = new vscode.Diagnostic(range, detail.error, vscode.DiagnosticSeverity.Error);
        diagnostic.source = 'PyneComp';
        this.diagnostics.set(doc.uri, [diagnostic]);
      }
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
        'Show Compile Usage'
      );
      if (choice === 'Show Compile Usage') await this.showUsage();
      return;
    }
    // 413 and anything else: the API message is already human-readable.
    const choice = await vscode.window.showErrorMessage(
      `PyneIDE: ${detail.error}`,
      'Report a Problem'
    );
    if (choice === 'Report a Problem') {
      await vscode.commands.executeCommand('pyneide.reportProblem');
    }
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
        `PyneSys compile usage — ${fmt('Daily', usage.daily)}; ${fmt('Hourly', usage.hourly)}`
      );
    } catch (err) {
      void vscode.window.showErrorMessage(
        `PyneIDE: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

}
