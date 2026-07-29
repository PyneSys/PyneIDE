/**
 * `.ohlcv` binary format reader shared by the host and the table webview — a TS
 * mirror of pynecore `core/ohlcv.py` (v2) + `core/ohlcv_legacy.py` (v1).
 *
 * v2 files start with a magic (`\x89PYN\r\n\x1a\n`) and a 64-byte header
 * followed by one 24-byte descriptor per column: the schema (roles, dtypes,
 * byte offsets, delta bases) is written into the file, so nothing may be
 * assumed about record size or field order. Timestamps are int64 milliseconds,
 * prices may be f32 deltas relative to another column (`base`), and missing
 * values are NaN. `record_count` in the header is authoritative — bytes past it
 * are an uncommitted tail and must be ignored.
 *
 * Legacy v1 files have no header at all: a flat array of 24-byte records
 * (uint32 seconds + 5x float32, little-endian) where gap-fill records carry a
 * negative volume. Both formats are decoded through the same {@link OhlcvLayout}
 * so callers never branch on the version.
 *
 * Deliberately dependency-free (no `node:fs`, no `vscode`): the webview bundles
 * it as-is.
 */

/** Magic of a v2 file: `\x89 P Y N \r \n \x1a \n` (PNG-style). */
const V2_MAGIC = [0x89, 0x50, 0x59, 0x4e, 0x0d, 0x0a, 0x1a, 0x0a];
/** Fixed part of the v2 header, before the column descriptors. */
export const V2_FIXED_HEADER_BYTES = 64;
/** Bytes per v2 column descriptor. */
const V2_DESCRIPTOR_BYTES = 24;
/** Bytes per legacy v1 record: uint32 timestamp + 5x float32. */
export const V1_RECORD_BYTES = 24;

/** `base` value marking an absolute (non-delta) column. */
const BASE_ABSOLUTE = 255;
/** `role` value marking a provider-specific column identified by its name. */
export const ROLE_CUSTOM = 255;

export const ROLE_TIMESTAMP = 0;
export const ROLE_OPEN = 1;
export const ROLE_HIGH = 2;
export const ROLE_LOW = 3;
export const ROLE_CLOSE = 4;
export const ROLE_VOLUME = 5;

/** Display names of the standard roles (index = role id). */
export const ROLE_NAMES = [
  'timestamp', 'open', 'high', 'low', 'close', 'volume', 'bid', 'ask',
  'bid_size', 'ask_size', 'open_interest', 'vwap', 'trade_count', 'turnover',
];

/** dtype ids a v2 file may declare: 2 = int64, 5 = float32, 6 = float64. */
const V2_DTYPES = new Set([2, 5, 6]);
/** Reader-only dtype for the legacy uint32 timestamp; never appears in a v2 file. */
const DTYPE_U32 = 1;

/** One column of the record schema, as written in the file's descriptor block. */
export interface OhlcvColumn {
  role: number;
  dtype: number;
  /** Role this column is a delta of, or {@link BASE_ABSOLUTE} when absolute. */
  base: number;
  byteOffset: number;
  name: string;
}

/** How to read a given `.ohlcv` file: schema + committed record range. */
export interface OhlcvLayout {
  version: 1 | 2;
  /** Byte offset of the first record. */
  headerSize: number;
  recordSize: number;
  /** Committed records — never derive this from the file size on v2. */
  recordCount: number;
  columns: OhlcvColumn[];
  /** Verified "every gap is a real gap" flag; undefined for v1 (not declared). */
  dense?: boolean;
  /** First/last record timestamps in ms, from the header (v2 only). */
  firstTimestamp?: number;
  lastTimestamp?: number;
  /** Declared TradingView period (v2 only), e.g. `5`, `240`, `1D`. */
  period?: string;
  /** Nominal bar interval in ms (v2 only). */
  intervalMs?: number;
}

/** One decoded record. Roles beyond OHLCV (bid/ask/…) land in `extra`. */
export interface OhlcvBar {
  /** Unix timestamp in MILLISECONDS, for both formats. */
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  extra?: Record<string, number>;
}

/** Thrown when a v2 header is present but the given buffer does not cover it. */
export class OhlcvHeaderTooShortError extends Error {
  constructor(readonly headerSize: number) {
    super(`OHLCV v2 header needs ${headerSize} bytes`);
  }
}

/** True when the buffer starts with the v2 magic. */
export function isV2Magic(bytes: Uint8Array): boolean {
  if (bytes.length < V2_MAGIC.length) return false;
  return V2_MAGIC.every((b, i) => bytes[i] === b);
}

/**
 * Total header size of a v2 file (fixed header + descriptors), or `undefined`
 * for a legacy v1 file — lets a host read the exact header in two `fs.read`s.
 */
