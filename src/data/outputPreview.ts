/**
 * Rebuild a finished chart from pynecore's paired output files:
 *
 * - `<stem>.csv` contains OHLCV + plot values;
 * - `<stem>_viz.ndjson` contains the native visual header, plot metadata,
 *   dynamic color deltas, strategy equity and final drawing snapshot.
 *
 * The files are deliberately joined best-effort. Unknown visual records,
 * colors for timestamps absent from the CSV and metadata without a matching
 * plot column are harmless; the webview already drops/falls back for them.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import type {
  BarRow,
  BridgeEvent,
  ColorDeltaRow,
  ColorEnc,
  DrawingFamily,
  DrawingEventRecord,
  PlotMetaRecord,
  StartEvent,
} from '../run/bridgeClient';

interface NativeRecord {
  t?: string;
  data?: string;
  initialCapital?: number | null;
  id?: string | number;
  kind?: string;
  time?: number;
  equity?: number | null;
  c?: Record<string, ColorEnc>;
  script?: Record<string, unknown>;
  syminfo?: Record<string, unknown>;
  lines?: Array<Record<string, unknown>>;
  labels?: Array<Record<string, unknown>>;
  boxes?: Array<Record<string, unknown>>;
  tables?: Array<Record<string, unknown>>;
  polylines?: Array<Record<string, unknown>>;
  linefills?: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

export interface OutputPair {
  plot: string;
  viz: string;
}

export interface OutputPreview {
  events: BridgeEvent[];
  warnings: string[];
}

/** Resolve the persisted output pair belonging to a script. Runner output is
 * keyed by the runnable script's stem, which is shared by a Pine source and
 * its compiled Python sibling. */
export function resolveScriptOutputPair(
  workdir: string,
  scriptPath: string
): OutputPair | undefined {
  const plot = path.join(workdir, 'output', `${path.parse(scriptPath).name}.csv`);
  return resolveOutputPair(plot);
}

/** Resolve either member of a plot/viz pair; undefined means it is an ordinary
 * output file and should continue to open as text. */
export function resolveOutputPair(filePath: string): OutputPair | undefined {
  let plot: string;
  let viz: string;
  if (/_viz\.ndjson$/i.test(filePath)) {
    viz = filePath;
    plot = filePath.replace(/_viz\.ndjson$/i, '.csv');
  } else if (/\.csv$/i.test(filePath)) {
    plot = filePath;
    viz = filePath.replace(/\.csv$/i, '_viz.ndjson');
  } else {
    return undefined;
  }
  return fs.existsSync(plot) && fs.existsSync(viz) ? { plot, viz } : undefined;
}

