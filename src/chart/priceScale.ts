/**
 * How the price axis maps values to pixels: one list shared by the toolbar
 * popup, the persisted `pyneide.chart.priceScale` setting and the webview.
 *
 * The ids are deliberately KLineChart's own y-axis template names
 * (`normal`/`percentage`/`logarithm`, all three built in), so the webview can
 * hand an id straight to `chart.overrideYAxis({ name })`. This file itself
 * stays free of both `vscode` and `klinecharts` imports so the extension host
 * and the webview can share it.
 */

export const PRICE_SCALE_IDS = ['normal', 'logarithm', 'percentage'] as const;

export type PriceScaleId = (typeof PRICE_SCALE_IDS)[number];

export const DEFAULT_PRICE_SCALE: PriceScaleId = 'normal';

export interface PriceScaleOption {
  id: PriceScaleId;
  label: string;
  /** Shown as the row's tooltip in the toolbar popup. */
  detail: string;
}

export const PRICE_SCALE_OPTIONS: readonly PriceScaleOption[] = [
  { id: 'normal', label: 'Regular', detail: 'Linear price axis: equal price moves take equal space' },
  {
    id: 'logarithm',
    label: 'Logarithmic',
    detail: 'Equal percentage moves take equal space — the honest view of a long uptrend',
  },
  {
    id: 'percentage',
    label: 'Percent',
    detail: 'Percent change from the first visible bar’s close',
  },
];

/** Narrow an unknown (setting value, restored state) to a known scale id. */
export function toPriceScaleId(value: unknown): PriceScaleId {
  return PRICE_SCALE_IDS.includes(value as PriceScaleId)
    ? (value as PriceScaleId)
    : DEFAULT_PRICE_SCALE;
}
