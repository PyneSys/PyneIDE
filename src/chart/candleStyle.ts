/**
 * The chart's candle-rendering styles: one list shared by the toolbar popup,
 * the persisted `pyneide.chart.candleStyle` setting and the webview renderer.
 *
 * Deliberately one flat list rather than a type × palette matrix: the user
 * makes a single "how should price look" choice, the way a TradingView chart
 * type menu works. Kept free of both `vscode` and `klinecharts` imports so the
 * extension host and the webview can share it; the mapping onto KLineChart's
 * `candle.type`/`candle.bar` styles lives in the webview (it needs theme
 * colors).
 */

export const CANDLE_STYLE_IDS = ['candles', 'hollow', 'bars', 'mono', 'line', 'area'] as const;

export type CandleStyleId = (typeof CANDLE_STYLE_IDS)[number];

export const DEFAULT_CANDLE_STYLE: CandleStyleId = 'candles';

export interface CandleStyleOption {
  id: CandleStyleId;
  label: string;
  /** Shown as the row's tooltip in the toolbar popup. */
  detail: string;
}

export const CANDLE_STYLE_OPTIONS: readonly CandleStyleOption[] = [
  { id: 'candles', label: 'Candles', detail: 'Filled candles, up/down colored' },
  { id: 'hollow', label: 'Hollow candles', detail: 'Rising candles hollow, falling filled' },
  { id: 'bars', label: 'Bars', detail: 'OHLC bars: open tick left, close tick right' },
  { id: 'mono', label: 'Monochrome', detail: 'Hollow candles in the editor foreground color' },
  { id: 'line', label: 'Line', detail: 'Closing price as a plain line' },
  { id: 'area', label: 'Area', detail: 'Closing price as a filled area' },
];

/** Narrow an unknown (setting value, restored state) to a known style id. */
export function toCandleStyleId(value: unknown): CandleStyleId {
  return CANDLE_STYLE_IDS.includes(value as CandleStyleId)
    ? (value as CandleStyleId)
    : DEFAULT_CANDLE_STYLE;
}

/** Whether price is drawn as a line/area rather than per-bar shapes — the
 * per-bar decorations (barcolor) have nothing to paint on in that case. */
export function isPriceLineStyle(id: CandleStyleId): boolean {
  return id === 'line' || id === 'area';
}
