/**
 * Editor diagnostics for a script's `request.security()` data requirements
 * (2d). Its own `pyne-security` collection, computed PURELY LOCALLY — no bridge
 * spawn — from four inputs the run-time resolver also uses:
 *
 * - the global `config/symbol_map.toml` (`[symbol_map]` table),
 * - the per-script `workspaceState` overrides (`pyneide.securityOverrides`),
 * - the sibling `data/*.toml` syminfo (`[download]` provider + period),
 * - the script's remembered primary data (`getRememberedData`), which fixes the
 *   chart symbol and timeframe the same-symbol requirements resolve against.
 *
 * Each `request.security()` call the worker reports is classified:
 * - a mapped / overridden / same-symbol coarser feed → Information (`→ file`),
 * - a same-symbol FINER feed the chart data cannot resample → Warning,
 * - an unmapped cross-symbol feed → Warning (the run will prompt),
 * - a dynamic (non-literal symbol/tf) call → Hint (resolved only at run time).
 *
 * Pine sources have no `request.security` lines of their own; the call sites
 * live in the compiled `.py`, so the check runs on that and maps each line back
 * through the sibling `.py.map`. Without a fresh map it stays silent.
 *
 * It refreshes on worker results (document edits), on a FileSystemWatcher over
 * the workdir symbol map and data tomls, and on demand after the run-time
 * resolver persists a choice (`refreshAll`).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import * as vscode from 'vscode';

import { canonicalChartKey } from '../chart/chartKey';
import { loadSourcemapFor, pineLineFor } from '../compile/sourcemap';
import { parseSymInfo } from '../data/syminfo';
import { resolveWorkspaceWorkdir } from '../env/workdirConfig';
import { detectPyne, DETECT_HEAD_BYTES } from '../pyneDetect';
import { getRememberedData } from '../run/dataSelect';
import type { SecurityCall, SeriesAnalyzer } from './seriesAnalyzer';

const CHECK_DEBOUNCE_MS = 400;
const OVERRIDES_STATE_KEY = 'pyneide.securityOverrides';

/** Minutes per timeframe unit, for the resample-direction comparison. */
const TF_UNIT_MINUTES: Record<string, number> = {
  S: 1 / 60,
  '': 1, // bare number = minutes
  D: 1440,
  W: 10080,
  M: 43200,
};

