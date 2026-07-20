/**
 * Drawing-object rendering (F9B): the pynecore viz journal's line / label /
 * box / polyline / linefill objects painted onto the chart's canvas, plus the
 * table model consumed by the HTML layer in main.ts (the canvas has no table
 * primitive). Follows the F9A pattern: a figure-less indicator's draw
 * callback (zLevel 2, above the plot lines and markers) — no overlay API, so
 * nothing feeds the y-axis autoscale and hundreds of objects stay one canvas
 * pass.
 *
 * Coordinates: everything is resolved to BAR-INDEX space first (xloc
 * 'bar_index' is already there; 'bar_time' resolves through the run's
 * timestamp->index map, extrapolating linearly beyond the loaded range —
 * KLineChart's xAxis.convertToPixel is a pure linear formula, so future bar
 * indices map to valid pixels).
 */
import type { DrawingEventRecord } from '../../run/bridgeClient';
import type { MarkerDrawEnv } from './plotStyles';

// --- serialized state shapes (pynecore core/viz.py _*_dict) -----------------
// Colors are #RRGGBBAA or null; enums are attribute names; na -> null.

export interface LineState {
  id: number;
  x1: number | null;
  y1: number | null;
  x2: number | null;
  y2: number | null;
  xloc?: string | null;
  extend?: string | null;
  color?: string | null;
  style?: string | null;
  width?: number | null;
  force_overlay?: boolean;
}

export interface LabelState {
  id: number;
  x: number | null;
  y: number | null;
  text?: string | null;
  xloc?: string | null;
  yloc?: string | null;
  color?: string | null;
  style?: string | null;
  textcolor?: string | null;
  size?: string | number | null;
  textalign?: string | null;
  tooltip?: string | null;
  force_overlay?: boolean;
}

export interface BoxState {
  id: number;
  left: number | null;
  top: number | null;
  right: number | null;
  bottom: number | null;
  border_color?: string | null;
  border_width?: number | null;
  border_style?: string | null;
  extend?: string | null;
  xloc?: string | null;
  bgcolor?: string | null;
  text?: string | null;
  text_size?: string | number | null;
  text_color?: string | null;
  text_halign?: string | null;
  text_valign?: string | null;
  text_wrap?: string | null;
  force_overlay?: boolean;
}

export interface TableCellState {
  col: number;
  row: number;
  text?: string | null;
  width?: number | null;
  height?: number | null;
  text_color?: string | null;
  text_halign?: string | null;
  text_valign?: string | null;
  text_size?: string | number | null;
  bgcolor?: string | null;
  tooltip?: string | null;
  /** [start_col, start_row, end_col, end_row]; only the range's top-left
   * cell renders, the others are hidden by it. */
  merge?: [number, number, number, number];
}

export interface TableState {
  id: number;
  position?: string | null;
  columns: number;
  rows: number;
  bgcolor?: string | null;
  frame_color?: string | null;
  frame_width?: number | null;
  border_color?: string | null;
  border_width?: number | null;
  force_overlay?: boolean;
  cells: TableCellState[];
}

export interface PolylinePoint {
  index: number | null;
  time: number | null;
  price: number | null;
}

export interface PolylineState {
  id: number;
  points: PolylinePoint[];
  curved?: boolean;
  closed?: boolean;
  xloc?: string | null;
  line_color?: string | null;
  fill_color?: string | null;
  line_style?: string | null;
  line_width?: number | null;
  force_overlay?: boolean;
}

export interface LinefillState {
  id: number;
  color?: string | null;
  /** The two lines' current state, embedded — a linefill update is
   * self-contained even when only one of its lines moved. */
  line1_state: LineState;
  line2_state: LineState;
}

// --- store -------------------------------------------------------------------

/**
 * The live drawing objects, keyed by vid per family. `apply` upserts on
 * create/update and removes on delete; `version` bumps on every change so
 * the HTML table layer knows when to re-render.
 */
