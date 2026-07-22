/**
 * Chart webview: KLineChart v10 fed from the runner bridge event stream.
 *
 * Data flow: bar rows accumulate in `allBars`; a throttled tick calls
 * `chart.resetData()`, whose data loader serves the full array (v10 has no
 * push API — the loader model IS the API). Plots are grouped into two
 * dynamic indicators (candle pane vs a separate pane); each plot renders
 * with its pynecore PlotMeta (color/linewidth/style/force_overlay, per-bar
 * dynamic colors via ColorTrack — see plotStyles.ts), falling back to the
 * legacy palette-by-index lines when no meta arrives (pynecore < 6.6).
 * Strategy equity gets its own pane; closed trades become annotation
 * overlays at run end.
 */
import {
  init,
  dispose,
  registerIndicator,
  utils,
  type Chart,
  type KLineData,
  type DeepPartial,
  type Period,
  type Styles,
  type VisibleRange,
} from 'klinecharts';

import type { BarRow, PlotMetaRecord, StartEvent, TradeRecord } from '../../run/bridgeClient';
import type { ChartInMessage, ChartOutMessage } from '../messages';
import { ColorTrack } from './colorTrack';
import {
  DrawingStore,
  drawDrawings,
  makeXResolver,
  sizePx,
  type TableCellState,
  type TableState,
} from './drawings';
import {
  buildFigure,
  buildHlineFigure,
  drawAreas,
  drawArrows,
  drawBackgrounds,
  drawBarcolors,
  drawFills,
  drawMarkers,
  drawPlotCandles,
  drawSteplines,
  drawTrackprices,
  paneFor,
  panePrecision,
  type ArrowItem,
  type CandleItem,
  type FillItem,
  type FillSource,
  type MarkerDrawEnv,
  type MarkerItem,
  type PaneTarget,
  type PlotDatum,
  type PlotDrawItem,
  type PlotFigureSpec,
} from './plotStyles';

declare function acquireVsCodeApi(): { postMessage(msg: ChartOutMessage): void };

const vscode = acquireVsCodeApi();

const UI_TICK_MS = 400;
const MAX_TRADE_ANNOTATIONS = 2000;

const PLOT_COLORS = [
  '#2962ff',
  '#ff6d00',
  '#d500f9',
  '#00bfa5',
  '#ffd600',
  '#f50057',
  '#00b8d4',
  '#76ff03',
];

interface PyneBar extends KLineData {
  plots: (number | null)[];
  equity?: number | null;
}

interface RunState {
  chart: Chart;
  start: StartEvent;
  bars: PyneBar[];
  plotKeys: string[];
  /** Plot style metadata by plot id (== plot key for kind 'plot'); upserted —
   * a repeated id is an update (a plot turning dynamic re-emits its meta). */
  plotMeta: Map<string, PlotMetaRecord>;
  /** Per-bar dynamic color reconstruction from the sparse `colors` deltas. */
  colorTrack: ColorTrack;
  /** Bar timestamp (ms) -> bar index, for joining color deltas to bars. */
  tsToIndex: Map<number, number>;
  /** Live drawing objects (line/label/box/table/polyline/linefill). */
  drawings: DrawingStore;
  /** store.tableVersion last rendered into the HTML table layer. */
  renderedTableVersion: number;
  trades: TradeRecord[];
  stats: Record<string, number | null> | undefined;
  dirty: boolean;
  /** A meta arrived/changed: plot indicators need a rebuild on the next tick. */
  metaDirty: boolean;
  ended: boolean;
  /** plot index -> pane target, kept in sync with the metas */
  plotPane: Map<number, PaneTarget>;
  /** Plot ids toggled off from the legend (webview-local, per-plot show/hide);
   * a hidden plot is routed to the 'hidden' pane and dropped from every layer,
   * without re-running the script. */
  hidden: Set<string>;
  overlayIndicatorId?: string;
  paneIndicatorId?: string;
  overlayMarkersIndicatorId?: string;
  paneMarkersIndicatorId?: string;
  overlayBgIndicatorId?: string;
  paneBgIndicatorId?: string;
  overlayDrawIndicatorId?: string;
  paneDrawIndicatorId?: string;
  barcolorIndicatorId?: string;
  equityIndicatorId?: string;
  showVolume: boolean;
  volumeIndicatorId?: string;
}

let state: RunState | undefined;

const container = document.getElementById('chart') as HTMLDivElement;

function cssVar(name: string, fallback: string): string {
  const v = getComputedStyle(document.body).getPropertyValue(name).trim();
  return v || fallback;
}

function isDark(): boolean {
  return (
    document.body.classList.contains('vscode-dark') ||
    document.body.classList.contains('vscode-high-contrast')
  );
}

function chartStyles(): DeepPartial<Styles> {
  const dark = isDark();
  const text = cssVar('--vscode-editor-foreground', dark ? '#ccc' : '#333');
  const grid = dark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)';
  const axisLine = dark ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.2)';
  return {
    grid: {
      horizontal: { color: grid },
      vertical: { color: grid },
    },
    candle: {
      priceMark: { last: { show: false } },
      tooltip: { legend: { color: text } },
    },
    indicator: {
      tooltip: { legend: { color: text } },
    },
    xAxis: {
      axisLine: { color: axisLine },
      tickText: { color: text },
    },
    yAxis: {
      axisLine: { color: axisLine },
      tickText: { color: text },
    },
    crosshair: {
      horizontal: { text: { backgroundColor: dark ? '#555' : '#333' } },
      vertical: { text: { backgroundColor: dark ? '#555' : '#333' } },
    },
  };
}

function mintickDecimals(mintick: unknown): number {
  const t = typeof mintick === 'number' ? mintick : 0;
  if (!(t > 0) || t >= 1) return 2;
  return Math.min(10, Math.max(0, Math.round(-Math.log10(t))));
}

/** TradingView period string ("60", "1D", "1W"...) to a v10 period object. */
function parsePeriod(period: unknown): Period {
  const p = String(period ?? '').toUpperCase();
  const m = /^(\d*)([SDWM]?)$/.exec(p);
  if (!m) return { span: 1, type: 'day' };
  const span = m[1] ? parseInt(m[1], 10) : 1;
  switch (m[2]) {
    case 'S':
      return { span, type: 'second' };
    case 'D':
      return { span, type: 'day' };
    case 'W':
      return { span, type: 'week' };
    case 'M':
      return { span, type: 'month' };
    default:
      return { span: span || 1, type: 'minute' };
  }
}

function rowToBar(row: BarRow): PyneBar {
  return {
    timestamp: row[0],
    open: row[1] ?? NaN,
    high: row[2] ?? NaN,
    low: row[3] ?? NaN,
    close: row[4] ?? NaN,
    volume: row[5] ?? undefined,
    plots: row[6] ?? [],
    equity: row[7] ?? null,
  };
}

