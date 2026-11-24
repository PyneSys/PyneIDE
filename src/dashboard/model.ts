/**
 * The live dashboard file (`dashboards/<name>.toml` in the workdir): what charts
 * it holds, how they are laid out, and which scripts run on each chart with
 * which inputs. vscode-free, so the parsing and the layout edits are testable
 * on their own.
 *
 * ```toml
 * name = "BTC scalping"
 *
 * [layout]
 * split = "horizontal"
 * sizes = [0.6, 0.4]
 * children = ["btc_1", { split = "vertical", sizes = [0.5, 0.5], children = ["eth_5", "btc_60"] }]
 *
 * [charts.btc_1]
 * provider = "ccxt:BINANCE:BTC/USDT@1"
 * history = "-500"
 *
 * [[charts.btc_1.scripts]]
 * id = "ema_fast"
 * path = "scripts/ema.py"
 * inputs = { length = 9 }
 *
 * [[charts.btc_1.drawings]]
 * tool = "segment"
 * timeframe = "1"
 * color = "#2962FF"
 * width = 1
 * dash = "solid"
 * points = [ [ 2026-11-24T10:00:00.000Z, 97000.5 ], [ 2026-11-24T11:30:00.000Z, 98250 ] ]
 * ```
 *
 * A layout leaf is a chart key; a split lays its children side by side
 * (`horizontal`) or one under the other (`vertical`), `sizes` being their
 * shares of the split (they sum to 1).
 *
 * A chart's `drawings` are the user's own: each point is a bar time and a
 * price, and a Fibonacci retracement also lists its `levels`
 * (`{ value, color, visible }`). The chart drops a drawing once its bars have
 * left the chart's history (see `DrawingTools`).
 */
import { parse, stringify } from 'smol-toml';

import {
  clampDrawingWidth,
  DEFAULT_DRAWING_STYLE,
  type DrawingPoint,
  type DrawingRecord,
  type FibLevel,
  isDrawingColor,
  isDrawingDash,
} from '../chart/drawingRecord';

/** Charts one dashboard may hold. */
export const MAX_CHARTS = 6;
/** Indicator instances one chart may run (one script added twice counts twice). */
export const MAX_INDICATORS = 4;
/** Strategy instances one chart may run: two would mix their trade markers. */
export const MAX_STRATEGIES = 1;
/** History of a new chart: the last 500 bars. */
export const DEFAULT_HISTORY = '-500';
/** The smallest share a layout cell may be dragged down to. */
export const MIN_SIZE = 0.1;

export type SplitDirection = 'horizontal' | 'vertical';

export interface LayoutSplit {
  split: SplitDirection;
  sizes: number[];
  children: LayoutNode[];
}

/** A chart key, or a split of further nodes. */
export type LayoutNode = string | LayoutSplit;

export type ScriptKind = 'indicator' | 'strategy';

export interface DashboardScript {
  /** Unique within its chart: names the output files and the legend group. */
  id: string;
  /** The script, relative to the workdir (`scripts/ema.py`, `scripts/x.pine`). */
  path: string;
  /** Input values by `main()` parameter name, over the script's own `.toml`. */
  inputs?: Record<string, unknown>;
  /** Script settings (decorator arguments), over the script's own `.toml`. */
  settings?: Record<string, unknown>;
  /** A strategy also trades on the history (and carries that position live). */
  tradeOnHistory?: boolean;
}

export interface DashboardChart {
  /** A live provider string with its timeframe (`ccxt:BINANCE:BTC/USDT@1`). */
  provider: string;
  /** History start: a date, days, or `-N` bars. */
  history: string;
  scripts: DashboardScript[];
  /** The user's drawings on the chart. */
  drawings?: DrawingRecord[];
}

export interface Dashboard {
  name?: string;
  layout: LayoutNode | undefined;
  charts: Record<string, DashboardChart>;
}

/** A file that does not describe a dashboard. */
export class DashboardFormatError extends Error {}

/** A chart key / script id: a TOML bare key and a file name at once. */
const KEY_RE = /^[A-Za-z0-9_-]+$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, where: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new DashboardFormatError(`${where} must be a non-empty string`);
  }
  return value;
}

