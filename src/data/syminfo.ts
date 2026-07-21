/**
 * Shared syminfo helpers for the `.ohlcv` data format (see pynecore
 * core/ohlcv_file.py + core/syminfo.py). The `.ohlcv` is a header-less flat
 * array of 24-byte little-endian records (`'Ifffff'`: uint32 timestamp + 5x
 * float32 OHLCV; gap-fills carry volume < 0). The sibling `.toml` holds the
 * `[symbol]` syminfo. VSCode ships no TOML parser, so `parseSymbolSection` is a
 * deliberately tiny scraper — enough for the header, not a general parser.
 */
import * as fs from 'node:fs';

/** Bytes per OHLCV record: uint32 timestamp + 5x float32. */
export const OHLCV_RECORD_BYTES = 24;

/**
 * Pull the flat `key = value` pairs from the `[symbol]` table of a syminfo
 * toml. Handles quoted strings, bare numbers, and `#`-commented lines.
 */
export function parseSymbolSection(text: string): Record<string, string> {
  return parseSymInfo(text).symbol;
}

/** One `[[opening_hours]]` row: an exchange-local trading interval on `day`
 * (Pine dayofweek: 1=Sun … 7=Sat). Times are "HH:MM:SS" strings. */
export interface SymInfoInterval {
  day?: number;
  start?: string;
  end?: string;
}

/** One `[[session_starts]]` / `[[session_ends]]` row. */
export interface SymInfoSession {
  day?: number;
  time?: string;
}

/** The full syminfo of a `.toml`: the flat `[symbol]` fields (as strings, the
 * caller formats), the trading-hours / session arrays, and the persisted
 * `[download]` provider string. */
export interface FullSymInfo {
  symbol: Record<string, string>;
  openingHours: SymInfoInterval[];
  sessionStarts: SymInfoSession[];
  sessionEnds: SymInfoSession[];
  provider?: string;
}

/** Strip a TOML scalar's inline comment and surrounding quotes. */
function unquote(rawValue: string): string {
  let value = rawValue.trim();
  if (!value.startsWith('"') && !value.startsWith("'")) {
    const hash = value.indexOf('#');
    if (hash >= 0) value = value.slice(0, hash).trim();
  }
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }
  return value;
}

/**
 * Parse a full syminfo `.toml` — the `[symbol]` flat fields plus the
 * `[[opening_hours]]` / `[[session_starts]]` / `[[session_ends]]` array-of-tables
 * and the `[download]` provider string. Still a mini scraper (VSCode ships no
 * TOML parser), but array-aware, unlike {@link parseSymbolSection}.
 */
export function parseSymInfo(text: string): FullSymInfo {
  const out: FullSymInfo = {
    symbol: {},
    openingHours: [],
    sessionStarts: [],
    sessionEnds: [],
  };
  // Which section flat `key = value` lines belong to.
  type Section = 'symbol' | 'download' | 'other';
  let section: Section = 'other';
  // Which array a `[[...]]` row's fields go into, so day is parsed to a number.
  let arrayRow: SymInfoInterval | SymInfoSession | undefined;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;

    if (line.startsWith('[[') && line.endsWith(']]')) {
      const name = line.slice(2, -2).trim();
      section = 'other';
      arrayRow = undefined;
      if (name === 'opening_hours') {
        const row: SymInfoInterval = {};
        out.openingHours.push(row);
        arrayRow = row;
      } else if (name === 'session_starts') {
        const row: SymInfoSession = {};
        out.sessionStarts.push(row);
        arrayRow = row;
      } else if (name === 'session_ends') {
        const row: SymInfoSession = {};
        out.sessionEnds.push(row);
        arrayRow = row;
      }
      continue;
    }
    if (line.startsWith('[') && line.endsWith(']')) {
      const name = line.slice(1, -1).trim();
      arrayRow = undefined;
      section = name === 'symbol' ? 'symbol' : name === 'download' ? 'download' : 'other';
      continue;
    }

    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    const value = unquote(line.slice(eq + 1));
    if (!key) continue;

    if (arrayRow) {
      if (key === 'day') {
        const n = Number(value);
        if (Number.isFinite(n)) arrayRow.day = n;
      } else if (key === 'start' || key === 'end') {
        (arrayRow as SymInfoInterval)[key] = value;
      } else if (key === 'time') {
        (arrayRow as SymInfoSession).time = value;
      }
    } else if (section === 'symbol') {
      out.symbol[key] = value;
    } else if (section === 'download' && key === 'provider') {
      out.provider = value;
    }
  }
  return out;
}

export interface OhlcvStats {
  /** Timestamp (unix seconds) of the first record, or undefined when empty. */
  firstTs?: number;
  /** Timestamp (unix seconds) of the last record, or undefined when empty. */
  lastTs?: number;
  /** Interval between the first two records in seconds, if derivable. */
  intervalSec?: number;
  /** Number of 24-byte records. */
  bars: number;
  /** File size in bytes. */
  size: number;
}

/**
 * Read the coverage of an `.ohlcv` file without loading it: bar count comes
 * from the size, and the range from the first and last 24-byte records
 * (`fs.read`, not the whole file). The interval is the difference between the
 * first two records when there are at least two.
 */
export function readOhlcvStats(filePath: string): OhlcvStats {
  const size = fs.statSync(filePath).size;
  const bars = Math.floor(size / OHLCV_RECORD_BYTES);
  if (bars === 0) return { bars: 0, size };

  const fd = fs.openSync(filePath, 'r');
  try {
    const first = Buffer.alloc(OHLCV_RECORD_BYTES);
    fs.readSync(fd, first, 0, OHLCV_RECORD_BYTES, 0);
    const firstTs = first.readUInt32LE(0);

    let intervalSec: number | undefined;
    if (bars >= 2) {
      const second = Buffer.alloc(OHLCV_RECORD_BYTES);
      fs.readSync(fd, second, 0, OHLCV_RECORD_BYTES, OHLCV_RECORD_BYTES);
      intervalSec = second.readUInt32LE(0) - firstTs;
    }

    const last = Buffer.alloc(OHLCV_RECORD_BYTES);
    fs.readSync(fd, last, 0, OHLCV_RECORD_BYTES, (bars - 1) * OHLCV_RECORD_BYTES);
    const lastTs = last.readUInt32LE(0);

    return { firstTs, lastTs, intervalSec, bars, size };
  } finally {
    fs.closeSync(fd);
  }
}