function startRun(start: StartEvent): void {
  if (state) {
    dispose(state.chart);
  }
  container.innerHTML = '';
  const chart = init(container);
  if (!chart) return;

  chart.setStyles(chartStyles());
  // The crosshair date label also shows the bar_index — a big help while
  // developing a script, since log/debug output is indexed by it.
  chart.setFormatter({
    formatDate: ({ dateTimeFormat, timestamp, template, type }) => {
      const text = utils.formatDate(dateTimeFormat, timestamp, template);
      if (type !== 'crosshair') return text;
      const idx = state?.tsToIndex.get(timestamp);
      return idx === undefined ? text : `${text} (${idx})`;
    },
  });
  const tz = start.syminfo.timezone;
  if (typeof tz === 'string' && tz) {
    try {
      chart.setTimezone(tz);
    } catch {
      // unknown IANA zone: keep the default
    }
  }

  state = {
    chart,
    start,
    bars: [],
    plotKeys: [],
    plotMeta: new Map(),
    colorTrack: new ColorTrack(),
    tsToIndex: new Map(),
    drawings: new DrawingStore(),
    renderedTableVersion: -1,
    trades: [],
    stats: undefined,
    dirty: false,
    metaDirty: false,
    ended: false,
    plotPane: new Map(),
    hidden: new Set(),
    showVolume: false,
  };
  renderTables();
  renderPlotList(state);
  const tables = document.getElementById('pyne-tables');
  if (tables) tables.innerHTML = '';
  const st = state;

  chart.setDataLoader({
    getBars: ({ callback }) => {
      callback(st.bars.slice(), false);
    },
    subscribeBar: () => {},
    unsubscribeBar: () => {},
  });
  chart.setSymbol({
    ticker: String(start.syminfo.tickerid ?? start.syminfo.ticker ?? 'SYMBOL'),
    pricePrecision: mintickDecimals(start.syminfo.mintick),
    volumePrecision: 2,
  });
  chart.setPeriod(parsePeriod(start.syminfo.period));
  chart.subscribeAction('onVisibleRangeChange', (data) =>
    updateRealtimeButton(data as VisibleRange)
  );
  applyVolume(state, false);
  syncToolbar();
  updateRealtimeButton();
}

// --- "Back to realtime" floating button ------------------------------------
// KLineChart has no built-in TradingView-style jump-to-latest control; we show
// our own once the newest bar scrolls off the right edge. `range.to` is the
// last visible real bar index (exclusive), clamped to the data length, so
// `to < bars.length` means the newest bar is out of view.

const toRealtimeEl = document.getElementById('to-realtime') as HTMLButtonElement | null;

function updateRealtimeButton(range?: VisibleRange): void {
  if (!toRealtimeEl) return;
  const total = state?.bars.length ?? 0;
  const to = range ? range.to : state?.chart.getVisibleRange().to ?? 0;
  const show = total > 0 && to < total;
  toRealtimeEl.hidden = !show;
  if (show && state) {
    // Sit just left of the price axis (its width grows with the price digits).
    const yAxis = state.chart.getSize('candle_pane', 'yAxis');
    toRealtimeEl.style.right = `${Math.round((yAxis?.width ?? 60) + 8)}px`;
  }
}

toRealtimeEl?.addEventListener('click', () => {
  state?.chart.scrollToRealTime(300);
});

/**
 * Show/hide the volume histogram. Volume is opt-in (this is an indicator/
 * strategy dev tool, not a trading terminal). When on, draw a plain histogram —
 * calcParams: [] strips the built-in VOL indicator's MA5/MA10/MA20 lines.
 */
function applyVolume(st: RunState, on: boolean): void {
  st.showVolume = on;
  if (on && st.volumeIndicatorId === undefined) {
    st.volumeIndicatorId = st.chart.createIndicator({ name: 'VOL', calcParams: [] }) ?? undefined;
  } else if (!on && st.volumeIndicatorId !== undefined) {
    st.chart.removeIndicator({ id: st.volumeIndicatorId });
    st.volumeIndicatorId = undefined;
  }
}

/** plotcandle/plotbar store four value columns named after the base plot. */
const OHLC_COL = /^(.+) \((open|high|low|close)\)$/;

/** The meta governing a plot-data column: an exact id match first (kind
 * 'plot' columns are keyed by their title), then the plotcandle/plotbar base
 * whose four `"<title> (open|high|low|close)"` columns share one meta. */
function metaForKey(st: RunState, key: string): PlotMetaRecord | undefined {
  const exact = st.plotMeta.get(key);
  if (exact) return exact;
  const m = OHLC_COL.exec(key);
  if (m) {
    const base = st.plotMeta.get(m[1]);
    if (base && (base.kind === 'candle' || base.kind === 'bar')) return base;
  }
  return undefined;
}

/**
 * Assign plots to the candle pane (overlay), a separate pane, or hide them,
 * honoring each plot's meta (`force_overlay`, `display`, renderable kind)
 * with the script-level `overlay=` as the base. Keys without a meta
 * (pynecore < 6.6) keep the legacy script-flag behavior.
 */
function assignPlotPanes(st: RunState): boolean {
  let changed = false;
  for (let i = 0; i < st.plotKeys.length; i++) {
    const meta = metaForKey(st, st.plotKeys[i]);
    const id = meta?.id ?? st.plotKeys[i];
    const target = st.hidden.has(id) ? 'hidden' : paneFor(meta, st.start.overlay);
    if (st.plotPane.get(i) !== target) {
      st.plotPane.set(i, target);
      changed = true;
    }
  }
  return changed;
}

function figureKey(index: number): string {
  return `p${index}`;
}

/** Datum field carrying plot `index`'s resolved per-bar color (dynamic only). */
function colorKey(index: number): string {
  return `c${index}`;
}

/** Fixed pane id for the separate plots pane, so the marker layer can be
 * stacked onto the same pane (an unknown paneId makes KLineChart create the
 * pane on demand). */
const PLOTS_PANE_ID = 'pyne_plots_pane';

/** Adapt an indicator draw-callback's params to a MarkerDrawEnv. */
interface IndicatorDrawParams {
  ctx: CanvasRenderingContext2D;
  chart: {
    getVisibleRange(): VisibleRange;
    getBarSpace(): { gapBar: number };
  };
  bounding: { width: number; height: number };
  xAxis: { convertToPixel(value: number): number };
  yAxis: { convertToPixel(value: number): number };
}

function drawEnv(st: RunState, params: IndicatorDrawParams, overlay: boolean): MarkerDrawEnv {
  const range = params.chart.getVisibleRange();
  return {
    ctx: params.ctx,
    bounding: params.bounding,
    xAxis: params.xAxis,
    yAxis: params.yAxis,
    visibleFrom: range.from,
    visibleTo: range.to,
    overlay,
    gapBar: params.chart.getBarSpace().gapBar,
    bars: st.bars,
    colorAt: (channel, barIndex) => st.colorTrack.colorAt(channel, barIndex),
  };
}