function optionalTable(value: unknown, where: string): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new DashboardFormatError(`${where} must be a table`);
  return value;
}

function parseScript(raw: unknown, where: string): DashboardScript {
  if (!isRecord(raw)) throw new DashboardFormatError(`${where} must be a table`);
  const id = requireString(raw.id, `${where}.id`);
  if (!KEY_RE.test(id)) {
    throw new DashboardFormatError(`${where}.id may hold letters, digits, _ and - only: ${id}`);
  }
  const script: DashboardScript = { id, path: requireString(raw.path, `${where}.path`) };
  const inputs = optionalTable(raw.inputs, `${where}.inputs`);
  if (inputs) script.inputs = inputs;
  const settings = optionalTable(raw.settings, `${where}.settings`);
  if (settings) script.settings = settings;
  if (raw.trade_on_history !== undefined) {
    if (typeof raw.trade_on_history !== 'boolean') {
      throw new DashboardFormatError(`${where}.trade_on_history must be true or false`);
    }
    script.tradeOnHistory = raw.trade_on_history;
  }
  return script;
}

function parsePoint(raw: unknown, where: string): DrawingPoint {
  if (!Array.isArray(raw) || raw.length !== 2 || !(raw[0] instanceof Date) ||
    typeof raw[1] !== 'number' || !Number.isFinite(raw[0].getTime()) || !Number.isFinite(raw[1])) {
    throw new DashboardFormatError(`${where} must be [time, price], the time a date-time`);
  }
  return { timestamp: raw[0].getTime(), value: raw[1] };
}

function parseLevel(raw: unknown, where: string): FibLevel {
  if (!isRecord(raw)) throw new DashboardFormatError(`${where} must be a table`);
  if (typeof raw.value !== 'number' || !Number.isFinite(raw.value)) {
    throw new DashboardFormatError(`${where}.value must be a number`);
  }
  if (!isDrawingColor(raw.color)) throw new DashboardFormatError(`${where}.color must be #RRGGBB`);
  if (raw.visible !== undefined && typeof raw.visible !== 'boolean') {
    throw new DashboardFormatError(`${where}.visible must be true or false`);
  }
  return { value: raw.value, color: raw.color, visible: raw.visible ?? true };
}

function parseDrawing(raw: unknown, where: string): DrawingRecord {
  if (!isRecord(raw)) throw new DashboardFormatError(`${where} must be a table`);
  const tool = requireString(raw.tool, `${where}.tool`);
  if (!Array.isArray(raw.points) || raw.points.length === 0) {
    throw new DashboardFormatError(`${where}.points must be a non-empty array`);
  }
  const points = raw.points.map((p, i) => parsePoint(p, `${where}.points[${i}]`));
  const style = { ...DEFAULT_DRAWING_STYLE };
  if (raw.color !== undefined) {
    if (!isDrawingColor(raw.color)) throw new DashboardFormatError(`${where}.color must be #RRGGBB`);
    style.color = raw.color;
  }
  if (raw.width !== undefined) {
    if (typeof raw.width !== 'number' || !Number.isFinite(raw.width)) {
      throw new DashboardFormatError(`${where}.width must be a number`);
    }
    style.width = clampDrawingWidth(raw.width);
  }
  if (raw.dash !== undefined) {
    if (!isDrawingDash(raw.dash)) {
      throw new DashboardFormatError(`${where}.dash must be "solid", "dashed" or "dotted"`);
    }
    style.dash = raw.dash;
  }
  const drawing: DrawingRecord = { tool, points, style };
  if (raw.timeframe !== undefined) drawing.timeframe = requireString(raw.timeframe, `${where}.timeframe`);
  if (raw.levels !== undefined) {
    if (!Array.isArray(raw.levels)) throw new DashboardFormatError(`${where}.levels must be an array`);
    drawing.levels = raw.levels.map((l, i) => parseLevel(l, `${where}.levels[${i}]`));
  }
  return drawing;
}

