/**
 * Run-time resolution of a script's `request.security()` data requirements.
 *
 * The core (pynecore) already resolves everything it can — the chart's own
 * feed, same-symbol coarser timeframes (resampled from the chart data), and any
 * cross-symbol requirement that hits the global `config/symbol_map.toml` and
 * whose derived `.ohlcv` exists. This layer only asks the user about the
 * REMAINDER: unresolved cross-symbol feeds. Each gets a chained QuickPick of
 * candidate `.ohlcv` files (ticker-matching suggestions ranked first), a
 * Download entry, and a Skip / Run-anyway escape.
 *
 * A chosen file is remembered persistently: when it carries a `[download]`
 * provider string (and its timeframe matches the requirement) the choice is
 * written into `symbol_map.toml` so the CLI resolves it too; otherwise it is
 * passed as an explicit `--security KEY=stem` arg for the run and remembered in
 * `workspaceState` so re-runs stay prompt-free.
 *
 * Inspection (a one-shot bridge spawn, the `--inspect-inputs` pattern) is cached
 * in memory and `workspaceState`, keyed on the script hash, the data stem, the
 * timeframe override and the newest scripts/lib mtime — so an input-save chart
 * re-run never re-prompts.
 */
import { spawn } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import * as vscode from 'vscode';

import type { SecurityPrefill } from '../data/symbolBrowserPanel';
import { parseSymInfo } from '../data/syminfo';
import { writeSymbolMapEntry } from './symbolMapFile';

const INSPECT_TIMEOUT_MS = 30000;
const CACHE_STATE_KEY = 'pyneide.securityInspectCache';
const OVERRIDES_STATE_KEY = 'pyneide.securityOverrides';
const CACHE_CAP = 40;

/** One classified `request.security()` requirement (mirrors pynecore's
 * `SecurityRequirement`, camelCased by the bridge's `_serialize_security_req`). */
export interface SecurityRequirementItem {
  secId: string;
  symbol: string | null;
  timeframe: string | null;
  isLtf: boolean;
  ignoreInvalidSymbol: boolean;
  fromLibrary: boolean;
  hasSecurityMapping: boolean;
  hasGlobalMap: boolean;
  mappedProvider: string | null;
  mappedNativeSymbol: string | null;
  mappedFile: string | null;
  mappedFileExists: boolean;
  downloadSuggestion: string | null;
  fileSuggestions: string[];
}

/** The four classified buckets of a script's data requirements. */
export interface SecurityInspection {
  supported: boolean;
  chartSymbol?: string;
  chartTf?: string;
  chartMain: SecurityRequirementItem[];
  sameSymbolOtherTf: SecurityRequirementItem[];
  crossSymbol: SecurityRequirementItem[];
  dynamic: SecurityRequirementItem[];
}

export interface ResolveResult {
  /** Explicit `--security KEY=stem` args for this run (map-resolved feeds need none). */
  security: string[];
  /** True when the user cancelled a QuickPick (Esc) or chose Download — abort the run. */
  cancelled: boolean;
  /** True when inspection failed or the pynecore predates the classifier. */
  unsupported: boolean;
}

/** Opens the Symbol Browser armed with a security-download prefill: it seeds the
 * search + timeframe and, after the download, writes the symbol_map entry. */
export type ShowSymbolBrowser = (prefill: SecurityPrefill) => void;

type Choice =
  | { kind: 'file'; stem: string }
  | { kind: 'download' }
  | { kind: 'skip' }
  | { kind: 'cancel' };

interface FileMeta {
  label: string;
  /** Provider-qualified native symbol (the `[download]` string minus `@TF`). */
  nativeProvider?: string;
  period?: string;
}

export class SecurityDataService {
  private readonly memCache = new Map<string, SecurityInspection>();

