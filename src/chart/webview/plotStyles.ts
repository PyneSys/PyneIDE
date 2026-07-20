/**
 * Meta-driven plot rendering: maps pynecore PlotMeta records onto KLineChart
 * indicator figures (real Pine colors/styles instead of the palette-by-index
 * fallback). A1+A2 scope: kind 'plot' (line/linebr/histogram/columns/circles/
 * cross/stepline/steplinebr), kind 'hline' as a constant line figure, and
 * kind 'shape'/'char' markers painted by the group indicator's draw callback
 * (a figure datum's value would feed the y-axis autoscale — see
 * drawMarkers). A3 adds the draw-callback layer: area fills, plotarrow,
 * bgcolor (a zLevel -1 indicator painting with destination-over, i.e. behind
 * the candles) and trackprice lines. A4 completes the family: plotcandle/
 * plotbar (four value columns fed to the y-axis autoscale through paint-less
 * figures, bodies painted by the draw callback), barcolor (repaints the
 * built-in candles) and fill (plot–plot / hline–hline, solid or gradient).
 * Verified v10 behaviors this relies on: a null datum breaks a line figure
 * (linebr comes for free), per-datum styles apply per line segment, a line
 * figure's segment coordinates are overridable via attrs (steplines), a text
 * figure's content is overridable via its attrs callback, and tooltip
 * legends skip figures without a string title.
 */
import type { ColorEnc, PlotMetaRecord } from '../../run/bridgeClient';

export type PaneTarget = 'overlay' | 'pane' | 'hidden';

/** Kinds the chart can currently render (everything else is hidden). */
const RENDERABLE_KINDS = new Set([
  'plot',
  'shape',
  'char',
  'hline',
  'arrow',
  'bgcolor',
  'candle',
  'bar',
  'barcolor',
  'fill',
]);

/** Stand-in for na colors: the datum keeps its slot but paints nothing. */
const TRANSPARENT = '#00000000';

/** A datum record produced by the plot indicators' calc: figure values plus
 * resolved per-bar colors for dynamic plots (string) — null means na color,
 * absent means "before the first change" (use the static color). */
export type PlotDatum = Record<string, number | string | null | undefined>;

/** Pane-visibility of a `display` name: Pine's display.* is "show only
 * here", so anything except 'all'/'pane' hides the plot from the chart pane
 * (data_window/status_line/price_scale belong to F9C UI surfaces). */
function paneVisible(display: string | undefined): boolean {
  return display === undefined || display === 'all' || display === 'pane';
}

/** Which pane a plot renders in; 'hidden' = not rendered at all. A key
 * without a meta (pynecore < 6.6) keeps the legacy script-level behavior.
 * hline has no force_overlay, so it simply follows the script pane. */
export function paneFor(
  meta: PlotMetaRecord | undefined,
  scriptOverlay: boolean
): PaneTarget {
  if (!meta) return scriptOverlay ? 'overlay' : 'pane';
  if (!RENDERABLE_KINDS.has(meta.kind) || !paneVisible(meta.display)) return 'hidden';
  return meta.force_overlay || scriptOverlay ? 'overlay' : 'pane';
}

/** Highest declared precision among the pane's members (fallback when none
 * of them declares one). */
export function panePrecision(
  metas: Array<PlotMetaRecord | undefined>,
  fallback: number
): number {
  let p = -1;
  for (const m of metas) {
    if (typeof m?.precision === 'number') p = Math.max(p, m.precision);
  }
  return p >= 0 ? p : fallback;
}

/** Per-figure pixel coordinates the framework hands to attrs callbacks:
 * `x` plus one entry per figure key that resolved to a number. */
type FigureCoordinate = Record<string, number | undefined> & { x: number };

export interface PlotFigureSpec {
  key: string;
  /** Tooltip legend label; figures without one stay out of the tooltip. */
  title?: string;
  type: string;
  baseValue?: number;
  attrs?: (params: {
    barSpace: { halfGapBar: number };
    coordinate: {
      prev: FigureCoordinate;
      current: FigureCoordinate;
      next: FigureCoordinate;
    };
  }) => Record<string, unknown>;
  styles: (params: { data: { current?: PlotDatum | null } }) => Record<string, unknown>;
}

/**
 * Build the KLineChart figure for one plot. `colorKey` names the datum field
 * carrying the resolved per-bar color (filled by the indicator's calc via
 * ColorTrack) — only read when the meta is dynamic.
 */