function parseChart(raw: unknown, key: string): DashboardChart {
  const where = `charts.${key}`;
  if (!isRecord(raw)) throw new DashboardFormatError(`${where} must be a table`);
  const history = raw.history === undefined ? DEFAULT_HISTORY :
    typeof raw.history === 'number' ? String(raw.history) : requireString(raw.history, `${where}.history`);
  const scriptsRaw = raw.scripts ?? [];
  if (!Array.isArray(scriptsRaw)) throw new DashboardFormatError(`${where}.scripts must be an array`);
  const scripts = scriptsRaw.map((s, i) => parseScript(s, `${where}.scripts[${i}]`));
  const ids = new Set<string>();
  for (const s of scripts) {
    if (ids.has(s.id)) throw new DashboardFormatError(`${where}: script id ${s.id} is used twice`);
    ids.add(s.id);
  }
  const chart: DashboardChart = { provider: requireString(raw.provider, `${where}.provider`), history, scripts };
  if (raw.drawings !== undefined) {
    if (!Array.isArray(raw.drawings)) throw new DashboardFormatError(`${where}.drawings must be an array`);
    const drawings = raw.drawings.map((d, i) => parseDrawing(d, `${where}.drawings[${i}]`));
    if (drawings.length) chart.drawings = drawings;
  }
  return chart;
}

function parseLayout(raw: unknown, where: string): LayoutNode {
  if (typeof raw === 'string') return raw;
  if (!isRecord(raw)) throw new DashboardFormatError(`${where} must be a chart key or a split`);
  if (raw.split !== 'horizontal' && raw.split !== 'vertical') {
    throw new DashboardFormatError(`${where}.split must be "horizontal" or "vertical"`);
  }
  if (!Array.isArray(raw.children) || raw.children.length === 0) {
    throw new DashboardFormatError(`${where}.children must be a non-empty array`);
  }
  const children = raw.children.map((c, i) => parseLayout(c, `${where}.children[${i}]`));
  const sizes = Array.isArray(raw.sizes) && raw.sizes.length === children.length &&
    raw.sizes.every((v) => typeof v === 'number' && Number.isFinite(v) && v > 0)
    ? normalizeSizes(raw.sizes as number[])
    : children.map(() => 1 / children.length);
  return { split: raw.split, sizes, children };
}

/** Parse a dashboard file. A layout that misses charts or names unknown ones
 * is repaired (see {@link normalizeLayout}), anything else malformed throws. */
export function parseDashboard(text: string): Dashboard {
  let raw: Record<string, unknown>;
  try {
    raw = parse(text) as Record<string, unknown>;
  } catch (err) {
    throw new DashboardFormatError(err instanceof Error ? err.message : String(err));
  }
  const chartsRaw = raw.charts ?? {};
  if (!isRecord(chartsRaw)) throw new DashboardFormatError('charts must be a table');
  const charts: Record<string, DashboardChart> = {};
  for (const [key, value] of Object.entries(chartsRaw)) {
    if (!KEY_RE.test(key)) {
      throw new DashboardFormatError(`chart key may hold letters, digits, _ and - only: ${key}`);
    }
    charts[key] = parseChart(value, key);
  }
  const name = raw.name === undefined ? undefined : requireString(raw.name, 'name');
  const layout = raw.layout === undefined ? undefined : parseLayout(raw.layout, 'layout');
  return { name, layout: normalizeLayout(layout, Object.keys(charts)), charts };
}

function roundSize(v: number): number {
  return Math.round(v * 1000) / 1000;
}

function layoutToToml(node: LayoutNode): unknown {
  if (typeof node === 'string') return node;
  return { split: node.split, sizes: node.sizes.map(roundSize), children: node.children.map(layoutToToml) };
}

function scriptToToml(s: DashboardScript): Record<string, unknown> {
  const out: Record<string, unknown> = { id: s.id, path: s.path };
  if (s.tradeOnHistory !== undefined) out.trade_on_history = s.tradeOnHistory;
  if (s.inputs && Object.keys(s.inputs).length) out.inputs = s.inputs;
  if (s.settings && Object.keys(s.settings).length) out.settings = s.settings;
  return out;
}

