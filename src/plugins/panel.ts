/**
 * Plugins webview panel (viewType `pyneide.plugins`): the PyneCore plugin
 * catalogue plus what is installed in the environment, with install/update/
 * uninstall on the managed venv.
 *
 * The panel is a thin shell over {@link PluginService}: it posts the merged
 * model, turns webview intents into service calls, and re-posts the model after
 * each one. Detail payloads are fetched per selection and memoized for the
 * lifetime of the panel.
 *
 * One panel at a time (singleton): a second `show()` reveals the existing one.
 */
import * as vscode from 'vscode';

import type { PluginDetail } from './catalog';
import type { PluginsInMessage, PluginsOutMessage } from './messages';
import { PluginActionError, type PluginRow, type PluginService } from './service';

export class PluginsPanel {
  private static current: PluginsPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly detailCache = new Map<string, PluginDetail>();
  private rows: PluginRow[] = [];
  private busyRow: string | undefined;

  static show(context: vscode.ExtensionContext, service: PluginService): void {
    if (PluginsPanel.current) {
      PluginsPanel.current.panel.reveal(vscode.ViewColumn.Active);
      return;
    }
    PluginsPanel.current = new PluginsPanel(context, service);
  }

  /** Re-post the model if the panel is open (an install elsewhere changed it). */
  static refresh(): void {
    void PluginsPanel.current?.postModel();
  }

