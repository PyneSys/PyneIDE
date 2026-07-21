/**
 * Host-side `.ohlcv` reader for the Data-tree "Preview chart" action: decodes
 * the flat 24-byte records (see syminfo.ts) into the chart's `BarRow` rows and
 * builds a bars-only `StartEvent`, so the ChartPanel can replay a raw-candle
 * snapshot without running the bridge. The binary is read in record-aligned
 * chunks (files can be 1M+ records), never as one giant buffer/string.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import type { BarRow, StartEvent } from '../run/bridgeClient';
import { OHLCV_RECORD_BYTES, parseSymbolSection } from './syminfo';

/** Records decoded per read; 64k records = ~1.5 MB per chunk. */
const CHUNK_RECORDS = 65536;

/**
 * Decode every non-gap-fill record of an `.ohlcv` file into chart bar rows
 * (timestamp in ms, OHLCV, no plots). Gap-fill records (volume < 0) are
 * dropped, matching what a run/chart sees.
 */
export function readOhlcvBars(filePath: string): BarRow[] {
  const fd = fs.openSync(filePath, 'r');
  try {
    const total = Math.floor(fs.fstatSync(fd).size / OHLCV_RECORD_BYTES);
    const bars: BarRow[] = [];
    const buf = Buffer.alloc(CHUNK_RECORDS * OHLCV_RECORD_BYTES);
    for (let read = 0; read < total; ) {
      const n = Math.min(CHUNK_RECORDS, total - read);
      fs.readSync(fd, buf, 0, n * OHLCV_RECORD_BYTES, read * OHLCV_RECORD_BYTES);
      for (let i = 0; i < n; i++) {
        const o = i * OHLCV_RECORD_BYTES;
        const volume = buf.readFloatLE(o + 20);
        if (volume < 0) continue;
        bars.push([
          buf.readUInt32LE(o) * 1000,
          buf.readFloatLE(o + 4),
          buf.readFloatLE(o + 8),
          buf.readFloatLE(o + 12),
          buf.readFloatLE(o + 16),
          volume,
          null,
        ]);
      }
      read += n;
    }
    return bars;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Build the bars-only preview snapshot for an `.ohlcv` file: its sibling
 * `.toml` syminfo (numeric fields coerced) plus the decoded candles. The
 * `StartEvent` carries no plots/outputs — every other snapshot section is
 * length-guarded in the webview, so a bars-only replay is safe.
 */
export function buildOhlcvPreview(filePath: string): { start: StartEvent; bars: BarRow[] } {
  let sym: Record<string, string> = {};
  try {
    sym = parseSymbolSection(fs.readFileSync(filePath.replace(/\.ohlcv$/i, '.toml'), 'utf8'));
  } catch {
    // No sibling toml — fall back to the file stem for the symbol.
  }

  const syminfo: Record<string, string | number | boolean | null> = { ...sym };
  for (const key of ['mintick', 'pricescale']) {
    const v = Number(sym[key]);
    if (Number.isFinite(v)) syminfo[key] = v;
  }
  const ticker = sym.ticker || path.basename(filePath).replace(/\.ohlcv$/i, '');
  syminfo.ticker = ticker;
  syminfo.tickerid = sym.tickerid || ticker;

  const bars = readOhlcvBars(filePath);
  const from = bars.length ? Math.floor(bars[0][0] / 1000) : 0;
  const to = bars.length ? Math.floor(bars[bars.length - 1][0] / 1000) : 0;
  const start: StartEvent = {
    e: 'start',
    script: path.basename(filePath),
    scriptType: 'indicator',
    overlay: true,
    dataOnly: true,
    syminfo,
    data: filePath,
    range: { from, to, bars: bars.length },
    outputs: { plot: '', strat: null, trades: null },
  };
  return { start, bars };
}