export function buildFigure(
  meta: PlotMetaRecord | undefined,
  key: string,
  colorKey: string,
  title: string,
  fallbackColor: string
): PlotFigureSpec {
  const linewidth = meta?.linewidth ?? 1;
  const staticColor = meta?.color ?? fallbackColor;
  const dynamic = meta?.dynamic === true;
  const colorOf = (datum: PlotDatum | null | undefined): string => {
    if (!dynamic) return staticColor;
    const c = datum?.[colorKey];
    if (typeof c === 'string') return c;
    return c === null ? TRANSPARENT : staticColor;
  };

  switch (meta?.style) {
    case 'histogram':
    case 'columns':
      return {
        key,
        title,
        type: 'bar',
        baseValue: meta.histbase ?? 0,
        // Pine draws histograms as thin bars, columns near bar-wide.
        attrs:
          meta.style === 'histogram'
            ? ({ barSpace }) => ({ width: Math.max(1, barSpace.halfGapBar) })
            : undefined,
        styles: ({ data }) => ({ color: colorOf(data.current) }),
      };
    case 'circles':
      return {
        key,
        title,
        type: 'circle',
        attrs: () => ({ r: Math.max(2, linewidth + 1) }),
        styles: ({ data }) => ({ color: colorOf(data.current) }),
      };
    case 'cross':
      return {
        key,
        title,
        type: 'text',
        attrs: () => ({ text: '✚' }),
        styles: ({ data }) => ({
          color: colorOf(data.current),
          backgroundColor: 'transparent',
          size: 8 + linewidth * 2,
        }),
      };
    case 'stepline':
    case 'steplinebr': {
      // A line figure whose segment coordinates are overridden: hold the
      // current value horizontally to the next bar, then (stepline only)
      // jump vertically. steplinebr leaves the jump out, so consecutive
      // steps stay disconnected polylines.
      const withJump = meta.style === 'stepline';
      return {
        key,
        title,
        type: 'line',
        attrs: ({ coordinate }) => {
          const y = coordinate.current[key];
          const nextY = coordinate.next[key];
          if (typeof y !== 'number') return {};
          const coordinates: Array<{ x: number; y: number }> = [
            { x: coordinate.current.x, y },
            { x: coordinate.next.x, y },
          ];
          if (withJump && typeof nextY === 'number') {
            coordinates.push({ x: coordinate.next.x, y: nextY });
          }
          return { coordinates };
        },
        styles: ({ data }) => ({ color: colorOf(data.current), size: linewidth }),
      };
    }
    default:
      // line/linebr natively; area* as a line until A3.
      return {
        key,
        title,
        type: 'line',
        styles: ({ data }) => ({ color: colorOf(data.current), size: linewidth }),
      };
  }
}

/** hline as a constant-value line figure: it participates in the pane's
 * y-axis autoscale (as in Pine) and shows up in the tooltip. Dotted/dashed
 * are both KLineChart 'dashed' lines with different dash patterns. */
export function buildHlineFigure(meta: PlotMetaRecord, key: string): PlotFigureSpec {
  const styles: Record<string, unknown> = {
    color: meta.color ?? '#2962FFFF',
    size: meta.linewidth ?? 1,
    style: meta.linestyle === 'dotted' || meta.linestyle === 'dashed' ? 'dashed' : 'solid',
  };
  if (meta.linestyle === 'dotted') styles.dashedValue = [2, 2];
  else if (meta.linestyle === 'dashed') styles.dashedValue = [8, 4];
  return {
    key,
    title: `${meta.title ?? meta.id}: `,
    type: 'line',
    styles: () => styles,
  };
}

// --- shape/char markers -----------------------------------------------------
// Painted by the group indicator's draw callback instead of per-datum text
// figures: a figure datum needs a numeric value, and every figure value is
// fed into the pane's y-axis range — an "anchor" value would distort the
// scale of non-overlay panes. The draw callback positions in pixel space
// with no autoscale side effects.

const SHAPE_GLYPHS: Record<string, string> = {
  xcross: '✕',
  cross: '✚',
  triangleup: '▲',
  triangledown: '▼',
  flag: '⚑',
  circle: '●',
  arrowup: '↑',
  arrowdown: '↓',
  labelup: '⬆',
  labeldown: '⬇',
  square: '■',
  diamond: '◆',
};

const SIZE_PX: Record<string, number> = {
  auto: 12,
  tiny: 8,
  small: 10,
  normal: 14,
  large: 18,
  huge: 24,
};

/** One shape/char plot to paint: its column in the bar rows plus its meta. */
export interface MarkerItem {
  plotIndex: number;
  meta: PlotMetaRecord;
}

/** The slice of the indicator draw-callback params drawMarkers needs. */
export interface MarkerDrawEnv {
  ctx: CanvasRenderingContext2D;
  bounding: { width: number; height: number };
  xAxis: { convertToPixel(value: number): number };
  yAxis: { convertToPixel(value: number): number };
  /** Visible bar-index range, `to` exclusive. */
  visibleFrom: number;
  visibleTo: number;
  /** True when drawing on the candle pane (bar high/low anchors exist). */
  overlay: boolean;
  /** Data-bar slot width in pixels (candle body width incl. no gap). */
  gapBar: number;
  bars: Array<{
    open: number;
    high: number;
    low: number;
    close: number;
    plots?: (number | null)[];
  }>;
  colorAt(channel: string, barIndex: number): ColorEnc | undefined;
}