export class DrawingStore {
  readonly lines = new Map<number, LineState>();
  readonly labels = new Map<number, LabelState>();
  readonly boxes = new Map<number, BoxState>();
  readonly tables = new Map<number, TableState>();
  readonly polylines = new Map<number, PolylineState>();
  readonly linefills = new Map<number, LinefillState>();
  version = 0;
  /** Bumped only on table changes — the HTML table layer re-renders on this
   * (a per-bar-moving line must not churn the table DOM every tick). */
  tableVersion = 0;

  get size(): number {
    return (
      this.lines.size +
      this.labels.size +
      this.boxes.size +
      this.tables.size +
      this.polylines.size +
      this.linefills.size
    );
  }

  clear(): void {
    this.lines.clear();
    this.labels.clear();
    this.boxes.clear();
    this.tables.clear();
    this.polylines.clear();
    this.linefills.clear();
    this.version++;
    this.tableVersion++;
  }

  apply(events: DrawingEventRecord[]): void {
    let tables = false;
    for (const ev of events) {
      const map = this.familyMap(ev.obj);
      if (!map) continue;
      if (ev.op === 'delete') map.delete(ev.id);
      else if (ev.s) map.set(ev.id, ev.s as never);
      if (ev.obj === 'table') tables = true;
    }
    if (events.length) this.version++;
    if (tables) this.tableVersion++;
  }

  /** Any canvas-drawn object routed to the given pane (tables excluded —
   * they live in the HTML layer). */
  hasCanvasFor(overlay: boolean, scriptOverlay: boolean): boolean {
    const match = (fo: boolean | undefined): boolean =>
      ((fo ?? false) || scriptOverlay) === overlay;
    for (const l of this.lines.values()) if (match(l.force_overlay)) return true;
    for (const l of this.labels.values()) if (match(l.force_overlay)) return true;
    for (const b of this.boxes.values()) if (match(b.force_overlay)) return true;
    for (const p of this.polylines.values()) if (match(p.force_overlay)) return true;
    for (const lf of this.linefills.values()) {
      if (match(lf.line1_state?.force_overlay)) return true;
    }
    return false;
  }

  private familyMap(obj: DrawingEventRecord['obj']): Map<number, object> | undefined {
    switch (obj) {
      case 'line':
        return this.lines;
      case 'label':
        return this.labels;
      case 'box':
        return this.boxes;
      case 'table':
        return this.tables;
      case 'polyline':
        return this.polylines;
      case 'linefill':
        return this.linefills;
      default:
        return undefined;
    }
  }
}

// --- x resolution -------------------------------------------------------------

/** Resolves a drawing x coordinate to (possibly fractional / out-of-range)
 * bar-index space. xloc 'bar_time' values are bar-open timestamps in ms. */
export interface XResolver {
  toIndex(x: number | null | undefined, xloc: string | null | undefined): number | null;
}

/**
 * Build an x resolver over the run's bars: exact timestamps hit the map,
 * anything else interpolates/extrapolates linearly with the bar interval
 * (Pine lines and labels may point beyond the last bar).
 */
export function makeXResolver(
  bars: Array<{ timestamp: number }>,
  tsToIndex: ReadonlyMap<number, number>
): XResolver {
  return {
    toIndex(x, xloc) {
      if (x === null || x === undefined || !Number.isFinite(x)) return null;
      if (xloc !== 'bar_time') return x;
      const exact = tsToIndex.get(x);
      if (exact !== undefined) return exact;
      const n = bars.length;
      if (n === 0) return null;
      const first = bars[0].timestamp;
      const last = bars[n - 1].timestamp;
      const interval = n > 1 ? (last - first) / (n - 1) : 60_000;
      if (interval <= 0) return null;
      if (x >= last) return n - 1 + (x - last) / interval;
      if (x <= first) return (x - first) / interval;
      // Inside the range but not a bar-open time: nearest by interpolation.
      return (x - first) / interval;
    },
  };
}

// --- shared paint helpers ------------------------------------------------------

const LINE_DASH: Record<string, number[]> = {
  solid: [],
  dotted: [2, 2],
  dashed: [8, 4],
  arrow_left: [],
  arrow_right: [],
  arrow_both: [],
};