function rebuildPlotIndicators(st: RunState): void {
  const overlayIdx = [...st.plotPane.entries()].filter(([, p]) => p === 'overlay').map(([i]) => i);
  const paneIdx = [...st.plotPane.entries()].filter(([, p]) => p === 'pane').map(([i]) => i);
  // hlines carry no per-bar data, so they live outside plotKeys; route them
  // by the same pane rules (no force_overlay -> the script pane), ordered by
  // id for a stable figure layout.
  const hlines = [...st.plotMeta.values()]
    .filter((m) => m.kind === 'hline' && !st.hidden.has(m.id))
    .sort((a, b) => a.id.localeCompare(b.id));
  const overlayHlines = hlines.filter((m) => paneFor(m, st.start.overlay) === 'overlay');
  const paneHlines = hlines.filter((m) => paneFor(m, st.start.overlay) === 'pane');
  // bgcolor also lives outside plotKeys (color channel only); same routing.
  const bgMetas = [...st.plotMeta.values()]
    .filter((m) => m.kind === 'bgcolor' && !st.hidden.has(m.id))
    .sort((a, b) => a.id.localeCompare(b.id));
  const overlayBg = bgMetas.filter((m) => paneFor(m, st.start.overlay) === 'overlay');
  const paneBg = bgMetas.filter((m) => paneFor(m, st.start.overlay) === 'pane');

  // shape/char/arrow columns are not figures — a figure value would feed the
  // pane's y-axis autoscale — they are painted by a separate marker-layer
  // indicator stacked ON TOP of the plots one (zLevel 1), matching Pine's
  // markers-above-lines ordering. plotcandle/plotbar columns become
  // paint-less figures (autoscale only) drawn by the group's draw callback.
  const splitGroup = (
    indices: number[]
  ): {
    lineIdx: number[];
    markers: MarkerItem[];
    arrows: ArrowItem[];
    candles: CandleItem[];
  } => {
    const lineIdx: number[] = [];
    const markers: MarkerItem[] = [];
    const arrows: ArrowItem[] = [];
    const parts = new Map<string, { meta: PlotMetaRecord; cols: Record<string, number> }>();
    for (const i of indices) {
      const key = st.plotKeys[i];
      const meta = metaForKey(st, key);
      if (meta && (meta.kind === 'shape' || meta.kind === 'char')) {
        markers.push({ plotIndex: i, meta });
      } else if (meta && meta.kind === 'arrow') {
        arrows.push({ plotIndex: i, meta });
      } else if (meta && (meta.kind === 'candle' || meta.kind === 'bar')) {
        const role = OHLC_COL.exec(key)?.[2];
        if (role) {
          let entry = parts.get(meta.id);
          if (!entry) parts.set(meta.id, (entry = { meta, cols: {} }));
          entry.cols[role] = i;
        }
      } else {
        lineIdx.push(i);
      }
    }
    const candles: CandleItem[] = [];
    for (const { meta, cols } of parts.values()) {
      const { open, high, low, close } = cols;
      if (open !== undefined && high !== undefined && low !== undefined && close !== undefined) {
        candles.push({ meta, open, high, low, close });
      }
    }
    return { lineIdx, markers, arrows, candles };
  };
  const overlayGroup = splitGroup(overlayIdx);
  const paneGroup = splitGroup(paneIdx);

  // fills route to the pane of their first referenced plot/hline; a fill
  // whose own display hides it (or whose references are unresolvable) is
  // skipped. Sources resolve to plot columns (their own offset/show_last
  // still apply) or constant hline prices.
  const overlayFills: FillItem[] = [];
  const paneFills: FillItem[] = [];
  const fillMetas = [...st.plotMeta.values()]
    .filter((m) => m.kind === 'fill' && !st.hidden.has(m.id))
    .sort((a, b) => a.id.localeCompare(b.id));
  for (const m of fillMetas) {
    if (paneFor(m, st.start.overlay) === 'hidden') continue;
    let target: PaneTarget;
    let a: FillSource;
    let b: FillSource;
    if (m.hline1 !== undefined && m.hline2 !== undefined) {
      const h1 = st.plotMeta.get(m.hline1);
      const h2 = st.plotMeta.get(m.hline2);
      if (h1?.price === undefined || h2?.price === undefined) continue;
      target = paneFor(h1, st.start.overlay);
      a = { price: h1.price };
      b = { price: h2.price };
    } else if (m.plot1 !== undefined && m.plot2 !== undefined) {
      const i1 = st.plotKeys.indexOf(m.plot1);
      const i2 = st.plotKeys.indexOf(m.plot2);
      if (i1 < 0 || i2 < 0) continue;
      const m1 = st.plotMeta.get(m.plot1);
      target = paneFor(m1, st.start.overlay);
      a = { plotIndex: i1, plotMeta: m1 };
      b = { plotIndex: i2, plotMeta: st.plotMeta.get(m.plot2) };
    } else {
      continue;
    }
    if (target === 'overlay') overlayFills.push({ meta: m, a, b });
    else if (target === 'pane') paneFills.push({ meta: m, a, b });
  }

  const makeDefinition = (
    name: string,
    lineIdx: number[],
    groupHlines: PlotMetaRecord[],
    precision: number,
    candles: CandleItem[],
    fills: FillItem[]
  ) => {
    // Dynamic plots resolve their per-bar color in calc (ColorTrack lookups
    // are amortized O(1) over ascending bar indices); the figures' styles
    // callbacks then just read the resolved datum field.
    const dynChannel = new Map<number, string>();
    for (const i of lineIdx) {
      const meta = st.plotMeta.get(st.plotKeys[i]);
      if (meta?.dynamic) dynChannel.set(i, meta.id);
    }
    // Draw-callback work collected while walking the figures: stepline
    // risers/half-treads (the segment merge drops a segment's third
    // coordinate), area fills below the line figure, and trackprice lines —
    // all with the same color the figure uses.
    const stepItems: PlotDrawItem[] = [];
    const areaItems: PlotDrawItem[] = [];
    const trackItems: PlotDrawItem[] = [];
    const figures: PlotFigureSpec[] = lineIdx.map((i, n) => {
      const meta = st.plotMeta.get(st.plotKeys[i]);
      const fallbackColor = PLOT_COLORS[n % PLOT_COLORS.length];
      if (meta && (meta.style === 'stepline' || meta.style === 'steplinebr')) {
        stepItems.push({ plotIndex: i, meta, fallbackColor });
      }
      if (meta && (meta.style === 'area' || meta.style === 'areabr')) {
        areaItems.push({ plotIndex: i, meta, fallbackColor });
      }
      if (meta?.trackprice === true) {
        trackItems.push({ plotIndex: i, meta, fallbackColor });
      }
      return buildFigure(
        meta,
        figureKey(i),
        colorKey(i),
        `${meta?.title ?? st.plotKeys[i]}: `,
        fallbackColor
      );
    });
    figures.push(...groupHlines.map((m, n) => buildHlineFigure(m, `h${n}`)));
    // plotcandle/plotbar columns feed the y-axis range through figures with
    // an unregistered type and no attrs: the range pass reads every figure
    // key's value, but the paint pass silently skips an unknown figure class.
    const candleIdx = candles.flatMap((c) => [c.open, c.high, c.low, c.close]);
    figures.push(
      ...candleIdx.map((i) => ({ key: figureKey(i), type: 'none', styles: () => ({}) }))
    );
    const valueIdx = [...lineIdx, ...candleIdx];
    return {
      name,
      shortName: 'Plots',
      precision,
      figures,
      calc: (dataList: PyneBar[]) =>
        dataList.map((_d, barIndex) => {
          const out: PlotDatum = {};
          for (const i of valueIdx) {
            const meta = metaForKey(st, st.plotKeys[i]);
            // offset shifts the series right (value seen offset bars ago);
            // show_last blanks everything before the last N bars.
            const src = barIndex - (meta?.offset ?? 0);
            let v = src >= 0 && src < dataList.length ? dataList[src].plots?.[i] ?? null : null;
            if (meta?.show_last !== undefined && barIndex < dataList.length - meta.show_last) {
              v = null;
            }
            out[figureKey(i)] = v;
            const channel = dynChannel.get(i);
            if (channel !== undefined && src >= 0 && src < dataList.length) {
              const enc = st.colorTrack.colorAt(channel, src);
              if (enc !== undefined) {
                out[colorKey(i)] = typeof enc === 'string' ? enc : null;
              }
            }
          }
          for (let n = 0; n < groupHlines.length; n++) {
            out[`h${n}`] = groupHlines[n].price ?? null;
          }
          return out;
        }),
      draw:
        stepItems.length ||
        areaItems.length ||
        trackItems.length ||
        candles.length ||
        fills.length
          ? (params: IndicatorDrawParams) => {
              const env = drawEnv(st, params, false);
              drawFills(env, fills);
              drawPlotCandles(env, candles);
              drawAreas(env, areaItems);
              drawTrackprices(env, trackItems);
              drawSteplines(env, stepItems);
              // Not a cover: the framework still draws the line figures after.
              return false;
            }
          : null,
    };
  };

  /** Marker layer: no figures (nothing feeds the y-axis autoscale, nothing
   * shows in the tooltip), just a draw callback painting arrows and glyphs. */
  const makeMarkerDefinition = (
    name: string,
    markers: MarkerItem[],
    arrows: ArrowItem[],
    overlay: boolean
  ) => ({
    name,
    shortName: name,
    figures: [],
    calc: () => [],
    styles: { tooltip: { showRule: 'none' } },
    draw: (params: IndicatorDrawParams) => {
      const env = drawEnv(st, params, overlay);
      drawArrows(env, arrows);
      drawMarkers(env, markers);
      return false;
    },
  });

  /** Background layer: full-height bgcolor fills. zLevel -1 makes KLineChart
   * paint it with destination-over, i.e. behind the candles and plots. */
  const makeBgDefinition = (name: string, metas: PlotMetaRecord[]) => ({
    name,
    shortName: name,
    figures: [],
    calc: () => [],
    styles: { tooltip: { showRule: 'none' } },
    draw: (params: IndicatorDrawParams) => {
      drawBackgrounds(drawEnv(st, params, false), metas);
      return false;
    },
  });

  // barcolor always targets the candle pane (it recolors the chart's own
  // bars). Created BEFORE the overlay plots indicator: same zLevel, so the
  // paint order is creation order and the plot lines stay on top.
  const barcolorMetas = [...st.plotMeta.values()]
    .filter((m) => m.kind === 'barcolor' && !st.hidden.has(m.id) && paneFor(m, true) !== 'hidden')
    .sort((a, b) => a.id.localeCompare(b.id));
  if (barcolorMetas.length) {
    registerIndicator({
      name: 'PyneBarcolor',
      shortName: 'PyneBarcolor',
      figures: [],
      calc: () => [],
      styles: { tooltip: { showRule: 'none' } },
      draw: (params: IndicatorDrawParams) => {
        drawBarcolors(drawEnv(st, params, true), barcolorMetas);
        return false;
      },
    } as never);
    if (st.barcolorIndicatorId) st.chart.removeIndicator({ id: st.barcolorIndicatorId });
    st.barcolorIndicatorId =
      st.chart.createIndicator({ name: 'PyneBarcolor', paneId: 'candle_pane' }, true) ?? undefined;
  } else if (st.barcolorIndicatorId) {
    st.chart.removeIndicator({ id: st.barcolorIndicatorId });
    st.barcolorIndicatorId = undefined;
  }

  // Overlay group: plots stacked on the candle pane, markers above them.
  if (overlayGroup.lineIdx.length || overlayHlines.length || overlayGroup.candles.length ||
      overlayFills.length) {
    const pricePrecision = mintickDecimals(st.start.syminfo.mintick);
    registerIndicator(
      makeDefinition(
        'PynePlotsOverlay',
        overlayGroup.lineIdx,
        overlayHlines,
        pricePrecision,
        overlayGroup.candles,
        overlayFills
      ) as never
    );
    if (st.overlayIndicatorId) st.chart.removeIndicator({ id: st.overlayIndicatorId });
    st.overlayIndicatorId =
      st.chart.createIndicator({ name: 'PynePlotsOverlay', paneId: 'candle_pane' }, true) ??
      undefined;
  } else if (st.overlayIndicatorId) {
    st.chart.removeIndicator({ id: st.overlayIndicatorId });
    st.overlayIndicatorId = undefined;
  }
  if (overlayGroup.markers.length || overlayGroup.arrows.length) {
    registerIndicator(
      makeMarkerDefinition(
        'PyneMarkersOverlay',
        overlayGroup.markers,
        overlayGroup.arrows,
        true
      ) as never
    );
    if (st.overlayMarkersIndicatorId) {
      st.chart.removeIndicator({ id: st.overlayMarkersIndicatorId });
    }
    st.overlayMarkersIndicatorId =
      st.chart.createIndicator({ name: 'PyneMarkersOverlay', paneId: 'candle_pane', zLevel: 1 }, true) ??
      undefined;
  } else if (st.overlayMarkersIndicatorId) {
    st.chart.removeIndicator({ id: st.overlayMarkersIndicatorId });
    st.overlayMarkersIndicatorId = undefined;
  }
  if (overlayBg.length) {
    registerIndicator(makeBgDefinition('PyneBgOverlay', overlayBg) as never);
    if (st.overlayBgIndicatorId) st.chart.removeIndicator({ id: st.overlayBgIndicatorId });
    st.overlayBgIndicatorId =
      st.chart.createIndicator({ name: 'PyneBgOverlay', paneId: 'candle_pane', zLevel: -1 }, true) ??
      undefined;
  } else if (st.overlayBgIndicatorId) {
    st.chart.removeIndicator({ id: st.overlayBgIndicatorId });
    st.overlayBgIndicatorId = undefined;
  }

  // Pane group: a fixed pane id so plots and markers land on one pane.
  // The plots indicator is created first WITHOUT stacking (wiping the pane
  // clean), then the marker layer stacks on top of it.
  if (paneGroup.lineIdx.length || paneHlines.length || paneGroup.candles.length ||
      paneFills.length) {
    const precision = panePrecision(
      [...paneGroup.lineIdx.map((i) => st.plotMeta.get(st.plotKeys[i])), ...paneHlines],
      2
    );
    registerIndicator(
      makeDefinition(
        'PynePlotsPane',
        paneGroup.lineIdx,
        paneHlines,
        precision,
        paneGroup.candles,
        paneFills
      ) as never
    );
    if (st.paneIndicatorId) st.chart.removeIndicator({ id: st.paneIndicatorId });
    st.paneIndicatorId =
      st.chart.createIndicator({ name: 'PynePlotsPane', paneId: PLOTS_PANE_ID }) ?? undefined;
  } else if (st.paneIndicatorId) {
    st.chart.removeIndicator({ id: st.paneIndicatorId });
    st.paneIndicatorId = undefined;
  }
  if (paneGroup.markers.length || paneGroup.arrows.length) {
    registerIndicator(
      makeMarkerDefinition('PyneMarkersPane', paneGroup.markers, paneGroup.arrows, false) as never
    );
    if (st.paneMarkersIndicatorId) st.chart.removeIndicator({ id: st.paneMarkersIndicatorId });
    st.paneMarkersIndicatorId =
      st.chart.createIndicator({ name: 'PyneMarkersPane', paneId: PLOTS_PANE_ID, zLevel: 1 }, true) ??
      undefined;
  } else if (st.paneMarkersIndicatorId) {
    st.chart.removeIndicator({ id: st.paneMarkersIndicatorId });
    st.paneMarkersIndicatorId = undefined;
  }
  if (paneBg.length) {
    registerIndicator(makeBgDefinition('PyneBgPane', paneBg) as never);
    if (st.paneBgIndicatorId) st.chart.removeIndicator({ id: st.paneBgIndicatorId });
    st.paneBgIndicatorId =
      st.chart.createIndicator({ name: 'PyneBgPane', paneId: PLOTS_PANE_ID, zLevel: -1 }, true) ??
      undefined;
  } else if (st.paneBgIndicatorId) {
    st.chart.removeIndicator({ id: st.paneBgIndicatorId });
    st.paneBgIndicatorId = undefined;
  }
}