const MARKER_EDGE_PAD = 8;
const MARKER_BAR_PAD = 6;
const MARKER_STACK_GAP = 4;

/** The plot's value as displayed at barIndex: offset shifts the source bar,
 * show_last blanks everything before the last N bars (same rules the
 * indicator calc applies to the line figures). */
function displayedValue(
  env: MarkerDrawEnv,
  meta: PlotMetaRecord,
  plotIndex: number,
  barIndex: number
): number | null {
  const total = env.bars.length;
  const src = barIndex - (meta.offset ?? 0);
  if (src < 0 || src >= total) return null;
  const v = env.bars[src].plots?.[plotIndex];
  if (v === null || v === undefined || !Number.isFinite(v)) return null;
  if (meta.show_last !== undefined && barIndex < total - meta.show_last) return null;
  return v;
}

/** One plot handled (fully or partially) by the group's draw callback:
 * steplines (risers), areas (fill), trackprice (last-value line). */
export interface PlotDrawItem {
  plotIndex: number;
  meta: PlotMetaRecord;
  /** Palette color used by the figure when the meta carries no color. */
  fallbackColor: string;
}

/**
 * Complete the stepline family's rendering. The horizontal treads come from
 * the plot's line figure (attrs.coordinates), but KLineChart's segment-merge
 * pass only ever reads the first two coordinates of a segment, so the
 * vertical risers must be painted here (stepline only — steplinebr leaves
 * its steps disconnected by design). Also draws the trailing half-bar tread
 * a run's last bar loses to the framework's current+next validity guard
 * (the very last bar and every bar before a gap).
 */
export function drawSteplines(env: MarkerDrawEnv, items: PlotDrawItem[]): void {
  const { ctx } = env;
  const total = env.bars.length;
  const from = Math.max(0, env.visibleFrom);
  const to = Math.min(total, env.visibleTo);
  // The canvas may carry a dash pattern from whatever painted before the
  // draw callback (dashed grid/hlines) — steplines are always solid.
  ctx.setLineDash([]);
  for (const item of items) {
    const { plotIndex, meta } = item;
    ctx.lineWidth = meta.linewidth ?? 1;
    const colorFor = (barIndex: number): string | null => drawItemColor(env, item, barIndex);
    const stroke = (x1: number, y1: number, x2: number, y2: number, color: string): void => {
      ctx.strokeStyle = color;
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
    };
    for (let barIndex = from; barIndex < to; barIndex++) {
      const v = displayedValue(env, meta, plotIndex, barIndex);
      if (v === null) continue;
      const x = env.xAxis.convertToPixel(barIndex);
      // Riser at this bar, from the previous tread's level (stepline only).
      if (meta.style === 'stepline' && barIndex > 0) {
        const prev = displayedValue(env, meta, plotIndex, barIndex - 1);
        if (prev !== null && prev !== v) {
          const color = colorFor(barIndex);
          if (color !== null) {
            stroke(x, env.yAxis.convertToPixel(prev), x, env.yAxis.convertToPixel(v), color);
          }
        }
      }
      // Trailing half tread where the figure's segment is suppressed: the
      // last bar of the data and the last bar before a gap.
      const next = barIndex + 1 < total ? displayedValue(env, meta, plotIndex, barIndex + 1) : null;
      if (next === null) {
        const color = colorFor(barIndex);
        if (color !== null) {
          const y = env.yAxis.convertToPixel(v);
          const half = (env.xAxis.convertToPixel(barIndex + 1) - x) / 2;
          stroke(x, y, x + half, y, color);
        }
      }
    }
  }
}

/** Shared dynamic-or-static color resolution for draw-callback plots: the
 * channel value at the bar (shifted back by offset), null = na (skip). */
function drawItemColor(
  env: MarkerDrawEnv,
  item: PlotDrawItem,
  barIndex: number
): string | null {
  const { meta, fallbackColor } = item;
  if (!meta.dynamic) return meta.color ?? fallbackColor;
  const enc = env.colorAt(meta.id, barIndex - (meta.offset ?? 0));
  if (enc === undefined) return meta.color ?? fallbackColor;
  return typeof enc === 'string' ? enc : null;
}

/** Fill color for an area plot: a color that already carries transparency is
 * used as-is; an opaque one gets TradingView's soft default fill alpha so the
 * area does not bury the candles/plots behind it. */
