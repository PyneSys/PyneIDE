/**
 * Messages between the Symbol Map host (symbolMapPanel.ts) and its webview
 * (webview/symbolMap.ts). The host owns the workdir `[symbol_map]` table and the
 * on-disk data-file scan; the webview renders the whole map at once and posts
 * edits back. Every host-side mutation re-posts a fresh {@link SymbolMapModel},
 * so the webview is a pure function of the model it last received.
 */
import type { SymbolMapModel } from './symbolMapModel';

/** Host -> webview. */
export type SymbolMapInMessage =
  // The current map + data files, sent on `ready` and after every change.
  | { type: 'model'; model: SymbolMapModel };

/** Webview -> host. */
export type SymbolMapOutMessage =
  | { type: 'ready' }
  // Add or update `key = value`. When `oldKey` differs from `key` the entry is
  // renamed: the old key is removed and the new one written in one host step.
  | { type: 'setEntry'; key: string; value: string; oldKey?: string }
  | { type: 'removeEntry'; key: string }
  // Open the Symbol Browser armed to download + auto-map THIS entry. `symbol`
  // seeds the search box (native symbol, best-effort); `tvKey` is the map key.
  | { type: 'download'; tvKey: string; symbol: string; timeframe?: string }
  // Open the raw `config/symbol_map.toml` in a text editor.
  | { type: 'openRaw' };
