/**
 * Symbol Map webview panel (viewType `pyneide.symbolMap`): a single editable view
 * of the whole workdir `[symbol_map]` table. It lists every TV-symbol -> native
 * mapping with its ok/missing `.ohlcv` status, and surfaces the existing data
 * files as one-click mapping targets (the primary "file -> TV name" flow).
 *
 * The panel is a thin shell over the pure {@link buildSymbolMapModel} data and
 * the line-oriented `symbol_map.toml` writers: every edit goes straight to the
 * file, then the fresh model is re-posted so the webview is a pure function of
 * what is on disk. A FileSystemWatcher on the map file and the data dir re-posts
 * on external change (CLI edits, a download finishing), so the view stays live.
 *
 * One panel at a time (singleton): a second `show()` reveals the existing one.
 */
import * as vscode from 'vscode';

import {
  ensureSymbolMapFile,
  removeSymbolMapEntry,
  symbolMapPath,
  writeSymbolMapEntry,
} from '../run/symbolMapFile';
import type { SecurityPrefill } from './symbolBrowserPanel';
import { buildSymbolMapModel } from './symbolMapModel';
import type { SymbolMapInMessage, SymbolMapOutMessage } from './symbolMapMessages';

export interface SymbolMapDeps {
  /** The active Pyne workspace directory (holds `config/` and `data/`). */
  workdir: string;
  /**
   * Open the Symbol Browser armed with a download prefill, so its post-download
   * auto-map fills the map entry the user asked to download. A panel-initiated
   * download carries no `chartKey`, so no "Run" is offered afterwards.
   */
  showSymbolBrowser: (prefill: SecurityPrefill) => void;
  /** Fired after a map write/remove so the tree and diagnostics can refresh. */
  onChanged?: () => void;
}

export class SymbolMapPanel {
  private static current: SymbolMapPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  /** Coalesces a burst of watcher events into a single re-post. */
  private repostTimer: ReturnType<typeof setTimeout> | undefined;

  /** Reveal the existing Symbol Map panel or create one in the editor area. */
  static show(context: vscode.ExtensionContext, deps: SymbolMapDeps): void {
    if (SymbolMapPanel.current) {
      SymbolMapPanel.current.panel.reveal(vscode.ViewColumn.Active);
      return;
    }
    SymbolMapPanel.current = new SymbolMapPanel(context, deps);
  }

