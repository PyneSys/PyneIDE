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
 * Strategy performance is rendered as a full-run equity curve in its own
 * bottom-panel tab; trades become TradingView-style, background-free markers
 * at run end, painted by a figure-less indicator (see tradeMarkers.ts).
 */
import {
  init,
  dispose,
  registerIndicator,
  registerOverlay,
  utils,
  type CandleAreaStyle,
  type CandleBarColor,
  type Chart,
  type KLineData,
  type DeepPartial,
  type Period,
  type Styles,
  type VisibleRange,
} from 'klinecharts';

import type { BarRow, PlotMetaRecord, StartEvent, TradeRecord } from '../../run/bridgeClient';
import {
  CANDLE_STYLE_OPTIONS,
  DEFAULT_CANDLE_STYLE,
  isPriceLineStyle,
  type CandleStyleId,
} from '../candleStyle';
import {
  CLASSIC_PALETTE,
  COLORBLIND_PALETTE_DARK,
  COLORBLIND_PALETTE_LIGHT,
  COLOR_SCHEME_OPTIONS,
  DEFAULT_COLOR_SCHEME,
  type ChartPalette,
  type ColorSchemeId,
} from '../colorScheme';
import type { ChartBreakpointTarget, ChartInMessage, ChartOutMessage } from '../messages';
import { DEFAULT_PRICE_SCALE, PRICE_SCALE_OPTIONS, type PriceScaleId } from '../priceScale';
import { ColorTrack } from './colorTrack';
import {
  calculateEquitySummary,
  drawEquityCurve,
  type EquitySummary,
} from './equityCurve';
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
  type BarcolorShape,
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
import {
  buildTradeMarkerIndex,
  drawTradeMarkers,
  type TradeMarkerIndex,
  type TradeMarkerTheme,
} from './tradeMarkers';

declare function acquireVsCodeApi(): { postMessage(msg: ChartOutMessage): void };

const vscode = acquireVsCodeApi();

const UI_TICK_MS = 400;
const MEASURE_OVERLAY_NAME = 'PyneMeasure';
const BREAKPOINT_OVERLAY_NAME = 'PyneBreakpoint';
const TRADE_MARKER_INDICATOR_NAME = 'PyneTradeMarkers';
const BREAKPOINT_CLICK_DRAG_THRESHOLD_PX = 4;

/**
 * Short name for the figure-less layers that paint straight onto the canvas —
 * they have nothing to say in the chart legend, and an empty name is the only
 * way to say so. `IndicatorTooltipView` takes its tooltip styles from the chart
 * store, never from the indicator, so a per-indicator `tooltip.showRule` is
 * silently ignored; a layer with no name and no figures is skipped instead.
 */
const NO_LEGEND = '';

interface BreakpointOverlayData extends ChartBreakpointTarget {}

function formatMeasureDuration(durationMs: number): string {
  let seconds = Math.max(0, Math.round(durationMs / 1000));
  const days = Math.floor(seconds / 86400);
  seconds -= days * 86400;
  const hours = Math.floor(seconds / 3600);
  seconds -= hours * 3600;
  const minutes = Math.floor(seconds / 60);
  seconds -= minutes * 60;

  const parts: string[] = [];
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (minutes && parts.length < 2) parts.push(`${minutes}m`);
  if (seconds && parts.length < 2) parts.push(`${seconds}s`);
  return parts.slice(0, 2).join(' ') || '0s';
}

registerOverlay({
  name: MEASURE_OVERLAY_NAME,
  totalStep: 3,
  needDefaultPointFigure: true,
  needDefaultXAxisFigure: true,
  needDefaultYAxisFigure: true,
  mode: 'weak_magnet',
  modeSensitivity: 8,
  createPointFigures: ({ chart, overlay, coordinates, bounding }) => {
    if (coordinates.length < 2) return [];

    const [a, b] = coordinates;
    const [start, end] = overlay.points;
    const startValue = start?.value;
    const endValue = end?.value;
    if (typeof startValue !== 'number' || typeof endValue !== 'number') return [];

    const rising = endValue >= startValue;
    // Resolved per draw, so the box follows a scheme or theme switch made while
    // a measurement is on screen.
    const p = palette();
    const color = rising ? p.up : p.down;
    const fill = withAlpha(color, 0.14);
    const pricePrecision = chart.getSymbol()?.pricePrecision ?? 2;
    const delta = endValue - startValue;
    const percent = startValue === 0 ? undefined : (delta / startValue) * 100;
    const deltaText = `${delta >= 0 ? '+' : ''}${delta.toFixed(pricePrecision)}`;
    const percentText = percent === undefined
      ? '—'
      : `${percent >= 0 ? '+' : ''}${percent.toFixed(2)}%`;

    const startIndex = typeof start.dataIndex === 'number' ? Math.round(start.dataIndex) : undefined;
    const endIndex = typeof end.dataIndex === 'number' ? Math.round(end.dataIndex) : undefined;
    const bars = startIndex === undefined || endIndex === undefined
      ? undefined
      : Math.abs(endIndex - startIndex);
    const startTs = typeof start.timestamp === 'number'
      ? start.timestamp
      : startIndex === undefined ? undefined : chart.getDataList()[startIndex]?.timestamp;
    const endTs = typeof end.timestamp === 'number'
      ? end.timestamp
      : endIndex === undefined ? undefined : chart.getDataList()[endIndex]?.timestamp;
    const duration = startTs === undefined || endTs === undefined
      ? undefined
      : formatMeasureDuration(Math.abs(endTs - startTs));
    const rangeText = [bars === undefined ? undefined : `${bars} bars`, duration]
      .filter((part): part is string => !!part)
      .join(' · ');
    const label = `${deltaText} (${percentText})${rangeText ? ` · ${rangeText}` : ''}`;

    const x = Math.min(a.x, b.x);
    const y = Math.min(a.y, b.y);
    const width = Math.abs(b.x - a.x);
    const height = Math.abs(b.y - a.y);
    const midX = Math.min(Math.max((a.x + b.x) / 2, 4), Math.max(4, bounding.width - 4));
    const labelAbove = y >= 28;

    return [
      {
        type: 'rect',
        attrs: { x, y, width, height },
        styles: {
          style: 'stroke_fill',
          color: fill,
          borderColor: color,
          borderSize: 1,
          borderStyle: 'dashed',
          borderDashedValue: [4, 3],
        },
      },
      {
        type: 'line',
        attrs: { coordinates: [a, b] },
        styles: { color, size: 1, style: 'solid' },
      },
      {
        type: 'text',
        attrs: {
          x: midX,
          y: labelAbove ? y - 4 : y + 4,
          text: label,
          align: 'center',
          baseline: labelAbove ? 'bottom' : 'top',
        },
        styles: {
          style: 'stroke_fill',
          color: '#ffffff',
          size: 11,
          backgroundColor: color,
          borderColor: color,
          borderSize: 1,
          borderRadius: 3,
          paddingLeft: 5,
          paddingTop: 3,
          paddingRight: 5,
          paddingBottom: 3,
        },
        ignoreEvent: true,
      },
    ];
  },
});

registerOverlay<BreakpointOverlayData>({
  name: BREAKPOINT_OVERLAY_NAME,
  totalStep: 2,
  createPointFigures: ({ overlay, coordinates, bounding }) => {
    const point = coordinates[0];
    if (!point) return [];
    const data = overlay.extendData;
    const color = data.enabled
      ? cssVar('--vscode-debugIcon-breakpointForeground', '#e51400')
      : cssVar('--vscode-debugIcon-breakpointDisabledForeground', '#848484');
    const label = data.count > 1 ? `BP ×${data.count}` : 'BP';
    return [
      {
        type: 'line',
        attrs: {
          coordinates: [
            { x: point.x, y: 0 },
            { x: point.x, y: bounding.height },
          ],
        },
        styles: { color, size: 1, style: 'dashed', dashedValue: [4, 3] },
      },
      {
        type: 'text',
        attrs: { x: point.x, y: 4, text: label, align: 'center', baseline: 'top' },
        styles: {
          style: 'stroke_fill',
          color: '#ffffff',
          size: 10,
          backgroundColor: color,
          borderColor: color,
          borderSize: 1,
          borderRadius: 3,
          paddingLeft: 4,
          paddingTop: 2,
          paddingRight: 4,
          paddingBottom: 2,
        },
      },
    ];
  },
  onClick: ({ overlay }) => selectBreakpointTimestamp(overlay.extendData.timestamp),
  onRightClick: ({ overlay, preventDefault }) => {
    preventDefault?.();
    vscode.postMessage({
      type: 'removeBreakpointBar',
      timestamp: overlay.extendData.timestamp,
    });
  },
});

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
  /** Bar index -> trade glyphs, rebuilt whenever trades/bars grow. */
  tradeMarkers?: TradeMarkerIndex;
  /** [trades.length, bars.length] the index above was built from. */
  tradeMarkersBuiltFor?: [number, number];
  tradeMarkerIndicatorId?: string;
  barcolorIndicatorId?: string;
  showVolume: boolean;
  volumeIndicatorId?: string;
  breakpointOverlays: Map<number, { id: string; enabled: boolean; count: number }>;
  /** Where the view sat before this run replaced the chart (see captureView). */
  viewAnchor?: ViewAnchor;
}