export class SecurityStatusService {
  private readonly diagnostics = vscode.languages.createDiagnosticCollection('pyne-security');
  private readonly timers = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly analyzer: SeriesAnalyzer,
    private readonly output: vscode.OutputChannel
  ) {}

  register(): void {
    const mapWatcher = vscode.workspace.createFileSystemWatcher('**/config/symbol_map.toml');
    const dataWatcher = vscode.workspace.createFileSystemWatcher('**/data/*.toml');
    const refresh = (): void => this.refreshAll();
    this.context.subscriptions.push(
      this.diagnostics,
      mapWatcher,
      dataWatcher,
      { dispose: () => this.clearTimers() },
      vscode.workspace.onDidOpenTextDocument((doc) => void this.check(doc)),
      vscode.workspace.onDidChangeTextDocument((e) => this.scheduleCheck(e.document)),
      vscode.workspace.onDidCloseTextDocument((doc) => this.forget(doc.uri)),
      mapWatcher.onDidChange(refresh),
      mapWatcher.onDidCreate(refresh),
      mapWatcher.onDidDelete(refresh),
      dataWatcher.onDidChange(refresh),
      dataWatcher.onDidCreate(refresh),
      dataWatcher.onDidDelete(refresh)
    );
    this.refreshAll();
  }

  /** Re-check every open document (map/override/data changed underneath). */
  refreshAll(): void {
    for (const doc of vscode.workspace.textDocuments) void this.check(doc);
  }

  private isPyneDocument(doc: vscode.TextDocument): boolean {
    if (doc.languageId === 'pine') return true;
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
   * Analyze the script and publish its data-requirement diagnostics. Pine docs
   * analyze the compiled `.py` and map its call lines back to Pine; a missing
   * analysis or a stale/absent map leaves the document silent.
   */
  private async check(doc: vscode.TextDocument): Promise<void> {
    if (!this.isPyneDocument(doc)) {
      this.diagnostics.delete(doc.uri);
      return;
    }
    const version = doc.version;

    // The source path a chart/data binding is scoped to (a .pine and its .py
    // fold onto one key), and the workdir the map/data live in.
    const chartKey = canonicalChartKey(doc.uri.fsPath);
    const workdir = this.resolveWorkdir(doc);
    if (!workdir) {
      this.diagnostics.delete(doc.uri);
      return;
    }

    let calls: SecurityCall[];
    let toPineLine: ((pyLine0: number) => number | undefined) | undefined;
    if (doc.languageId === 'pine') {
      const mapped = await this.pineCalls(doc);
      if (!mapped) {
        this.diagnostics.delete(doc.uri);
        return;
      }
      if (doc.version !== version || doc.isClosed) return;
      calls = mapped.calls;
      toPineLine = mapped.toPineLine;
    } else {
      const analysis = await this.safeAnalyze(doc.uri, doc.getText());
      if (!analysis) return; // keep whatever is on screen
      if (doc.version !== version || doc.isClosed) return;
      calls = analysis.securityCalls;
    }

    const ctx = this.buildContext(workdir, chartKey);
    const diagnostics: vscode.Diagnostic[] = [];
    for (const call of calls) {
      const built = this.classify(call, ctx);
      if (!built) continue;
      const range = this.rangeFor(doc, call, toPineLine);
      if (!range) continue;
      const diagnostic = new vscode.Diagnostic(range, built.message, built.severity);
      diagnostic.source = 'Pyne';
      diagnostic.code = 'pyne-security';
      diagnostics.push(diagnostic);
    }
    this.diagnostics.set(doc.uri, diagnostics);
  }

  private async safeAnalyze(uri: vscode.Uri, text: string): ReturnType<SeriesAnalyzer['analyze']> {
    try {
      return await this.analyzer.analyze(uri, text);
    } catch (err) {
      this.output.appendLine(
        `Pyne security status: analysis failed (${err instanceof Error ? err.message : String(err)})`
      );
      return undefined;
    }
  }

  /** Analyze a Pine doc's compiled `.py` and build a py→pine line mapper. */
  private async pineCalls(
    doc: vscode.TextDocument
  ): Promise<
    { calls: SecurityCall[]; toPineLine: (pyLine0: number) => number | undefined } | undefined
  > {
    const pyPath = doc.uri.fsPath.replace(/\.pine$/i, '.py');
    if (pyPath === doc.uri.fsPath || !fs.existsSync(pyPath)) return undefined;
    const map = loadSourcemapFor(pyPath);
    if (!map) return undefined;
    const pyText = this.readFile(pyPath);
    if (pyText === undefined) return undefined;
    const analysis = await this.safeAnalyze(vscode.Uri.file(pyPath), pyText);
    if (!analysis) return undefined;
    return {
      calls: analysis.securityCalls,
      // sourcemap lines are 1-indexed; worker call lines and ranges 0-indexed.
      toPineLine: (pyLine0) => {
        const pine = pineLineFor(map, pyLine0 + 1);
        return pine === undefined ? undefined : pine - 1;
      },
    };
  }

  private readFile(p: string): string | undefined {
    try {
      return fs.readFileSync(p, 'utf8');
    } catch {
      return undefined;
    }
  }

  private rangeFor(
    doc: vscode.TextDocument,
    call: SecurityCall,
    toPineLine?: (pyLine0: number) => number | undefined
  ): vscode.Range | undefined {
    if (toPineLine) {
      const pineLine = toPineLine(call.line);
      if (pineLine === undefined || pineLine < 0 || pineLine >= doc.lineCount) return undefined;
      // Columns are the .py's; anchor to the whole Pine line instead.
      return doc.lineAt(pineLine).range;
    }
    return new vscode.Range(call.line, call.col, call.line, call.endCol);
  }

  // --- classification --------------------------------------------------------

  private classify(call: SecurityCall, ctx: LocalContext): Built | undefined {
    const info = vscode.DiagnosticSeverity.Information;
    const warn = vscode.DiagnosticSeverity.Warning;
    const hint = vscode.DiagnosticSeverity.Hint;

    if (call.dynamic) {
      return {
        severity: hint,
        message: 'request.security: dynamic symbol/timeframe — resolved at run time',
      };
    }
    if (call.symbol == null || call.timeframe == null) return undefined;
    const label = `${call.symbol} @ ${call.timeframe}`;

    // Same symbol as the chart feed: coarser TFs resample from it, finer ones
    // need a separate finer feed the chart data cannot provide.
    if (ctx.chartSymbol && sameSymbol(call.symbol, ctx.chartSymbol)) {
      if (ctx.chartTf && sameTf(call.timeframe, ctx.chartTf)) {
        return { severity: info, message: `request.security: ${label} → chart feed` };
      }
      const reqMin = tfMinutes(call.timeframe);
      const chartMin = ctx.chartTf ? tfMinutes(ctx.chartTf) : undefined;
      if (reqMin !== undefined && chartMin !== undefined && reqMin < chartMin) {
        return {
          severity: warn,
          message: `request.security: ${label} needs a finer feed than the chart data (${ctx.chartTf})`,
        };
      }
      return {
        severity: info,
        message: `request.security: ${label} → resampled from the chart feed`,
      };
    }

    // Cross-symbol: resolved by an override, or by a symbol_map entry.
    const override = ctx.overrides[`${call.symbol}:${call.timeframe}`];
    if (override && ctx.dataStems.has(override)) {
      return { severity: info, message: `request.security: ${label} → ${override}.ohlcv` };
    }
    const mapped = ctx.mapValue(call.symbol, call.timeframe);
    if (mapped) {
      const file = ctx.fileForProvider(mapped, call.timeframe);
      if (file) {
        return { severity: info, message: `request.security: ${label} → ${file}.ohlcv` };
      }
      return {
        severity: warn,
        message: `request.security: ${label} mapped to ${mapped}, but no data file — the run will prompt`,
      };
    }
    return {
      severity: warn,
      message: `request.security: ${label} — no data mapped, the run will prompt`,
    };
  }

  // --- local inputs ----------------------------------------------------------

  private buildContext(workdir: string, chartKey: string): LocalContext {
    const map = readSymbolMap(workdir);
    const overrides =
      this.context.workspaceState.get<Record<string, Record<string, string>>>(
        OVERRIDES_STATE_KEY,
        {}
      )[chartKey] ?? {};
    const dataFiles = readDataFiles(workdir);
    const dataStems = new Set(dataFiles.map((f) => f.stem));

    let chartSymbol: string | undefined;
    let chartTf: string | undefined;
    const primary = getRememberedData(this.context, workdir, chartKey);
    if (primary) {
      const meta = dataFiles.find((f) => f.stem === primary);
      chartSymbol = meta?.symbol;
      chartTf = meta?.period;
    }

    return {
      chartSymbol,
      chartTf,
      overrides,
      dataStems,
      mapValue: (symbol, tf) => map.get(`${symbol}:${tf}`) ?? map.get(symbol),
      fileForProvider: (provider, tf) =>
        dataFiles.find((f) => f.provider === provider && f.period === tf)?.stem,
    };
  }

  private resolveWorkdir(doc: vscode.TextDocument): string | undefined {
    const folder = vscode.workspace.getWorkspaceFolder(doc.uri);
    const res = resolveWorkspaceWorkdir(folder, path.dirname(doc.uri.fsPath));
    return res?.exists ? res.path : undefined;
  }
}