  private constructor(
    context: vscode.ExtensionContext,
    private readonly deps: SymbolMapDeps
  ) {
    const distRoot = vscode.Uri.joinPath(context.extensionUri, 'dist');
    this.panel = vscode.window.createWebviewPanel(
      'pyneide.symbolMap',
      'Symbol Map',
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [distRoot] }
    );
    this.panel.webview.html = this.html(this.panel.webview, distRoot);
    this.panel.webview.onDidReceiveMessage(
      (msg: SymbolMapOutMessage) => void this.onMessage(msg),
      null,
      this.disposables
    );
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.watch();
  }

  /** Re-post the model whenever the map file or the data dir changes on disk. */
  private watch(): void {
    const mapWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.Uri.file(this.deps.workdir), 'config/symbol_map.toml')
    );
    const dataWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.Uri.file(this.deps.workdir), 'data/*')
    );
    for (const w of [mapWatcher, dataWatcher]) {
      w.onDidChange(() => this.scheduleRepost(), null, this.disposables);
      w.onDidCreate(() => this.scheduleRepost(), null, this.disposables);
      w.onDidDelete(() => this.scheduleRepost(), null, this.disposables);
      this.disposables.push(w);
    }
  }

  /** Debounced model re-post: a download writes an `.ohlcv` + `.toml` + the map
   * entry in quick succession, and we want one refresh, not three. */
  private scheduleRepost(): void {
    if (this.repostTimer) clearTimeout(this.repostTimer);
    this.repostTimer = setTimeout(() => this.postModel(), 120);
  }

  private postModel(): void {
    const message: SymbolMapInMessage = { type: 'model', model: buildSymbolMapModel(this.deps.workdir) };
    void this.panel.webview.postMessage(message);
  }

  private async onMessage(msg: SymbolMapOutMessage): Promise<void> {
    switch (msg.type) {
      case 'ready':
        this.postModel();
        break;
      case 'setEntry':
        this.setEntry(msg.key, msg.value, msg.oldKey);
        break;
      case 'removeEntry':
        removeSymbolMapEntry(this.deps.workdir, msg.key);
        this.postModel();
        this.deps.onChanged?.();
        break;
      case 'download':
        this.download(msg.tvKey, msg.symbol, msg.timeframe);
        break;
      case 'openRaw':
        await this.openRaw();
        break;
    }
  }

  /** Write (or rename) a map entry, then re-post + notify. A rename drops the old
   * key first so a changed KEY leaves no stale line behind. */
  private setEntry(key: string, value: string, oldKey?: string): void {
    ensureSymbolMapFile(this.deps.workdir);
    if (oldKey && oldKey !== key) removeSymbolMapEntry(this.deps.workdir, oldKey);
    writeSymbolMapEntry(this.deps.workdir, key, value);
    this.postModel();
    this.deps.onChanged?.();
  }

  /** Open the Symbol Browser to download data for `tvKey`; its post-download
   * auto-map writes the entry, which the watcher then reflects here. */
  private download(tvKey: string, symbol: string, timeframe?: string): void {
    const prefill: SecurityPrefill = {
      symbol,
      timeframe,
      mapKey: tvKey,
      workdir: this.deps.workdir,
    };
    this.deps.showSymbolBrowser(prefill);
  }

  /** Open the raw `config/symbol_map.toml` (created if missing) in a text editor. */
  private async openRaw(): Promise<void> {
    ensureSymbolMapFile(this.deps.workdir);
    const doc = await vscode.workspace.openTextDocument(
      vscode.Uri.file(symbolMapPath(this.deps.workdir))
    );
    await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
  }

  private dispose(): void {
    SymbolMapPanel.current = undefined;
    if (this.repostTimer) clearTimeout(this.repostTimer);
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
  }

  private html(webview: vscode.Webview, distRoot: vscode.Uri): string {
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(distRoot, 'symbol-map.js'));
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; script-src ${webview.cspSource}; style-src 'unsafe-inline';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  html, body { height: 100%; margin: 0; padding: 0; }
  body {
    font-family: var(--vscode-font-family);
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    font-size: 13px;
  }
  #root { max-width: 1100px; margin: 0 auto; padding: 12px 16px 60px; }
  #header {
    position: sticky; top: 0; z-index: 3;
    background: var(--vscode-editor-background);
    padding: 8px 0 10px; margin-bottom: 6px;
    border-bottom: 1px solid var(--vscode-panel-border, #444);
    display: flex; align-items: baseline; gap: 12px;
  }
  #title { font-size: 15px; font-weight: 600; flex: 0 0 auto; }
  #subtitle { color: var(--vscode-descriptionForeground); font-size: 12px; flex: 1 1 auto; }
  h2.section {
    font-size: 11px; text-transform: uppercase; letter-spacing: .05em; font-weight: 600;
    color: var(--vscode-descriptionForeground);
    margin: 22px 0 6px; padding-bottom: 3px;
    border-bottom: 1px solid var(--vscode-panel-border, #333);
  }
  table { border-collapse: collapse; width: 100%; }
  thead th {
    text-align: left; font-weight: 600; font-size: 11px;
    text-transform: uppercase; letter-spacing: .03em;
    color: var(--vscode-descriptionForeground);
    padding: 4px 8px; border-bottom: 1px solid var(--vscode-panel-border, #333);
    white-space: nowrap;
  }
  tbody td { padding: 4px 8px; vertical-align: middle; border-bottom: 1px solid var(--vscode-panel-border, #2a2a2a); }
  tbody tr:hover { background: var(--vscode-list-hoverBackground, rgba(128,128,128,0.08)); }
  .col-remove { width: 28px; text-align: center; }
  .col-data { white-space: nowrap; }
  .mono { font-family: var(--vscode-editor-font-family, monospace); font-variant-numeric: tabular-nums; }
  input[type=text], select {
    box-sizing: border-box; width: 100%; min-width: 60px;
    background: var(--vscode-input-background); color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, var(--vscode-panel-border, #444));
    border-radius: 2px; padding: 3px 6px; font-family: inherit; font-size: 12px; height: 26px;
    color-scheme: light dark;
  }
  .target-cell { display: flex; flex-direction: column; gap: 4px; }
  .target-cell select { font-family: var(--vscode-editor-font-family, monospace); }
  .tf-chips { display: inline-flex; flex-wrap: wrap; gap: 4px; }
  .tf-chip {
    display: inline-block; padding: 1px 7px; border-radius: 10px;
    font-size: 11px; font-weight: 600; white-space: nowrap;
    font-variant-numeric: tabular-nums;
    color: var(--vscode-charts-green, #89d185); border: 1px solid currentColor;
  }
  .tf-tag {
    display: inline-block; margin-left: 6px; padding: 0 6px; border-radius: 3px;
    font-size: 10px; font-weight: 600; letter-spacing: .02em; vertical-align: middle;
    color: var(--vscode-descriptionForeground);
    background: var(--vscode-badge-background, rgba(128,128,128,0.2));
  }
  .file-name { color: var(--vscode-descriptionForeground); font-size: 12px; }
  button {
    background: var(--vscode-button-background, #0e639c);
    color: var(--vscode-button-foreground, #fff);
    border: none; border-radius: 3px; cursor: pointer; padding: 3px 10px;
    font-size: 12px; height: 26px; white-space: nowrap;
  }
  button:hover:not(:disabled) { background: var(--vscode-button-hoverBackground, #1177bb); }
  button:disabled { opacity: 0.5; cursor: default; }
  button.secondary {
    background: var(--vscode-button-secondaryBackground, transparent);
    color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
    border: 1px solid var(--vscode-panel-border, #444);
  }
  button.icon {
    background: transparent; color: var(--vscode-descriptionForeground);
    padding: 0; width: 22px; height: 22px; font-size: 15px; line-height: 1;
  }
  button.icon:hover:not(:disabled) {
    background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.2));
    color: var(--vscode-errorForeground, #f48771);
  }
  #add-row { margin: 8px 0 4px; }
  .empty { color: var(--vscode-descriptionForeground); padding: 10px 8px; }
  .files-table td.tv { color: var(--vscode-descriptionForeground); }
</style>
</head>
<body>
<div id="root">
  <div id="header">
    <div id="title">Symbol Map</div>
    <div id="subtitle">TradingView symbols -> provider-qualified native symbols</div>
    <button id="open-raw" class="secondary" type="button">Edit TOML</button>
  </div>

  <h2 class="section">Mappings</h2>
  <div id="mappings"></div>
  <div id="add-row"><button id="add" class="secondary" type="button">+ Add mapping</button></div>

  <h2 class="section">Your data</h2>
  <div id="files"></div>
</div>
<script src="${scriptUri}"></script>
</body>
</html>`;
  }
}
