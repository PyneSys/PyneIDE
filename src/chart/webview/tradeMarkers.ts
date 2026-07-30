/**
 * Strategy trade markers, painted straight onto the chart canvas.
 *
 * Each fill gets a triangle at its ACTUAL price — entry and exit alike — so the
 * chart never misplaces where the trade happened. The side/size label and its
 * arrow are separate glyphs anchored to the bar's low/high, because a label
 * drawn at the fill price would sit inside the candle body; those are the ones
 * that stack when several trades land on one bar.
 *
 * Follows the F9A pattern used by drawings.ts — a figure-less indicator's draw
 * callback, NOT the KLineChart overlay API. The overlay path cannot scale here:
 * `OverlayView.drawImp` iterates every overlay of the pane on each repaint with
 * no visible-range culling, and the overlay canvas repaints on every crosshair
 * move. Candles stay fast at 100k+ bars precisely because they iterate the
 * visible range only; painting markers the same way removes the need for any
 * marker cap.
 *
 * Everything expensive (index resolution, title/size formatting) happens once
 * in `buildTradeMarkerIndex`, so the draw callback only converts coordinates.
 */
import type { TradeRecord } from '../../run/bridgeClient';
import { MARKER_STACK_GAP, type MarkerDrawEnv } from './plotStyles';

/** Half-width of the widest entry label, in pixels — how far off-screen a
 * marker can still be while painting visible pixels. */
const MARKER_HALF_WIDTH_PX = 40;

/** Entry glyph geometry, in pixels outward from the anchor. */
const ARROW_TIP = 16;
const ARROW_TAIL = 34;
const TITLE_OFFSET = 44;
const DETAIL_OFFSET = 59;
const TEXT_PX = 12;
/** Arrow head length and half-width, and the stem's half-width. */
const ARROW_HEAD = 7;
const ARROW_HEAD_HALF = 6;
const ARROW_STEM_HALF = 1.5;

/** One glyph to paint, with every value already resolved. */
export interface TradeMarkerItem {
  /** 'price' is the triangle at a fill price (entry or exit); 'label' is the
   * arrow + side/size text anchored to the bar's low/high. */
  kind: 'price' | 'label';
  /** The fill price for 'price', the bar low/high for 'label'. */
  value: number;
  /** 'up' is a long: the label sits below the bar, pointing up. */
  direction: 'up' | 'down';
  /**
   * Which of the two trade colors this glyph wears. Deliberately the ROLE, not
   * a resolved color: the index outlives a scheme or theme switch (it is only
   * rebuilt when the trade or bar count moves), so baking a color in here would
   * leave every existing marker in the old palette. Not derivable from
   * `direction` either — a long's exit points up but is painted 'short'.
   */
  tone: 'long' | 'short';
  /** 'label' only, pre-formatted. */
  title?: string;
  /** 'label' only, pre-formatted signed size. */
  detail?: string;
}

/** Bar index -> the glyphs anchored to that bar, in trade order. */
export type TradeMarkerIndex = Map<number, TradeMarkerItem[]>;

export interface TradeMarkerTheme {
  textColor: string;
  fontFamily: string;
  longColor: string;
  shortColor: string;
}

function toneColor(item: TradeMarkerItem, theme: TradeMarkerTheme): string {
  return item.tone === 'long' ? theme.longColor : theme.shortColor;
}

interface AnchorBar {
  high: number;
  low: number;
}

function entryTitle(long: boolean, entryId: string | null): string {
  const side = long ? 'Long' : 'Short';
  const id = entryId?.trim();
  if (!id || id.toLowerCase() === side.toLowerCase()) return side;
  return `${side} ${id}`;
}

function signedSize(size: number | null): string | undefined {
  if (size == null || !Number.isFinite(size) || size === 0) return undefined;
  const rounded = Number(size.toFixed(6));
  if (rounded === 0) return undefined;
  return `${rounded > 0 ? '+' : ''}${rounded}`;
}

/** Bar index for a trade timestamp, falling back to the runner's bar number
 * when the timestamp is not on the chart (e.g. a resampled series). */