function areaFillColor(color: string): string {
  if (color.length === 9 && color.slice(7).toLowerCase() !== 'ff') return color;
  return color.slice(0, 7) + '47';
}

/**
 * Fill area/areabr plots from the line down to histbase. The top line itself
 * is the plot's regular line figure (the framework paints figures after the
 * draw callback, so the line lands on top of the fill). Consecutive valid
 * bars of one color become one polygon; a na value or na dynamic color breaks
 * the polygon, a color change closes it and starts the next one at the same
 * point.
 */
export function drawAreas(env: MarkerDrawEnv, items: PlotDrawItem[]): void {
  const { ctx } = env;
  const total = env.bars.length;
  // One bar beyond the visible range on both sides, so partially visible
  // polygons reach the pane edge instead of popping in.
  const from = Math.max(0, env.visibleFrom - 1);
  const to = Math.min(total, env.visibleTo + 1);
  for (const item of items) {
    const { plotIndex, meta } = item;
    const baseY = env.yAxis.convertToPixel(meta.histbase ?? 0);
    let pts: Array<{ x: number; y: number }> = [];
    let runColor: string | null = null;
    const flush = (): void => {
      if (pts.length >= 2 && runColor !== null) {
        ctx.fillStyle = areaFillColor(runColor);
        ctx.beginPath();
        ctx.moveTo(pts[0].x, pts[0].y);
        for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
        ctx.lineTo(pts[pts.length - 1].x, baseY);
        ctx.lineTo(pts[0].x, baseY);
        ctx.closePath();
        ctx.fill();
      }
      pts = [];
    };
    for (let barIndex = from; barIndex < to; barIndex++) {
      const v = displayedValue(env, meta, plotIndex, barIndex);
      const color = v === null ? null : drawItemColor(env, item, barIndex);
      if (v === null || color === null) {
        flush();
        runColor = null;
        continue;
      }
      const x = env.xAxis.convertToPixel(barIndex);
      const y = env.yAxis.convertToPixel(v);
      if (runColor !== null && color !== runColor) {
        pts.push({ x, y });
        flush();
      }
      runColor = color;
      pts.push({ x, y });
    }
    flush();
  }
}

/**
 * trackprice=true: a dotted horizontal line across the whole pane at the
 * plot's last displayed value (Pine's price-tracking line). Colored with the
 * static color or the dynamic color of that last bar.
 */
export function drawTrackprices(env: MarkerDrawEnv, items: PlotDrawItem[]): void {
  const { ctx } = env;
  const total = env.bars.length;
  ctx.setLineDash([2, 2]);
  ctx.lineWidth = 1;
  for (const item of items) {
    let value: number | null = null;
    let barIndex = total - 1;
    for (; barIndex >= 0; barIndex--) {
      value = displayedValue(env, item.meta, item.plotIndex, barIndex);
      if (value !== null) break;
    }
    if (value === null) continue;
    const color = drawItemColor(env, item, barIndex);
    if (color === null) continue;
    const y = env.yAxis.convertToPixel(value);
    ctx.strokeStyle = color;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(env.bounding.width, y);
    ctx.stroke();
  }
  ctx.setLineDash([]);
}

// --- plotarrow --------------------------------------------------------------

const ARROW_UP_DEFAULT = '#4CAF50';
const ARROW_DOWN_DEFAULT = '#F23645';

/** One plotarrow plot: its raw series column plus its meta. */
export interface ArrowItem {
  plotIndex: number;
  meta: PlotMetaRecord;
}

/**
 * Paint plotarrow arrows: positive values draw an up arrow under the bar
 * pointing at it, negatives a down arrow above it. Arrow length scales with
 * |value| relative to the series' maximum between minheight and maxheight
 * pixels (Pine's rule). In a non-price pane the arrows grow from the pane
 * edges. Dynamic colors ride the plot's (colorup, colordown) channel.
 */