  /** Notified after a resolution persists a choice (map/override) so the editor
   * data-requirement diagnostics can refresh. */
  private onChanged?: () => void;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly output: vscode.OutputChannel,
    private readonly extensionUri: vscode.Uri,
    private showSymbolBrowser?: ShowSymbolBrowser
  ) {}

  /** Wire the Symbol Browser callback (Part 3 wires the panel-prefill side). */
  setShowSymbolBrowser(cb: ShowSymbolBrowser): void {
    this.showSymbolBrowser = cb;
  }

  /** Wire the "a choice was persisted" listener (editor diagnostics refresh). */
  setOnChanged(cb: () => void): void {
    this.onChanged = cb;
  }

  /**
   * Inspect a script's data requirements (cached). `undefined` on failure; an
   * inspection with `supported: false` for a pynecore that lacks the classifier.
   */
  async inspectSecurityRequirements(
    pythonBin: string,
    workdir: string,
    scriptPath: string,
    dataStem: string,
    timeframe?: string
  ): Promise<SecurityInspection | undefined> {
    const key = this.cacheKey(workdir, scriptPath, dataStem, timeframe);
    const mem = this.memCache.get(key);
    if (mem) return mem;
    const persisted = this.context.workspaceState.get<Record<string, SecurityInspection>>(
      CACHE_STATE_KEY,
      {}
    )[key];
    if (persisted) {
      this.memCache.set(key, persisted);
      return persisted;
    }

    let result: SecurityInspection;
    try {
      const event = await this.oneShot(pythonBin, workdir, [
        '--inspect-security',
        scriptPath,
        '--data',
        dataStem,
        ...(timeframe ? ['--timeframe', timeframe] : []),
      ]);
      result = normalizeInspection(event);
    } catch (err) {
      this.output.appendLine(
        `Security inspection failed: ${err instanceof Error ? err.message : String(err)}`
      );
      return undefined;
    }

    this.memCache.set(key, result);
    await this.persistCache(key, result);
    return result;
  }

  /**
   * Resolve the unresolved cross-symbol requirements. Prompts only for what the
   * core cannot resolve; returns the explicit `--security` args (if any), and
   * signals cancellation (abort the run) or unsupported (caller warns once).
   */
  async resolveSecurityData(opts: {
    pythonBin: string;
    workdir: string;
    scriptPath: string;
    dataStem: string;
    chartKey: string;
    timeframe?: string;
  }): Promise<ResolveResult> {
    const inspection = await this.inspectSecurityRequirements(
      opts.pythonBin,
      opts.workdir,
      opts.scriptPath,
      opts.dataStem,
      opts.timeframe
    );
    if (!inspection) return { security: [], cancelled: false, unsupported: true };
    if (!inspection.supported) return { security: [], cancelled: false, unsupported: true };

    const overrides = this.getOverrides(opts.chartKey);
    const security: string[] = [];
    let mapWritten = false;
    let changed = false;

    for (const req of inspection.crossSymbol) {
      if (req.symbol == null || req.timeframe == null) continue;
      // Core resolves a mapped-and-present feed on its own (config_dir is passed
      // to the run), so no arg — and no prompt — is needed.
      if (req.hasGlobalMap && req.mappedFileExists) continue;

      const secKey = `${req.symbol}:${req.timeframe}`;
      const remembered = overrides[secKey];
      if (remembered && this.dataFileExists(opts.workdir, remembered)) {
        security.push(`${secKey}=${remembered}`);
        continue;
      }

      const choice = await this.promptForRequirement(opts.workdir, req);
      if (choice.kind === 'cancel') return { security: [], cancelled: true, unsupported: false };
      if (choice.kind === 'download') {
        this.launchDownload(req, opts.workdir, opts.chartKey);
        return { security: [], cancelled: true, unsupported: false };
      }
      if (choice.kind === 'skip') continue;

      const stem = choice.stem;
      const meta = this.readFileMeta(opts.workdir, stem);
      // Prefer a persistent symbol_map.toml entry (CLI benefits too) when the
      // file names its origin provider AND its timeframe matches the request —
      // only then does the core's get_ohlcv_path derivation land on this file.
      if (meta.nativeProvider && meta.period && meta.period === req.timeframe) {
        writeSymbolMapEntry(opts.workdir, req.symbol, meta.nativeProvider);
        this.output.appendLine(`symbol_map: "${req.symbol}" -> "${meta.nativeProvider}"`);
        mapWritten = true;
        changed = true;
      } else {
        // Manual / import data with no provider (or a TF mismatch): pass it
        // explicitly for this run and remember it so re-runs stay silent.
        security.push(`${secKey}=${stem}`);
        this.rememberOverride(opts.chartKey, secKey, stem);
        changed = true;
      }
    }

    // A fresh map entry invalidates the cached inspection (mappedFileExists flips).
    if (mapWritten) this.invalidate(opts.workdir, opts.scriptPath, opts.dataStem, opts.timeframe);
    if (changed) this.onChanged?.();
    return { security, cancelled: false, unsupported: false };
  }

  // --- prompting ------------------------------------------------------------

  private async promptForRequirement(
    workdir: string,
    req: SecurityRequirementItem
  ): Promise<Choice> {
    const dataDir = path.join(workdir, 'data');
    const suggested = new Set(req.fileSuggestions);
    const stems = this.listOhlcv(dataDir).sort((a, b) => {
      const sa = suggested.has(a) ? 0 : 1;
      const sb = suggested.has(b) ? 0 : 1;
      return sa !== sb ? sa - sb : a.localeCompare(b);
    });

    type Item = vscode.QuickPickItem & { choice: Choice };
    const items: Item[] = stems.map((stem) => {
      const meta = this.readFileMeta(workdir, stem);
      return {
        label: `$(graph-line) ${meta.label}`,
        description: stem,
        detail: suggested.has(stem) ? 'ticker matches — suggested' : undefined,
        choice: { kind: 'file', stem } as Choice,
      };
    });
    items.push({
      label: '$(cloud-download) Download…',
      description: req.downloadSuggestion ?? 'open the Symbol Browser to fetch this data',
      choice: { kind: 'download' },
    });
    items.push(
      req.ignoreInvalidSymbol
        ? {
            label: '$(circle-slash) Skip (na)',
            description: 'ignore_invalid_symbol=true — the feed reads as na',
            choice: { kind: 'skip' },
          }
        : {
            label: '$(warning) Run anyway (will fail)',
            description: 'no data for a required security — the run will error',
            choice: { kind: 'skip' },
          }
    );

    const missingNote =
      req.hasGlobalMap && !req.mappedFileExists
        ? ` — mapped to ${req.mappedProvider}:${req.mappedNativeSymbol}, but its file is missing`
        : '';
    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: `Data for ${req.symbol} @ ${req.timeframe}${missingNote}`,
      matchOnDescription: true,
      ignoreFocusOut: true,
    });
    return picked?.choice ?? { kind: 'cancel' };
  }

  private launchDownload(req: SecurityRequirementItem, workdir: string, chartKey: string): void {
    if (!this.showSymbolBrowser || req.symbol == null) {
      void vscode.commands.executeCommand('pyneide.openSymbolBrowser');
      return;
    }
    // Seed the browser with the mapped native symbol when known (its search box
    // needs the broker-native ticker, not the TV symbol), and arm the map write
    // under the TV symbol key so the CLI resolves it afterwards too.
    this.showSymbolBrowser({
      symbol: req.mappedNativeSymbol ?? req.symbol,
      timeframe: req.timeframe ?? undefined,
      mapKey: req.symbol,
      workdir,
      chartKey,
    });
  }

  // --- persistence helpers --------------------------------------------------

  private getOverrides(chartKey: string): Record<string, string> {
    return (
      this.context.workspaceState.get<Record<string, Record<string, string>>>(
        OVERRIDES_STATE_KEY,
        {}
      )[chartKey] ?? {}
    );
  }

  private rememberOverride(chartKey: string, secKey: string, stem: string): void {
    const all = this.context.workspaceState.get<Record<string, Record<string, string>>>(
      OVERRIDES_STATE_KEY,
      {}
    );
    const forKey = { ...(all[chartKey] ?? {}), [secKey]: stem };
    void this.context.workspaceState.update(OVERRIDES_STATE_KEY, { ...all, [chartKey]: forKey });
  }

  private async persistCache(key: string, value: SecurityInspection): Promise<void> {
    const all = this.context.workspaceState.get<Record<string, SecurityInspection>>(
      CACHE_STATE_KEY,
      {}
    );
    const entries = Object.entries(all);
    // Cap the persisted cache so it cannot grow without bound (FIFO drop).
    const trimmed = entries.length >= CACHE_CAP ? entries.slice(entries.length - CACHE_CAP + 1) : entries;
    await this.context.workspaceState.update(CACHE_STATE_KEY, {
      ...Object.fromEntries(trimmed),
      [key]: value,
    });
  }

  private invalidate(workdir: string, scriptPath: string, dataStem: string, timeframe?: string): void {
    const key = this.cacheKey(workdir, scriptPath, dataStem, timeframe);
    this.memCache.delete(key);
    const all = this.context.workspaceState.get<Record<string, SecurityInspection>>(
      CACHE_STATE_KEY,
      {}
    );
    if (key in all) {
      const { [key]: _drop, ...rest } = all;
      void this.context.workspaceState.update(CACHE_STATE_KEY, rest);
    }
  }

  // --- file helpers ---------------------------------------------------------

  private cacheKey(workdir: string, scriptPath: string, dataStem: string, timeframe?: string): string {
    let sha = '';
    try {
      sha = crypto.createHash('sha256').update(fs.readFileSync(scriptPath)).digest('hex');
    } catch {
      sha = scriptPath;
    }
    const libMtime = newestMtime(path.join(workdir, 'scripts'));
    return [sha, dataStem, timeframe ?? '', libMtime].join('|');
  }

  private listOhlcv(dataDir: string): string[] {
    try {
      return fs
        .readdirSync(dataDir)
        .filter((n) => n.endsWith('.ohlcv'))
        .map((n) => n.slice(0, -'.ohlcv'.length));
    } catch {
      return [];
    }
  }

  private dataFileExists(workdir: string, stem: string): boolean {
    return fs.existsSync(path.join(workdir, 'data', `${stem}.ohlcv`));
  }

  private readFileMeta(workdir: string, stem: string): FileMeta {
    try {
      const text = fs.readFileSync(path.join(workdir, 'data', `${stem}.toml`), 'utf8');
      const info = parseSymInfo(text);
      const prefix = info.symbol.prefix;
      const ticker = info.symbol.ticker;
      const period = info.symbol.period;
      const label =
        prefix && ticker ? `${prefix}:${ticker}${period ? ` @ ${period}` : ''}` : ticker ?? stem;
      // The [download] provider string carries the timeframe as a trailing
      // "@TF"; the symbol_map value is the native symbol without it.
      let nativeProvider: string | undefined;
      if (info.provider) {
        const at = info.provider.lastIndexOf('@');
        nativeProvider = at > 0 ? info.provider.slice(0, at) : info.provider;
      }
      return { label, nativeProvider, period };
    } catch {
      return { label: stem };
    }
  }

  // --- one-shot bridge spawn (the --inspect-inputs pattern) -----------------

  private oneShot(
    pythonBin: string,
    workdir: string,
    extraArgs: string[]
  ): Promise<Record<string, unknown>> {
    const bridgeRoot = vscode.Uri.joinPath(this.extensionUri, 'python').fsPath;
    return new Promise((resolve, reject) => {
      const pythonPath = process.env.PYTHONPATH
        ? `${bridgeRoot}${path.delimiter}${process.env.PYTHONPATH}`
        : bridgeRoot;
      const child = spawn(
        pythonBin,
        ['-X', 'utf8', '-m', 'pyneide_bridge', '--workdir', workdir, ...extraArgs],
        {
          cwd: workdir,
          env: { ...process.env, PYTHONPATH: pythonPath, PYNE_WORK_DIR: workdir, PYTHONUNBUFFERED: '1' },
          stdio: ['ignore', 'pipe', 'pipe'],
        }
      );

      let settled = false;
      let stdoutBuf = '';
      const timer = setTimeout(() => {
        finish(() => reject(new Error('security inspection timed out')));
        child.kill('SIGTERM');
      }, INSPECT_TIMEOUT_MS);
      const finish = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };

      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => {
        stdoutBuf += chunk;
        let nl: number;
        while ((nl = stdoutBuf.indexOf('\n')) >= 0) {
          const line = stdoutBuf.slice(0, nl).trim();
          stdoutBuf = stdoutBuf.slice(nl + 1);
          if (!line) continue;
          let event: { e?: string; [key: string]: unknown };
          try {
            event = JSON.parse(line);
          } catch {
            continue;
          }
          if (event.e === 'security') finish(() => resolve(event));
          else if (event.e === 'error') {
            finish(() => reject(new Error(String(event.message ?? 'security inspection failed'))));
          }
        }
      });

      child.stderr?.setEncoding('utf8');
      child.stderr?.on('data', (chunk: string) => {
        for (const line of chunk.split('\n')) {
          if (line.trim()) this.output.appendLine(`[inspect-security] ${line}`);
        }
      });

      child.on('error', (err) => finish(() => reject(err)));
      child.on('close', () => finish(() => reject(new Error('security inspection produced no result'))));
    });
  }
}