/**
 * Zoom + scroll position carried across a chart rebuild. A re-run of the same
 * script on the same feed (inputs saved) must change only the data under the
 * view, not where the user is looking — but every run disposes the chart, and
 * `resetData()` snaps the viewport back to the newest bar on every tick, so the
 * position has to be captured before the rebuild and re-applied after each
 * reset.
 */
interface ViewAnchor {
  /** Bar width in px == the zoom level. */
  barSpace: number;
  /** Timestamp of the bar at the right edge; null when the view was following
   * the newest bar, in which case only the zoom is restored. */
  rightTimestamp: number | null;
  /** The x pixel that bar sat on. `scrollToDataIndex` only lands within a bar
   * of the original position — and always to the same side, so a chart re-run
   * ten times would walk ten bars — so the pixel is what makes it exact. */
  rightX: number | undefined;
}

let state: RunState | undefined;
let chartBreakpointTargets: ChartBreakpointTarget[] = [];
let breakpointSelectionLabel: string | undefined;
let breakpointPointerGesture:
  | { pointerId: number; startX: number; startY: number; dragged: boolean }
  | undefined;
/** Chart-wide, not per-run: a run rebuilds the chart from scratch, and having
 * the legend come back every time would defeat the toggle. */
let legendVisible = true;

/** Mirrors the persisted `pyneide.chart.candleStyle`; the host pushes the
 * stored value on load, so this initial value only covers the gap before the
 * first message (and standalone test harnesses). */
let candleStyleId: CandleStyleId = DEFAULT_CANDLE_STYLE;

/** Mirrors the persisted `pyneide.chart.priceScale`, same host-owned lifecycle
 * as `candleStyleId`. Applies to the price pane only: an indicator pane's own
 * scale is unrelated to how price is plotted. */
let priceScaleId: PriceScaleId = DEFAULT_PRICE_SCALE;

/** Mirrors the persisted `pyneide.chart.colorScheme`, same host-owned lifecycle
 * as `candleStyleId`. */
let colorSchemeId: ColorSchemeId = DEFAULT_COLOR_SCHEME;

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

/**
 * The four direction colors of a scheme. Resolved on each call rather than
 * cached: only style-building code reads it (the per-frame trade-marker path
 * takes its copy through `markerTheme`'s memo), and a live theme switch has to
 * be able to change the answer under `theme` and `colorblind` alike.
 */
function paletteFor(id: ColorSchemeId): ChartPalette {
  switch (id) {
    case 'theme':
      // Mirrors Classic's role assignment in whatever colors the theme picked:
      // green/red price, blue longs, red shorts.
      return {
        up: cssVar('--vscode-charts-green', CLASSIC_PALETTE.up),
        down: cssVar('--vscode-charts-red', CLASSIC_PALETTE.down),
        long: cssVar('--vscode-charts-blue', CLASSIC_PALETTE.long),
        short: cssVar('--vscode-charts-red', CLASSIC_PALETTE.short),
      };
    case 'colorblind':
      return isDark() ? COLORBLIND_PALETTE_DARK : COLORBLIND_PALETTE_LIGHT;
    default:
      return CLASSIC_PALETTE;
  }
}

/** The colors in force right now. */
function palette(): ChartPalette {
  return paletteFor(colorSchemeId);
}

/**
 * Hand the palette to the CSS side — the Stats table colors its numbers from
 * `--pyne-up`/`--pyne-down`, so they say up and down the same way the bars do.
 *
 * Set on the BODY, never on the root element: the theme observer watches the
 * root's `style` attribute (that is where the `--vscode-*` properties live), so
 * writing ours there would retrigger it on every repaint, forever.
 */
function publishPaletteVars(p: ChartPalette): void {
  const style = document.body?.style;
  if (!style) return;
  style.setProperty('--pyne-up', p.up);
  style.setProperty('--pyne-down', p.down);
  style.setProperty('--pyne-long', p.long);
  style.setProperty('--pyne-short', p.short);
}

/**
 * Re-express a palette color at partial opacity, for the fills that sit behind
 * something else (volume bars, the measure box). Handles the forms a theme
 * color can actually arrive in — `#rgb`, `#rrggbb`, `#rrggbbaa` and
 * `rgb()`/`rgba()`; anything else is handed back opaque rather than guessed at,
 * which merely looks heavier, never wrong.
 */