/**
 * Create/remove the figure-less drawing-layer indicators. zLevel 2 puts the
 * drawings above the plot lines and the marker layer (TradingView's order).
 * Creation is a transition only — the draw callbacks read the DrawingStore
 * live, so ordinary updates just repaint on the next resetData tick.
 */
function ensureDrawingIndicators(st: RunState): void {
  const wantOverlay = st.drawings.hasCanvasFor(true, st.start.overlay);
  const wantPane = st.drawings.hasCanvasFor(false, st.start.overlay);
  const xres = makeXResolver(st.bars, st.tsToIndex);
  const makeDef = (name: string, overlay: boolean) => ({
    name,
    shortName: name,
    figures: [],
    calc: () => [],
    styles: { tooltip: { showRule: 'none' } },
    draw: (params: IndicatorDrawParams) => {
      drawDrawings(drawEnv(st, params, overlay), st.drawings, xres, st.start.overlay);
      return false;
    },
  });
  if (wantOverlay && !st.overlayDrawIndicatorId) {
    registerIndicator(makeDef('PyneDrawOverlay', true) as never);
    st.overlayDrawIndicatorId =
      st.chart.createIndicator({ name: 'PyneDrawOverlay', paneId: 'candle_pane', zLevel: 2 }, true) ??
      undefined;
  } else if (!wantOverlay && st.overlayDrawIndicatorId) {
    st.chart.removeIndicator({ id: st.overlayDrawIndicatorId });
    st.overlayDrawIndicatorId = undefined;
  }
  if (wantPane && !st.paneDrawIndicatorId) {
    registerIndicator(makeDef('PyneDrawPane', false) as never);
    st.paneDrawIndicatorId =
      st.chart.createIndicator({ name: 'PyneDrawPane', paneId: PLOTS_PANE_ID, zLevel: 2 }, true) ??
      undefined;
  } else if (!wantPane && st.paneDrawIndicatorId) {
    st.chart.removeIndicator({ id: st.paneDrawIndicatorId });
    st.paneDrawIndicatorId = undefined;
  }
}