function barIndexFor(
  tsToIndex: ReadonlyMap<number, number>,
  timestamp: number,
  barFallback: number,
): number | undefined {
  const byTime = tsToIndex.get(timestamp);
  if (byTime !== undefined) return byTime;
  return Number.isInteger(barFallback) ? barFallback : undefined;
}

function push(index: TradeMarkerIndex, barIndex: number, item: TradeMarkerItem): void {
  const bucket = index.get(barIndex);
  if (bucket) bucket.push(item);
  else index.set(barIndex, [item]);
}

/**
 * Resolve every trade to its bar and glyphs. Keying by bar index makes the
 * result independent of `trades` ordering — open trades arrive after the closed
 * ones, so the array itself is not strictly chronological.
 */
export function buildTradeMarkerIndex(
  trades: readonly TradeRecord[],
  bars: readonly AnchorBar[],
  tsToIndex: ReadonlyMap<number, number>,
): TradeMarkerIndex {
  const index: TradeMarkerIndex = new Map();
  for (const trade of trades) {
    const long = (trade.size ?? 0) > 0;

    const entryIndex = barIndexFor(tsToIndex, trade.entryTime, trade.entryBar);
    const entryBar = entryIndex === undefined ? undefined : bars[entryIndex];
    if (entryIndex !== undefined && entryBar) {
      // The fill price marker, at the exact entry price.
      if (trade.entryPrice != null && Number.isFinite(trade.entryPrice)) {
        push(index, entryIndex, {
          kind: 'price',
          value: trade.entryPrice,
          direction: long ? 'up' : 'down',
          tone: long ? 'long' : 'short',
        });
      }
      // The side/size label, hung off the bar so it clears the candle body.
      const anchor = long ? entryBar.low : entryBar.high;
      if (Number.isFinite(anchor)) {
        push(index, entryIndex, {
          kind: 'label',
          value: anchor,
          direction: long ? 'up' : 'down',
          tone: long ? 'long' : 'short',
          title: entryTitle(long, trade.entryId),
          detail: signedSize(trade.size),
        });
      }
    }

    // An open trade has no exit price — entry markers only.
    if (trade.exitPrice == null || !Number.isFinite(trade.exitPrice)) continue;
    const exitIndex = barIndexFor(tsToIndex, trade.exitTime, trade.exitBar);
    if (exitIndex === undefined || !bars[exitIndex]) continue;
    push(index, exitIndex, {
      kind: 'price',
      value: trade.exitPrice,
      direction: long ? 'up' : 'down',
      tone: long ? 'short' : 'long',
    });
  }
  return index;
}

/**
 * How far a label glyph reaches outward from its anchor, including the text.
 * The two directions differ because the labels use a 'top' baseline below the
 * bar and a 'bottom' baseline above it.
 */
function labelExtent(item: TradeMarkerItem): number {
  const last = item.detail ? DETAIL_OFFSET : TITLE_OFFSET;
  return item.direction === 'up' ? last + TEXT_PX : last;
}

