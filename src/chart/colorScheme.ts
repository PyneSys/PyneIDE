/**
 * Which colors the chart says "up" and "down" in: one list shared by the chart
 * style popup, the persisted `pyneide.chart.colorScheme` setting and the
 * webview renderer.
 *
 * Four roles, not two. Rising/falling price and long/short trades need separate
 * pairs because a trade marker is painted ON the candle it belongs to — reusing
 * the candle pair would hide half the entries against their own bar.
 *
 * Kept free of both `vscode` and `klinecharts` imports so the extension host and
 * the webview can share it. `theme` resolves against the `--vscode-charts-*`
 * custom properties, which only the webview can read, so the resolution itself
 * lives there; what is here is the static palettes and the fallbacks.
 */

export const COLOR_SCHEME_IDS = ['classic', 'theme', 'colorblind'] as const;

export type ColorSchemeId = (typeof COLOR_SCHEME_IDS)[number];

export const DEFAULT_COLOR_SCHEME: ColorSchemeId = 'classic';

export interface ColorSchemeOption {
  id: ColorSchemeId;
  label: string;
  /** Shown as the row's tooltip in the toolbar popup. */
  detail: string;
}

export const COLOR_SCHEME_OPTIONS: readonly ColorSchemeOption[] = [
  {
    id: 'classic',
    label: 'Classic',
    detail: 'The trading-chart standard: teal up, red down, blue/red trades',
  },
  {
    id: 'theme',
    label: 'Theme',
    detail: "Follows the color theme's own chart colors, light and dark alike",
  },
  {
    id: 'colorblind',
    label: 'Colorblind-safe',
    detail: 'Blue up, orange down — readable with any form of color blindness',
  },
];

/** The four direction colors of a resolved scheme. */
export interface ChartPalette {
  /** Rising bar. */
  up: string;
  /** Falling bar. */
  down: string;
  /** Long entry, and the exit of a short. */
  long: string;
  /** Short entry, and the exit of a long. */
  short: string;
}

/**
 * TradingView's own pair, which `plotcandle`/`plotbar` and the measure tool
 * already default to — the chart's own candles use it too so that a colorless
 * `plotcandle()` and the bars underneath are not two different greens.
 */
export const CLASSIC_PALETTE: ChartPalette = {
  up: '#26a69a',
  down: '#ef5350',
  long: '#2962ff',
  short: '#ff5252',
};

/**
 * Okabe-Ito, the standard palette that stays separable under deuteranopia,
 * protanopia and tritanopia alike. Split by background because no single pair
 * carries both: the darker blues disappear on a dark editor, the brighter ones
 * on a light one. The trade pair (green/purple) is deliberately off the
 * candles' blue/orange axis so a marker never melts into its own bar.
 */
export const COLORBLIND_PALETTE_DARK: ChartPalette = {
  up: '#56b4e9',
  down: '#e69f00',
  long: '#00c894',
  short: '#cc79a7',
};

export const COLORBLIND_PALETTE_LIGHT: ChartPalette = {
  up: '#0072b2',
  down: '#d55e00',
  long: '#009e73',
  short: '#cc79a7',
};

/** Narrow an unknown (setting value, restored state) to a known scheme id. */
export function toColorSchemeId(value: unknown): ColorSchemeId {
  return COLOR_SCHEME_IDS.includes(value as ColorSchemeId)
    ? (value as ColorSchemeId)
    : DEFAULT_COLOR_SCHEME;
}
