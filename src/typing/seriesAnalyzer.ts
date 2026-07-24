import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

import * as vscode from 'vscode';

import type { EnvManager } from '../env/manager';
import type { Span } from './seriesFilter';

/** A series-typed name occurrence and the annotation it was declared with. */
export interface SeriesRef {
  line: number;
  start: number;
  end: number;
  annotation: string;
}

/**
 * A script-structure problem the worker reports for the Pyne-checker (L5d).
 * `code` is a stable rule id (e.g. `pyne-main-missing`), `message` English.
 */
export interface PyneProblem {
  line: number;
  start: number;
  end: number;
  code: string;
  message: string;
}

/**
 * A `request.security()` / `request.security_lower_tf()` call site the worker
 * found. `symbol`/`timeframe` are the literal string arguments (null when
 * absent or non-literal); `dynamic` is true when either was non-literal, so the
 * feed is only knowable at run time.
 */
export interface SecurityCall {
  line: number;
  col: number;
  endCol: number;
  symbol: string | null;
  timeframe: string | null;
  isLtf: boolean;
  dynamic: boolean;
}

export interface SeriesAnalysis {
  /** Bases of subscripts that pynecomp rewrites into series-buffer reads. */
  spans: Span[];
  refs: SeriesRef[];
  /** Script-structure diagnostics for the Pyne-checker (L5d). */
  problems: PyneProblem[];
  /**
   * Name spans of defs decorated with pynecore's own `@overload` — legit
   * redefinitions of one name, whose `reportRedeclaration` gets dropped.
   */
  overloads: Span[];
  /**
   * Name spans of public library functions declared through `__all__` or
   * pynecore's runtime `@export` decorator.
   */
  exports: Span[];
  /** `request.security()` call sites for the data-requirement diagnostics. */
  securityCalls: SecurityCall[];
}

interface CacheEntry {
  text: string;
  analysis: SeriesAnalysis;
}

interface Pending {
  resolve: (value: SeriesAnalysis | undefined) => void;
  timer: NodeJS.Timeout;
}

interface WorkerResponse {
  id?: number;
  ok?: boolean;
  spans?: Span[];
  refs?: [number, number, number, string][];
  problems?: [number, number, number, string, string][];
  overloads?: Span[];
  exports?: Span[];
  securityCalls?: SecurityCall[];
  error?: string;
}

/** A single request may not outlive a keystroke burst by much. */
const REQUEST_TIMEOUT_MS = 5000;

/** Consecutive spawn failures after which the analyzer gives up for good. */
const MAX_SPAWN_FAILURES = 3;

/**
 * Series-access analysis for the precise `reportIndexIssue` filter (F7/L5c).
 *
 * Runs `python/pyneide_series.py` as a long-lived NDJSON worker and caches its
 * result per document text. The worker is stdlib-only on purpose: it must
 * answer before the managed environment exists, so any Python 3 on the machine
 * will do (the managed interpreter is preferred once it is ready).
 *
 * Every failure mode — no interpreter, a dead worker, half-typed source — ends
 * in `undefined`, which the caller reads as "fall back to suppressing the whole
 * rule". A missing analysis therefore never turns into a false error.
 */
export class SeriesAnalyzer implements vscode.Disposable {
  private worker?: ChildProcessWithoutNullStreams;
  private workerPython?: string;
  private stdoutBuffer = '';
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly cache = new Map<string, CacheEntry>();
  private spawnFailures = 0;
  private disposed = false;

  constructor(
    private readonly scriptPath: string,
    private readonly env: EnvManager,
    private readonly output: vscode.OutputChannel
  ) {}

  /** The cached analysis for `text`, if it was the last one analyzed. */
  cached(uri: vscode.Uri, text: string): SeriesAnalysis | undefined {
    const entry = this.cache.get(uri.toString());
    return entry && entry.text === text ? entry.analysis : undefined;
  }

  /** Analyze `text`, reusing the cache; undefined when analysis is unavailable. */
  async analyze(uri: vscode.Uri, text: string): Promise<SeriesAnalysis | undefined> {
    const hit = this.cached(uri, text);
    if (hit) return hit;
    const analysis = await this.request(text);
    if (analysis) this.cache.set(uri.toString(), { text, analysis });
    return analysis;
  }

  /** The document's current text, from the editor if open, else from disk. */
  static readText(uri: vscode.Uri): string | undefined {
    const open = vscode.workspace.textDocuments.find(
      (doc) => doc.uri.toString() === uri.toString()
    );
    if (open) return open.getText();
    try {
      return fs.readFileSync(uri.fsPath, 'utf8');
    } catch {
      return undefined;
    }
  }

  forget(uri: vscode.Uri): void {
    this.cache.delete(uri.toString());
  }

  /** The managed interpreter changed: restart onto it. */
  refreshInterpreter(): void {
    if (this.worker && this.pythonBin() !== this.workerPython) this.stopWorker();
  }