// --- Pine tables as an HTML layer -------------------------------------------
// The canvas has no table primitive; tables render as absolutely positioned
// HTML over the chart, anchored to their pane's bounding box per the Pine
// position enum. pointer-events: none — interaction belongs to F9C.

const tablesEl = ((): HTMLDivElement | null => {
  const area = container?.parentElement;
  if (!area) return null;
  const el = document.createElement('div');
  el.id = 'pyne-tables';
  el.style.cssText = 'position:absolute;inset:0;pointer-events:none;z-index:4;overflow:hidden;';
  area.appendChild(el);
  return el;
})();

function tableAnchorCss(position: string | null | undefined): string {
  const pos = position ?? 'top_right';
  const [v, h] = pos.split('_');
  const pad = 6;
  let css = '';
  if (v === 'top') css += `top:${pad}px;`;
  else if (v === 'bottom') css += `bottom:${pad}px;`;
  else css += 'top:50%;transform:translateY(-50%);';
  if (h === 'left') css += `left:${pad}px;`;
  else if (h === 'right') css += `right:${pad}px;`;
  else css += v === 'middle' ? 'left:50%;transform:translate(-50%,-50%);' : 'left:50%;transform:translateX(-50%);';
  return css;
}

function renderDrawingTables(st: RunState): void {
  if (!tablesEl) return;
  if (st.drawings.tableVersion === st.renderedTableVersion) return;
  st.renderedTableVersion = st.drawings.tableVersion;
  tablesEl.innerHTML = '';
  for (const table of st.drawings.tables.values()) {
    const paneId = table.force_overlay || st.start.overlay ? 'candle_pane' : PLOTS_PANE_ID;
    const pane = st.chart.getSize(paneId, 'main') ?? st.chart.getSize('candle_pane', 'main');
    if (!pane) continue;
    const wrap = document.createElement('div');
    wrap.style.cssText =
      `position:absolute;left:${pane.left}px;top:${pane.top}px;` +
      `width:${pane.width}px;height:${pane.height}px;pointer-events:none;`;
    wrap.appendChild(buildTableEl(table, pane.width, pane.height));
    tablesEl.appendChild(wrap);
  }
}

function buildTableEl(table: TableState, paneW: number, paneH: number): HTMLElement {
  const el = document.createElement('table');
  el.style.cssText =
    `position:absolute;${tableAnchorCss(table.position)}` +
    'border-collapse:collapse;table-layout:auto;max-width:96%;max-height:96%;' +
    // pointer-events limited to the table itself (the layer stays transparent
    // to the mouse) so cell tooltips hover without stealing chart interaction.
    'pointer-events:auto;' +
    `background:${table.bgcolor ?? 'transparent'};`;
  if (table.frame_color && (table.frame_width ?? 0) > 0) {
    el.style.border = `${table.frame_width}px solid ${table.frame_color}`;
  }
  // Cell grid: pynecore serializes set cells only; merged ranges render at
  // their top-left cell and hide the covered ones.
  const byPos = new Map<string, TableCellState>();
  const hidden = new Set<string>();
  for (const cell of table.cells ?? []) {
    byPos.set(`${cell.col},${cell.row}`, cell);
    if (cell.merge) {
      const [c1, r1, c2, r2] = cell.merge;
      for (let c = c1; c <= c2; c++) {
        for (let r = r1; r <= r2; r++) {
          if (c !== cell.col || r !== cell.row) hidden.add(`${c},${r}`);
        }
      }
    }
  }
  for (let r = 0; r < table.rows; r++) {
    const tr = document.createElement('tr');
    for (let c = 0; c < table.columns; c++) {
      if (hidden.has(`${c},${r}`)) continue;
      const cell = byPos.get(`${c},${r}`);
      const td = document.createElement('td');
      if (cell?.merge) {
        td.colSpan = cell.merge[2] - cell.merge[0] + 1;
        td.rowSpan = cell.merge[3] - cell.merge[1] + 1;
      }
      const px = sizePx(cell?.text_size, 12);
      td.style.cssText =
        `padding:2px 6px;font-size:${px}px;white-space:pre;` +
        `text-align:${cell?.text_halign ?? 'center'};` +
        `vertical-align:${cell?.text_valign === 'top' ? 'top' : cell?.text_valign === 'bottom' ? 'bottom' : 'middle'};` +
        `color:${cell?.text_color ?? 'inherit'};` +
        `background:${cell?.bgcolor ?? 'transparent'};`;
      if (table.border_color && (table.border_width ?? 0) > 0) {
        td.style.border = `${table.border_width}px solid ${table.border_color}`;
      }
      // Pine cell width/height are % of the whole chart space; 0 = auto.
      if (cell?.width) td.style.width = `${(cell.width / 100) * paneW}px`;
      if (cell?.height) td.style.height = `${(cell.height / 100) * paneH}px`;
      if (cell?.tooltip) td.title = cell.tooltip;
      td.textContent = cell?.text ?? '';
      tr.appendChild(td);
    }
    el.appendChild(tr);
  }
  return el;
}