/** Label/text size names to px; numeric sizes pass through. Also used by
 * the HTML table layer in main.ts for cell text sizes. */
export function sizePx(size: string | number | null | undefined, base: number): number {
  if (typeof size === 'number' && size > 0) return size;
  switch (size) {
    case 'tiny':
      return base - 4;
    case 'small':
      return base - 2;
    case 'large':
      return base + 6;
    case 'huge':
      return base + 14;
    default:
      return base; // auto / normal
  }
}

interface Pt {
  x: number;
  y: number;
}

/**
 * Liang-Barsky style clip of the (possibly extended) line p1->p2 against the
 * pane. `extendLeft` opens the parameter range below 0 (beyond p1),
 * `extendRight` above 1 (beyond p2). Returns the drawable segment or null.
 *
 * `yPad` grows the vertical clip bounds. Callers that only need the horizontal
 * span (linefill: the fill stays visible even when a bounding line is scrolled
 * out of the price range) pass a large pad and let the canvas clip in y.
 */
function clipLine(
  p1: Pt,
  p2: Pt,
  bounds: { width: number; height: number },
  extendLeft: boolean,
  extendRight: boolean,
  yPad = 0
): [Pt, Pt] | null {
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  if (dx === 0 && dy === 0) return null;
  let t0 = extendLeft ? -Infinity : 0;
  let t1 = extendRight ? Infinity : 1;
  const edges: Array<[number, number]> = [
    [-dx, p1.x], // x >= 0
    [dx, bounds.width - p1.x], // x <= width
    [-dy, p1.y + yPad], // y >= -yPad
    [dy, bounds.height + yPad - p1.y], // y <= height + yPad
  ];
  for (const [p, q] of edges) {
    if (p === 0) {
      if (q < 0) return null;
      continue;
    }
    const r = q / p;
    if (p < 0) {
      if (r > t1) return null;
      if (r > t0) t0 = r;
    } else {
      if (r < t0) return null;
      if (r < t1) t1 = r;
    }
  }
  if (t0 > t1) return null;
  return [
    { x: p1.x + t0 * dx, y: p1.y + t0 * dy },
    { x: p1.x + t1 * dx, y: p1.y + t1 * dy },
  ];
}

function arrowHead(ctx: CanvasRenderingContext2D, tip: Pt, from: Pt, size: number): void {
  const angle = Math.atan2(tip.y - from.y, tip.x - from.x);
  ctx.beginPath();
  ctx.moveTo(tip.x, tip.y);
  ctx.lineTo(tip.x - size * Math.cos(angle - 0.4), tip.y - size * Math.sin(angle - 0.4));
  ctx.lineTo(tip.x - size * Math.cos(angle + 0.4), tip.y - size * Math.sin(angle + 0.4));
  ctx.closePath();
  ctx.fill();
}

/** The line's pixel endpoints (unclipped), or null when a coordinate is na. */
function linePixels(env: MarkerDrawEnv, xres: XResolver, l: LineState): [Pt, Pt] | null {
  const i1 = xres.toIndex(l.x1, l.xloc);
  const i2 = xres.toIndex(l.x2, l.xloc);
  if (i1 === null || i2 === null) return null;
  if (typeof l.y1 !== 'number' || typeof l.y2 !== 'number') return null;
  return [
    { x: env.xAxis.convertToPixel(i1), y: env.yAxis.convertToPixel(l.y1) },
    { x: env.xAxis.convertToPixel(i2), y: env.yAxis.convertToPixel(l.y2) },
  ];
}

// --- painters -------------------------------------------------------------------

const LINE_DEFAULT_COLOR = '#2962FFFF';