function normalizeInspection(event: Record<string, unknown>): SecurityInspection {
  const bucket = (name: string): SecurityRequirementItem[] => {
    const raw = event[name];
    if (!Array.isArray(raw)) return [];
    return raw.map((r) => normalizeReq(r as Record<string, unknown>));
  };
  return {
    supported: event.supported !== false,
    chartSymbol: typeof event.chartSymbol === 'string' ? event.chartSymbol : undefined,
    chartTf: typeof event.chartTf === 'string' ? event.chartTf : undefined,
    chartMain: bucket('chartMain'),
    sameSymbolOtherTf: bucket('sameSymbolOtherTf'),
    crossSymbol: bucket('crossSymbol'),
    dynamic: bucket('dynamic'),
  };
}

function normalizeReq(r: Record<string, unknown>): SecurityRequirementItem {
  const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
  return {
    secId: String(r.secId ?? ''),
    symbol: str(r.symbol),
    timeframe: str(r.timeframe),
    isLtf: r.isLtf === true,
    ignoreInvalidSymbol: r.ignoreInvalidSymbol === true,
    fromLibrary: r.fromLibrary === true,
    hasSecurityMapping: r.hasSecurityMapping === true,
    hasGlobalMap: r.hasGlobalMap === true,
    mappedProvider: str(r.mappedProvider),
    mappedNativeSymbol: str(r.mappedNativeSymbol),
    mappedFile: str(r.mappedFile),
    mappedFileExists: r.mappedFileExists === true,
    downloadSuggestion: str(r.downloadSuggestion),
    fileSuggestions: Array.isArray(r.fileSuggestions)
      ? r.fileSuggestions.filter((s): s is string => typeof s === 'string')
      : [],
  };
}

/** Newest mtime (ms) among `.py`/`.pine` files under `dir`, recursively; 0 if none. */
function newestMtime(dir: string): number {
  let newest = 0;
  const walk = (d: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) {
        walk(full);
      } else if (e.name.endsWith('.py') || e.name.endsWith('.pine')) {
        try {
          const m = fs.statSync(full).mtimeMs;
          if (m > newest) newest = m;
        } catch {
          // ignore unreadable file
        }
      }
    }
  };
  walk(dir);
  return Math.floor(newest);
}