// --- Layers popup: per-plot & built-in show/hide --------------------------
// A dropdown (opened from the "Layers" toolbar button) listing the script's
// plots (swatch + name + kind) plus a "Built-in" section with the chart-level
// Volume toggle. Clicking a plot row toggles its visibility webview-locally:
// the plot is routed to the 'hidden' pane and dropped from every layer on the
// next indicator rebuild, so nothing re-runs and the accumulated bars/data stay
// put. The Volume row instead drives the native VOL indicator via applyVolume.

interface LegendEntry {
  id: string;
  label: string;
  kind: string;
  color?: string;
}

const plotsPopupEl = ((): HTMLDivElement | null => {
  if (!document.body) return null;
  const el = document.createElement('div');
  el.id = 'plots-popup';
  el.hidden = true;
  document.body.appendChild(el);
  return el;
})();

/** Collect one legend entry per plot id: every meta (plotcandle/plotbar's four
 * columns share one id, so they collapse to one row) plus any plot column that
 * arrived without a meta (pynecore < 6.6). */
function legendEntries(st: RunState): LegendEntry[] {
  const byId = new Map<string, LegendEntry>();
  for (const meta of st.plotMeta.values()) {
    byId.set(meta.id, { id: meta.id, label: meta.title ?? meta.id, kind: meta.kind, color: meta.color });
  }
  for (const key of st.plotKeys) {
    if (metaForKey(st, key)) continue;
    if (!byId.has(key)) byId.set(key, { id: key, label: key, kind: 'plot' });
  }
  return [...byId.values()];
}

/** Recompute panes and rebuild the plot indicators from the current `hidden`
 * set, then reload the (retained) bars — no script re-run, no data reset. */
function applyVisibility(st: RunState): void {
  assignPlotPanes(st);
  rebuildPlotIndicators(st);
  st.chart.resetData();
}

/** Build one clickable show/hide row (swatch + name), dimmed + struck-through
 * when `off`. */
function makeLayerRow(
  label: string, kind: string, off: boolean, color: string | undefined, onToggle: () => void,
): HTMLDivElement {
  const row = document.createElement('div');
  row.className = 'plot-row';
  row.style.opacity = off ? '0.4' : '1';
  const swatch = document.createElement('span');
  swatch.className = 'plot-swatch';
  swatch.style.background = color ?? 'var(--vscode-foreground)';
  if (off) swatch.style.outline = '1px solid var(--vscode-descriptionForeground)';
  const name = document.createElement('span');
  name.className = 'plot-name';
  name.textContent = label;
  name.style.color = 'var(--vscode-foreground)';
  if (off) name.style.textDecoration = 'line-through';
  row.title = `${label} (${kind}) — click to ${off ? 'show' : 'hide'}`;
  row.appendChild(swatch);
  row.appendChild(name);
  // Keep the popup open across toggles (multi-select): stop the click from
  // reaching the outside-click handler, which would otherwise close it — the
  // re-render detaches this row before that handler runs its containment check.
  row.addEventListener('click', (e) => {
    e.stopPropagation();
    onToggle();
  });
  return row;
}

/** Fill the popup: one row per script plot, then a "Built-in" section with the
 * chart-level Volume toggle. The button is always enabled — Volume is available
 * even when the script has no plots. */
function renderPlotList(st: RunState): void {
  if (!plotsPopupEl) return;
  plotsPopupEl.innerHTML = '';
  const entries = legendEntries(st);
  for (const entry of entries) {
    const off = st.hidden.has(entry.id);
    plotsPopupEl.appendChild(makeLayerRow(entry.label, entry.kind, off, entry.color, () => {
      if (st.hidden.has(entry.id)) st.hidden.delete(entry.id);
      else st.hidden.add(entry.id);
      applyVisibility(st);
      renderPlotList(st);
    }));
  }
  if (entries.length > 0) {
    const sep = document.createElement('div');
    sep.className = 'plot-sep';
    plotsPopupEl.appendChild(sep);
  }
  const section = document.createElement('div');
  section.className = 'plot-section';
  section.textContent = 'Built-in';
  plotsPopupEl.appendChild(section);
  plotsPopupEl.appendChild(makeLayerRow('Volume', 'built-in', !st.showVolume, undefined, () => {
    applyVolume(st, !st.showVolume);
    renderPlotList(st);
  }));
}

/** Anchor the popup just below the "Layers" toolbar button. */
function positionPlotsPopup(): void {
  if (!plotsPopupEl || !tbLayersEl) return;
  const r = tbLayersEl.getBoundingClientRect();
  plotsPopupEl.style.left = `${Math.round(r.left)}px`;
  plotsPopupEl.style.top = `${Math.round(r.bottom + 3)}px`;
}

function openPlotsPopup(): void {
  if (!plotsPopupEl || !state) return;
  renderPlotList(state);
  plotsPopupEl.hidden = false;
  positionPlotsPopup();
  tbLayersEl?.classList.add('active');
}

function closePlotsPopup(): void {
  if (plotsPopupEl) plotsPopupEl.hidden = true;
  tbLayersEl?.classList.remove('active');
}

function togglePlotsPopup(): void {
  if (plotsPopupEl && !plotsPopupEl.hidden) closePlotsPopup();
  else openPlotsPopup();
}

function ensureEquityIndicator(st: RunState): void {
  if (st.equityIndicatorId) return;
  if (st.start.scriptType !== 'strategy') return;
  if (!st.bars.some((b) => typeof b.equity === 'number')) return;
  registerIndicator({
    name: 'PyneEquity',
    shortName: 'Equity',
    precision: 2,
    figures: [
      {
        key: 'equity',
        title: 'Equity: ',
        type: 'line',
        styles: () => ({ color: '#00bfa5' }),
      },
    ],
    calc: (dataList: PyneBar[]) => dataList.map((d) => ({ equity: d.equity ?? null })),
  } as never);
  st.equityIndicatorId = st.chart.createIndicator('PyneEquity') ?? undefined;
}