function drawingToToml(d: DrawingRecord): Record<string, unknown> {
  const out: Record<string, unknown> = { tool: d.tool };
  if (d.timeframe !== undefined) out.timeframe = d.timeframe;
  out.color = d.style.color;
  out.width = d.style.width;
  out.dash = d.style.dash;
  // A point without a bar time has no place outside the chart that drew it
  out.points = d.points
    .filter((p) => p.timestamp !== undefined && p.value !== undefined)
    .map((p) => [new Date(p.timestamp as number), p.value]);
  if (d.levels) out.levels = d.levels.map((l) => ({ value: l.value, color: l.color, visible: l.visible }));
  return out;
}

/** Serialize a dashboard into its file. */
export function serializeDashboard(d: Dashboard): string {
  const out: Record<string, unknown> = {};
  if (d.name !== undefined) out.name = d.name;
  if (d.layout !== undefined) {
    // A lone chart is still a table, so the file keeps one shape
    out.layout = layoutToToml(typeof d.layout === 'string'
      ? { split: 'horizontal', sizes: [1], children: [d.layout] } : d.layout);
  }
  const charts: Record<string, unknown> = {};
  for (const [key, chart] of Object.entries(d.charts)) {
    const c: Record<string, unknown> = { provider: chart.provider, history: chart.history };
    if (chart.scripts.length) c.scripts = chart.scripts.map(scriptToToml);
    const drawings = (chart.drawings ?? []).map(drawingToToml)
      .filter((d) => (d.points as unknown[]).length > 0);
    if (drawings.length) c.drawings = drawings;
    charts[key] = c;
  }
  if (Object.keys(charts).length) out.charts = charts;
  return stringify(out) + '\n';
}

/** The chart keys of a layout, in reading order. */
export function layoutKeys(node: LayoutNode | undefined): string[] {
  if (node === undefined) return [];
  if (typeof node === 'string') return [node];
  return node.children.flatMap(layoutKeys);
}

/** Shares summing to 1. */
export function normalizeSizes(sizes: number[]): number[] {
  const total = sizes.reduce((a, b) => a + b, 0);
  return total > 0 ? sizes.map((s) => s / total) : sizes.map(() => 1 / sizes.length);
}

function prune(node: LayoutNode, keep: (key: string) => boolean): LayoutNode | undefined {
  if (typeof node === 'string') return keep(node) ? node : undefined;
  const children: LayoutNode[] = [];
  const sizes: number[] = [];
  node.children.forEach((child, i) => {
    const pruned = prune(child, keep);
    if (pruned === undefined) return;
    // A split inside a split of the same direction is one split
    if (typeof pruned !== 'string' && pruned.split === node.split) {
      pruned.children.forEach((c, j) => {
        children.push(c);
        sizes.push(node.sizes[i] * pruned.sizes[j]);
      });
      return;
    }
    children.push(pruned);
    sizes.push(node.sizes[i]);
  });
  if (children.length === 0) return undefined;
  if (children.length === 1) return children[0];
  return { split: node.split, sizes: normalizeSizes(sizes), children };
}

/**
 * The layout of exactly `keys`: leaves of unknown or repeated charts go, and a
 * chart the layout does not place is added at the right edge.
 */