export function drawArrows(env: MarkerDrawEnv, items: ArrowItem[]): void {
  const { ctx, bars } = env;
  const total = bars.length;
  const from = Math.max(0, env.visibleFrom);
  const to = Math.min(total, env.visibleTo);
  ctx.setLineDash([]);
  for (const { plotIndex, meta } of items) {
    // Length scale: the largest |value| of the whole series maps to maxheight.
    let maxAbs = 0;
    for (let i = 0; i < total; i++) {
      const v = bars[i].plots?.[plotIndex];
      if (typeof v === 'number' && Number.isFinite(v)) maxAbs = Math.max(maxAbs, Math.abs(v));
    }
    if (maxAbs === 0) continue;
    const minH = meta.minheight ?? 5;
    const maxH = meta.maxheight ?? 100;
    for (let barIndex = from; barIndex < to; barIndex++) {
      const v = displayedValue(env, meta, plotIndex, barIndex);
      if (v === null || v === 0) continue;
      const up = v > 0;
      let color = up ? meta.colorup ?? ARROW_UP_DEFAULT : meta.colordown ?? ARROW_DOWN_DEFAULT;
      if (meta.dynamic) {
        const enc = env.colorAt(meta.id, barIndex - (meta.offset ?? 0));
        if (enc !== undefined) {
          const pick = Array.isArray(enc) ? enc[up ? 0 : 1] : enc;
          if (typeof pick !== 'string') continue;
          color = pick;
        }
      }
      const h = minH + ((maxH - minH) * Math.abs(v)) / maxAbs;
      const x = env.xAxis.convertToPixel(barIndex);
      // Tip points at the bar (or grows inward from the pane edge); tail is
      // h pixels outward. In canvas coords "down" is +y.
      let tip: number;
      if (env.overlay) {
        tip = up
          ? env.yAxis.convertToPixel(bars[barIndex].low) + MARKER_BAR_PAD
          : env.yAxis.convertToPixel(bars[barIndex].high) - MARKER_BAR_PAD;
      } else {
        tip = up ? env.bounding.height - MARKER_EDGE_PAD - h : MARKER_EDGE_PAD + h;
      }
      const dir = up ? 1 : -1; // from tip toward tail
      const tail = tip + dir * h;
      const headLen = Math.min(7, Math.max(4, h * 0.35));
      const halfW = headLen * 0.7;
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(x, tail);
      ctx.lineTo(x, tip + dir * headLen * 0.8);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(x, tip);
      ctx.lineTo(x - halfW, tip + dir * headLen);
      ctx.lineTo(x + halfW, tip + dir * headLen);
      ctx.closePath();
      ctx.fill();
    }
  }
}

// --- bgcolor ----------------------------------------------------------------

/**
 * Paint bgcolor fills: full-height rectangles over each bar's slot (midpoint
 * to midpoint), consecutive same-color bars merged into one rect. Runs in a
 * zLevel -1 indicator, which KLineChart paints with destination-over — the
 * fill lands BEHIND the candles/plots already on the canvas. bgcolor is
 * always dynamic: every bar's color (or null = unpainted) arrives on the
 * plot's color channel.
 */
export function drawBackgrounds(env: MarkerDrawEnv, metas: PlotMetaRecord[]): void {
  const { ctx } = env;
  const total = env.bars.length;
  const from = Math.max(0, env.visibleFrom);
  const to = Math.min(total, env.visibleTo);
  // A bar's slot spans the midpoints toward its neighbors.
  const edge = (i: number): number =>
    (env.xAxis.convertToPixel(i - 1) + env.xAxis.convertToPixel(i)) / 2;
  for (const meta of metas) {
    let runColor: string | null = null;
    let runStartX = 0;
    const flush = (endX: number): void => {
      if (runColor !== null) {
        ctx.fillStyle = runColor;
        ctx.fillRect(runStartX, 0, endX - runStartX, env.bounding.height);
      }
      runColor = null;
    };
    for (let barIndex = from; barIndex < to; barIndex++) {
      let color: string | null = null;
      const src = barIndex - (meta.offset ?? 0);
      const masked = meta.show_last !== undefined && barIndex < total - meta.show_last;
      if (!masked && src >= 0 && src < total) {
        const enc = env.colorAt(meta.id, src);
        if (typeof enc === 'string') color = enc;
      }
      if (color !== runColor) {
        const x = edge(barIndex);
        flush(x);
        if (color !== null) {
          runColor = color;
          runStartX = x;
        }
      }
    }
    flush(edge(to));
  }
}

// --- plotcandle / plotbar ---------------------------------------------------

const CANDLE_UP_DEFAULT = '#26A69A';
const CANDLE_DOWN_DEFAULT = '#EF5350';

/** One plotcandle/plotbar: its meta plus the plot indices of the four value
 * columns pynecore stores as `"<title> (open|high|low|close)"`. */
export interface CandleItem {
  meta: PlotMetaRecord;
  open: number;
  high: number;
  low: number;
  close: number;
}

/**
 * Paint plotcandle candles / plotbar OHLC bars from their four value columns.
 * The columns feed the pane's y-axis range through paint-less figures; the
 * visuals live here. Static colors come from the meta (TV's green/red
 * up/down defaults when absent), dynamic ones from the plot's channel —
 * candle: (color, wickcolor, bordercolor), bar: a single color; a null
 * element falls back to the static/default color.
 */