function withAlpha(color: string, alpha: number): string {
  const hex = /^#([0-9a-f]{3,8})$/i.exec(color.trim());
  if (hex) {
    const d = hex[1];
    const full = d.length === 3 || d.length === 4
      ? d.slice(0, 3).split('').map((c) => c + c).join('')
      : d.slice(0, 6);
    if (full.length !== 6) return color;
    const n = parseInt(full, 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
  }
  const rgb = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(color.trim());
  if (rgb) return `rgba(${rgb[1]}, ${rgb[2]}, ${rgb[3]}, ${alpha})`;
  return color;
}

/**
 * Legend styles, split out because the toolbar toggle re-applies them on the
 * live chart. `showRule` is a chart-store style: the tooltip views read it from
 * there, so switching it off hides the OHLCV block and every plot's values in
 * one go — the whole top-left overlay, not just parts of it.
 */
function legendStyles(): DeepPartial<Styles> {
  const text = cssVar('--vscode-editor-foreground', isDark() ? '#ccc' : '#333');
  const showRule = legendVisible ? 'always' : 'none';
  return {
    candle: { tooltip: { showRule, legend: { color: text } } },
    indicator: { tooltip: { showRule, legend: { color: text } } },
  };
}

/** KLineChart's own line/area styling, captured from a pristine chart before
 * the first setStyles. setStyles only ever MERGES, so switching away from Line
 * has to write the defaults back explicitly — there is no "unset" — and
 * hardcoding them here would silently drift on a lib bump. The candle BAR
 * colors need no such capture: every branch writes all nine from the palette.
 * Line/area is left alone on purpose — it plots one undirected close series, so
 * a scheme about up and down has nothing to say about it. */
let candleDefaults: { area: CandleAreaStyle } | undefined;

function captureCandleDefaults(chart: Chart): void {
  if (candleDefaults) return;
  // Deep copy: getStyles() hands back the live style object, which the very
  // next setStyles would mutate under us. Colors/numbers only, so JSON is safe.
  candleDefaults = {
    area: JSON.parse(JSON.stringify(chart.getStyles().candle.area)) as CandleAreaStyle,
  };
}

/** barcolor paints over the chart's own bars, so it has to follow their shape;
 * read at draw time, so a style switch needs no indicator rebuild. */
function barcolorShape(): BarcolorShape {
  if (isPriceLineStyle(candleStyleId)) return 'none';
  if (candleStyleId === 'bars') return 'bar';
  return candleStyleId === 'hollow' || candleStyleId === 'mono' ? 'hollow' : 'candle';
}

/** Every bar/wick/border color set to the editor foreground: up bars stay
 * distinguishable through the hollow/filled shape instead of hue. */
function monochromeBar(): DeepPartial<CandleBarColor> {
  const fg = cssVar('--vscode-editor-foreground', isDark() ? '#d4d4d4' : '#333333');
  return {
    upColor: fg, downColor: fg, noChangeColor: fg,
    upBorderColor: fg, downBorderColor: fg, noChangeBorderColor: fg,
    upWickColor: fg, downWickColor: fg, noChangeWickColor: fg,
  };
}

/** Bars whose open and close match exactly have no direction to color, so they
 * stay on KLineChart's neutral grey in every scheme. */
const NO_CHANGE_COLOR = '#76808f';

/** The nine candle-bar colors of the current scheme. Written in full by every
 * style branch, because setStyles merges: coming back from Monochrome has to
 * overwrite all nine, not just the ones that happen to differ. */
function paletteBar(p: ChartPalette): DeepPartial<CandleBarColor> {
  return {
    upColor: p.up, downColor: p.down, noChangeColor: NO_CHANGE_COLOR,
    upBorderColor: p.up, downBorderColor: p.down, noChangeBorderColor: NO_CHANGE_COLOR,
    upWickColor: p.up, downWickColor: p.down, noChangeWickColor: NO_CHANGE_COLOR,
  };
}

/** Map the persisted style id onto KLineChart's candle styles. Each branch
 * restates the full palette so switching between styles in any order lands on
 * the same picture. */
function candleStyles(): DeepPartial<Styles> {
  const bar = paletteBar(palette());
  // Spread copy, never the captured object itself: setStyles merges its
  // argument into the live styles, and an empty object is simply a no-op if the
  // defaults were somehow never captured.
  const area: DeepPartial<CandleAreaStyle> = { ...candleDefaults?.area };
  switch (candleStyleId) {
    case 'hollow':
      return { candle: { type: 'candle_up_stroke', bar } };
    case 'bars':
      return { candle: { type: 'ohlc', bar } };
    case 'mono':
      return { candle: { type: 'candle_up_stroke', bar: { ...bar, ...monochromeBar() } } };
    case 'line':
      // 'area' with a fully transparent fill — v10 has no separate line type.
      return { candle: { type: 'area', bar, area: { ...area, backgroundColor: 'rgba(0,0,0,0)' } } };
    case 'area':
      return { candle: { type: 'area', bar, area } };
    default:
      return { candle: { type: 'candle_solid', bar } };
  }
}

function chartStyles(): DeepPartial<Styles> {
  const dark = isDark();
  const text = cssVar('--vscode-editor-foreground', dark ? '#ccc' : '#333');
  const grid = dark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)';
  const axisLine = dark ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.2)';
  const legend = legendStyles();
  const candle = candleStyles();
  const p = palette();
  // The built-in VOL indicator takes its bar colors from the SHARED indicator
  // styles rather than from anything per-indicator, so setting them here is
  // what makes the volume pane follow the scheme. `bars` is merged index-wise
  // (KLineChart walks arrays as plain objects), so a partial first entry keeps
  // the rest of its styling.
  const volumeBar = { upColor: withAlpha(p.up, 0.7), downColor: withAlpha(p.down, 0.7) };
  return {
    grid: {
      horizontal: { color: grid },
      vertical: { color: grid },
    },
    candle: {
      priceMark: { last: { show: false } },
      ...candle.candle,
      ...legend.candle,
    },
    indicator: { ...legend.indicator, ohlc: volumeBar, bars: [volumeBar] },
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

/** Identity of the bars a run draws: the same script re-run on the same feed
 * keeps its view, a different symbol/timeframe starts fresh. */
function feedId(start: StartEvent): string {
  const s = start.syminfo;
  return `${s.tickerid ?? s.ticker ?? ''}|${s.period ?? ''}`;
}

/**
 * Snapshot the viewport so the next run can restore it. Undefined whenever
 * restoring would be wrong (nothing drawn yet, or the bars themselves change).
 */
function captureView(prev: RunState, next: StartEvent): ViewAnchor | undefined {
  if (!prev.bars.length || feedId(prev.start) !== feedId(next)) return undefined;
  const range = prev.chart.getVisibleRange();
  // `to` is clamped to the data, so `to >= bars.length` means the newest bar
  // still sits at the right edge. That is a RELATIVE position: pinning it to a
  // timestamp would stop a re-run that produced more bars from following them.
  const atRealtime = range.to >= prev.bars.length;
  const rightIndex = range.to - 1;
  return {
    barSpace: prev.chart.getBarSpace().bar,
    rightTimestamp: atRealtime ? null : prev.bars[rightIndex]?.timestamp ?? null,
    rightX: atRealtime ? undefined : barX(prev.chart, rightIndex),
  };
}

/** X pixel of a bar on the shared (candle-pane) x-axis; undefined before the
 * pane is laid out. */
function barX(chart: Chart, dataIndex: number): number | undefined {
  const point = chart.convertToPixel({ dataIndex }, { paneId: 'candle_pane' });
  const x = Array.isArray(point) ? point[0]?.x : point.x;
  return typeof x === 'number' && Number.isFinite(x) ? x : undefined;
}

/**
 * Put the view back where `captureView` found it. Called after every
 * `resetData()`, which resets the scroll to the newest bar: without an anchor
 * that IS the wanted behavior (a live run follows its bars).
 */
function restoreView(st: RunState): void {
  const anchor = st.viewAnchor;
  if (!anchor) {
    st.chart.scrollToRealTime(0);
    return;
  }
  st.chart.setBarSpace(anchor.barSpace);
  const index = anchor.rightTimestamp === null
    ? undefined
    : st.tsToIndex.get(anchor.rightTimestamp);
  // No anchor bar (the view followed the newest one, or it has not streamed in
  // yet): stay at the right edge — a later tick lands the anchor.
  if (index === undefined) {
    st.chart.scrollToRealTime(0);
    return;
  }
  // Coarse: puts the bar near the right edge. Then correct by the pixel it
  // actually landed on — scrolling by +d moves the content right by d px.
  st.chart.scrollToDataIndex(index, 0);
  const x = barX(st.chart, index);
  if (anchor.rightX !== undefined && x !== undefined && x !== anchor.rightX) {
    st.chart.scrollByDistance(anchor.rightX - x, 0);
  }
}

// --- Freeze frame ----------------------------------------------------------
// A run tears the chart down (dispose + init) and refills it bar by bar, which
// reads as a flash of empty chart. When the view is being preserved anyway,
// paint the last frame over the chart and lift it only once the new run has
// drawn — the old snapshot trick, far cheaper than double-buffering the whole
// run state, at the cost of a picture that cannot be interacted with (any
// input, or the deadline below, drops it early).

/** Longest a stale picture may stay up. A run streaming for longer should show
 * its progress instead, and a bridge that dies never sends `end` at all. */
const FREEZE_MAX_MS = 1500;

/** A re-run that finishes this fast needs no spinner — showing one would be a
 * blink of its own, which is exactly what the held frame is there to avoid. */
const BUSY_DELAY_MS = 250;

let freezeEl: HTMLCanvasElement | undefined;
let freezeDeadline: number | undefined;
let freezeSize: { width: number; height: number } | undefined;
let busyTimer: number | undefined;
const busyEl = document.getElementById('chart-busy') as HTMLDivElement | null;

function freezeChart(): void {
  unfreezeChart();
  const area = container.parentElement;
  const rect = container.getBoundingClientRect();
  if (!area || rect.width < 1 || rect.height < 1) return;
  const dpr = window.devicePixelRatio || 1;
  const snap = document.createElement('canvas');
  snap.width = Math.round(rect.width * dpr);
  snap.height = Math.round(rect.height * dpr);
  const ctx = snap.getContext('2d');
  if (!ctx) return;
  ctx.scale(dpr, dpr);
  // KLineChart paints on transparent canvases (the background is the webview's
  // own), so the snapshot needs that background painted in — otherwise the
  // chart rebuilding underneath would show through the held picture.
  const bodyBg = getComputedStyle(document.body).backgroundColor;
  ctx.fillStyle =
    bodyBg && bodyBg !== 'rgba(0, 0, 0, 0)' && bodyBg !== 'transparent'
      ? bodyBg
      : cssVar('--vscode-editor-background', isDark() ? '#1e1e1e' : '#ffffff');
  ctx.fillRect(0, 0, rect.width, rect.height);
  // Document order is paint order: every pane canvas shares the same z-index,
  // and the per-pane overlay canvas is transparent above its main canvas.
  container.querySelectorAll('canvas').forEach((canvas) => {
    const r = canvas.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return;
    ctx.drawImage(canvas, r.left - rect.left, r.top - rect.top, r.width, r.height);
  });
  // Under #pyne-tables (z-index 4): HTML cannot be rasterized into the
  // snapshot, so that layer keeps its own old content until the reveal.
  snap.style.cssText =
    'position:absolute;inset:0;z-index:3;pointer-events:none;width:100%;height:100%;';
  area.appendChild(snap);
  freezeEl = snap;
  freezeSize = { width: rect.width, height: rect.height };
  freezeDeadline = window.setTimeout(unfreezeChart, FREEZE_MAX_MS);
  busyTimer = window.setTimeout(() => {
    busyTimer = undefined;
    if (busyEl) busyEl.hidden = false;
  }, BUSY_DELAY_MS);
}

function isFrozen(): boolean {
  return freezeEl !== undefined;
}

/** A snapshot taken at another size would stretch with the area it covers, so
 * a real resize drops it. Same-size relayouts (the bottom panel reopening at
 * the end of a strategy run) must NOT, or the reveal loses its paint delay. */
function unfreezeIfResized(): void {
  if (!freezeEl || !freezeSize) return;
  const rect = container.getBoundingClientRect();
  if (
    Math.abs(rect.width - freezeSize.width) > 0.5 ||
    Math.abs(rect.height - freezeSize.height) > 0.5
  ) {
    unfreezeChart();
  }
}

function unfreezeChart(): void {
  if (freezeDeadline !== undefined) {
    clearTimeout(freezeDeadline);
    freezeDeadline = undefined;
  }
  if (busyTimer !== undefined) {
    clearTimeout(busyTimer);
    busyTimer = undefined;
  }
  if (busyEl) busyEl.hidden = true;
  if (!freezeEl) return;
  freezeEl.remove();
  freezeEl = undefined;
  freezeSize = undefined;
  // The layers left untouched while frozen catch up in one go.
  if (state) {
    state.renderedTableVersion = -1;
    renderDrawingTables(state);
  }
  renderTables();
  drawPerformance();
}

/** Lift the freeze once the new chart has really painted: klinecharts lays out
 * from a microtask, so the next frame is the first one that shows it. */
function unfreezeAfterPaint(): void {
  if (!freezeEl) return;
  requestAnimationFrame(() => requestAnimationFrame(unfreezeChart));
}

function startRun(start: StartEvent): void {
  measureOverlayId = undefined;
  measureDrawing = false;
  tbMeasureEl?.classList.remove('active');
  tbMeasureEl?.setAttribute('aria-pressed', 'false');
  activeTab = start.scriptType === 'strategy' ? 'performance' : 'trades';
  let viewAnchor: ViewAnchor | undefined;
  if (state) {
    viewAnchor = captureView(state, start);
    // Same script, same feed: hold the picture over the teardown and refill.
    // A different feed must not keep showing bars it no longer draws.
    if (viewAnchor) freezeChart();
    dispose(state.chart);
  }
  container.innerHTML = '';
  const chart = init(container);
  if (!chart) return;

  captureCandleDefaults(chart);
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
    breakpointOverlays: new Map(),
    viewAnchor,
  };
  // The bottom panel is part of the held picture too: emptying its rows and
  // equity curve while the chart still shows the old run would be the same
  // flicker one layer down.
  if (!isFrozen()) renderTables();
  renderPlotList(state);
  // While frozen the old tables stay up (they sit above the snapshot and are
  // its missing half); the reveal clears and rebuilds them together.
  const tables = isFrozen() ? null : document.getElementById('pyne-tables');
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
  // The y-axis template belongs to the chart instance, and a run builds a new
  // one — re-apply the persisted scale or every re-run would drop back to
  // linear.
  applyPriceScale();
  syncBreakpointOverlays(state);
  syncToolbar();
  updateRealtimeButton();
}

