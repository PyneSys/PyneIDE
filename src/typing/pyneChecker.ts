import * as vscode from 'vscode';

import { detectPyne, DETECT_HEAD_BYTES } from '../pyneDetect';
import type { PyneProblem, SeriesAnalyzer } from './seriesAnalyzer';

/** Debounce between an edit and the analysis it triggers, in milliseconds. */
const CHECK_DEBOUNCE_MS = 400;

/**
 * Pyne script checker (F7/L5d).
 *
 * Mirrors the script-structure errors pynecore itself raises at compile/import
 * time — missing `main()`, an undecorated `main`, module-level `Series`/
 * `Persistent` state, a lib import kept under an alias, strategy state read
 * inside `request.security` — so they surface while editing instead of only on
 * the first run. The Python worker (`python/pyneide_series.py`) is the single
 * source of truth for the rules and their wording; this service only publishes
 * whatever `problems` it returns as diagnostics.
 *
 * Failure contract mirrors L5c (see seriesAnalyzer.ts): the worker collapses
 * every unavailable state — no interpreter, a dead worker, half-typed or
 * unparsable source — into `undefined`. On `undefined` the document's existing
 * diagnostics are left untouched (no stale-empty flash); an analysis that does
 * arrive replaces them wholesale, so an empty `problems` array is what clears
 * the panel. Async results are dropped when the text moved on meanwhile, since
 * a newer change event re-runs the check.
 */
export class PyneCheckerService {
  private readonly diagnostics = vscode.languages.createDiagnosticCollection('pyne');
  private readonly timers = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly analyzer: SeriesAnalyzer,
    private readonly output: vscode.OutputChannel
  ) {}

  register(): void {
    this.context.subscriptions.push(
      this.diagnostics,
      { dispose: () => this.clearTimers() },
      vscode.workspace.onDidOpenTextDocument((doc) => void this.check(doc)),
      vscode.workspace.onDidChangeTextDocument((e) => this.scheduleCheck(e.document)),
      vscode.workspace.onDidCloseTextDocument((doc) => this.forget(doc.uri)),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('pyneide.checker.enabled')) this.reconcile();
      })
    );
    this.reconcile();
  }

  /** The whole checker is on/off via a single machine-scoped setting. */
  private isEnabled(): boolean {
    return vscode.workspace.getConfiguration('pyneide').get<boolean>('checker.enabled', true);
  }

  /** Re-run every open document, or wipe the panel when the checker is off. */
  private reconcile(): void {
    if (!this.isEnabled()) {
      this.clearTimers();
      this.diagnostics.clear();
      return;
    }
    for (const doc of vscode.workspace.textDocuments) void this.check(doc);
  }

  /** Only Python documents whose head marks them as `@pyne` are checked. */
  private isPyneDocument(doc: vscode.TextDocument): boolean {
    return (
      doc.languageId === 'python' &&
      detectPyne(doc.getText().slice(0, DETECT_HEAD_BYTES)) !== undefined
    );
  }

  private scheduleCheck(doc: vscode.TextDocument): void {
    const key = doc.uri.toString();
    const existing = this.timers.get(key);
    if (existing) clearTimeout(existing);
    this.timers.set(
      key,
      setTimeout(() => {
        this.timers.delete(key);
        void this.check(doc);
      }, CHECK_DEBOUNCE_MS)
    );
  }

  private forget(uri: vscode.Uri): void {
    const key = uri.toString();
    const timer = this.timers.get(key);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(key);
    }
    this.diagnostics.delete(uri);
  }

  private clearTimers(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  /**
   * Analyze the document and publish its problems. A document that is no longer
   * a Pyne script (docstring edited away) has its stale diagnostics cleared.
   * A missing analysis leaves the existing diagnostics as they are.
   */
  private async check(doc: vscode.TextDocument): Promise<void> {
    if (!this.isEnabled()) return;
    if (!this.isPyneDocument(doc)) {
      this.diagnostics.delete(doc.uri);
      return;
    }
    const text = doc.getText();
    const version = doc.version;
    let analysis;
    try {
      analysis = await this.analyzer.analyze(doc.uri, text);
    } catch (err) {
      this.output.appendLine(
        `Pyne checker: analysis failed (${err instanceof Error ? err.message : String(err)})`
      );
      return;
    }
    // No analysis: keep whatever is on screen rather than flashing it empty.
    if (!analysis) return;
    // A newer edit already superseded this text (its own check will publish),
    // or the document closed while analyzing and was already forgotten.
    if (doc.version !== version || doc.isClosed) return;
    this.diagnostics.set(doc.uri, analysis.problems.map(toDiagnostic));
  }
}

/** Turn a worker problem into an Error-severity Pyne diagnostic. */
function toDiagnostic(problem: PyneProblem): vscode.Diagnostic {
  const range = new vscode.Range(problem.line, problem.start, problem.line, problem.end);
  const diagnostic = new vscode.Diagnostic(
    range,
    problem.message,
    vscode.DiagnosticSeverity.Error
  );
  diagnostic.source = 'Pyne';
  diagnostic.code = problem.code;
  return diagnostic;
}
