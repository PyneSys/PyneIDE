/**
 * Pure-data model behind the Symbol Map panel and the single source of truth for
 * the `request.security` ok/missing derivation. Given a workdir it reads the
 * global `[symbol_map]` table and the `<workdir>/data/*.ohlcv` metadata (both via
 * the existing line/toml scrapers) and answers one question in one place: does a
 * map value — a provider-qualified native symbol like `"ccxt:BYBIT:BTC/USDT:USDT"`
 * — at a timeframe have a matching `.ohlcv` on disk, and what is its stem?
 *
 * There is deliberately no vscode dependency here (filesystem only): the panel,
 * the diagnostics (`typing/securityStatus.ts`) and any future caller all derive
 * ok/missing the same way, so the tree, the editor squiggles and the panel can
 * never disagree.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { readSymbolMapEntries } from '../run/symbolMapFile';
import { parseSymInfo } from './syminfo';

/** Metadata of one `<workdir>/data/*.ohlcv`, read from its sibling `.toml`. */
export interface DataFileMeta {
  /** File stem (the `.ohlcv` name without its extension). */
  stem: string;
  /** TradingView-style `PREFIX:TICKER` from the syminfo, when both are known. */
  symbol?: string;
  /** Timeframe token from the syminfo `period` (`"60"`, `"1D"`). */
  period?: string;
  /**
   * The full provider-qualified native symbol you would put in the map to point
   * at THIS file: the `[download]` provider string minus its `@TF` suffix
   * (`"ccxt:BYBIT:BTC/USDT:USDT"`).
   */
  native?: string;
}

/**
 * Metadata of every `.ohlcv` in `<workdir>/data`, read from each one's sibling
 * `.toml`. A missing data dir yields `[]`; a file with no readable sibling toml
 * stays a bare stem.
 */
export function readDataFiles(workdir: string): DataFileMeta[] {
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
        meta.native = at > 0 ? info.provider.slice(0, at) : info.provider;
      }
    } catch {
      // A file with no readable sibling toml stays a bare stem.
    }
    out.push(meta);
  }
  return out;
}

/**
 * The `.ohlcv` stem whose data backs a map value (a provider-qualified native
 * symbol) at `tf`, or `undefined` when none exists — the single ok/missing
 * derivation shared by the security diagnostics and the panel. With `tf` given
 * it matches on both the value and the timeframe; without one (a bare map key
 * that carries no `:TF`) it matches on the value alone, taking the first file.
 */
export function fileForMappedValue(
  dataFiles: DataFileMeta[],
  value: string,
  tf?: string
): string | undefined {
  return dataFiles.find((f) => f.native === value && (tf === undefined || f.period === tf))?.stem;
}

/** One row of the map: a TV-style symbol mapped to a provider-qualified native
 * VALUE. The mapping is timeframe-independent — it names an instrument, and the
 * `.ohlcv` for whatever timeframe a script requests is derived from it. */
export interface SymbolMapEntry {
  /** The raw map KEY (`"BYBIT:BTCUSDT.P"`, or a rare CLI-made `"NASDAQ:AAPL:60"`). */
  key: string;
  /** The KEY minus its optional trailing `:TF` (`"NASDAQ:AAPL"`). */
  tvSymbol: string;
  /**
   * A timeframe peeled off the KEY, when a rare per-TF override entry carried one
   * (`"60"`). The panel never creates these — it maps timeframe-independently —
   * but preserves any it reads so a CLI/hand-written `:TF` override survives edits.
   */
  tf?: string;
  /** The raw map VALUE (`"ccxt:BYBIT:BTC/USDT:USDT"`). */
  value: string;
  /** The VALUE's leading provider token (`"ccxt"`). */
  provider: string;
  /** The VALUE minus its provider prefix — the native symbol (`"BYBIT:BTC/USDT:USDT"`). */
  native: string;
  /**
   * The timeframes already downloaded for this instrument (the `.ohlcv` files
   * whose native matches the VALUE), coarsest-last. Empty when no data exists yet
   * — the panel offers a Download then. Which single file a run uses is decided at
   * run time from the requested timeframe, not stored here.
   */
  availableTfs: string[];
}

/** An instrument the workdir already has data for, surfaced as a ready mapping
 * target: one entry per provider+native symbol, collapsing its timeframes. */
export interface SymbolMapInstrument {
  /** The full map VALUE that targets this instrument (`"ccxt:BYBIT:BTC/USDT:USDT"`). */
  native: string;
  /** Provider token (`"ccxt"`), from the `[download]` string or stem fallback. */
  provider?: string;
  /** TV-style `PREFIX:TICKER` from the syminfo (`"BYBIT:BTCUSDT.P"`), or the native
   * symbol as a fallback — the human label for the instrument. */
  symbol: string;
  /** The timeframes downloaded for this instrument (`["15", "60", "1D"]`), coarsest-last. */
  timeframes: string[];
}

/** The whole Symbol Map as plain data: the mapped entries and the instruments the
 * workdir has data for, which the panel offers as one-click targets. */
export interface SymbolMapModel {
  entries: SymbolMapEntry[];
  instruments: SymbolMapInstrument[];
}