function drawLabel(
  ctx: CanvasRenderingContext2D,
  item: TradeMarkerItem,
  x: number,
  y: number,
  theme: TradeMarkerTheme,
): void {
  const pointsUp = item.direction === 'up';
  const dir = pointsUp ? 1 : -1;
  // Snap to whole pixels: the stem is 3 px wide, so integer center keeps both
  // of its edges on pixel boundaries instead of smearing across two columns.
  const cx = Math.round(x);
  const cy = Math.round(y);
  const tipY = cy + ARROW_TIP * dir;
  const baseY = tipY + ARROW_HEAD * dir;
  const tailY = cy + ARROW_TAIL * dir;
  const titleY = cy + TITLE_OFFSET * dir;
  const detailY = cy + DETAIL_OFFSET * dir;

  // Stem and head as ONE filled polygon. Stroking the stem separately made its
  // round cap overshoot the head's apex by half the line width, which reads as
  // a blunt nub sitting past the tip.
  ctx.lineJoin = 'round';
  ctx.fillStyle = toneColor(item, theme);
  ctx.shadowColor = 'rgba(0, 0, 0, 0.9)';
  ctx.shadowBlur = 4;
  ctx.shadowOffsetY = 1;
  ctx.beginPath();
  ctx.moveTo(cx, tipY);
  ctx.lineTo(cx - ARROW_HEAD_HALF, baseY);
  ctx.lineTo(cx - ARROW_STEM_HALF, baseY);
  ctx.lineTo(cx - ARROW_STEM_HALF, tailY);
  ctx.lineTo(cx + ARROW_STEM_HALF, tailY);
  ctx.lineTo(cx + ARROW_STEM_HALF, baseY);
  ctx.lineTo(cx + ARROW_HEAD_HALF, baseY);
  ctx.closePath();
  ctx.fill();

  ctx.font = `500 12px ${theme.fontFamily}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = pointsUp ? 'top' : 'bottom';
  ctx.lineWidth = 3;
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.9)';
  ctx.fillStyle = theme.textColor;
  ctx.shadowBlur = 3;
  if (item.title) {
    ctx.strokeText(item.title, cx, titleY);
    ctx.fillText(item.title, cx, titleY);
  }
  if (item.detail) {
    ctx.strokeText(item.detail, cx, detailY);
    ctx.fillText(item.detail, cx, detailY);
  }
}

function drawPriceMark(
  ctx: CanvasRenderingContext2D,
  item: TradeMarkerItem,
  x: number,
  y: number,
  theme: TradeMarkerTheme,
): void {
  const backX = x - 8;

  ctx.lineJoin = 'round';
  ctx.fillStyle = toneColor(item, theme);
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.9)';
  ctx.lineWidth = 1.5;
  ctx.shadowColor = 'rgba(0, 0, 0, 0.9)';
  ctx.shadowBlur = 2;
  ctx.shadowOffsetY = 1;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(backX, y - 5);
  ctx.lineTo(backX, y + 5);
  ctx.closePath();
  ctx.stroke();
  ctx.fill();
}

/**
 * Paint the trade markers of the visible bar range. The range is padded by the
 * label half-width converted to bars, so a marker anchored just off-screen
 * still contributes its visible pixels.
 *
 * Labels landing on the same bar are stacked outward in trade order (long
 * labels grow down from the low, short labels up from the high), the way
 * TradingView does it. Price triangles are never stacked or shifted — every one
 * of them stays on its own fill price, for entries and exits alike.
 */
export function drawTradeMarkers(
  env: MarkerDrawEnv,
  index: TradeMarkerIndex,
  theme: TradeMarkerTheme,
): void {
  if (index.size === 0) return;
  const { ctx } = env;
  const pad = Math.max(1, Math.ceil(MARKER_HALF_WIDTH_PX / Math.max(1, env.gapBar)));
  const from = Math.max(0, env.visibleFrom - pad);
  const to = Math.min(env.bars.length, env.visibleTo + pad);
  if (to <= from) return;

  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, env.bounding.width, env.bounding.height);
  ctx.clip();
  for (let barIndex = from; barIndex < to; barIndex++) {
    const items = index.get(barIndex);
    if (!items) continue;
    const x = env.xAxis.convertToPixel(barIndex);
    // Outward stacking offsets, per direction, reset per bar.
    let stackDown = 0;
    let stackUp = 0;
    for (const item of items) {
      const y = env.yAxis.convertToPixel(item.value);
      if (item.kind === 'price') {
        drawPriceMark(ctx, item, x, y, theme);
        continue;
      }
      const pointsUp = item.direction === 'up';
      const offset = pointsUp ? stackDown : stackUp;
      // Once the stack has walked off the pane there is nothing left to show;
      // a bar with thousands of entries must not cost thousands of draws.
      if (offset > env.bounding.height) continue;
      drawLabel(ctx, item, x, pointsUp ? y + offset : y - offset, theme);
      const consumed = labelExtent(item) + MARKER_STACK_GAP;
      if (pointsUp) stackDown += consumed;
      else stackUp += consumed;
    }
  }
  ctx.restore();
}