  private constructor(
    context: vscode.ExtensionContext,
    private readonly service: PluginService
  ) {
    const distRoot = vscode.Uri.joinPath(context.extensionUri, 'dist');
    this.panel = vscode.window.createWebviewPanel(
      'pyneide.plugins',
      'PyneCore Plugins',
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [distRoot] }
    );
    this.panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'icons', 'pyne-view.svg');
    this.panel.webview.html = this.html(this.panel.webview, distRoot);
    this.panel.webview.onDidReceiveMessage(
      (msg: PluginsOutMessage) => void this.onMessage(msg),
      null,
      this.disposables
    );
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
  }

  private post(message: PluginsInMessage): void {
    void this.panel.webview.postMessage(message);
  }

  private async postModel(refresh = false): Promise<void> {
    this.post({ type: 'loading' });
    const model = await this.service.model(refresh);
    this.rows = model.rows;
    this.post({ type: 'model', model });
  }

  private async onMessage(msg: PluginsOutMessage): Promise<void> {
    switch (msg.type) {
      case 'ready':
        await this.postModel();
        break;
      case 'refresh':
        this.detailCache.clear();
        await this.postModel(true);
        break;
      case 'select':
        await this.sendDetail(msg.id);
        break;
      case 'install':
        await this.runAction(msg.id, 'install');
        break;
      case 'uninstall':
        await this.runAction(msg.id, 'uninstall');
        break;
      case 'copyCommand':
        await this.copyCommand(msg.id);
        break;
      case 'openLink':
        await vscode.env.openExternal(vscode.Uri.parse(msg.url));
        break;
    }
  }

  /** Index detail for the side pane; locally installed rows have none. */
  private async sendDetail(id: string): Promise<void> {
    const row = this.row(id);
    if (!row?.inCatalogue) return;
    const cached = this.detailCache.get(row.package);
    if (cached) {
      this.post({ type: 'detail', id, detail: cached });
      return;
    }
    try {
      const detail = await this.service.detail(row.package);
      this.detailCache.set(row.package, detail);
      this.post({ type: 'detail', id, detail });
    } catch (err) {
      this.post({
        type: 'detail',
        id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async runAction(id: string, action: 'install' | 'uninstall'): Promise<void> {
    const row = this.row(id);
    if (!row || this.busyRow) return;
    this.busyRow = id;
    this.post({ type: 'busy', id });
    try {
      if (action === 'install') {
        await this.service.install(row);
      } else {
        await this.service.uninstall(row);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.post({ type: 'actionError', id, message });
      if (err instanceof PluginActionError && err.kind === 'unmanaged') {
        await this.copyCommand(id);
      } else {
        void vscode.window.showErrorMessage(
          `PyneIDE: ${action === 'install' ? 'installing' : 'removing'} ${row.package} failed — ${message}`
        );
      }
    } finally {
      this.busyRow = undefined;
      this.post({ type: 'busy', id: null });
      this.detailCache.delete(row.package);
      await this.postModel();
    }
  }

  private async copyCommand(id: string): Promise<void> {
    const row = this.row(id);
    if (!row) return;
    const command = this.service.installCommand(row);
    await vscode.env.clipboard.writeText(command);
    void vscode.window.showInformationMessage(`PyneIDE: copied to clipboard — ${command}`);
  }

  private row(id: string): PluginRow | undefined {
    return this.rows.find((r) => r.id === id);
  }

  private dispose(): void {
    PluginsPanel.current = undefined;
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
  }

  private html(webview: vscode.Webview, distRoot: vscode.Uri): string {
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(distRoot, 'plugins.js'));
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; script-src ${webview.cspSource}; style-src 'unsafe-inline';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  html, body { height: 100%; margin: 0; padding: 0; overflow: hidden; }
  body {
    font-family: var(--vscode-font-family);
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    font-size: 13px;
    display: flex; flex-direction: column;
  }
  #header {
    flex: 0 0 auto; padding: 10px 16px 8px;
    border-bottom: 1px solid var(--vscode-panel-border, #444);
    display: flex; flex-direction: column; gap: 8px;
  }
  #title-row { display: flex; align-items: baseline; gap: 12px; }
  #title { font-size: 15px; font-weight: 600; }
  #status { color: var(--vscode-descriptionForeground); font-size: 12px; flex: 1 1 auto; }
  #status.warn { color: var(--vscode-editorWarning-foreground, #cca700); }
  #status.error { color: var(--vscode-errorForeground, #f48771); }
  #filters { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  input[type=text] {
    box-sizing: border-box; flex: 1 1 220px; min-width: 160px;
    background: var(--vscode-input-background); color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, var(--vscode-panel-border, #444));
    border-radius: 2px; padding: 4px 8px; font-family: inherit; font-size: 12px; height: 26px;
    color-scheme: light dark;
  }
  .chip {
    padding: 2px 9px; border-radius: 10px; font-size: 11px; cursor: pointer;
    border: 1px solid var(--vscode-panel-border, #444);
    color: var(--vscode-descriptionForeground); background: transparent; user-select: none;
  }
  .chip.on {
    color: var(--vscode-button-foreground, #fff);
    background: var(--vscode-button-background, #0e639c);
    border-color: transparent;
  }
  #main { flex: 1 1 auto; display: flex; min-height: 0; }
  #list {
    flex: 1 1 55%; overflow-y: auto; min-width: 320px;
    border-right: 1px solid var(--vscode-panel-border, #444);
  }
  #detail { flex: 1 1 45%; overflow-y: auto; padding: 14px 18px 40px; }
  .row {
    padding: 9px 16px; cursor: pointer;
    border-bottom: 1px solid var(--vscode-panel-border, #2a2a2a);
  }
  .row:hover { background: var(--vscode-list-hoverBackground, rgba(128,128,128,0.08)); }
  .row.sel {
    background: var(--vscode-list-activeSelectionBackground, rgba(80,120,200,0.25));
    color: var(--vscode-list-activeSelectionForeground, inherit);
  }
  .row-head { display: flex; align-items: baseline; gap: 8px; }
  .name { font-weight: 600; }
  .pkg { color: var(--vscode-descriptionForeground); font-size: 11px; }
  .row-summary {
    color: var(--vscode-descriptionForeground); font-size: 12px;
    margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .badges { display: inline-flex; gap: 5px; flex-wrap: wrap; align-items: center; }
  .badge {
    display: inline-block; padding: 0 6px; border-radius: 3px;
    font-size: 10px; font-weight: 600; letter-spacing: .02em; white-space: nowrap;
    background: var(--vscode-badge-background, rgba(128,128,128,0.2));
    color: var(--vscode-badge-foreground, inherit);
  }
  .badge.official { color: var(--vscode-charts-green, #89d185); border: 1px solid currentColor; background: transparent; }
  .badge.verified { color: var(--vscode-charts-blue, #75beff); border: 1px solid currentColor; background: transparent; }
  .badge.community { color: var(--vscode-descriptionForeground); border: 1px solid currentColor; background: transparent; }
  .badge.installed { color: var(--vscode-charts-green, #89d185); border: 1px solid currentColor; background: transparent; }
  .badge.update { color: var(--vscode-editorWarning-foreground, #cca700); border: 1px solid currentColor; background: transparent; }
  .badge.warn { color: var(--vscode-errorForeground, #f48771); border: 1px solid currentColor; background: transparent; }
  h2.section {
    font-size: 11px; text-transform: uppercase; letter-spacing: .05em; font-weight: 600;
    color: var(--vscode-descriptionForeground);
    margin: 14px 16px 4px; padding-bottom: 3px;
    border-bottom: 1px solid var(--vscode-panel-border, #333);
  }
  #detail h1 { font-size: 16px; margin: 0 0 2px; }
  #detail .sub { color: var(--vscode-descriptionForeground); font-size: 12px; margin-bottom: 12px; }
  #detail h3 {
    font-size: 11px; text-transform: uppercase; letter-spacing: .05em;
    color: var(--vscode-descriptionForeground); margin: 18px 0 6px;
  }
  #detail p { margin: 6px 0; line-height: 1.5; }
  #actions { display: flex; gap: 8px; flex-wrap: wrap; margin: 12px 0 4px; }
  .meta { border-collapse: collapse; width: 100%; }
  .meta td { padding: 3px 0; vertical-align: top; font-size: 12px; }
  .meta td.k { color: var(--vscode-descriptionForeground); width: 40%; padding-right: 10px; }
  .mono { font-family: var(--vscode-editor-font-family, monospace); }
  a { color: var(--vscode-textLink-foreground); cursor: pointer; text-decoration: none; }
  a:hover { text-decoration: underline; }
  button {
    background: var(--vscode-button-background, #0e639c);
    color: var(--vscode-button-foreground, #fff);
    border: none; border-radius: 3px; cursor: pointer; padding: 4px 12px;
    font-size: 12px; height: 26px; white-space: nowrap;
  }
  button:hover:not(:disabled) { background: var(--vscode-button-hoverBackground, #1177bb); }
  button:disabled { opacity: 0.5; cursor: default; }
  button.secondary {
    background: var(--vscode-button-secondaryBackground, transparent);
    color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
    border: 1px solid var(--vscode-panel-border, #444);
  }
  .empty { color: var(--vscode-descriptionForeground); padding: 16px; }
  .note { color: var(--vscode-descriptionForeground); font-size: 12px; margin-top: 8px; }
  .note.blocked { color: var(--vscode-editorWarning-foreground, #cca700); }
  .note.error { color: var(--vscode-errorForeground, #f48771); }
</style>
</head>
<body>
<div id="header">
  <div id="title-row">
    <div id="title">PyneCore Plugins</div>
    <div id="status"></div>
    <button id="refresh" class="secondary" type="button">Refresh</button>
  </div>
  <div id="filters">
    <input type="text" id="search" placeholder="Search plugins…" />
    <span class="chip" data-filter="installed">Installed</span>
    <span class="chip" data-filter="provider">Provider</span>
    <span class="chip" data-filter="broker">Broker</span>
    <span class="chip" data-filter="cli">CLI</span>
  </div>
</div>
<div id="main">
  <div id="list"></div>
  <div id="detail"><div class="empty">Select a plugin to see its details.</div></div>
</div>
<script src="${scriptUri}"></script>
</body>
</html>`;
  }
}