/** RFC-4180-style CSV reader sufficient for pynecore's LF writer, including
 * quoted commas/quotes and CRLF. Embedded newlines are accepted as well. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"' && field.length === 0) quoted = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      if (field.endsWith('\r')) field = field.slice(0, -1);
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += ch;
    }
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function numberOrNull(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === '') return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function parseTime(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const numeric = Number(raw);
  if (Number.isFinite(numeric)) return numeric < 1e12 ? numeric * 1000 : numeric;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function primitiveRecord(value: Record<string, unknown> | undefined): StartEvent['syminfo'] {
  const result: StartEvent['syminfo'] = {};
  if (!value) return result;
  for (const [key, item] of Object.entries(value)) {
    if (item === null || ['string', 'number', 'boolean'].includes(typeof item)) {
      result[key] = item as string | number | boolean | null;
    }
  }
  return result;
}

function drawingEvents(record: NativeRecord | undefined): DrawingEventRecord[] {
  if (!record) return [];
  const groups: Array<[DrawingFamily, Array<Record<string, unknown>> | undefined]> = [
    ['line', record.lines],
    ['label', record.labels],
    ['box', record.boxes],
    ['table', record.tables],
    ['polyline', record.polylines],
    ['linefill', record.linefills],
  ];
  const events: DrawingEventRecord[] = [];
  for (const [obj, states] of groups) {
    for (const state of states ?? []) {
      if (typeof state.id !== 'number') continue;
      events.push({ i: 0, op: 'create', obj, id: state.id, s: state });
    }
  }
  return events;
}

export function buildOutputPreview(pair: OutputPair, dataPath?: string): OutputPreview {
  const warnings: string[] = [];
  const records: NativeRecord[] = [];
  const lines = fs.readFileSync(pair.viz, 'utf8').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    try {
      records.push(JSON.parse(lines[i]) as NativeRecord);
    } catch {
      warnings.push(`ignored malformed visualization record at line ${i + 1}`);
    }
  }

  const csv = parseCsv(fs.readFileSync(pair.plot, 'utf8'));
  const header = csv.shift();
  if (!header || header.length < 6) throw new Error('plot CSV has no valid OHLCV header');
  const plotKeys = header.slice(6);
  const bars: BarRow[] = [];
  for (const row of csv) {
    const time = parseTime(row[0]);
    if (time === undefined) {
      if (row.some((field) => field.trim())) warnings.push('ignored plot row with invalid time');
      continue;
    }
    bars.push([
      time,
      numberOrNull(row[1]),
      numberOrNull(row[2]),
      numberOrNull(row[3]),
      numberOrNull(row[4]),
      numberOrNull(row[5]),
      plotKeys.length ? plotKeys.map((_, i) => numberOrNull(row[i + 6])) : null,
    ]);
  }
  if (!bars.length) throw new Error('plot CSV contains no chartable rows');

  const hdr = records.find((record) => record.t === 'hdr');
  const metas = new Map<string, PlotMetaRecord>();
  const colors: ColorDeltaRow[] = [];
  const equityByTime = new Map<number, number>();
  let drawings: NativeRecord | undefined;
  let complete = false;
  for (const record of records) {
    if (record.t === 'meta' && typeof record.id === 'string' && typeof record.kind === 'string') {
      const { t: _t, ...meta } = record;
      metas.set(record.id, meta as PlotMetaRecord);
    } else if (record.t === 'bar' && typeof record.time === 'number') {
      if (record.c) colors.push([record.time, record.c]);
      if (typeof record.equity === 'number' && Number.isFinite(record.equity)) {
        equityByTime.set(record.time, record.equity);
      }
    } else if (record.t === 'drawings') {
      drawings = record;
    } else if (record.t === 'end') {
      complete = true;
    }
  }
  for (const bar of bars) {
    const equity = equityByTime.get(bar[0]);
    if (equity !== undefined) bar[7] = equity;
  }

  const script = hdr?.script ?? {};
  const syminfo = primitiveRecord(hdr?.syminfo);
  if (syminfo.period === undefined && typeof syminfo.timeframe === 'string') {
    syminfo.period = syminfo.timeframe;
  }
  const from = Math.floor(bars[0][0] / 1000);
  const to = Math.floor(bars[bars.length - 1][0] / 1000);
  const start: StartEvent = {
    e: 'start',
    script: pair.plot,
    scriptType: script.type === 'strategy' ? 'strategy' : 'indicator',
    overlay: script.overlay === true,
    initialCapital:
      typeof hdr?.initialCapital === 'number' && Number.isFinite(hdr.initialCapital)
        ? hdr.initialCapital
        : undefined,
    syminfo,
    // New bridge output persists the exact OHLCV path in the viz header. For
    // older files, script-owned callers supply the IDE's persisted data
    // binding; generic orphan previews retain the plot path as a fallback.
    data: (typeof hdr?.data === 'string' && hdr.data) || dataPath || pair.plot,
    range: { from, to, bars: bars.length },
    outputs: {
      plot: pair.plot,
      strat: null,
      trades: null,
      viz: pair.viz,
    },
  };

  const events: BridgeEvent[] = [start];
  if (metas.size) events.push({ e: 'plotMeta', metas: [...metas.values()] });
  if (plotKeys.length) events.push({ e: 'plotKeys', keys: plotKeys });
  events.push({ e: 'bars', d: bars });
  if (colors.length) events.push({ e: 'colors', d: colors });
  const drawingList = drawingEvents(drawings);
  if (drawingList.length) events.push({ e: 'drawings', d: drawingList });
  events.push({ e: 'end', bars: bars.length, cancelled: !complete });
  return { events, warnings };
}