export function normalizeLayout(node: LayoutNode | undefined, keys: string[]): LayoutNode | undefined {
  const known = new Set(keys);
  const seen = new Set<string>();
  let layout = node === undefined ? undefined : prune(structuredClone(node), (key) => {
    if (!known.has(key) || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  for (const key of keys) {
    if (seen.has(key)) continue;
    layout = layout === undefined ? key : insertBeside(layout, undefined, key, 'horizontal');
  }
  return layout;
}

/**
 * Put `key` beside `target` (`horizontal`: to its right, `vertical`: below it),
 * halving the target's cell; without a target, beside the whole layout.
 */
export function insertBeside(
  layout: LayoutNode | undefined,
  target: string | undefined,
  key: string,
  direction: SplitDirection
): LayoutNode {
  if (layout === undefined) return key;
  if (target === undefined) {
    if (typeof layout !== 'string' && layout.split === direction) {
      const n = layout.children.length + 1;
      return {
        split: direction,
        sizes: normalizeSizes([...layout.sizes.map((s) => s * (n - 1)), 1]),
        children: [...layout.children, key],
      };
    }
    return { split: direction, sizes: [0.5, 0.5], children: [layout, key] };
  }
  const visit = (node: LayoutNode): LayoutNode => {
    if (typeof node === 'string') {
      return node === target ? { split: direction, sizes: [0.5, 0.5], children: [node, key] } : node;
    }
    const at = node.children.indexOf(target);
    if (at >= 0 && node.split === direction) {
      const half = node.sizes[at] / 2;
      const sizes = [...node.sizes];
      sizes.splice(at, 1, half, half);
      const children = [...node.children];
      children.splice(at + 1, 0, key);
      return { split: node.split, sizes, children };
    }
    return { ...node, children: node.children.map(visit) };
  };
  return visit(layout);
}

/** The layout without `key`; its cell's space goes to its neighbours. */
export function removeFromLayout(layout: LayoutNode | undefined, key: string): LayoutNode | undefined {
  return layout === undefined ? undefined : prune(structuredClone(layout), (k) => k !== key);
}

/**
 * Set the shares of the split at `path` (child indexes from the root). Shares
 * below {@link MIN_SIZE} are raised to it.
 */
export function resizeSplit(layout: LayoutNode | undefined, path: number[], sizes: number[]): LayoutNode | undefined {
  if (layout === undefined) return undefined;
  const visit = (node: LayoutNode, depth: number): LayoutNode => {
    if (typeof node === 'string') return node;
    if (depth === path.length) {
      if (sizes.length !== node.children.length || sizes.some((s) => !Number.isFinite(s) || s <= 0)) {
        return node;
      }
      return { ...node, sizes: normalizeSizes(normalizeSizes(sizes).map((s) => Math.max(s, MIN_SIZE))) };
    }
    const at = path[depth];
    if (at < 0 || at >= node.children.length) return node;
    const children = [...node.children];
    children[at] = visit(children[at], depth + 1);
    return { ...node, children };
  };
  return visit(layout, 0);
}

/** A key not yet in `taken`, from `base` (made key-safe), suffixed `-2`, `-3`, ... */
export function uniqueKey(base: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  const safe = base.toLowerCase().replace(/[^a-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'chart';
  if (!used.has(safe)) return safe;
  for (let n = 2; ; n++) {
    const candidate = `${safe}-${n}`;
    if (!used.has(candidate)) return candidate;
  }
}

/** A chart key for a provider string: `ccxt:BINANCE:BTC/USDT@1` -> `btc_usdt_1`. */
export function chartKeyFor(provider: string, taken: Iterable<string>): string {
  const at = provider.lastIndexOf('@');
  const symbol = at >= 0 ? provider.slice(0, at) : provider;
  const tf = at >= 0 ? provider.slice(at + 1) : '';
  const parts = symbol.split(':');
  // provider:EXCHANGE:SYMBOL -> SYMBOL (a perpetual's settle suffix stays)
  const name = parts.length > 2 ? parts.slice(2).join(':') : parts[parts.length - 1];
  return uniqueKey(tf ? `${name}_${tf}` : name, taken);
}

/** A script id for a script path: `scripts/ema.py` -> `ema`, then `ema-2`, ... */
export function scriptIdFor(scriptPath: string, taken: Iterable<string>): string {
  const file = scriptPath.split(/[\\/]/).pop() ?? scriptPath;
  return uniqueKey(file.replace(/\.[^.]+$/, ''), taken);
}

/** Why another script of this kind cannot join the chart, or undefined when it can. */
export function scriptLimitReason(kinds: ScriptKind[], adding: ScriptKind): string | undefined {
  const count = kinds.filter((k) => k === adding).length;
  if (adding === 'strategy' && count >= MAX_STRATEGIES) {
    return `A chart runs at most ${MAX_STRATEGIES} strategy.`;
  }
  if (adding === 'indicator' && count >= MAX_INDICATORS) {
    return `A chart runs at most ${MAX_INDICATORS} indicators.`;
  }
  return undefined;
}

/** A new, empty dashboard. */
export function emptyDashboard(name: string): Dashboard {
  return { name, layout: undefined, charts: {} };
}