export function v2HeaderSize(head: Uint8Array): number | undefined {
  if (!isV2Magic(head) || head.length < V2_FIXED_HEADER_BYTES) return undefined;
  return viewOf(head).getUint32(12, true);
}

/**
 * Parse the file's schema. `head` must cover the whole header of a v2 file
 * (see {@link v2HeaderSize}); for a v1 file only `fileSize` matters.
 */
export function parseOhlcvLayout(head: Uint8Array, fileSize: number): OhlcvLayout {
  if (!isV2Magic(head)) return legacyLayout(fileSize);

  if (head.length < V2_FIXED_HEADER_BYTES) throw new OhlcvHeaderTooShortError(V2_FIXED_HEADER_BYTES);
  const view = viewOf(head);
  const versionMajor = view.getUint16(8, true);
  const headerSize = view.getUint32(12, true);
  const recordSize = view.getUint32(16, true);
  const columnCount = view.getUint16(20, true);
  const flags = view.getUint16(22, true);
  const recordCount = Number(view.getBigUint64(24, true));
  const firstTimestamp = Number(view.getBigInt64(32, true));
  const lastTimestamp = Number(view.getBigInt64(40, true));
  const intervalValue = view.getUint32(48, true);
  const intervalUnit = view.getUint8(52);

  if (versionMajor !== 2) throw new Error(`Unsupported .ohlcv version: ${versionMajor}`);
  if (headerSize !== V2_FIXED_HEADER_BYTES + columnCount * V2_DESCRIPTOR_BYTES) {
    throw new Error('Corrupt .ohlcv header: descriptor count does not match header size');
  }
  if (head.length < headerSize) throw new OhlcvHeaderTooShortError(headerSize);
  if (recordSize === 0 || columnCount === 0) throw new Error('Corrupt .ohlcv header: empty schema');

  const columns: OhlcvColumn[] = [];
  for (let i = 0; i < columnCount; i++) {
    const at = V2_FIXED_HEADER_BYTES + i * V2_DESCRIPTOR_BYTES;
    const role = view.getUint8(at);
    const dtype = view.getUint8(at + 1);
    if (!V2_DTYPES.has(dtype)) throw new Error(`Unsupported .ohlcv dtype: ${dtype}`);
    columns.push({
      role,
      dtype,
      base: view.getUint8(at + 2),
      byteOffset: view.getUint16(at + 4, true),
      name: asciiName(head.subarray(at + 6, at + 24)) || ROLE_NAMES[role] || `col${i}`,
    });
  }

  // Trust record_count, but never read past what the file actually holds.
  const committed = Math.max(0, Math.floor((fileSize - headerSize) / recordSize));
  return {
    version: 2,
    headerSize,
    recordSize,
    recordCount: Math.min(recordCount, committed),
    columns,
    dense: (flags & 0x0001) !== 0,
    firstTimestamp,
    lastTimestamp,
    period: periodFromInterval(intervalValue, intervalUnit),
    intervalMs: intervalMs(intervalValue, intervalUnit),
  };
}

/** Schema of the header-less legacy format (`Ifffff`, timestamps in seconds). */
function legacyLayout(fileSize: number): OhlcvLayout {
  return {
    version: 1,
    headerSize: 0,
    recordSize: V1_RECORD_BYTES,
    recordCount: Math.floor(fileSize / V1_RECORD_BYTES),
    columns: [
      { role: ROLE_TIMESTAMP, dtype: DTYPE_U32, base: BASE_ABSOLUTE, byteOffset: 0, name: 'timestamp' },
      { role: ROLE_OPEN, dtype: 5, base: BASE_ABSOLUTE, byteOffset: 4, name: 'open' },
      { role: ROLE_HIGH, dtype: 5, base: BASE_ABSOLUTE, byteOffset: 8, name: 'high' },
      { role: ROLE_LOW, dtype: 5, base: BASE_ABSOLUTE, byteOffset: 12, name: 'low' },
      { role: ROLE_CLOSE, dtype: 5, base: BASE_ABSOLUTE, byteOffset: 16, name: 'close' },
      { role: ROLE_VOLUME, dtype: 5, base: BASE_ABSOLUTE, byteOffset: 20, name: 'volume' },
    ],
  };
}

/** Byte offset of a record inside the file. */
export function recordOffset(layout: OhlcvLayout, index: number): number {
  return layout.headerSize + index * layout.recordSize;
}

/**
 * A record is a phantom gap-fill: only legacy v1 files have them (they carry a
 * negative volume); v2 simply omits missing bars.
 */
export function isGapFill(layout: OhlcvLayout, bar: OhlcvBar): boolean {
  return layout.version === 1 && bar.volume < 0;
}

