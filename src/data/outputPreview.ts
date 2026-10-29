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
  EquityExcursions,
  PlotMetaRecord,
  StartEvent,
  TradeRecord,
} from '../run/bridgeClient';

interface NativeRecord {
  t?: string;
  data?: string;
  initialCapital?: number | null;
  id?: string | number;
  kind?: string;
  time?: number;
  equity?: number | null;
  excursions?: unknown;
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
  trades?: string;
  strat?: string;
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
  if (!fs.existsSync(plot) || !fs.existsSync(viz)) return undefined;
  const stem = plot.replace(/\.csv$/i, '');
  const trades = `${stem}_trade.csv`;
  const strat = `${stem}_strat.csv`;
  return {
    plot,
    viz,
    trades: fs.existsSync(trades) ? trades : undefined,
    strat: fs.existsSync(strat) ? strat : undefined,
  };
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

/** Older native outputs keep trades only in the two-leg CSV. Fields absent
 * from that format (comments and commission) remain unknown. */
function readTradeCsv(file: string, warnings: string[]): { closed: TradeRecord[]; open: TradeRecord[] } {
  const rows = parseCsv(fs.readFileSync(file, 'utf8'));
  const header = rows.shift();
  const closed: TradeRecord[] = [];
  const open: TradeRecord[] = [];
  if (header?.[0] !== 'Trade #' || header[2] !== 'Type' || header[4] !== 'Date/Time') {
    warnings.push('trade CSV has no valid trade header');
    return { closed, open };
  }
  const entries = new Map<string, string[]>();
  for (const row of rows) {
    if (/^Entry (long|short)$/.test(row[2])) {
      entries.set(row[0], row);
      continue;
    }
    if (!/^Exit (long|short)$/.test(row[2])) continue;
    const entry = entries.get(row[0]);
    const entryTime = parseTime(entry?.[4]);
    const exitTime = parseTime(row[4]);
    const entryBar = numberOrNull(entry?.[1]);
    const exitBar = numberOrNull(row[1]);
    if (!entry || entryTime === undefined || exitTime === undefined ||
        entryBar === null || exitBar === null) {
      warnings.push(`ignored trade ${row[0]} with missing or invalid entry/exit`);
      continue;
    }
    entries.delete(row[0]);
    const isOpen = row[3] === 'Open';
    const contracts = numberOrNull(entry[6]);
    const trade: TradeRecord = {
      entryId: entry[3], entryBar, entryTime, entryPrice: numberOrNull(entry[5]),
      entryComment: null, exitId: isOpen ? null : row[3], exitBar, exitTime,
      exitPrice: numberOrNull(row[5]), exitComment: null,
      size: contracts === null ? null : Math.abs(contracts) * (entry[2] === 'Entry short' ? -1 : 1),
      commission: null, profit: numberOrNull(row[7]), profitPct: numberOrNull(row[8]),
      cumProfit: numberOrNull(row[9]), cumProfitPct: numberOrNull(row[10]),
    };
    (isOpen ? open : closed).push(trade);
  }
  return { closed, open };
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
  const excursionsByTime = new Map<number, EquityExcursions>();
  let drawings: NativeRecord | undefined;
  let complete = false;
  let savedTrades: { closed: TradeRecord[]; open: TradeRecord[] } | undefined;
  for (const record of records) {
    if (record.t === 'meta' && typeof record.id === 'string' && typeof record.kind === 'string') {
      const { t: _t, ...meta } = record;
      metas.set(record.id, meta as PlotMetaRecord);
    } else if (record.t === 'bar' && typeof record.time === 'number') {
      if (record.c) colors.push([record.time, record.c]);
      if (typeof record.equity === 'number' && Number.isFinite(record.equity)) {
        equityByTime.set(record.time, record.equity);
      }
      if (Array.isArray(record.excursions) && record.excursions.length === 4) {
        excursionsByTime.set(
          record.time,
          record.excursions.map((v) =>
            typeof v === 'number' && Number.isFinite(v) ? v : null
          ) as EquityExcursions
        );
      }
    } else if (record.t === 'drawings') {
      drawings = record;
    } else if (record.t === 'end') {
      complete = true;
      if (Array.isArray(record.trades) && Array.isArray(record.openTrades)) {
        savedTrades = { closed: record.trades as TradeRecord[], open: record.openTrades as TradeRecord[] };
      }
    }
  }
  for (const bar of bars) {
    const equity = equityByTime.get(bar[0]);
    if (equity !== undefined) bar[7] = equity;
    const excursions = excursionsByTime.get(bar[0]);
    if (excursions !== undefined) bar[8] = excursions;
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
    scriptTitle: typeof script.title === 'string' ? script.title : undefined,
    scriptShortTitle: typeof script.shorttitle === 'string' ? script.shorttitle : undefined,
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
      strat: pair.strat ?? null,
      trades: pair.trades ?? null,
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
  if (start.scriptType === 'strategy') {
    const trades = savedTrades ?? (pair.trades ? readTradeCsv(pair.trades, warnings) : undefined);
    if (trades?.closed.length) events.push({ e: 'trades', d: trades.closed });
    if (trades?.open.length) events.push({ e: 'openTrades', d: trades.open });
  }
  events.push({ e: 'end', bars: bars.length, cancelled: !complete });
  return { events, warnings };
}