function drawLine(env: MarkerDrawEnv, xres: XResolver, l: LineState): void {
  const pts = linePixels(env, xres, l);
  if (!pts) return;
  const [p1, p2] = pts;
  const extend = l.extend ?? 'none';
  const seg = clipLine(
    p1,
    p2,
    env.bounding,
    extend === 'left' || extend === 'both',
    extend === 'right' || extend === 'both'
  );
  if (!seg) return;
  const { ctx } = env;
  const color = l.color ?? LINE_DEFAULT_COLOR;
  const width = l.width ?? 1;
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = width;
  ctx.setLineDash(LINE_DASH[l.style ?? 'solid'] ?? []);
  ctx.beginPath();
  ctx.moveTo(seg[0].x, seg[0].y);
  ctx.lineTo(seg[1].x, seg[1].y);
  ctx.stroke();
  ctx.setLineDash([]);
  const head = Math.max(6, width * 3);
  if (l.style === 'arrow_right' || l.style === 'arrow_both') arrowHead(ctx, p2, p1, head);
  if (l.style === 'arrow_left' || l.style === 'arrow_both') arrowHead(ctx, p1, p2, head);
}

/** Vertical slack for a linefill's bounding lines, in pixels: keeps the fill
 * alive while a line sits far outside the visible price range, without letting
 * a vertical line's extended parameter run to infinity. */
const LINEFILL_Y_PAD = 1e5;

function drawLinefill(env: MarkerDrawEnv, xres: XResolver, lf: LinefillState): void {
  const a = lf.line1_state && linePixels(env, xres, lf.line1_state);
  const b = lf.line2_state && linePixels(env, xres, lf.line2_state);
  if (!a || !b || !lf.color) return;
  const segFor = (pts: [Pt, Pt], l: LineState): [Pt, Pt] | null => {
    const extend = l.extend ?? 'none';
    return clipLine(
      pts[0],
      pts[1],
      env.bounding,
      extend === 'left' || extend === 'both',
      extend === 'right' || extend === 'both',
      LINEFILL_Y_PAD
    );
  };
  const sa = segFor(a, lf.line1_state);
  const sb = segFor(b, lf.line2_state);
  if (!sa || !sb) return;
  // The fill spans the overlap of the two segments' x-domains; each line's y
  // is evaluated linearly at the overlap edges (both transforms are affine).
  const [a1, a2] = sa[0].x <= sa[1].x ? sa : [sa[1], sa[0]];
  const [b1, b2] = sb[0].x <= sb[1].x ? sb : [sb[1], sb[0]];
  const x1 = Math.max(a1.x, b1.x);
  const x2 = Math.min(a2.x, b2.x);
  if (!(x2 > x1)) return;
  const yAt = (p: Pt, q: Pt, x: number): number =>
    q.x === p.x ? p.y : p.y + ((q.y - p.y) * (x - p.x)) / (q.x - p.x);
  const { ctx } = env;
  ctx.fillStyle = lf.color;
  ctx.beginPath();
  ctx.moveTo(x1, yAt(a1, a2, x1));
  ctx.lineTo(x2, yAt(a1, a2, x2));
  ctx.lineTo(x2, yAt(b1, b2, x2));
  ctx.lineTo(x1, yAt(b1, b2, x1));
  ctx.closePath();
  ctx.fill();
}

function drawBox(env: MarkerDrawEnv, xres: XResolver, b: BoxState): void {
  const il = xres.toIndex(b.left, b.xloc);
  const ir = xres.toIndex(b.right, b.xloc);
  if (il === null || ir === null) return;
  if (typeof b.top !== 'number' || typeof b.bottom !== 'number') return;
  let x1 = env.xAxis.convertToPixel(il);
  let x2 = env.xAxis.convertToPixel(ir);
  if (x2 < x1) [x1, x2] = [x2, x1];
  const extend = b.extend ?? 'none';
  if (extend === 'left' || extend === 'both') x1 = 0;
  if (extend === 'right' || extend === 'both') x2 = env.bounding.width;
  const yTop = env.yAxis.convertToPixel(b.top);
  const yBot = env.yAxis.convertToPixel(b.bottom);
  const y1 = Math.min(yTop, yBot);
  const h = Math.max(1, Math.abs(yBot - yTop));
  const w = Math.max(1, x2 - x1);
  const { ctx } = env;
  if (b.bgcolor) {
    ctx.fillStyle = b.bgcolor;
    ctx.fillRect(x1, y1, w, h);
  }
  const bw = b.border_width ?? 1;
  if (b.border_color && bw > 0) {
    ctx.strokeStyle = b.border_color;
    ctx.lineWidth = bw;
    ctx.setLineDash(LINE_DASH[b.border_style ?? 'solid'] ?? []);
    ctx.strokeRect(x1, y1, w, h);
    ctx.setLineDash([]);
  }
  if (b.text) {
    drawBoxText(env, b, x1, y1, w, h);
  }
}

