/**
 * Messages between the Plugins host (panel.ts) and its webview
 * (webview/plugins.ts). The host owns the merged catalogue/installed model and
 * every mutation; the webview renders whatever model it last received and posts
 * intents back. Every host-side change re-posts a fresh model, so the webview
 * stays a pure function of it.
 */
import type { PluginDetail } from './catalog';
import type { PluginsModel } from './service';

/**
 * Rows are addressed by `PluginRow.id`, not by package name: PyneCore declares
 * both `ccxt` and `replay` from one package, so the package alone is not unique.
 */
/** Host -> webview. */
export type PluginsInMessage =
  // Full model, sent on `ready`, after a refresh and after every mutation.
  | { type: 'model'; model: PluginsModel }
  | { type: 'loading' }
  // The row an install/uninstall is running for (null = nothing running).
  | { type: 'busy'; id: string | null }
  // Detail pane payload for the selected row; `error` when the lookup failed.
  | { type: 'detail'; id: string; detail?: PluginDetail; error?: string }
  | { type: 'actionError'; id: string; message: string };

/** Webview -> host. */
export type PluginsOutMessage =
  | { type: 'ready' }
  | { type: 'refresh' }
  // Row selected: the host answers with a `detail` message for catalogue rows.
  | { type: 'select'; id: string }
  | { type: 'install'; id: string }
  | { type: 'uninstall'; id: string }
  // User-provided environments get the command instead of an install button.
  | { type: 'copyCommand'; id: string }
  | { type: 'openLink'; url: string };