function addTradeAnnotations(st: RunState): void {
  let budget = MAX_TRADE_ANNOTATIONS;
  for (const trade of st.trades) {
    if (budget <= 0) break;
    const long = (trade.size ?? 0) > 0;
    if (trade.entryTime > 0 && trade.entryPrice != null) {
      st.chart.createOverlay({
        name: 'simpleAnnotation',
        points: [{ timestamp: trade.entryTime, value: trade.entryPrice }],
        extendData: `${long ? '▲ Long' : '▼ Short'} ${trade.entryId ?? ''}`,
        styles: {
          text: { color: long ? '#26a69a' : '#ef5350' },
        },
        lock: true,
      });
      budget--;
    }
    if (trade.exitTime > 0 && trade.exitPrice != null && budget > 0) {
      const win = (trade.profit ?? 0) >= 0;
      st.chart.createOverlay({
        name: 'simpleAnnotation',
        points: [{ timestamp: trade.exitTime, value: trade.exitPrice }],
        extendData: `✕ ${trade.exitId ?? ''} (${win ? '+' : ''}${(trade.profit ?? 0).toFixed(2)})`,
        styles: {
          text: { color: win ? '#26a69a' : '#ef5350' },
        },
        lock: true,
      });
      budget--;
    }
  }
}

/**
 * Adaptive UI tick: a full resetData() costs O(bars), so the next tick is
 * scheduled relative to how long the last one took — the main thread stays
 * mostly idle even while a 100k-bar backtest streams in, updates just get
 * less frequent as the dataset grows.
 */
function uiTick(): void {
  const st = state;
  let elapsed = 0;
  if (st && st.dirty && !st.ended) {
    st.dirty = false;
    const t0 = performance.now();
    const paneChange = assignPlotPanes(st);
    st.chart.resetData();
    // Follow the freshly streamed bars; resetData alone keeps the old anchor.
    st.chart.scrollToRealTime(0);
    if (paneChange || st.metaDirty) {
      st.metaDirty = false;
      rebuildPlotIndicators(st);
      renderPlotList(st);
    }
    ensureEquityIndicator(st);
    ensureDrawingIndicators(st);
    renderDrawingTables(st);
    elapsed = performance.now() - t0;
  }
  setTimeout(uiTick, Math.max(UI_TICK_MS, elapsed * 3));
}

setTimeout(uiTick, UI_TICK_MS);

// --- Bottom panel: trades / stats tables -----------------------------------
// The elements are absent in standalone test harnesses; every access is
// guarded so the chart works without the panel markup.

const bottomEl = document.getElementById('bottom');
const tabBodyEl = document.getElementById('tab-body');
const tabTradesEl = document.getElementById('tab-trades');
const tabStatsEl = document.getElementById('tab-stats');
const tabToggleEl = document.getElementById('tab-toggle');
let activeTab: 'trades' | 'stats' = 'trades';

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function fmt(v: number | null | undefined, decimals = 2): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return v.toLocaleString(undefined, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

function fmtTime(ts: number): string {
  if (!(ts > 0)) return '—';
  return new Date(ts).toISOString().replace('T', ' ').slice(0, 16);
}

function signClass(v: number | null | undefined): string {
  if (v === null || v === undefined || v === 0) return '';
  return v > 0 ? 'pos' : 'neg';
}

function setCollapsed(collapsed: boolean): void {
  if (!bottomEl) return;
  bottomEl.classList.toggle('collapsed', collapsed);
  if (tabToggleEl) tabToggleEl.textContent = collapsed ? '▴' : '▾';
  state?.chart.resize();
}

function renderTrades(): string {
  const st = state;
  if (!st || st.trades.length === 0) {
    return '<span class="muted">No trades (yet). Indicators produce no trades.</span>';
  }
  const d = mintickDecimals(st.start.syminfo.mintick);
  const rows = st.trades
    .map((t, i) => {
      const long = (t.size ?? 0) > 0;
      return (
        `<tr class="clickable" data-ts="${t.entryTime}">` +
        `<td>${i + 1} ${long ? '▲' : '▼'} ${esc(t.entryId ?? '')}</td>` +
        `<td>${fmtTime(t.entryTime)}</td><td>${fmt(t.entryPrice, d)}</td>` +
        `<td>${fmtTime(t.exitTime)}</td><td>${fmt(t.exitPrice, d)}</td>` +
        `<td>${fmt(Math.abs(t.size ?? 0), 4)}</td>` +
        `<td class="${signClass(t.profit)}">${fmt(t.profit)}</td>` +
        `<td class="${signClass(t.profitPct)}">${fmt(t.profitPct)}%</td>` +
        `<td class="${signClass(t.cumProfit)}">${fmt(t.cumProfit)}</td>` +
        `</tr>`
      );
    })
    .join('');
  return (
    '<table><thead><tr><th>Trade</th><th>Entry time</th><th>Entry price</th>' +
    '<th>Exit time</th><th>Exit price</th><th>Qty</th><th>Profit</th><th>Profit %</th>' +
    '<th>Cum. profit</th></tr></thead><tbody>' +
    rows +
    '</tbody></table>'
  );
}

function renderStats(): string {
  const st = state;
  if (!st?.stats) {
    return '<span class="muted">Strategy statistics appear when the run finishes.</span>';
  }
  const rows = Object.entries(st.stats)
    .map(([key, value]) => {
      const pct = key.includes('%');
      const isCount = Number.isInteger(value) && !pct && Math.abs(value ?? 0) < 1e6 &&
        /Trades|Wins|Losses|Calls|Bars/.test(key);
      return (
        `<tr><td>${esc(key)}</td>` +
        `<td class="${signClass(value)}">${isCount ? String(value) : fmt(value)}${pct ? '%' : ''}</td></tr>`
      );
    })
    .join('');
  return '<table><thead><tr><th>Metric</th><th>Value</th></tr></thead><tbody>' + rows + '</tbody></table>';
}

function renderTables(): void {
  if (!tabBodyEl || !bottomEl) return;
  tabTradesEl?.classList.toggle('active', activeTab === 'trades');
  tabStatsEl?.classList.toggle('active', activeTab === 'stats');
  if (tabTradesEl && state) tabTradesEl.textContent = `Trades (${state.trades.length})`;
  if (bottomEl.classList.contains('collapsed')) return;
  tabBodyEl.innerHTML = activeTab === 'trades' ? renderTrades() : renderStats();
}

tabTradesEl?.addEventListener('click', () => {
  activeTab = 'trades';
  setCollapsed(false);
  renderTables();
});
tabStatsEl?.addEventListener('click', () => {
  activeTab = 'stats';
  setCollapsed(false);
  renderTables();
});
tabToggleEl?.addEventListener('click', () => {
  setCollapsed(!bottomEl?.classList.contains('collapsed'));
  renderTables();
});
tabBodyEl?.addEventListener('click', (event) => {
  const row = (event.target as HTMLElement).closest('tr[data-ts]');
  const ts = row ? Number((row as HTMLElement).dataset.ts) : 0;
  if (ts > 0) state?.chart.scrollToTimestamp(ts, 200);
});

// --- Top toolbar: data / layers / go-to-date / CSV -------------------------
// Elements are absent in standalone test harnesses; every access is guarded.

const tbDataEl = document.getElementById('tb-data') as HTMLButtonElement | null;
const tbLayersEl = document.getElementById('tb-layers') as HTMLButtonElement | null;
const tbGotoEl = document.getElementById('tb-goto') as HTMLButtonElement | null;
const gotoPopupEl = document.getElementById('goto-popup') as HTMLDivElement | null;
const tbGotoInputEl = document.getElementById('tb-goto-input') as HTMLInputElement | null;
const tbGotoDoEl = document.getElementById('tb-goto-do');
const tbCsvPlotEl = document.getElementById('tb-csv-plot') as HTMLButtonElement | null;
const tbCsvTradesEl = document.getElementById('tb-csv-trades') as HTMLButtonElement | null;

/** The data name shown on the Data button (bare stem of the .ohlcv path). */
function dataLabel(dataPath?: string): string {
  if (!dataPath) return 'Data';
  const base = dataPath.split(/[\\/]/).pop() ?? dataPath;
  return base.endsWith('.ohlcv') ? base.slice(0, -'.ohlcv'.length) : base;
}

/** Reflect current run state onto the toolbar (data, volume, CSV). */
function syncToolbar(): void {
  const st = state;
  if (tbDataEl) tbDataEl.textContent = dataLabel(st?.start.data);
  if (tbCsvPlotEl) tbCsvPlotEl.disabled = !(st?.ended && st.start.outputs.plot);
  if (tbCsvTradesEl) {
    const hasTrades = st?.ended === true && st.trades.length > 0 && !!st.start.outputs.trades;
    tbCsvTradesEl.hidden = st?.start.scriptType !== 'strategy';
    tbCsvTradesEl.disabled = !hasTrades;
  }
}

tbDataEl?.addEventListener('click', () => vscode.postMessage({ type: 'selectData' }));

tbLayersEl?.addEventListener('click', (e) => {
  e.stopPropagation();
  closeGotoPopup();
  togglePlotsPopup();
});

// Close the plots popup on any click outside it (and outside its button).
document.addEventListener('click', (e) => {
  if (!plotsPopupEl || plotsPopupEl.hidden) return;
  const t = e.target as Node;
  if (plotsPopupEl.contains(t) || tbLayersEl?.contains(t)) return;
  closePlotsPopup();
});

window.addEventListener('resize', () => {
  if (plotsPopupEl && !plotsPopupEl.hidden) positionPlotsPopup();
  if (gotoPopupEl && !gotoPopupEl.hidden) positionGotoPopup();
});

/** Anchor the date picker inside the chart, below the matching toolbar button. */
function positionGotoPopup(): void {
  if (!gotoPopupEl || !tbGotoEl) return;
  const buttonRect = tbGotoEl.getBoundingClientRect();
  const areaRect = container.parentElement?.getBoundingClientRect();
  if (!areaRect) return;
  const maxLeft = Math.max(6, areaRect.width - gotoPopupEl.offsetWidth - 6);
  const left = Math.min(Math.max(6, buttonRect.left - areaRect.left), maxLeft);
  gotoPopupEl.style.left = `${Math.round(left)}px`;
  gotoPopupEl.style.top = '6px';
}

function openGotoPopup(): void {
  if (!gotoPopupEl) return;
  closePlotsPopup();
  gotoPopupEl.hidden = false;
  tbGotoEl?.classList.add('active');
  positionGotoPopup();
  if (tbGotoInputEl) {
    if (!tbGotoInputEl.value && state?.bars.length) {
      // Prefill with the first bar's time (UTC) as a sensible starting point.
      tbGotoInputEl.value = new Date(state.bars[0].timestamp).toISOString().slice(0, 19);
    }
    tbGotoInputEl.focus();
  }
}

function closeGotoPopup(): void {
  if (gotoPopupEl) gotoPopupEl.hidden = true;
  tbGotoEl?.classList.remove('active');
}

tbGotoEl?.addEventListener('click', (e) => {
  e.stopPropagation();
  if (gotoPopupEl?.hidden) openGotoPopup();
  else closeGotoPopup();
});

document.addEventListener('click', (e) => {
  if (!gotoPopupEl || gotoPopupEl.hidden) return;
  const target = e.target as Node;
  if (gotoPopupEl.contains(target) || tbGotoEl?.contains(target)) return;
  closeGotoPopup();
});

/** Parse the datetime-local value as a UTC instant to match bar timestamps. */
function gotoInputTimestamp(): number | undefined {
  const v = tbGotoInputEl?.value;
  const m = v ? /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(v) : null;
  if (!m) return undefined;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], m[6] ? +m[6] : 0);
}