export function drawPlotCandles(env: MarkerDrawEnv, items: CandleItem[]): void {
  const { ctx } = env;
  const total = env.bars.length;
  const from = Math.max(0, env.visibleFrom);
  const to = Math.min(total, env.visibleTo);
  const bodyW = Math.max(1, env.gapBar);
  ctx.setLineDash([]);
  for (const item of items) {
    const { meta } = item;
    const isBar = meta.kind === 'bar';
    for (let barIndex = from; barIndex < to; barIndex++) {
      const o = displayedValue(env, meta, item.open, barIndex);
      const h = displayedValue(env, meta, item.high, barIndex);
      const l = displayedValue(env, meta, item.low, barIndex);
      const c = displayedValue(env, meta, item.close, barIndex);
      if (o === null || h === null || l === null || c === null) continue;
      let body: string | null = meta.color ?? null;
      let wick: string | null = meta.wickcolor ?? null;
      let border: string | null = meta.bordercolor ?? null;
      if (meta.dynamic) {
        const enc = env.colorAt(meta.id, barIndex - (meta.offset ?? 0));
        if (enc !== undefined && enc !== null) {
          if (Array.isArray(enc)) {
            if (typeof enc[0] === 'string') body = enc[0];
            if (typeof enc[1] === 'string') wick = enc[1];
            if (typeof enc[2] === 'string') border = enc[2];
          } else if (typeof enc === 'string') {
            body = enc;
          }
        }
      }
      if (body === null) body = c >= o ? CANDLE_UP_DEFAULT : CANDLE_DOWN_DEFAULT;
      const x = env.xAxis.convertToPixel(barIndex);
      const yh = env.yAxis.convertToPixel(h);
      const yl = env.yAxis.convertToPixel(l);
      if (isBar) {
        const half = bodyW / 2;
        ctx.strokeStyle = body;
        ctx.lineWidth = Math.min(Math.max(Math.round(env.gapBar * 0.15), 1), 3);
        ctx.beginPath();
        ctx.moveTo(x, yh);
        ctx.lineTo(x, yl);
        ctx.moveTo(x - half, env.yAxis.convertToPixel(o));
        ctx.lineTo(x, env.yAxis.convertToPixel(o));
        ctx.moveTo(x, env.yAxis.convertToPixel(c));
        ctx.lineTo(x + half, env.yAxis.convertToPixel(c));
        ctx.stroke();
        continue;
      }
      const yo = env.yAxis.convertToPixel(o);
      const yc = env.yAxis.convertToPixel(c);
      ctx.strokeStyle = wick ?? body;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, yh);
      ctx.lineTo(x, yl);
      ctx.stroke();
      const top = Math.min(yo, yc);
      const height = Math.max(1, Math.abs(yo - yc));
      ctx.fillStyle = body;
      ctx.fillRect(x - bodyW / 2, top, bodyW, height);
      if (border !== null && border !== body) {
        ctx.strokeStyle = border;
        ctx.strokeRect(x - bodyW / 2, top, bodyW, height);
      }
    }
  }
}

// --- barcolor ---------------------------------------------------------------

/**
 * Repaint the built-in candles in the barcolor color: an opaque body rect
 * plus wick over the original (KLineChart has no per-bar candle color API).
 * barcolor is always dynamic — every bar's color (or null = leave the candle
 * alone) arrives on its channel. Runs before the plot figures, so plot lines
 * stay on top. Later barcolor calls paint over earlier ones (Pine's rule).
 */
export function drawBarcolors(env: MarkerDrawEnv, metas: PlotMetaRecord[]): void {
  const { ctx, bars } = env;
  const total = bars.length;
  const from = Math.max(0, env.visibleFrom);
  const to = Math.min(total, env.visibleTo);
  const bodyW = Math.max(1, env.gapBar);
  for (const meta of metas) {
    for (let barIndex = from; barIndex < to; barIndex++) {
      const src = barIndex - (meta.offset ?? 0);
      if (src < 0 || src >= total) continue;
      if (meta.show_last !== undefined && barIndex < total - meta.show_last) continue;
      const enc = env.colorAt(meta.id, src);
      if (typeof enc !== 'string') continue;
      const bar = bars[barIndex];
      if (!Number.isFinite(bar.high) || !Number.isFinite(bar.low)) continue;
      const x = env.xAxis.convertToPixel(barIndex);
      const yo = env.yAxis.convertToPixel(bar.open);
      const yc = env.yAxis.convertToPixel(bar.close);
      ctx.strokeStyle = enc;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, env.yAxis.convertToPixel(bar.high));
      ctx.lineTo(x, env.yAxis.convertToPixel(bar.low));
      ctx.stroke();
      ctx.fillStyle = enc;
      ctx.fillRect(x - bodyW / 2, Math.min(yo, yc), bodyW, Math.max(1, Math.abs(yo - yc)));
    }
  }
}

// --- fill -------------------------------------------------------------------

/** TV's default fill color when the call carries none. */
const FILL_DEFAULT = '#2196F3';