/**
 * Build the plain-data {@link SymbolMapModel} for a workdir: every `[symbol_map]`
 * entry resolved to its ok/missing `.ohlcv` status, plus every existing data
 * file described as a ready mapping target. Pure filesystem read — no vscode, no
 * side effects — so any UI or diagnostic layer can render or diff it.
 */
export function buildSymbolMapModel(workdir: string): SymbolMapModel {
  const dataFiles = readDataFiles(workdir);
  const instruments = groupInstruments(dataFiles);
  const tfsByNative = new Map(instruments.map((i) => [i.native, i.timeframes]));

  const entries: SymbolMapEntry[] = readSymbolMapEntries(workdir).map(({ key, value }) => {
    const { tvSymbol, tf } = splitKey(key);
    const { provider, native } = splitValue(value);
    return { key, tvSymbol, tf, value, provider, native, availableTfs: tfsByNative.get(value) ?? [] };
  });

  return { entries, instruments };
}

/**
 * Collapse the per-file data metadata into one {@link SymbolMapInstrument} per
 * provider-qualified native symbol (the map VALUE), merging every timeframe of the
 * same instrument into one row. Files with no derivable native (unnamed/imported
 * data) cannot be a map target and are skipped. Instruments are sorted by symbol,
 * their timeframes coarsest-last.
 */
function groupInstruments(dataFiles: DataFileMeta[]): SymbolMapInstrument[] {
  const byNative = new Map<string, SymbolMapInstrument>();
  for (const meta of dataFiles) {
    if (!meta.native) continue;
    let inst = byNative.get(meta.native);
    if (!inst) {
      inst = {
        native: meta.native,
        provider: providerFromValue(meta.native) ?? providerFromStem(meta.stem),
        symbol: meta.symbol ?? meta.native,
        timeframes: [],
      };
      byNative.set(meta.native, inst);
    }
    if (meta.period && !inst.timeframes.includes(meta.period)) inst.timeframes.push(meta.period);
  }
  const instruments = [...byNative.values()];
  for (const inst of instruments) inst.timeframes.sort((a, b) => tfMinutes(a) - tfMinutes(b));
  instruments.sort((a, b) => a.symbol.localeCompare(b.symbol));
  return instruments;
}

/** A timeframe token's length in minutes, for coarsest-last ordering. Unknown
 * tokens sort last. Mirrors pynecore's `S`/`D`/`W`/`M` unit convention. */
function tfMinutes(tf: string): number {
  const m = /^(\d+)([SDWM]?)$/i.exec(tf.trim());
  if (!m) return Number.MAX_SAFE_INTEGER;
  const n = Number(m[1]);
  switch (m[2].toUpperCase()) {
    case 'S': return n / 60;
    case 'D': return n * 1440;
    case 'W': return n * 10080;
    case 'M': return n * 43200;
    default: return n;
  }
}

/**
 * A pynecore timeframe token as it appears as a trailing `:TF` on a map KEY
 * (`"60"`, `"15"`, `"240"`, `"1D"`, `"1W"`, `"1M"`, `"30S"`): one or more digits
 * with an optional S/D/W/M unit. Matched only against the LAST colon segment, so
 * a genuine symbol colon (`"BYBIT:BTCUSDT.P"`) is never mistaken for one.
 */
const TF_TOKEN_RE = /^\d+[SDWM]?$/i;

/** Provider names that carry the `<provider>_…` stem convention, used only as a
 * fallback when a data file has no persisted `[download]` provider string. */
const KNOWN_PROVIDERS = new Set([
  'ccxt',
  'bybit',
  'tradingview',
  'capitalcom',
  'ctrader',
  'coinbase',
]);

/**
 * Split a map KEY into its TradingView symbol and optional timeframe. Only the
 * last colon segment is peeled off, and only when it matches {@link TF_TOKEN_RE}
 * — so `"NASDAQ:AAPL:60"` -> `{ tvSymbol: "NASDAQ:AAPL", tf: "60" }` while
 * `"BYBIT:BTCUSDT.P"` stays whole.
 */
function splitKey(key: string): { tvSymbol: string; tf?: string } {
  const idx = key.lastIndexOf(':');
  if (idx > 0) {
    const tail = key.slice(idx + 1);
    if (TF_TOKEN_RE.test(tail)) return { tvSymbol: key.slice(0, idx), tf: tail };
  }
  return { tvSymbol: key };
}

/** Split a map VALUE `"provider:rest"` into its leading provider token and the
 * native symbol remainder. A value with no colon has an empty provider. */
function splitValue(value: string): { provider: string; native: string } {
  const idx = value.indexOf(':');
  if (idx < 0) return { provider: '', native: value };
  return { provider: value.slice(0, idx), native: value.slice(idx + 1) };
}

/** Leading `:`-token of a provider string (`"ccxt:BYBIT:BTC/USDT:USDT"` -> `"ccxt"`). */
function providerFromValue(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const head = value.split(':', 1)[0].trim();
  return head || undefined;
}

/** Best-effort provider from the `<provider>_…` filename stem, but only for the
 * known set — arbitrary user-named files (`pf68`, `demo`) must NOT guess one. */
function providerFromStem(stem: string): string | undefined {
  const head = stem.split('_', 1)[0].toLowerCase();
  return KNOWN_PROVIDERS.has(head) ? head : undefined;
}