function drawBoxText(
  env: MarkerDrawEnv,
  b: BoxState,
  x: number,
  y: number,
  w: number,
  h: number
): void {
  const { ctx } = env;
  const px = sizePx(b.text_size, 12);
  ctx.font = `${px}px sans-serif`;
  ctx.fillStyle = b.text_color ?? '#000000FF';
  const pad = 4;
  // Wrap into the box width ('auto' wrap), or keep the author's lines.
  const lines: string[] = [];
  for (const raw of String(b.text).split('\n')) {
    if (b.text_wrap !== 'auto' || ctx.measureText(raw).width <= w - pad * 2) {
      lines.push(raw);
      continue;
    }
    let cur = '';
    for (const word of raw.split(' ')) {
      const probe = cur ? `${cur} ${word}` : word;
      if (cur && ctx.measureText(probe).width > w - pad * 2) {
        lines.push(cur);
        cur = word;
      } else {
        cur = probe;
      }
    }
    if (cur) lines.push(cur);
  }
  const lineH = px * 1.25;
  const blockH = lines.length * lineH;
  let ty: number;
  switch (b.text_valign) {
    case 'top':
      ty = y + pad + lineH / 2;
      break;
    case 'bottom':
      ty = y + h - pad - blockH + lineH / 2;
      break;
    default:
      ty = y + h / 2 - blockH / 2 + lineH / 2;
      break;
  }
  ctx.textBaseline = 'middle';
  for (const line of lines) {
    let tx: number;
    switch (b.text_halign) {
      case 'left':
        ctx.textAlign = 'left';
        tx = x + pad;
        break;
      case 'right':
        ctx.textAlign = 'right';
        tx = x + w - pad;
        break;
      default:
        ctx.textAlign = 'center';
        tx = x + w / 2;
        break;
    }
    ctx.fillText(line, tx, ty);
    ty += lineH;
  }
  ctx.textAlign = 'center';
}

function drawPolyline(env: MarkerDrawEnv, xres: XResolver, p: PolylineState): void {
  const pts: Pt[] = [];
  for (const pt of p.points ?? []) {
    const i = xres.toIndex(p.xloc === 'bar_time' ? pt.time : pt.index, p.xloc);
    if (i === null || typeof pt.price !== 'number') continue;
    pts.push({ x: env.xAxis.convertToPixel(i), y: env.yAxis.convertToPixel(pt.price) });
  }
  if (pts.length < 2) return;
  const { ctx } = env;
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  if (p.curved) {
    // Quadratic smoothing through segment midpoints (TV-like curve).
    for (let i = 1; i < pts.length - 1; i++) {
      const mx = (pts[i].x + pts[i + 1].x) / 2;
      const my = (pts[i].y + pts[i + 1].y) / 2;
      ctx.quadraticCurveTo(pts[i].x, pts[i].y, mx, my);
    }
    ctx.lineTo(pts[pts.length - 1].x, pts[pts.length - 1].y);
  } else {
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
  }
  if (p.closed) ctx.closePath();
  if (p.fill_color) {
    ctx.fillStyle = p.fill_color;
    ctx.fill();
  }
  if (p.line_color) {
    ctx.strokeStyle = p.line_color;
    ctx.lineWidth = p.line_width ?? 1;
    ctx.setLineDash(LINE_DASH[p.line_style ?? 'solid'] ?? []);
    ctx.stroke();
    ctx.setLineDash([]);
  }
}

