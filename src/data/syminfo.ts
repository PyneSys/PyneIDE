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
  const out: Record<string, string> = {};
  let inSymbol = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('[')) {
      inSymbol = line === '[symbol]';
      continue;
    }
    if (!inSymbol) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    // Strip an inline comment outside of quotes.
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
    if (key) out[key] = value;
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