  dispose(): void {
    this.disposed = true;
    this.stopWorker();
    this.cache.clear();
  }

  // --- worker ------------------------------------------------------------

  private pythonBin(): string {
    const state = this.env.state;
    if (state.kind === 'ready') return state.pythonBin;
    return process.platform === 'win32' ? 'python' : 'python3';
  }

  private ensureWorker(): ChildProcessWithoutNullStreams | undefined {
    if (this.worker) return this.worker;
    if (this.disposed || this.spawnFailures >= MAX_SPAWN_FAILURES) return undefined;
    if (!fs.existsSync(this.scriptPath)) {
      this.spawnFailures = MAX_SPAWN_FAILURES;
      this.output.appendLine(`Series analyzer disabled: ${this.scriptPath} is missing`);
      return undefined;
    }
    const python = this.pythonBin();
    let worker: ChildProcessWithoutNullStreams;
    try {
      worker = spawn(python, ['-u', this.scriptPath], {
        cwd: path.dirname(this.scriptPath),
        stdio: ['pipe', 'pipe', 'pipe'],
        // A stray PYTHONPATH must not shadow the stdlib-only worker.
        env: { ...process.env, PYTHONNOUSERSITE: '1' },
      });
    } catch (err) {
      this.noteSpawnFailure(python, err);
      return undefined;
    }
    worker.on('error', (err) => {
      this.noteSpawnFailure(python, err);
      this.stopWorker();
    });
    worker.on('exit', (code, signal) => {
      if (!this.disposed && (code ?? 0) !== 0) {
        this.output.appendLine(`Series analyzer worker exited (code ${code}, signal ${signal})`);
      }
      this.stopWorker();
    });
    worker.stderr.on('data', (chunk: Buffer) => {
      this.output.appendLine(`Series analyzer: ${chunk.toString().trimEnd()}`);
    });
    worker.stdout.setEncoding('utf8');
    worker.stdout.on('data', (chunk: string) => this.consume(chunk));
    this.worker = worker;
    this.workerPython = python;
    return worker;
  }

  private noteSpawnFailure(python: string, err: unknown): void {
    this.spawnFailures += 1;
    const message = err instanceof Error ? err.message : String(err);
    this.output.appendLine(`Series analyzer could not start (${python}): ${message}`);
    if (this.spawnFailures >= MAX_SPAWN_FAILURES) {
      this.output.appendLine(
        'Series analyzer disabled; series index diagnostics stay fully suppressed'
      );
    }
  }

  private stopWorker(): void {
    const worker = this.worker;
    this.worker = undefined;
    this.workerPython = undefined;
    this.stdoutBuffer = '';
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.resolve(undefined);
      this.pending.delete(id);
    }
    if (worker) {
      worker.stdout.removeAllListeners();
      worker.stderr.removeAllListeners();
      worker.removeAllListeners();
      worker.kill();
    }
  }

  private consume(chunk: string): void {
    this.stdoutBuffer += chunk;
    for (;;) {
      const newline = this.stdoutBuffer.indexOf('\n');
      if (newline < 0) break;
      const line = this.stdoutBuffer.slice(0, newline).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (!line) continue;
      let response: WorkerResponse;
      try {
        response = JSON.parse(line) as WorkerResponse;
      } catch {
        this.output.appendLine(`Series analyzer: unparsable response ${line.slice(0, 200)}`);
        continue;
      }
      this.settle(response);
    }
  }

  private settle(response: WorkerResponse): void {
    const id = response.id;
    if (typeof id !== 'number') return;
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    clearTimeout(entry.timer);
    if (!response.ok) {
      entry.resolve(undefined);
      return;
    }
    entry.resolve({
      spans: response.spans ?? [],
      refs: (response.refs ?? []).map(([line, start, end, annotation]) => ({
        line,
        start,
        end,
        annotation,
      })),
      problems: (response.problems ?? []).map(([line, start, end, code, message]) => ({
        line,
        start,
        end,
        code,
        message,
      })),
      overloads: response.overloads ?? [],
      exports: response.exports ?? [],
      securityCalls: response.securityCalls ?? [],
    });
  }

  private request(source: string): Promise<SeriesAnalysis | undefined> {
    const worker = this.ensureWorker();
    if (!worker) return Promise.resolve(undefined);
    const id = this.nextId++;
    return new Promise<SeriesAnalysis | undefined>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.output.appendLine('Series analyzer: request timed out; restarting worker');
        this.stopWorker();
        resolve(undefined);
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, timer });
      try {
        worker.stdin.write(JSON.stringify({ id, source }) + '\n');
      } catch (err) {
        this.pending.delete(id);
        clearTimeout(timer);
        this.output.appendLine(
          `Series analyzer: write failed (${err instanceof Error ? err.message : String(err)})`
        );
        this.stopWorker();
        resolve(undefined);
      }
    });
  }
}