interface Built {
  severity: vscode.DiagnosticSeverity;
  message: string;
}

interface LocalContext {
  chartSymbol?: string;
  chartTf?: string;
  overrides: Record<string, string>;
  dataStems: Set<string>;
  /** The symbol_map value for `SYMBOL:TF` (then `SYMBOL`), or undefined. */
  mapValue: (symbol: string, tf: string) => string | undefined;
  /** The data stem whose `[download]` provider + period match, or undefined. */
  fileForProvider: (provider: string, tf: string) => string | undefined;
}

interface DataFileMeta {
  stem: string;
  symbol?: string;
  period?: string;
  /** Provider-qualified native symbol (the `[download]` string minus `@TF`). */
  provider?: string;
}

/** Read the `[symbol_map]` table of `config/symbol_map.toml` (flat key→value). */
function readSymbolMap(workdir: string): Map<string, string> {
  const out = new Map<string, string>();
  let text: string;
  try {
    text = fs.readFileSync(path.join(workdir, 'config', 'symbol_map.toml'), 'utf8');
  } catch {
    return out;
  }
  let inTable = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('[') && line.endsWith(']')) {
      inTable = line === '[symbol_map]';
      continue;
    }
    if (!inTable) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = stripQuotes(line.slice(0, eq).trim());
    const value = stripQuotes(line.slice(eq + 1).trim());
    if (key) out.set(key, value);
  }
  return out;
}

/** Metadata of every `.ohlcv` in `<workdir>/data`, from its sibling `.toml`. */
function readDataFiles(workdir: string): DataFileMeta[] {
  const dataDir = path.join(workdir, 'data');
  let names: string[];
  try {
    names = fs.readdirSync(dataDir);
  } catch {
    return [];
  }
  const out: DataFileMeta[] = [];
  for (const name of names) {
    if (!name.endsWith('.ohlcv')) continue;
    const stem = name.slice(0, -'.ohlcv'.length);
    const meta: DataFileMeta = { stem };
    try {
      const info = parseSymInfo(fs.readFileSync(path.join(dataDir, `${stem}.toml`), 'utf8'));
      const prefix = info.symbol.prefix;
      const ticker = info.symbol.ticker;
      if (prefix && ticker) meta.symbol = `${prefix}:${ticker}`;
      else if (ticker) meta.symbol = ticker;
      meta.period = info.symbol.period;
      if (info.provider) {
        const at = info.provider.lastIndexOf('@');
        meta.provider = at > 0 ? info.provider.slice(0, at) : info.provider;
      }
    } catch {
      // A file with no readable sibling toml stays a bare stem.
    }
    out.push(meta);
  }
  return out;
}

function stripQuotes(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function sameSymbol(a: string, b: string): boolean {
  return a.toUpperCase() === b.toUpperCase();
}

function sameTf(a: string, b: string): boolean {
  const ma = tfMinutes(a);
  const mb = tfMinutes(b);
  if (ma !== undefined && mb !== undefined) return ma === mb;
  return a.toUpperCase() === b.toUpperCase();
}

/** Minutes for a Pine timeframe string (`"60"`, `"1D"`, `"1W"`), or undefined. */
function tfMinutes(tf: string): number | undefined {
  const match = /^(\d*)\s*([SDWM]?)$/i.exec(tf.trim());
  if (!match) return undefined;
  const count = match[1] === '' ? 1 : Number(match[1]);
  const unit = match[2].toUpperCase();
  const per = TF_UNIT_MINUTES[unit];
  if (per === undefined || !Number.isFinite(count)) return undefined;
  return count * per;
}
