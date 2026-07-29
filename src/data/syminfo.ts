/**
 * Shared syminfo helpers for the `.ohlcv` data format (see pynecore
 * core/syminfo.py). The binary itself is decoded by `ohlcvFormat.ts`; the
 * sibling `.toml` holds the `[symbol]` syminfo. VSCode ships no TOML parser, so
 * `parseSymbolSection` is a deliberately tiny scraper — enough for the header,
 * not a general parser.
 */
import * as fs from 'node:fs';

import {
  OhlcvDecoder,
  V2_FIXED_HEADER_BYTES,
  parseOhlcvLayout,
  recordOffset,
  v2HeaderSize,
  type OhlcvLayout,
} from './ohlcvFormat';

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
  /** Timestamp (unix ms) of the first record, or undefined when empty. */
  firstTs?: number;
  /** Timestamp (unix ms) of the last record, or undefined when empty. */
  lastTs?: number;
  /** Declared bar period (`5`, `240`, `1D`), when the file states one. */
  period?: string;
  /** Number of committed records. */
  bars: number;
  /** File size in bytes. */
  size: number;
}

/**
 * Read an `.ohlcv` file's schema from its header (v1 files have none, so the
 * layout is synthesized from the file size) using at most two small reads.
 */
export function readOhlcvLayout(fd: number, fileSize: number): OhlcvLayout {
  const head = Buffer.alloc(Math.min(V2_FIXED_HEADER_BYTES, fileSize));
  fs.readSync(fd, head, 0, head.length, 0);
  const fullSize = v2HeaderSize(head);
  if (fullSize === undefined || fullSize <= head.length) return parseOhlcvLayout(head, fileSize);

  const full = Buffer.alloc(Math.min(fullSize, fileSize));
  fs.readSync(fd, full, 0, full.length, 0);
  return parseOhlcvLayout(full, fileSize);
}

/**
 * Read the coverage of an `.ohlcv` file without loading it: the record count
 * and (on v2) the range come from the header, otherwise the first and last
 * records are read individually — never the whole file.
 */
export function readOhlcvStats(filePath: string): OhlcvStats {
  const size = fs.statSync(filePath).size;
  const fd = fs.openSync(filePath, 'r');
  try {
    const layout = readOhlcvLayout(fd, size);
    const bars = layout.recordCount;
    const stats: OhlcvStats = { bars, size, period: layout.period };
    if (bars === 0) return stats;

    if (layout.firstTimestamp !== undefined && layout.lastTimestamp !== undefined) {
      // v2 states the committed range in its header — no record read needed.
      return { ...stats, firstTs: layout.firstTimestamp, lastTs: layout.lastTimestamp };
    }
    const decoder = new OhlcvDecoder(layout);
    return {
      ...stats,
      firstTs: readTimestamp(fd, layout, decoder, 0),
      lastTs: readTimestamp(fd, layout, decoder, bars - 1),
    };
  } finally {
    fs.closeSync(fd);
  }
}

/** Timestamp (ms) of one record, read on its own. */
function readTimestamp(
  fd: number,
  layout: OhlcvLayout,
  decoder: OhlcvDecoder,
  index: number
): number {
  const record = Buffer.alloc(layout.recordSize);
  fs.readSync(fd, record, 0, layout.recordSize, recordOffset(layout, index));
  return decoder.timestampAt(
    new DataView(record.buffer, record.byteOffset, record.byteLength),
    0
  );
}
