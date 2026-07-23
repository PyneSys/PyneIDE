import * as path from 'node:path';

import * as vscode from 'vscode';

import { resolveWorkspaceWorkdir } from '../env/workdirConfig';
import { DETECT_HEAD_BYTES, detectPyne } from '../pyneDetect';
import {
  collectWorkspaceLibraryImports,
  parsePineLibraryExports,
  parsePyneLibraryExports,
  readWorkspaceLibraryExports,
  resolveWorkspaceLibraryFile,
  validateWorkspaceLibraryCall,
  workspaceLibraryCalls,
  type LibraryImportSyntax,
  type WorkspaceLibraryExport,
} from './libraryImports';

const DIAGNOSTIC_DEBOUNCE_MS = 350;

/**
 * Static argument binding for direct workspace-library calls.
 *
 * This is deliberately conservative: only a completed `alias.member(...)`
 * call with a statically resolved workspace import is checked. Dynamic
 * `*args`/`**kwargs`, receiver-style method dispatch and unresolved exports
 * are left to the runtime instead of risking false positives.
 */
export class LibraryCallDiagnostics {
  private readonly diagnostics =
    vscode.languages.createDiagnosticCollection('pyne-library');
  private readonly timers = new Map<string, NodeJS.Timeout>();

  constructor(private readonly context: vscode.ExtensionContext) {}

  register(): void {
    const watcher = vscode.workspace.createFileSystemWatcher(
      '**/scripts/lib/**/*.{pine,py}'
    );
    this.context.subscriptions.push(
      this.diagnostics,
      watcher,
      { dispose: () => this.clearTimers() },
      vscode.workspace.onDidOpenTextDocument((document) => this.checkNow(document)),
      vscode.workspace.onDidChangeTextDocument((event) =>
        this.schedule(event.document)
      ),
      vscode.workspace.onDidCloseTextDocument((document) =>
        this.forget(document.uri)
      ),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('pyneide.workdir')) this.recheckAll();
      }),
      watcher.onDidCreate(() => this.recheckAll()),
      watcher.onDidChange(() => this.recheckAll()),
      watcher.onDidDelete(() => this.recheckAll())
    );
    this.recheckAll();
  }

  /**
   * Synchronously refresh one document and return its argument errors.
   *
   * Run/debug calls this after saving, so a user cannot outrun the editor
   * debounce and start with a known-invalid workspace-library call.
   */
  checkNow(document: vscode.TextDocument): readonly vscode.Diagnostic[] {
    const syntax = documentSyntax(document);
    if (!syntax) {
      this.diagnostics.delete(document.uri);
      return [];
    }
    const workdir = resolveWorkspaceWorkdir();
    if (!workdir?.exists) {
      this.diagnostics.delete(document.uri);
      return [];
    }

    const text = document.getText();
    const imports = new Map(
      collectWorkspaceLibraryImports(text, syntax).map((entry) => [
        entry.alias,
        entry,
      ])
    );
    const exportCache = new Map<string, WorkspaceLibraryExport[]>();
    const diagnostics: vscode.Diagnostic[] = [];

    for (const call of workspaceLibraryCalls(text, syntax)) {
      const imported = imports.get(call.alias);
      if (!imported) continue;
      const source = resolveWorkspaceLibraryFile(workdir.path, imported, syntax);
      if (!source) continue;
      let exports = exportCache.get(source);
      if (!exports) {
        exports = openLibraryExports(source);
        exportCache.set(source, exports);
      }
      const exported = exports.find((entry) => entry.name === call.member);
      if (!exported) continue;
      for (const issue of validateWorkspaceLibraryCall(call, exported, syntax)) {
        const diagnostic = new vscode.Diagnostic(
          new vscode.Range(
            document.positionAt(issue.start),
            document.positionAt(issue.end)
          ),
          issue.message,
          vscode.DiagnosticSeverity.Error
        );
        diagnostic.source = 'Pyne Library';
        diagnostic.code = issue.code;
        diagnostic.relatedInformation = [
          new vscode.DiagnosticRelatedInformation(
            new vscode.Location(
              vscode.Uri.file(source),
              new vscode.Position(0, 0)
            ),
            `Exported signature: ${exported.signature}`
          ),
        ];
        diagnostics.push(diagnostic);
      }
    }
    this.diagnostics.set(document.uri, diagnostics);
    return diagnostics;
  }

  private schedule(document: vscode.TextDocument): void {
    const key = document.uri.toString();
    const existing = this.timers.get(key);
    if (existing) clearTimeout(existing);
    this.timers.set(
      key,
      setTimeout(() => {
        this.timers.delete(key);
        if (!document.isClosed) this.checkNow(document);
      }, DIAGNOSTIC_DEBOUNCE_MS)
    );
  }

  private recheckAll(): void {
    for (const document of vscode.workspace.textDocuments) {
      this.checkNow(document);
    }
  }

  private forget(uri: vscode.Uri): void {
    const key = uri.toString();
    const timer = this.timers.get(key);
    if (timer) clearTimeout(timer);
    this.timers.delete(key);
    this.diagnostics.delete(uri);
  }

  private clearTimers(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }
}

function documentSyntax(
  document: vscode.TextDocument
): LibraryImportSyntax | undefined {
  if (document.languageId === 'pine') return 'pine';
  if (
    document.languageId === 'python' &&
    detectPyne(document.getText().slice(0, DETECT_HEAD_BYTES))
  ) {
    return 'pyne';
  }
  return undefined;
}

function openLibraryExports(source: string): WorkspaceLibraryExport[] {
  const open = vscode.workspace.textDocuments.find(
    (document) => document.uri.scheme === 'file' && document.uri.fsPath === source
  );
  if (!open) return readWorkspaceLibraryExports(source);
  return path.extname(source).toLowerCase() === '.pine'
    ? parsePineLibraryExports(open.getText())
    : parsePyneLibraryExports(open.getText());
}
