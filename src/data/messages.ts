/**
 * Messages between the OHLCV table editor host (ohlcvEditor.ts) and its webview
 * (webview/table.ts). The host reads the raw .ohlcv bytes + sibling .toml
 * syminfo and hands them to the webview, which parses the 24-byte records and
 * renders a virtualized table (files run to 100k+ bars).
 */

import type { FullSymInfo } from './syminfo';

/** Selected `[symbol]` fields from the sibling .toml, for the table header and
 * price formatting. All optional: a .ohlcv may have no .toml at all. */
export interface OhlcvMeta {
  fileName: string;
  description?: string;
  ticker?: string;
  currency?: string;
  basecurrency?: string;
  period?: string;
  type?: string;
  timezone?: string;
  mintick?: number;
  pricescale?: number;
  /** The full parsed syminfo (all `[symbol]` fields + trading-hours arrays +
   * `[download]` provider), for the expandable "Symbol info" panel. Absent when
   * there is no sibling .toml. */
  full?: FullSymInfo;
}

export type TableInMessage =
  // `uri` is a webview resource URI the webview fetch()es directly — NEVER send
  // the raw bytes via postMessage: VSCode serializes a Uint8Array as a JSON
  // number array, which takes ~a minute for a year of minute bars (~12 MB).
  | { type: 'data'; uri: string; meta: OhlcvMeta }
  | { type: 'error'; message: string };

export type TableOutMessage = { type: 'ready' };