function doGoto(): void {
  const ts = gotoInputTimestamp();
  if (ts !== undefined) {
    state?.chart.scrollToTimestamp(ts, 200);
    closeGotoPopup();
  }
}

tbGotoDoEl?.addEventListener('click', doGoto);
tbGotoInputEl?.addEventListener('keydown', (e) => {
  const key = (e as KeyboardEvent).key;
  if (key === 'Enter') doGoto();
  else if (key === 'Escape') closeGotoPopup();
});

tbCsvPlotEl?.addEventListener('click', () => vscode.postMessage({ type: 'openCsv', which: 'plot' }));
tbCsvTradesEl?.addEventListener('click', () =>
  vscode.postMessage({ type: 'openCsv', which: 'trades' })
);

window.addEventListener('message', (event: MessageEvent<ChartInMessage>) => {
  const msg = event.data;
  switch (msg.type) {
    case 'reset':
      startRun(msg.start);
      break;
    case 'bars': {
      if (!state) break;
      for (const row of msg.rows) {
        const bar = rowToBar(row);
        state.tsToIndex.set(bar.timestamp, state.bars.length);
        state.bars.push(bar);
      }
      state.dirty = true;
      break;
    }
    case 'plotKeys':
      if (state) {
        state.plotKeys = msg.keys;
        state.dirty = true;
      }
      break;
    case 'plotMeta':
      if (state) {
        for (const m of msg.metas) state.plotMeta.set(m.id, m);
        state.metaDirty = true;
        state.dirty = true;
      }
      break;
    case 'colors':
      if (state) {
        state.colorTrack.addRows(msg.d, state.tsToIndex);
        state.dirty = true;
      }
      break;
    case 'drawings':
      if (state) {
        state.drawings.apply(msg.d);
        state.dirty = true;
      }
      break;
    case 'trades':
    case 'openTrades':
      if (state) state.trades.push(...msg.trades);
      break;
    case 'stats':
      if (state) state.stats = msg.stats;
      break;
    case 'end':
      if (state) {
        state.ended = true;
        state.dirty = false;
        assignPlotPanes(state);
        state.chart.resetData();
        state.chart.scrollToRealTime(0);
        rebuildPlotIndicators(state);
        renderPlotList(state);
        ensureEquityIndicator(state);
        ensureDrawingIndicators(state);
        renderDrawingTables(state);
        addTradeAnnotations(state);
        if (state.trades.length) setCollapsed(false);
        renderTables();
        syncToolbar();
      }
      break;
  }
});

window.addEventListener('resize', () => state?.chart.resize());

vscode.postMessage({ type: 'ready' });