/** One side of a fill: a plot column (with the plot's own meta, so its
 * offset/show_last apply) or an hline's constant price. */
export interface FillSource {
  plotIndex?: number;
  plotMeta?: PlotMetaRecord;
  price?: number;
}

export interface FillItem {
  meta: PlotMetaRecord;
  a: FillSource;
  b: FillSource;
}

function fillSourceValue(env: MarkerDrawEnv, src: FillSource, barIndex: number): number | null {
  if (src.price !== undefined) return src.price;
  if (src.plotIndex === undefined) return null;
  return displayedValue(env, src.plotMeta ?? { id: '', kind: 'plot' }, src.plotIndex, barIndex);
}

/** Per-bar fill paint: a solid color or a vertical gradient spec. */
type FillPaint =
  | { kind: 'solid'; color: string }
  | { kind: 'gradient'; topValue: number; bottomValue: number; top: string; bottom: string }
  | null;

function fillPaintAt(env: MarkerDrawEnv, meta: PlotMetaRecord, barIndex: number): FillPaint {
  const solid = (c: string): FillPaint => ({ kind: 'solid', color: areaFillColor(c) });
  if (!meta.dynamic) return solid(meta.color ?? FILL_DEFAULT);
  const enc = env.colorAt(meta.id, barIndex);
  if (enc === undefined) return meta.color !== undefined ? solid(meta.color) : null;
  if (enc === null) return null;
  if (typeof enc === 'string') return solid(enc);
  if (Array.isArray(enc) && enc.length === 4) {
    const [tv, bv, tc, bc] = enc;
    if (typeof tv === 'number' && typeof bv === 'number' &&
        typeof tc === 'string' && typeof bc === 'string' && tv !== bv) {
      return { kind: 'gradient', topValue: tv, bottomValue: bv, top: tc, bottom: bc };
    }
  }
  return null;
}

/**
 * Fill the area between two plots (or two hlines). Solid runs of one color
 * merge into a single polygon (top polyline forward, bottom backward); a na
 * value breaks the run unless fillgaps is set (then the bar is skipped and
 * the polygon bridges the gap), a na color always breaks it. Gradient bars
 * (the 4-element channel) paint per bar segment with a vertical
 * createLinearGradient anchored at top_value/bottom_value.
 */
export function drawFills(env: MarkerDrawEnv, items: FillItem[]): void {
  const { ctx } = env;
  const total = env.bars.length;
  const from = Math.max(0, env.visibleFrom - 1);
  const to = Math.min(total, env.visibleTo + 1);
  for (const item of items) {
    const { meta } = item;
    let topPts: Array<{ x: number; y: number }> = [];
    let botPts: Array<{ x: number; y: number }> = [];
    let runColor: string | null = null;
    const flush = (): void => {
      if (topPts.length >= 2 && runColor !== null) {
        ctx.fillStyle = runColor;
        ctx.beginPath();
        ctx.moveTo(topPts[0].x, topPts[0].y);
        for (let i = 1; i < topPts.length; i++) ctx.lineTo(topPts[i].x, topPts[i].y);
        for (let i = botPts.length - 1; i >= 0; i--) ctx.lineTo(botPts[i].x, botPts[i].y);
        ctx.closePath();
        ctx.fill();
      }
      topPts = [];
      botPts = [];
      runColor = null;
    };
    let prev: { x: number; ya: number; yb: number } | null = null;
    for (let barIndex = from; barIndex < to; barIndex++) {
      const masked =
        meta.show_last !== undefined && barIndex < total - meta.show_last;
      const va = masked ? null : fillSourceValue(env, item.a, barIndex);
      const vb = masked ? null : fillSourceValue(env, item.b, barIndex);
      if (va === null || vb === null) {
        if (!meta.fillgaps || masked) {
          flush();
          prev = null;
        }
        continue;
      }
      const paint = fillPaintAt(env, meta, barIndex);
      if (paint === null) {
        flush();
        prev = null;
        continue;
      }
      const x = env.xAxis.convertToPixel(barIndex);
      const ya = env.yAxis.convertToPixel(va);
      const yb = env.yAxis.convertToPixel(vb);
      if (paint.kind === 'gradient') {
        flush();
        if (prev !== null) {
          const grad = ctx.createLinearGradient(
            0,
            env.yAxis.convertToPixel(paint.topValue),
            0,
            env.yAxis.convertToPixel(paint.bottomValue)
          );
          grad.addColorStop(0, paint.top);
          grad.addColorStop(1, paint.bottom);
          ctx.fillStyle = grad;
          ctx.beginPath();
          ctx.moveTo(prev.x, prev.ya);
          ctx.lineTo(x, ya);
          ctx.lineTo(x, yb);
          ctx.lineTo(prev.x, prev.yb);
          ctx.closePath();
          ctx.fill();
        }
      } else if (runColor !== null && paint.color !== runColor) {
        // Color change: close the old run at this bar, restart the new one
        // at the same point so the fill stays contiguous.
        topPts.push({ x, y: ya });
        botPts.push({ x, y: yb });
        flush();
        runColor = paint.color;
        topPts.push({ x, y: ya });
        botPts.push({ x, y: yb });
      } else {
        if (runColor === null && prev !== null) {
          // Fresh run after a gradient bar (or a bridged fillgaps gap):
          // anchor at the previous painted bar so no wedge is left open.
          topPts.push({ x: prev.x, y: prev.ya });
          botPts.push({ x: prev.x, y: prev.yb });
        }
        runColor = paint.color;
        topPts.push({ x, y: ya });
        botPts.push({ x, y: yb });
      }
      prev = { x, ya, yb };
    }
    flush();
  }
}