function syncBreakpointOverlays(st: RunState): void {
  const wanted = new Map(chartBreakpointTargets.map((target) => [target.timestamp, target]));
  for (const [timestamp, rendered] of [...st.breakpointOverlays]) {
    const target = wanted.get(timestamp);
    if (target && target.enabled === rendered.enabled && target.count === rendered.count) continue;
    st.chart.removeOverlay({ id: rendered.id });
    st.breakpointOverlays.delete(timestamp);
  }

  for (const target of chartBreakpointTargets) {
    if (st.breakpointOverlays.has(target.timestamp)) continue;
    const dataIndex = st.tsToIndex.get(target.timestamp);
    const bar = dataIndex === undefined ? undefined : st.bars[dataIndex];
    if (dataIndex === undefined || !bar) continue;
    const id = st.chart.createOverlay({
      name: BREAKPOINT_OVERLAY_NAME,
      paneId: 'candle_pane',
      points: [{ timestamp: target.timestamp, dataIndex, value: bar.high }],
      extendData: target,
      lock: true,
      zLevel: 100,
    });
    if (typeof id === 'string') {
      st.breakpointOverlays.set(target.timestamp, {
        id,
        enabled: target.enabled,
        count: target.count,
      });
    }
  }
}

function selectBreakpointTimestamp(timestamp: number): void {
  if (
    breakpointPointerGesture?.dragged ||
    !breakpointSelectionLabel ||
    !Number.isSafeInteger(timestamp) ||
    timestamp < 0
  ) return;
  breakpointSelectionLabel = undefined;
  syncBreakpointSelectionUi();
  vscode.postMessage({ type: 'selectBreakpointBar', timestamp });
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
    shortName: NO_LEGEND,
    figures: [],
    calc: () => [],
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
    shortName: NO_LEGEND,
    figures: [],
    calc: () => [],
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
      shortName: NO_LEGEND,
      figures: [],
      calc: () => [],
      draw: (params: IndicatorDrawParams) => {
        drawBarcolors(drawEnv(st, params, true), barcolorMetas, barcolorShape());
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
    shortName: NO_LEGEND,
    figures: [],
    calc: () => [],
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

/** Theme and palette values for the trade markers, memoized on the body class
 * list plus the scheme id — VS Code swaps
 * vscode-light/vscode-dark/vscode-high-contrast there. Reading computed style
 * per marker per frame is a forced style recalc on the hot path, which is
 * exactly what the overlay implementation used to do. A color-only theme edit
 * moves neither half of the key, so `applyColorScheme` drops the memo outright
 * rather than relying on it. */
let tradeMarkerTheme: (TradeMarkerTheme & { key: string }) | undefined;

function markerTheme(): TradeMarkerTheme {
  const key = `${document.body.className}|${colorSchemeId}`;
  if (!tradeMarkerTheme || tradeMarkerTheme.key !== key) {
    const p = palette();
    tradeMarkerTheme = {
      key,
      textColor: cssVar('--vscode-editor-foreground', isDark() ? '#b2b5be' : '#434651'),
      // Derived from the editor BACKGROUND, not from `isDark()`: the fg/bg pair
      // is the one contrast a theme guarantees, and it lands correctly on the
      // high-contrast themes too, which the body-class check cannot tell apart.
      haloColor: withAlpha(
        cssVar('--vscode-editor-background', isDark() ? '#000000' : '#ffffff'),
        0.9,
      ),
      fontFamily: getComputedStyle(document.body).fontFamily || 'sans-serif',
      longColor: p.long,
      shortColor: p.short,
    };
  }
  return tradeMarkerTheme;
}

/** Rebuild the bar-index -> glyph map when the trade or bar count moved. The
 * stamp check keeps this off the per-frame path; a full rebuild (rather than
 * an incremental append) also absorbs the fact that open trades arrive after
 * the closed ones, so `st.trades` is not strictly chronological. */
function tradeMarkerIndex(st: RunState): TradeMarkerIndex {
  const built = st.tradeMarkersBuiltFor;
  if (
    !st.tradeMarkers ||
    !built ||
    built[0] !== st.trades.length ||
    built[1] !== st.bars.length
  ) {
    st.tradeMarkers = buildTradeMarkerIndex(st.trades, st.bars, st.tsToIndex);
    st.tradeMarkersBuiltFor = [st.trades.length, st.bars.length];
  }
  return st.tradeMarkers;
}

/**
 * Create/remove the figure-less trade-marker indicator. zLevel 3 puts it above
 * the plots (-1/0/1) and the drawing layer (2). Unlike the overlay API this
 * costs one draw call per frame and only touches the visible bar range, so no
 * marker cap is needed.
 */
function ensureTradeMarkerIndicator(st: RunState): void {
  const want = st.start.scriptType === 'strategy' && st.trades.length > 0;
  if (want && !st.tradeMarkerIndicatorId) {
    registerIndicator({
      name: TRADE_MARKER_INDICATOR_NAME,
      shortName: NO_LEGEND,
      figures: [],
      calc: () => [],
      draw: (params: IndicatorDrawParams) => {
        drawTradeMarkers(drawEnv(st, params, true), tradeMarkerIndex(st), markerTheme());
        return false;
      },
    } as never);
    st.tradeMarkerIndicatorId =
      st.chart.createIndicator(
        { name: TRADE_MARKER_INDICATOR_NAME, paneId: 'candle_pane', zLevel: 3 },
        true,
      ) ?? undefined;
  } else if (!want && st.tradeMarkerIndicatorId) {
    st.chart.removeIndicator({ id: st.tradeMarkerIndicatorId });
    st.tradeMarkerIndicatorId = undefined;
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

const breakpointsPopupEl = ((): HTMLDivElement | null => {
  if (!document.body) return null;
  const el = document.createElement('div');
  el.id = 'breakpoints-popup';
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
 * set. Indicator creation recalculates against KLineChart's retained data, so
 * resetting the data here is unnecessary and would jump the viewport to the
 * latest bar. */
function applyVisibility(st: RunState): void {
  assignPlotPanes(st);
  rebuildPlotIndicators(st);
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
  closeBreakpointsPopup();
  renderPlotList(state);
  plotsPopupEl.hidden = false;
  positionPlotsPopup();
  tbLayersEl?.classList.add('active');
  tbLayersEl?.setAttribute('aria-pressed', 'true');
}

function closePlotsPopup(): void {
  if (plotsPopupEl) plotsPopupEl.hidden = true;
  tbLayersEl?.classList.remove('active');
  tbLayersEl?.setAttribute('aria-pressed', 'false');
}

function togglePlotsPopup(): void {
  if (plotsPopupEl && !plotsPopupEl.hidden) closePlotsPopup();
  else openPlotsPopup();
}

// --- Chart style popup: how price itself is drawn --------------------------
// The same dropdown pattern as Layers, but single-choice. The pick is a
// persisted setting, so the webview does not own it: it asks the host, which
// stores it and pushes the new value back here and to every other open chart.

const candlePopupEl = ((): HTMLDivElement | null => {
  if (!document.body) return null;
  const el = document.createElement('div');
  el.id = 'candle-popup';
  el.hidden = true;
  document.body.appendChild(el);
  return el;
})();

/**
 * A 16×16 preview of each style, so the list is picked by eye rather than by
 * name — and drawn in the chart's ACTUAL colors (Hollow and Monochrome are the
 * same shape, and only the color tells them apart).
 */
function candleGlyph(id: CandleStyleId): string {
  const fg = cssVar('--vscode-editor-foreground', isDark() ? '#d4d4d4' : '#333333');
  const { up, down } = palette();
  const areaLine = typeof candleDefaults?.area.lineColor === 'string'
    ? candleDefaults.area.lineColor
    : fg;
  /** Body + wick of one candle; `filled` false leaves it hollow. */
  const candle = (x: number, top: number, bottom: number, color: string, filled: boolean): string =>
    `<path d="M${x + 2.5} ${top}V${bottom}" stroke="${color}"/>` +
    `<rect x="${x}" y="${top + 3}" width="5" height="${bottom - top - 6}" ` +
    `stroke="${color}" fill="${filled ? color : 'none'}"/>`;
  /** One OHLC bar: stem with the open tick left and the close tick right. */
  const bar = (x: number, top: number, bottom: number, color: string): string =>
    `<path d="M${x} ${top}V${bottom}M${x - 2.5} ${top + 3}H${x}M${x} ${bottom - 3}H${x + 2.5}" ` +
    `stroke="${color}"/>`;
  const linePath = 'M2 11.5 5.5 7.5 9 9.5 14 3.5';
  switch (id) {
    case 'hollow':
      return candle(2.5, 2, 13, up, false) + candle(8.5, 3, 14, down, true);
    case 'bars':
      return bar(4.5, 2, 13, up) + bar(11.5, 3, 14, down);
    case 'mono':
      return candle(2.5, 2, 13, fg, false) + candle(8.5, 3, 14, fg, true);
    case 'line':
      return `<path d="${linePath}" stroke="${areaLine}"/>`;
    case 'area':
      return `<path d="${linePath}V14H2Z" fill="${areaLine}" fill-opacity="0.4" stroke="none"/>` +
        `<path d="${linePath}" stroke="${areaLine}"/>`;
    default:
      return candle(2.5, 2, 13, up, true) + candle(8.5, 3, 14, down, true);
  }
}

/**
 * A scheme's preview: the price pair as two candle bodies, the trade pair as
 * the two marker triangles that sit on them. All four, because the trade colors
 * are half of what a colorblind user is choosing between.
 */
function schemeGlyph(id: ColorSchemeId): string {
  const p = paletteFor(id);
  const body = (x: number, color: string): string =>
    `<rect x="${x}" y="1.5" width="4.5" height="8" rx="1" style="fill:${color};stroke:none"/>`;
  return (
    body(2.5, p.up) +
    body(9, p.down) +
    `<path d="M4.75 11.5 7 15.5H2.5Z" style="fill:${p.long};stroke:none"/>` +
    `<path d="M11.25 15.5 9 11.5h4.5Z" style="fill:${p.short};stroke:none"/>`
  );
}

/** One popup row: glyph, label, and a check on the active one. */
function candlePopupRow(
  glyph: string,
  label: string,
  detail: string,
  active: boolean,
  onPick: () => void,
): HTMLDivElement {
  const row = document.createElement('div');
  row.className = 'candle-row';
  if (active) row.classList.add('active');
  row.title = detail;
  row.innerHTML =
    `<svg viewBox="0 0 16 16" aria-hidden="true">${glyph}</svg>` +
    `<span class="candle-name"></span><span class="candle-check">${active ? '✓' : ''}</span>`;
  const name = row.querySelector('.candle-name');
  if (name) name.textContent = label;
  row.addEventListener('click', (e) => {
    e.stopPropagation();
    closeCandlePopup();
    onPick();
  });
  return row;
}

/**
 * Two lists in one popup: how price is drawn, then which colors say up and
 * down. Both are persisted settings the host owns, so a pick is applied locally
 * for the immediate feedback and posted for the host to store — waiting for the
 * settings round trip would make the click feel laggy.
 */
function renderCandleList(): void {
  if (!candlePopupEl) return;
  candlePopupEl.innerHTML = '';
  for (const option of CANDLE_STYLE_OPTIONS) {
    candlePopupEl.appendChild(
      candlePopupRow(
        candleGlyph(option.id), option.label, option.detail, option.id === candleStyleId,
        () => {
          if (option.id === candleStyleId) return;
          candleStyleId = option.id;
          applyCandleStyle();
          vscode.postMessage({ type: 'setCandleStyle', style: option.id });
        }
      )
    );
  }

  const sep = document.createElement('div');
  sep.className = 'candle-sep';
  candlePopupEl.appendChild(sep);
  const section = document.createElement('div');
  section.className = 'candle-section';
  section.textContent = 'Colors';
  candlePopupEl.appendChild(section);

  for (const option of COLOR_SCHEME_OPTIONS) {
    candlePopupEl.appendChild(
      candlePopupRow(
        schemeGlyph(option.id), option.label, option.detail, option.id === colorSchemeId,
        () => {
          if (option.id === colorSchemeId) return;
          colorSchemeId = option.id;
          applyColorScheme();
          vscode.postMessage({ type: 'setColorScheme', scheme: option.id });
        }
      )
    );
  }
}

/** Repaint the live chart in the current style and refresh the button's
 * tooltip. Styles-only, so nothing recalculates and the viewport stays put. */
function applyCandleStyle(): void {
  state?.chart.setStyles(candleStyles());
  const label =
    CANDLE_STYLE_OPTIONS.find((o) => o.id === candleStyleId)?.label ?? candleStyleId;
  if (tbCandleEl) {
    tbCandleEl.title = `Chart style: ${label}`;
    tbCandleEl.setAttribute('aria-label', `Chart style: ${label}`);
  }
  if (candlePopupEl && !candlePopupEl.hidden) renderCandleList();
}

/**
 * Repaint everything the direction colors reach: the candles and volume bars
 * (through setStyles), the trade markers (through their memo), the equity curve
 * and the CSS side. Also the entry point for a live theme switch, which can
 * move the answer for the `theme` and `colorblind` schemes alike.
 *
 * Styles-only again — no resetData, so the viewport stays where the user left
 * it. The trade-marker memo is dropped outright rather than left to its key: a
 * single overridden theme color changes neither the body class nor the scheme.
 */
function applyColorScheme(): void {
  tradeMarkerTheme = undefined;
  publishPaletteVars(palette());
  state?.chart.setStyles(chartStyles());
  drawPerformance();
  if (candlePopupEl && !candlePopupEl.hidden) renderCandleList();
}

function positionCandlePopup(): void {
  if (!candlePopupEl || !tbCandleEl) return;
  const r = tbCandleEl.getBoundingClientRect();
  candlePopupEl.style.left = `${Math.round(r.left)}px`;
  candlePopupEl.style.top = `${Math.round(r.bottom + 3)}px`;
}

function openCandlePopup(): void {
  if (!candlePopupEl) return;
  closePlotsPopup();
  closeBreakpointsPopup();
  renderCandleList();
  candlePopupEl.hidden = false;
  positionCandlePopup();
  tbCandleEl?.classList.add('active');
  tbCandleEl?.setAttribute('aria-pressed', 'true');
}

function closeCandlePopup(): void {
  if (candlePopupEl) candlePopupEl.hidden = true;
  tbCandleEl?.classList.remove('active');
  tbCandleEl?.setAttribute('aria-pressed', 'false');
}

// --- Price scale controls: the A / L / % corner between the two axes --------
// Parked where a trading chart puts them — bottom-right, in the price axis
// column — because they belong to that axis, not to the chart-wide toolbar.
// L and % are the mapping (a persisted setting, host-owned like chart style);
// A toggles auto-fit — lit while the axis follows the visible bars, off while
// it stays locked where the user put it.

const scaleControlsEl = document.getElementById('scale-controls');
const scaleAutoEl = document.getElementById('sc-auto') as HTMLButtonElement | null;
const scaleLogEl = document.getElementById('sc-log') as HTMLButtonElement | null;
const scalePercentEl = document.getElementById('sc-percent') as HTMLButtonElement | null;

/** The price pane's y-axis, with the auto-fit members KLineChart implements at
 * runtime but leaves out of its published types. */
type PriceAxis = {
  getAutoCalcTickFlag?: () => boolean;
  setRange?: (range: unknown) => void;
  getRange: () => unknown;
};

function priceAxis(): PriceAxis | undefined {
  return state?.chart.getYAxes({ paneId: 'candle_pane' })[0] as PriceAxis | undefined;
}

/**
 * KLineChart drops the price axis out of auto-fit as soon as the user drags it
 * (`setRange` clears the flag) and only a double-click on the axis re-arms it.
 * The flag is readable at runtime but absent from the published types, hence
 * the guarded call — an unknown state simply reads as "auto", which is what a
 * fresh chart is.
 */
function isPriceAxisAuto(): boolean {
  const axis = priceAxis();
  return typeof axis?.getAutoCalcTickFlag === 'function' ? axis.getAutoCalcTickFlag() : true;
}

/**
 * Auto-fit on or off, the way a trading chart's `A` works: on, the price axis
 * keeps fitting the visible bars; off, the range stays exactly where it is
 * while you scroll. Turning it off is `setRange(getRange())` — the same call
 * a manual axis drag makes, which is what clears the flag in the first place.
 */
function setPriceAxisAuto(auto: boolean): void {
  const axis = priceAxis();
  if (!axis) return;
  if (auto) {
    // Re-applying the current template re-arms the flag and relays out.
    state?.chart.overrideYAxis({ paneId: 'candle_pane', name: priceScaleId });
  } else if (typeof axis.setRange === 'function') {
    axis.setRange(axis.getRange());
  }
  // Reads the flag back rather than assuming: if the private call is ever gone,
  // the button silently stays on instead of lying about the state.
  syncScaleControls();
}

/**
 * Point the price pane's y-axis at the chosen template and refresh the buttons.
 * `overrideYAxis` rebuilds the axis and relays out, but touches no data, so the
 * viewport and every drawn series stay where they are — the plot/drawing/marker
 * layers all go through `yAxis.convertToPixel`, which follows the new mapping.
 * It also re-arms auto-fit, which is exactly what the A button needs.
 */
function applyPriceScale(): void {
  state?.chart.overrideYAxis({ paneId: 'candle_pane', name: priceScaleId });
  syncScaleControls();
}

/** Reflect the current mapping and auto-fit state on the three corner buttons. */
function syncScaleControls(): void {
  if (scaleControlsEl) scaleControlsEl.hidden = !state;
  const option = (id: PriceScaleId): string => {
    const found = PRICE_SCALE_OPTIONS.find((o) => o.id === id);
    return found ? `${found.label} — ${found.detail}` : id;
  };
  const label =
    PRICE_SCALE_OPTIONS.find((o) => o.id === priceScaleId)?.label ?? priceScaleId;
  for (const [el, id] of [
    [scaleLogEl, 'logarithm'],
    [scalePercentEl, 'percentage'],
  ] as const) {
    if (!el) continue;
    const on = priceScaleId === id;
    el.classList.toggle('active', on);
    el.setAttribute('aria-pressed', String(on));
    el.title = on ? `${option(id)}\nClick to go back to ${option('normal')}` : option(id);
  }
  if (scaleAutoEl) {
    const auto = isPriceAxisAuto();
    scaleAutoEl.classList.toggle('active', auto);
    scaleAutoEl.setAttribute('aria-pressed', String(auto));
    scaleAutoEl.title = auto
      ? `${label} scale, auto-fitted to the visible bars\nClick to lock it where it is`
      : `${label} scale, locked\nClick to auto-fit it to the visible bars again`;
  }
}

/** Switch mapping (or back to Regular when the active one is clicked again),
 * apply it locally for an instant response, and let the host persist it. */
function pickPriceScale(id: PriceScaleId): void {
  const next = priceScaleId === id ? DEFAULT_PRICE_SCALE : id;
  if (next === priceScaleId) return;
  priceScaleId = next;
  applyPriceScale();
  vscode.postMessage({ type: 'setPriceScale', scale: next });
}

scaleLogEl?.addEventListener('click', () => pickPriceScale('logarithm'));
scalePercentEl?.addEventListener('click', () => pickPriceScale('percentage'));
scaleAutoEl?.addEventListener('click', () => setPriceAxisAuto(!isPriceAxisAuto()));

// A y-axis drag or wheel-zoom turns auto-fit off without any event to listen
// for, so the button state is refreshed after any pointer interaction with the
// chart. Reading the flag is a plain property read — cheap enough for this.
window.addEventListener('pointerup', () => syncScaleControls());
container.addEventListener('wheel', () => syncScaleControls(), { passive: true });

// --- Live re-theming -------------------------------------------------------
// Switching theme rewrites the `--vscode-*` custom properties on the document
// element, and swaps the `vscode-light|dark|high-contrast` class on the body.
// Everything styled by CSS follows on its own; what does NOT are the colors
// already handed to KLineChart through `setStyles` (grid, axis text, crosshair
// label, monochrome candles) and the canvases painted here — those keep the
// old theme until the next run rebuilds the chart.

let themeFrame: number | undefined;

function applyTheme(): void {
  themeFrame = undefined;
  // Same work as a scheme switch: setStyles only merges, so this must pass every
  // themed value, which is exactly what chartStyles() is.
  applyColorScheme();
}

/** Coalesce the burst of mutations one theme switch produces into one repaint. */
function scheduleThemeRefresh(): void {
  if (themeFrame !== undefined) return;
  themeFrame = requestAnimationFrame(applyTheme);
}

if (document.body) {
  const themeObserver = new MutationObserver(scheduleThemeRefresh);
  themeObserver.observe(document.body, { attributes: true, attributeFilter: ['class'] });
  // The custom properties live in the root element's inline style: a theme with
  // the same kind (dark -> dark) or a single overridden color never touches the
  // body class, so watching that alone would miss it.
  themeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['style'],
  });
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
    // resetData snaps the viewport to the newest bar: follow the freshly
    // streamed bars, or hold the position this run inherited.
    restoreView(st);
    if (paneChange || st.metaDirty) {
      st.metaDirty = false;
      rebuildPlotIndicators(st);
      renderPlotList(st);
    }
    if (!isFrozen()) drawPerformance();
    ensureDrawingIndicators(st);
    syncBreakpointOverlays(st);
    if (!isFrozen()) renderDrawingTables(st);
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
const tabPerformanceEl = document.getElementById('tab-performance');
const tabTradesEl = document.getElementById('tab-trades');
const tabStatsEl = document.getElementById('tab-stats');
const tabToggleEl = document.getElementById('tab-toggle');
const panelSplitterEl = document.getElementById('panel-splitter');
let activeTab: 'performance' | 'trades' | 'stats' = 'trades';
let bottomPanelHeight: number | undefined;
let panelResizeFrame: number | undefined;

const MIN_CHART_HEIGHT = 120;
const MIN_BOTTOM_PANEL_HEIGHT = 120;
const PANEL_KEYBOARD_STEP = 20;

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

function signed(v: number): string {
  return `${v > 0 ? '+' : ''}${fmt(v)}`;
}

function percent(v: number | null): string {
  return v === null ? '—' : `${v > 0 ? '+' : ''}${fmt(v)}%`;
}

function performanceMetric(
  label: string,
  value: string,
  sign: number | null,
  detail?: string
): string {
  const title = esc(`${label}: ${value}${detail ? ` (${detail})` : ''}`);
  return (
    `<div class="performance-metric" title="${title}">` +
    `<span class="performance-label">${esc(label)}</span>` +
    `<strong class="${signClass(sign)}">${esc(value)}</strong>` +
    (detail ? `<small>${esc(detail)}</small>` : '') +
    '</div>'
  );
}

function equitySummary(): EquitySummary | undefined {
  return state ? calculateEquitySummary(state.bars, state.start.initialCapital) : undefined;
}

function renderPerformance(): string {
  const summary = equitySummary();
  if (!summary) {
    return '<span class="muted">The equity curve appears as strategy bars are processed.</span>';
  }
  return (
    '<div class="performance-view">' +
    '<div class="performance-summary">' +
    performanceMetric('Cumulative P&L', signed(summary.pnl), summary.pnl, percent(summary.returnPct)) +
    performanceMetric(
      'Max run-up',
      signed(summary.maxRunup),
      summary.maxRunup,
      percent(summary.maxRunupPct)
    ) +
    performanceMetric(
      'Max drawdown',
      `−${fmt(summary.maxDrawdown)}`,
      -summary.maxDrawdown,
      summary.maxDrawdownPct === null ? '—' : `−${fmt(summary.maxDrawdownPct)}%`
    ) +
    performanceMetric('Final equity', fmt(summary.finalEquity), null) +
    '</div>' +
    '<div class="equity-chart-wrap">' +
    '<span class="equity-chart-title">Cumulative P&amp;L · full run</span>' +
    '<canvas id="equity-canvas"></canvas>' +
    '</div>' +
    '</div>'
  );
}

function drawPerformance(): void {
  if (activeTab !== 'performance' || bottomEl?.classList.contains('collapsed')) return;
  const canvas = document.getElementById('equity-canvas') as HTMLCanvasElement | null;
  const summary = equitySummary();
  if (!canvas || !summary) return;
  const p = palette();
  drawEquityCurve(canvas, summary, {
    foreground: cssVar('--vscode-editor-foreground', '#ccc'),
    muted: cssVar('--vscode-descriptionForeground', '#999'),
    grid: isDark() ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)',
    positive: p.up,
    negative: p.down,
  });
}

function bottomPanelLimits(): { min: number; max: number } {
  const toolbarHeight = document.getElementById('toolbar')?.getBoundingClientRect().height ?? 0;
  const splitterHeight = panelSplitterEl?.getBoundingClientRect().height ?? 0;
  const max = Math.max(
    27,
    document.body.clientHeight - toolbarHeight - splitterHeight - MIN_CHART_HEIGHT
  );
  return { min: Math.min(MIN_BOTTOM_PANEL_HEIGHT, max), max };
}

function resizeChartAndPerformance(): void {
  unfreezeIfResized();
  if (panelResizeFrame !== undefined) return;
  panelResizeFrame = requestAnimationFrame(() => {
    panelResizeFrame = undefined;
    state?.chart.resize();
    drawPerformance();
  });
}

function setBottomPanelHeight(height: number): void {
  if (!bottomEl) return;
  const { min, max } = bottomPanelLimits();
  bottomPanelHeight = Math.round(Math.min(max, Math.max(min, height)));
  bottomEl.style.setProperty('--bottom-height', `${bottomPanelHeight}px`);
  panelSplitterEl?.setAttribute('aria-valuemin', String(Math.round(min)));
  panelSplitterEl?.setAttribute('aria-valuemax', String(Math.round(max)));
  panelSplitterEl?.setAttribute('aria-valuenow', String(bottomPanelHeight));
  resizeChartAndPerformance();
}

function setCollapsed(collapsed: boolean): void {
  if (!bottomEl) return;
  bottomEl.classList.toggle('collapsed', collapsed);
  if (panelSplitterEl) panelSplitterEl.hidden = collapsed;
  if (tabToggleEl) tabToggleEl.textContent = collapsed ? '▴' : '▾';
  if (!collapsed) {
    const currentHeight = bottomPanelHeight ?? bottomEl.getBoundingClientRect().height;
    setBottomPanelHeight(currentHeight);
  } else {
    resizeChartAndPerformance();
  }
}

panelSplitterEl?.addEventListener('pointerdown', (event) => {
  if (event.button !== 0 || !bottomEl || bottomEl.classList.contains('collapsed')) return;
  event.preventDefault();
  const pointerId = event.pointerId;
  const startY = event.clientY;
  const startHeight = bottomEl.getBoundingClientRect().height;
  panelSplitterEl.setPointerCapture(pointerId);
  document.body.classList.add('panel-resizing');

  const move = (moveEvent: PointerEvent): void => {
    if (moveEvent.pointerId !== pointerId) return;
    setBottomPanelHeight(startHeight + startY - moveEvent.clientY);
  };
  const finish = (finishEvent: PointerEvent): void => {
    if (finishEvent.pointerId !== pointerId) return;
    panelSplitterEl.removeEventListener('pointermove', move);
    panelSplitterEl.removeEventListener('pointerup', finish);
    panelSplitterEl.removeEventListener('pointercancel', finish);
    document.body.classList.remove('panel-resizing');
    if (panelSplitterEl.hasPointerCapture(pointerId)) {
      panelSplitterEl.releasePointerCapture(pointerId);
    }
  };

  panelSplitterEl.addEventListener('pointermove', move);
  panelSplitterEl.addEventListener('pointerup', finish);
  panelSplitterEl.addEventListener('pointercancel', finish);
});

panelSplitterEl?.addEventListener('keydown', (event) => {
  if (!bottomEl || bottomEl.classList.contains('collapsed')) return;
  if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
  event.preventDefault();
  const direction = event.key === 'ArrowUp' ? 1 : -1;
  setBottomPanelHeight(bottomEl.getBoundingClientRect().height + direction * PANEL_KEYBOARD_STEP);
});

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
  tabPerformanceEl?.classList.toggle('active', activeTab === 'performance');
  tabTradesEl?.classList.toggle('active', activeTab === 'trades');
  tabStatsEl?.classList.toggle('active', activeTab === 'stats');
  if (tabPerformanceEl) tabPerformanceEl.hidden = state?.start.scriptType !== 'strategy';
  if (tabTradesEl && state) tabTradesEl.textContent = `Trades (${state.trades.length})`;
  if (bottomEl.classList.contains('collapsed')) return;
  tabBodyEl.innerHTML =
    activeTab === 'performance'
      ? renderPerformance()
      : activeTab === 'trades'
        ? renderTrades()
        : renderStats();
  requestAnimationFrame(drawPerformance);
}

tabPerformanceEl?.addEventListener('click', () => {
  activeTab = 'performance';
  setCollapsed(false);
  renderTables();
});
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

// --- Top toolbar: data / layers / measure / go-to-date / CSV ---------------
// Elements are absent in standalone test harnesses; every access is guarded.

const tbDataEl = document.getElementById('tb-data') as HTMLButtonElement | null;
const tbLayersEl = document.getElementById('tb-layers') as HTMLButtonElement | null;
const tbCandleEl = document.getElementById('tb-candle') as HTMLButtonElement | null;
const tbLegendEl = document.getElementById('tb-legend') as HTMLButtonElement | null;
const tbMeasureEl = document.getElementById('tb-measure') as HTMLButtonElement | null;
const tbGotoEl = document.getElementById('tb-goto') as HTMLButtonElement | null;
const tbBreakpointsEl = document.getElementById('tb-breakpoints') as HTMLButtonElement | null;
const tbBreakpointsCountEl = document.getElementById('tb-breakpoints-count');
const tbSymbolNameEl = document.getElementById('tb-symbol-name');
const tbSymbolPeriodEl = document.getElementById('tb-symbol-period');
const gotoPopupEl = document.getElementById('goto-popup') as HTMLDivElement | null;
const tbGotoInputEl = document.getElementById('tb-goto-input') as HTMLInputElement | null;
const tbGotoDoEl = document.getElementById('tb-goto-do');
const tbCsvPlotEl = document.getElementById('tb-csv-plot') as HTMLButtonElement | null;
const tbCsvTradesEl = document.getElementById('tb-csv-trades') as HTMLButtonElement | null;
const breakpointPickEl = document.getElementById('breakpoint-pick') as HTMLDivElement | null;
const breakpointPickLabelEl = document.getElementById('breakpoint-pick-label');
const breakpointPickCancelEl = document.getElementById('breakpoint-pick-cancel');

function syncBreakpointSelectionUi(): void {
  if (!breakpointPickEl) return;
  breakpointPickEl.hidden = !breakpointSelectionLabel;
  if (breakpointPickLabelEl) {
    breakpointPickLabelEl.textContent = breakpointSelectionLabel
      ? `Select a bar for ${breakpointSelectionLabel}`
      : '';
  }
}

function renderBreakpointList(): void {
  if (!breakpointsPopupEl) return;
  breakpointsPopupEl.innerHTML = '';
  for (const target of chartBreakpointTargets) {
    const row = document.createElement('div');
    row.className = 'breakpoint-row';
    row.title = 'Jump to this breakpoint';

    const dot = document.createElement('span');
    dot.className = 'breakpoint-dot';
    dot.style.background = target.enabled
      ? cssVar('--vscode-debugIcon-breakpointForeground', '#e51400')
      : cssVar('--vscode-debugIcon-breakpointDisabledForeground', '#848484');

    const label = document.createElement('span');
    label.className = 'breakpoint-label';
    const dataIndex = state?.tsToIndex.get(target.timestamp);
    label.textContent = `${fmtTime(target.timestamp)}${
      dataIndex === undefined ? '' : ` · bar ${dataIndex}`
    }${target.count > 1 ? ` · ${target.count} breakpoints` : ''}`;

    const remove = document.createElement('button');
    remove.className = 'breakpoint-delete';
    remove.type = 'button';
    remove.title = 'Remove this chart breakpoint';
    remove.setAttribute('aria-label', `Remove breakpoint at ${fmtTime(target.timestamp)}`);
    remove.textContent = '×';
    remove.addEventListener('click', (event) => {
      event.stopPropagation();
      remove.disabled = true;
      vscode.postMessage({ type: 'removeBreakpointBar', timestamp: target.timestamp });
    });

    row.append(dot, label, remove);
    row.addEventListener('click', (event) => {
      event.stopPropagation();
      state?.chart.scrollToTimestamp(target.timestamp, 200);
    });
    breakpointsPopupEl.appendChild(row);
  }
}

function positionBreakpointsPopup(): void {
  if (!breakpointsPopupEl || !tbBreakpointsEl) return;
  const r = tbBreakpointsEl.getBoundingClientRect();
  const maxLeft = Math.max(6, window.innerWidth - breakpointsPopupEl.offsetWidth - 6);
  breakpointsPopupEl.style.left = `${Math.round(Math.min(Math.max(6, r.left), maxLeft))}px`;
  breakpointsPopupEl.style.top = `${Math.round(r.bottom + 3)}px`;
}

function openBreakpointsPopup(): void {
  if (!breakpointsPopupEl || !chartBreakpointTargets.length) return;
  closePlotsPopup();
  closeGotoPopup();
  closeCandlePopup();
  renderBreakpointList();
  breakpointsPopupEl.hidden = false;
  tbBreakpointsEl?.classList.add('active');
  tbBreakpointsEl?.setAttribute('aria-pressed', 'true');
  positionBreakpointsPopup();
}

function closeBreakpointsPopup(): void {
  if (breakpointsPopupEl) breakpointsPopupEl.hidden = true;
  tbBreakpointsEl?.classList.remove('active');
  tbBreakpointsEl?.setAttribute('aria-pressed', 'false');
}

function syncBreakpointControls(): void {
  const visible = chartBreakpointTargets.length > 0;
  if (tbBreakpointsEl) {
    tbBreakpointsEl.hidden = !visible;
    tbBreakpointsEl.title = visible
      ? `Chart breakpoints (${chartBreakpointTargets.length})`
      : 'Chart breakpoints';
    tbBreakpointsEl.setAttribute(
      'aria-label',
      visible ? `Chart breakpoints (${chartBreakpointTargets.length})` : 'Chart breakpoints'
    );
  }
  if (tbBreakpointsCountEl) {
    tbBreakpointsCountEl.textContent = chartBreakpointTargets.length > 99
      ? '99+'
      : String(chartBreakpointTargets.length);
  }
  if (!visible) closeBreakpointsPopup();
  else if (breakpointsPopupEl && !breakpointsPopupEl.hidden) {
    renderBreakpointList();
    positionBreakpointsPopup();
  }
}

function cancelBreakpointSelection(): void {
  if (!breakpointSelectionLabel) return;
  breakpointSelectionLabel = undefined;
  syncBreakpointSelectionUi();
  vscode.postMessage({ type: 'cancelBreakpointSelection' });
}

breakpointPickCancelEl?.addEventListener('click', cancelBreakpointSelection);
container.addEventListener('pointerdown', (event) => {
  if (event.button !== 0) {
    breakpointPointerGesture = undefined;
    return;
  }
  breakpointPointerGesture = {
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    dragged: false,
  };
}, true);
container.addEventListener('pointermove', (event) => {
  const gesture = breakpointPointerGesture;
  if (!gesture || gesture.pointerId !== event.pointerId || gesture.dragged) return;
  gesture.dragged =
    Math.abs(event.clientX - gesture.startX) > BREAKPOINT_CLICK_DRAG_THRESHOLD_PX ||
    Math.abs(event.clientY - gesture.startY) > BREAKPOINT_CLICK_DRAG_THRESHOLD_PX;
}, true);
container.addEventListener('pointercancel', () => {
  breakpointPointerGesture = undefined;
}, true);
container.addEventListener('click', (event) => {
  const dragged = breakpointPointerGesture?.dragged === true;
  breakpointPointerGesture = undefined;
  if (dragged || !breakpointSelectionLabel || !state) return;

  const bounds = container.getBoundingClientRect();
  const converted = state.chart.convertFromPixel(
    [{ x: event.clientX - bounds.left }],
    { paneId: 'candle_pane' }
  );
  const point = Array.isArray(converted) ? converted[0] : converted;
  if (typeof point?.timestamp === 'number') selectBreakpointTimestamp(point.timestamp);
});

interface DataPresentation {
  symbol: string;
  period: string;
}

function textValue(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
}

/** TradingView-style instrument identity, preferring syminfo and gracefully
 * cleaning legacy provider_symbol_period file stems. */
function dataPresentation(st?: RunState): DataPresentation {
  if (!st) return { symbol: 'Select data', period: '' };
  const info = st.start.syminfo;
  const dataPath = st.start.data;
  const base = (dataPath.split(/[\\/]/).pop() ?? dataPath).replace(/\.ohlcv$/i, '');
  const stemParts = base.split('_').filter(Boolean);
  const lastStemPart = stemParts[stemParts.length - 1] ?? '';
  const stemPeriod = stemParts.length > 2 && /^\d*[SDWM]?$/i.test(lastStemPart)
    ? stemParts.pop() ?? ''
    : '';
  const stemPrefix = stemParts.length > 1 ? stemParts.shift() ?? '' : '';
  const stemTicker = stemParts.join('_') || base;

  const ticker = textValue(info.ticker) || stemTicker;
  const tickerId = textValue(info.tickerid);
  const prefix = textValue(info.prefix) || stemPrefix;
  const symbol = tickerId.includes(':')
    ? tickerId
    : prefix && ticker
      ? `${prefix}:${ticker}`
      : tickerId || ticker || 'Select data';
  return {
    symbol: symbol.toUpperCase(),
    period: textValue(info.period) || textValue(info.timeframe) || stemPeriod,
  };
}

/** Reflect current run state onto the toolbar (data, volume, CSV). */
function syncToolbar(): void {
  const st = state;
  const data = dataPresentation(st);
  if (tbSymbolNameEl) tbSymbolNameEl.textContent = data.symbol;
  if (tbSymbolPeriodEl) tbSymbolPeriodEl.textContent = data.period;
  if (tbDataEl) {
    const detail = data.period ? `${data.symbol} · ${data.period}` : data.symbol;
    tbDataEl.title = `Select OHLCV data\n${detail}`;
    tbDataEl.setAttribute('aria-label', `Select OHLCV data. Current: ${detail}`);
  }
  if (tbMeasureEl) tbMeasureEl.disabled = !st;
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
  closeCandlePopup();
  togglePlotsPopup();
});

tbCandleEl?.addEventListener('click', (e) => {
  e.stopPropagation();
  closeGotoPopup();
  if (candlePopupEl?.hidden === false) closeCandlePopup();
  else openCandlePopup();
});

/** Reflect `legendVisible` on the button and, when a chart exists, on it. The
 * button reads as "hiding is on", so it lights up with the legend switched off
 * — that is the state worth signalling; a legend on screen speaks for itself. */
function applyLegendVisibility(): void {
  state?.chart.setStyles(legendStyles());
  const label = legendVisible ? 'Hide the chart legend' : 'Show the chart legend';
  if (tbLegendEl) {
    tbLegendEl.classList.toggle('active', !legendVisible);
    tbLegendEl.setAttribute('aria-pressed', String(!legendVisible));
    tbLegendEl.title = label;
    tbLegendEl.setAttribute('aria-label', label);
  }
}

tbLegendEl?.addEventListener('click', () => {
  legendVisible = !legendVisible;
  applyLegendVisibility();
});

tbBreakpointsEl?.addEventListener('click', (event) => {
  event.stopPropagation();
  if (breakpointsPopupEl?.hidden) openBreakpointsPopup();
  else closeBreakpointsPopup();
});

let measureOverlayId: string | undefined;
let measureDrawing = false;

function clearMeasureState(): void {
  measureOverlayId = undefined;
  measureDrawing = false;
  tbMeasureEl?.classList.remove('active');
  tbMeasureEl?.setAttribute('aria-pressed', 'false');
}

function removeMeasurement(): void {
  const st = state;
  const id = measureOverlayId;
  clearMeasureState();
  if (st && id) st.chart.removeOverlay({ id });
}

function toggleMeasureDrawing(): void {
  if (measureOverlayId) {
    removeMeasurement();
    return;
  }
  const st = state;
  if (!st) return;
  closePlotsPopup();
  closeGotoPopup();
  closeBreakpointsPopup();
  closeCandlePopup();
  const id = st.chart.createOverlay({
    name: MEASURE_OVERLAY_NAME,
    paneId: 'candle_pane',
    onDrawEnd: ({ overlay }) => {
      if (overlay.id === measureOverlayId) measureDrawing = false;
    },
    onRemoved: ({ overlay }) => {
      if (overlay.id === measureOverlayId) clearMeasureState();
    },
  });
  if (typeof id !== 'string') return;
  measureOverlayId = id;
  measureDrawing = true;
  tbMeasureEl?.classList.add('active');
  tbMeasureEl?.setAttribute('aria-pressed', 'true');
}

tbMeasureEl?.addEventListener('click', toggleMeasureDrawing);

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  if (breakpointSelectionLabel) {
    event.preventDefault();
    cancelBreakpointSelection();
    return;
  }
  if (breakpointsPopupEl && !breakpointsPopupEl.hidden) {
    event.preventDefault();
    closeBreakpointsPopup();
    return;
  }
  if (candlePopupEl && !candlePopupEl.hidden) {
    event.preventDefault();
    closeCandlePopup();
    return;
  }
  if (!measureDrawing) return;
  event.preventDefault();
  removeMeasurement();
});