/** Reads one column's value, following its delta chain to an absolute base. */
interface ColumnReader {
  role: number;
  name: string;
  /** Offsets to sum, own value first, then each base up the chain. */
  chain: { offset: number; dtype: number }[];
}

/** Precompiled per-file decoder: resolves the delta chains once, not per bar. */
export class OhlcvDecoder {
  private readonly timestamp: ColumnReader;
  private readonly ohlcv: (ColumnReader | undefined)[];
  private readonly extras: ColumnReader[];
  /** Legacy timestamps are seconds; everything else is already milliseconds. */
  private readonly timeScale: number;

  constructor(readonly layout: OhlcvLayout) {
    const byRole = new Map<number, OhlcvColumn>();
    for (const column of layout.columns) {
      if (column.role !== ROLE_CUSTOM) byRole.set(column.role, column);
    }
    const reader = (column: OhlcvColumn): ColumnReader => {
      const chain: { offset: number; dtype: number }[] = [];
      let current: OhlcvColumn | undefined = column;
      const seen = new Set<number>();
      while (current) {
        chain.push({ offset: current.byteOffset, dtype: current.dtype });
        if (current.base === BASE_ABSOLUTE || seen.has(current.base)) break;
        seen.add(current.base);
        current = byRole.get(current.base);
      }
      return { role: column.role, name: column.name, chain };
    };

    const timestampColumn = byRole.get(ROLE_TIMESTAMP);
    if (!timestampColumn) throw new Error('Corrupt .ohlcv header: no timestamp column');
    this.timestamp = reader(timestampColumn);
    this.ohlcv = [ROLE_OPEN, ROLE_HIGH, ROLE_LOW, ROLE_CLOSE, ROLE_VOLUME].map((role) => {
      const column = byRole.get(role);
      return column ? reader(column) : undefined;
    });
    this.extras = layout.columns
      .filter((column) => column.role === ROLE_CUSTOM || column.role > ROLE_VOLUME)
      .map(reader);
    this.timeScale = layout.version === 1 ? 1000 : 1;
  }

  /** Column names of the non-OHLCV roles, in record order (may be empty). */
  get extraNames(): string[] {
    return this.extras.map((column) => column.name);
  }

  /** Timestamp (ms) of the record at `offset`, without decoding the prices. */
  timestampAt(view: DataView, offset: number): number {
    return this.value(view, offset, this.timestamp) * this.timeScale;
  }

  /** Decode the record starting at `offset` (absolute, inside `view`). */
  read(view: DataView, offset: number): OhlcvBar {
    const bar: OhlcvBar = {
      timestamp: this.timestampAt(view, offset),
      open: this.field(view, offset, 0),
      high: this.field(view, offset, 1),
      low: this.field(view, offset, 2),
      close: this.field(view, offset, 3),
      volume: this.field(view, offset, 4),
    };
    if (this.extras.length) {
      const extra: Record<string, number> = {};
      for (const column of this.extras) extra[column.name] = this.value(view, offset, column);
      bar.extra = extra;
    }
    return bar;
  }

  private field(view: DataView, offset: number, index: number): number {
    const column = this.ohlcv[index];
    return column ? this.value(view, offset, column) : NaN;
  }

  /** Sum of the column and its delta bases — NaN in any link poisons the sum. */
  private value(view: DataView, offset: number, column: ColumnReader): number {
    let total = 0;
    for (const link of column.chain) {
      total += readScalar(view, offset + link.offset, link.dtype);
    }
    return total;
  }
}

function readScalar(view: DataView, at: number, dtype: number): number {
  if (dtype === 5) return view.getFloat32(at, true);
  if (dtype === 6) return view.getFloat64(at, true);
  if (dtype === DTYPE_U32) return view.getUint32(at, true);
  return Number(view.getBigInt64(at, true));
}

/** TradingView period string of a v2 interval (mirrors `_period_from_interval`). */
function periodFromInterval(value: number, unit: number): string | undefined {
  switch (unit) {
    case 1: return `${value}S`;
    case 2: return String(value);
    case 3: return String(value * 60);
    case 4: return `${value}D`;
    case 5: return `${value}W`;
    case 6: return `${value}M`;
    default: return undefined;
  }
}

/** Nominal interval in ms; months are not a fixed length, hence undefined. */
function intervalMs(value: number, unit: number): number | undefined {
  const fixed: Record<number, number> = {
    1: 1_000, 2: 60_000, 3: 3_600_000, 4: 86_400_000, 5: 604_800_000,
  };
  const ms = fixed[unit];
  return ms === undefined ? undefined : value * ms;
}

function asciiName(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) {
    if (byte === 0) break;
    out += String.fromCharCode(byte);
  }
  return out;
}

function viewOf(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}