/**
 * Paint shape/char markers for the visible bars. Marker rules follow Pine:
 * drawn where the stored series is truthy (na/0 skips the bar), located
 * above/below the bar (overlay) or pinned to the pane edge, stacked outward
 * in call order when several land on the same bar. `location.absolute` uses
 * the stored value on the pane's y-axis. Dynamic colors ride the plot's
 * (color, textcolor) channel.
 */
export function drawMarkers(env: MarkerDrawEnv, items: MarkerItem[]): void {
  const { ctx, bars } = env;
  const total = bars.length;
  const from = Math.max(0, env.visibleFrom);
  const to = Math.min(total, env.visibleTo);
  ctx.textAlign = 'center';
  for (let barIndex = from; barIndex < to; barIndex++) {
    // Outward stacking offsets, per anchor, reset per bar.
    const stack = { above: 0, below: 0, top: 0, bottom: 0 };
    const x = env.xAxis.convertToPixel(barIndex);
    for (const { plotIndex, meta } of items) {
      const value = displayedValue(env, meta, plotIndex, barIndex);
      if (value === null || value === 0) continue;

      let color: string | null = meta.color ?? null;
      let textcolor: string | null = meta.textcolor ?? null;
      if (meta.dynamic) {
        const enc = env.colorAt(meta.id, barIndex - (meta.offset ?? 0));
        if (enc !== undefined) {
          if (Array.isArray(enc)) {
            color = typeof enc[0] === 'string' ? enc[0] : null;
            textcolor = typeof enc[1] === 'string' ? enc[1] : textcolor;
          } else {
            color = typeof enc === 'string' ? enc : null;
          }
        }
      }
      if (color === null) continue;

      const glyph =
        meta.kind === 'char' ? meta.char ?? '◆' : SHAPE_GLYPHS[meta.style ?? ''] ?? '✕';
      const px = SIZE_PX[meta.size ?? 'auto'] ?? SIZE_PX.auto;
      const textPx = Math.max(9, px - 3);
      const consumed = px + (meta.text ? textPx + 2 : 0) + MARKER_STACK_GAP;

      // In a non-price pane there is no bar to hug: above/below degrade to
      // the pane edges (top/bottom) like TradingView does.
      let location = meta.location ?? 'abovebar';
      if (!env.overlay && (location === 'abovebar' || location === 'belowbar')) {
        location = location === 'abovebar' ? 'top' : 'bottom';
      }
      let y: number;
      let outward: -1 | 1 = -1;
      switch (location) {
        case 'belowbar':
          y = env.yAxis.convertToPixel(bars[barIndex].low) + MARKER_BAR_PAD + stack.below + px / 2;
          stack.below += consumed;
          outward = 1;
          break;
        case 'top':
          y = MARKER_EDGE_PAD + stack.top + px / 2;
          stack.top += consumed;
          outward = 1;
          break;
        case 'bottom':
          y = env.bounding.height - MARKER_EDGE_PAD - stack.bottom - px / 2;
          stack.bottom += consumed;
          outward = -1;
          break;
        case 'absolute':
          y = env.yAxis.convertToPixel(value);
          outward = 1;
          break;
        default:
          // abovebar
          y = env.yAxis.convertToPixel(bars[barIndex].high) - MARKER_BAR_PAD - stack.above - px / 2;
          stack.above += consumed;
          outward = -1;
          break;
      }

      ctx.font = `${px}px sans-serif`;
      ctx.textBaseline = 'middle';
      ctx.fillStyle = color;
      ctx.fillText(glyph, x, y);
      if (meta.text) {
        ctx.font = `${textPx}px sans-serif`;
        ctx.fillStyle = textcolor ?? color;
        ctx.fillText(meta.text, x, y + outward * (px / 2 + textPx / 2 + 2));
      }
    }
  }
}