// Close the plots popup on any click outside it (and outside its button).
document.addEventListener('click', (e) => {
  if (!plotsPopupEl || plotsPopupEl.hidden) return;
  const t = e.target as Node;
  if (plotsPopupEl.contains(t) || tbLayersEl?.contains(t)) return;
  closePlotsPopup();
});

document.addEventListener('click', (event) => {
  if (!breakpointsPopupEl || breakpointsPopupEl.hidden) return;
  const target = event.target as Node;
  if (breakpointsPopupEl.contains(target) || tbBreakpointsEl?.contains(target)) return;
  closeBreakpointsPopup();
});

document.addEventListener('click', (event) => {
  if (!candlePopupEl || candlePopupEl.hidden) return;
  const target = event.target as Node;
  if (candlePopupEl.contains(target) || tbCandleEl?.contains(target)) return;
  closeCandlePopup();
});

window.addEventListener('resize', () => {
  if (plotsPopupEl && !plotsPopupEl.hidden) positionPlotsPopup();
  if (candlePopupEl && !candlePopupEl.hidden) positionCandlePopup();
  if (breakpointsPopupEl && !breakpointsPopupEl.hidden) positionBreakpointsPopup();
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
  closeBreakpointsPopup();
  closeCandlePopup();
  gotoPopupEl.hidden = false;
  tbGotoEl?.classList.add('active');
  tbGotoEl?.setAttribute('aria-pressed', 'true');
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
  tbGotoEl?.setAttribute('aria-pressed', 'false');
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
    case 'breakpoints':
      chartBreakpointTargets = msg.targets;
      if (state) syncBreakpointOverlays(state);
      syncBreakpointControls();
      break;
    case 'candleStyle':
      candleStyleId = msg.style;
      applyCandleStyle();
      break;
    case 'priceScale':
      // Re-applying the same mapping would re-arm auto-fit, silently undoing a
      // locked scale — and the host pushes the setting on every webview load
      // and every settings change, not only on a real switch.
      if (msg.scale === priceScaleId) break;
      priceScaleId = msg.scale;
      applyPriceScale();
      break;
    case 'colorScheme':
      colorSchemeId = msg.scheme;
      applyColorScheme();
      break;
    case 'breakpointSelection':
      breakpointSelectionLabel = msg.label;
      breakpointPointerGesture = undefined;
      syncBreakpointSelectionUi();
      break;
    case 'end':
      if (state) {
        state.ended = true;
        state.dirty = false;
        assignPlotPanes(state);
        state.chart.resetData();
        restoreView(state);
        // Final position reached; from here the view belongs to the user again.
        state.viewAnchor = undefined;
        rebuildPlotIndicators(state);
        renderPlotList(state);
        ensureDrawingIndicators(state);
        syncBreakpointOverlays(state);
        if (!isFrozen()) renderDrawingTables(state);
        ensureTradeMarkerIndicator(state);
        if (state.start.scriptType === 'strategy') {
          activeTab = 'performance';
          setCollapsed(false);
        }
        renderTables();
        syncToolbar();
        // The new chart is complete: swap the held picture for it.
        unfreezeAfterPaint();
      }
      break;
  }
});

window.addEventListener('resize', () => {
  unfreezeIfResized();
  if (bottomPanelHeight !== undefined && !bottomEl?.classList.contains('collapsed')) {
    setBottomPanelHeight(bottomPanelHeight);
  } else {
    resizeChartAndPerformance();
  }
});

// A held picture is not interactive (no crosshair, no scroll), so the first
// input on the chart gives the live one back even mid-run.
container.parentElement?.addEventListener('pointerdown', unfreezeChart);
container.parentElement?.addEventListener('wheel', unfreezeChart, { passive: true });

vscode.postMessage({ type: 'ready' });