/** Pointer directions of the label_* bubble styles. */
const LABEL_POINTERS: Record<string, 'up' | 'down' | 'left' | 'right' | 'none'> = {
  label_up: 'up',
  label_down: 'down',
  label_left: 'left',
  label_right: 'right',
  label_lower_left: 'up',
  label_lower_right: 'up',
  label_upper_left: 'down',
  label_upper_right: 'down',
  label_center: 'none',
};

/** Glyphs of the shape-like label styles (drawn like plotshape markers). */
const LABEL_GLYPHS: Record<string, string> = {
  xcross: '✕',
  cross: '✚',
  triangleup: '▲',
  triangledown: '▼',
  flag: '⚑',
  circle: '●',
  arrowup: '↑',
  arrowdown: '↓',
  square: '■',
  diamond: '◆',
};

const LABEL_BG_DEFAULT = '#2962FFFF';

function drawLabel(env: MarkerDrawEnv, xres: XResolver, la: LabelState): void {
  const i = xres.toIndex(la.x, la.xloc);
  if (i === null) return;
  const x = env.xAxis.convertToPixel(i);
  const { ctx } = env;

  // Anchor y: price / abovebar / belowbar (bar anchors need the price pane;
  // in a sub-pane they degrade to the pane edges, like the plot markers).
  const yloc = la.yloc ?? 'price';
  const barIndex = Math.round(i);
  const bar = barIndex >= 0 && barIndex < env.bars.length ? env.bars[barIndex] : undefined;
  let y: number;
  if (yloc === 'abovebar') {
    y = env.overlay && bar ? env.yAxis.convertToPixel(bar.high) - 6 : 10;
  } else if (yloc === 'belowbar') {
    y = env.overlay && bar ? env.yAxis.convertToPixel(bar.low) + 6 : env.bounding.height - 10;
  } else {
    if (typeof la.y !== 'number') return;
    y = env.yAxis.convertToPixel(la.y);
  }

  const style = la.style ?? 'label_down';
  const px = sizePx(la.size, 14);
  const text = la.text ?? '';
  const lines = text ? text.split('\n') : [];

  const glyph = LABEL_GLYPHS[style];
  if (glyph !== undefined) {
    // Shape-style label: glyph at the anchor, text stacked away from it.
    const color = la.color ?? LABEL_BG_DEFAULT;
    ctx.font = `${px}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = color;
    const dir = yloc === 'belowbar' ? 1 : -1;
    ctx.fillText(glyph, x, y + dir * (px / 2));
    if (lines.length) {
      const tpx = Math.max(9, px - 3);
      ctx.font = `${tpx}px sans-serif`;
      ctx.fillStyle = la.textcolor ?? color;
      let ty = y + dir * (px + tpx / 2 + 2);
      for (const line of dir === 1 ? lines : [...lines].reverse()) {
        ctx.fillText(line, x, ty);
        ty += dir * tpx * 1.25;
      }
    }
    return;
  }

  if (style === 'none' || style === 'text_outline') {
    if (!lines.length) return;
    ctx.font = `${px}px sans-serif`;
    ctx.textAlign = la.textalign === 'left' ? 'left' : la.textalign === 'right' ? 'right' : 'center';
    ctx.textBaseline = 'middle';
    let ty = y - ((lines.length - 1) * px * 1.25) / 2;
    for (const line of lines) {
      if (style === 'text_outline') {
        ctx.lineWidth = 3;
        ctx.strokeStyle = isLight(la.textcolor) ? '#000000AA' : '#FFFFFFAA';
        ctx.strokeText(line, x, ty);
      }
      ctx.fillStyle = la.textcolor ?? la.color ?? LABEL_BG_DEFAULT;
      ctx.fillText(line, x, ty);
      ty += px * 1.25;
    }
    ctx.textAlign = 'center';
    return;
  }

  // Bubble label (label_up/down/left/right/...): rounded rect + pointer at
  // the anchor, offset away from it in the pointer's direction.
  const pointer = LABEL_POINTERS[style] ?? 'down';
  ctx.font = `${px}px sans-serif`;
  const pad = Math.max(4, px * 0.4);
  const lineH = px * 1.25;
  let textW = px; // minimum bubble for an empty label
  for (const line of lines) textW = Math.max(textW, ctx.measureText(line).width);
  const w = textW + pad * 2;
  const h = Math.max(lineH, lines.length * lineH) + pad * 2;
  const tip = 6;
  let bx: number;
  let by: number;
  switch (pointer) {
    case 'up':
      bx = x - w / 2;
      by = y + tip;
      break;
    case 'down':
      bx = x - w / 2;
      by = y - tip - h;
      break;
    case 'left':
      bx = x + tip;
      by = y - h / 2;
      break;
    case 'right':
      bx = x - tip - w;
      by = y - h / 2;
      break;
    default:
      bx = x - w / 2;
      by = y - h / 2;
      break;
  }
  const bg = la.color ?? LABEL_BG_DEFAULT;
  ctx.fillStyle = bg;
  const r = Math.min(6, h / 2);
  ctx.beginPath();
  ctx.roundRect(bx, by, w, h, r);
  ctx.fill();
  if (pointer !== 'none') {
    ctx.beginPath();
    ctx.moveTo(x, y);
    switch (pointer) {
      case 'up':
        ctx.lineTo(x - tip, by + 1);
        ctx.lineTo(x + tip, by + 1);
        break;
      case 'down':
        ctx.lineTo(x - tip, by + h - 1);
        ctx.lineTo(x + tip, by + h - 1);
        break;
      case 'left':
        ctx.lineTo(bx + 1, y - tip);
        ctx.lineTo(bx + 1, y + tip);
        break;
      case 'right':
        ctx.lineTo(bx + w - 1, y - tip);
        ctx.lineTo(bx + w - 1, y + tip);
        break;
    }
    ctx.closePath();
    ctx.fill();
  }
  if (lines.length) {
    ctx.fillStyle = la.textcolor ?? '#FFFFFFFF';
    ctx.textBaseline = 'middle';
    ctx.textAlign = la.textalign === 'left' ? 'left' : la.textalign === 'right' ? 'right' : 'center';
    const tx = la.textalign === 'left' ? bx + pad : la.textalign === 'right' ? bx + w - pad : bx + w / 2;
    let ty = by + h / 2 - ((lines.length - 1) * lineH) / 2;
    for (const line of lines) {
      ctx.fillText(line, tx, ty);
      ty += lineH;
    }
    ctx.textAlign = 'center';
  }
}

/** Rough luminance check for the text_outline contrast color. */
function isLight(color: string | null | undefined): boolean {
  if (!color || color.length < 7) return false;
  const r = parseInt(color.slice(1, 3), 16);
  const g = parseInt(color.slice(3, 5), 16);
  const b = parseInt(color.slice(5, 7), 16);
  return 0.299 * r + 0.587 * g + 0.114 * b > 140;
}

/**
 * Paint every canvas drawing routed to the current pane. Z-order within the
 * layer follows TradingView: fills at the bottom, then boxes, lines,
 * polylines, labels on top. Tables are not painted here — main.ts renders
 * them as an HTML layer.
 */
export function drawDrawings(
  env: MarkerDrawEnv,
  store: DrawingStore,
  xres: XResolver,
  scriptOverlay: boolean
): void {
  const mine = (fo: boolean | undefined): boolean =>
    ((fo ?? false) || scriptOverlay) === env.overlay;
  const { ctx } = env;
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, env.bounding.width, env.bounding.height);
  ctx.clip();
  for (const lf of store.linefills.values()) {
    if (mine(lf.line1_state?.force_overlay)) drawLinefill(env, xres, lf);
  }
  for (const b of store.boxes.values()) if (mine(b.force_overlay)) drawBox(env, xres, b);
  for (const l of store.lines.values()) if (mine(l.force_overlay)) drawLine(env, xres, l);
  for (const p of store.polylines.values()) if (mine(p.force_overlay)) drawPolyline(env, xres, p);
  for (const la of store.labels.values()) if (mine(la.force_overlay)) drawLabel(env, xres, la);
  ctx.restore();
}
