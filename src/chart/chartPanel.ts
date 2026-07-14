/**
 * Chart webview panel: owns the WebviewPanel lifecycle and forwards the
 * bridge event stream to the webview (see webview/main.ts for chart logic).
 * Messages are queued until the webview reports ready, so a run can start
 * streaming before the panel finished loading.
 */
import * as vscode from 'vscode';

import type { BridgeEvent, StartEvent } from '../run/bridgeClient';
import type { RunListener } from '../run/runService';
import type { ChartInMessage, ChartOutMessage } from './messages';

export class ChartPanelManager implements RunListener {
  private panel: vscode.WebviewPanel | undefined;
  private ready = false;
  private queue: ChartInMessage[] = [];
  private lastStart: StartEvent | undefined;

  constructor(private readonly context: vscode.ExtensionContext) {}

  onEvent(event: BridgeEvent): void {
    switch (event.e) {
      case 'start':
        this.lastStart = event;
        this.show(event.scriptTitle ?? undefined);
        this.post({ type: 'reset', start: event });
        break;
      case 'bars':
        this.post({ type: 'bars', rows: event.d });
        break;
      case 'plotKeys':
        this.post({ type: 'plotKeys', keys: event.keys });
        break;
      case 'trades':
        this.post({ type: 'trades', trades: event.d });
        break;
      case 'openTrades':
        this.post({ type: 'openTrades', trades: event.d });
        break;
      case 'stats':
        this.post({ type: 'stats', stats: event.d });
        break;
      case 'end':
        this.post({ type: 'end', bars: event.bars, cancelled: event.cancelled });
        break;
      default:
        break;
    }
  }

  onFinished(): void {
    // The 'end' event already closed out the chart state.
  }

  private handleOutMessage(msg: ChartOutMessage): void {
    switch (msg.type) {
      case 'ready':
        this.ready = true;
        for (const queued of this.queue) {
          void this.panel?.webview.postMessage(queued);
        }
        this.queue = [];
        break;
      case 'openCsv': {
        const file = msg.which === 'plot' ? this.lastStart?.outputs.plot : this.lastStart?.outputs.trades;
        if (file) void vscode.window.showTextDocument(vscode.Uri.file(file));
        break;
      }
    }
  }

  private post(message: ChartInMessage): void {
    if (!this.panel) return;
    if (!this.ready) {
      this.queue.push(message);
      return;
    }
    void this.panel.webview.postMessage(message);
  }

  private show(title?: string): void {
    if (this.panel) {
      this.panel.title = title ?? 'Pyne Chart';
      this.panel.reveal(undefined, true);
      return;
    }
    const distRoot = vscode.Uri.joinPath(this.context.extensionUri, 'dist');
    this.panel = vscode.window.createWebviewPanel(
      'pyneideChart',
      title ?? 'Pyne Chart',
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [distRoot],
      }
    );
    this.panel.webview.html = this.html(this.panel.webview, distRoot);
    this.panel.webview.onDidReceiveMessage((msg: ChartOutMessage) => this.handleOutMessage(msg));
    this.panel.onDidDispose(() => {
      this.panel = undefined;
      this.ready = false;
      this.queue = [];
    });
  }

  private html(webview: vscode.Webview, distRoot: vscode.Uri): string {
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(distRoot, 'chart-webview.js'));
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; script-src ${webview.cspSource}; style-src 'unsafe-inline';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  html, body { height: 100%; margin: 0; padding: 0; }
  body { display: flex; flex-direction: column; font-family: var(--vscode-font-family); }
  #toolbar {
    flex: 0 0 auto; display: flex; align-items: center; gap: 4px;
    padding: 3px 6px; user-select: none;
    border-bottom: 1px solid var(--vscode-panel-border, #444);
    background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
  }
  #toolbar button {
    background: var(--vscode-button-secondaryBackground, transparent);
    color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
    border: 1px solid var(--vscode-panel-border, #444); border-radius: 3px;
    cursor: pointer; padding: 2px 8px; font-size: 11px; height: 22px;
  }
  #toolbar button:hover:not(:disabled) {
    background: var(--vscode-button-secondaryHoverBackground, var(--vscode-list-hoverBackground, #333));
  }
  #toolbar button:disabled { opacity: 0.4; cursor: default; }
  #toolbar button.active {
    background: var(--vscode-button-background, #0e639c);
    color: var(--vscode-button-foreground, #fff);
    border-color: var(--vscode-button-background, #0e639c);
  }
  #toolbar .sep { width: 1px; height: 16px; background: var(--vscode-panel-border, #444); margin: 0 2px; }
  #toolbar .spacer { flex: 1; }
  #toolbar .goto-box { display: none; align-items: center; gap: 4px; }
  #toolbar .goto-box.open { display: flex; }
  #toolbar input[type="datetime-local"] {
    background: var(--vscode-input-background); color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, var(--vscode-panel-border, #444));
    border-radius: 3px; padding: 1px 4px; font-size: 11px; height: 22px;
    color-scheme: light dark;
  }
  #chart-area { flex: 1; min-height: 0; position: relative; }
  #chart { position: absolute; inset: 0; }
  #to-realtime {
    position: absolute; right: 68px; top: 10px; z-index: 5;
    width: 22px; height: 22px; border-radius: 50%;
    display: flex; align-items: center; justify-content: center;
    background: var(--vscode-editorWidget-background, rgba(50, 50, 50, 0.75));
    color: var(--vscode-descriptionForeground, #bbb);
    border: 1px solid var(--vscode-panel-border, #444);
    cursor: pointer; font-size: 12px; line-height: 1; padding: 0;
    opacity: 0.55; box-shadow: 0 1px 3px rgba(0, 0, 0, 0.25);
    transition: opacity 0.15s ease, background 0.15s ease, color 0.15s ease;
  }
  #to-realtime:hover {
    opacity: 1;
    background: var(--vscode-button-background, #0e639c);
    color: var(--vscode-button-foreground, #fff);
    border-color: var(--vscode-button-background, #0e639c);
  }
  #to-realtime[hidden] { display: none; }
  #bottom {
    flex: 0 0 auto; height: 220px; display: flex; flex-direction: column;
    border-top: 1px solid var(--vscode-panel-border, #444);
    background: var(--vscode-editor-background);
    color: var(--vscode-editor-foreground);
  }
  #bottom.collapsed { height: 27px; }
  #bottom.collapsed .tab-body { display: none; }
  .tab-bar {
    flex: 0 0 26px; display: flex; align-items: center; gap: 2px;
    padding: 0 6px; user-select: none;
    border-bottom: 1px solid var(--vscode-panel-border, #444);
  }
  .tab-bar button {
    background: none; border: none; cursor: pointer; padding: 4px 10px;
    color: var(--vscode-foreground); font-size: 11px; text-transform: uppercase;
  }
  .tab-bar button.active {
    color: var(--vscode-panelTitle-activeForeground, #fff);
    border-bottom: 1px solid var(--vscode-panelTitle-activeBorder, #fff);
  }
  .tab-bar .spacer { flex: 1; }
  .tab-body { flex: 1; overflow: auto; }
  .tab-body table { border-collapse: collapse; width: 100%; font-size: 12px; }
  .tab-body th, .tab-body td {
    text-align: right; padding: 2px 10px; white-space: nowrap;
    border-bottom: 1px solid var(--vscode-panel-border, #333);
  }
  .tab-body th:first-child, .tab-body td:first-child { text-align: left; }
  .tab-body th {
    position: sticky; top: 0; background: var(--vscode-editor-background);
    color: var(--vscode-descriptionForeground);
  }
  .tab-body tr.clickable { cursor: pointer; }
  .tab-body tr.clickable:hover { background: var(--vscode-list-hoverBackground, #333); }
  .pos { color: var(--vscode-charts-green, #26a69a); }
  .neg { color: var(--vscode-charts-red, #ef5350); }
  .muted { color: var(--vscode-descriptionForeground); padding: 8px; display: block; }
</style>
</head>
<body>
<div id="toolbar">
  <button id="tb-volume" title="Show/hide volume">Volume</button>
  <span class="sep"></span>
  <button id="tb-goto" title="Scroll the chart to a date/time">Go to date…</button>
  <span class="goto-box" id="tb-goto-box">
    <input type="datetime-local" id="tb-goto-input" step="1">
    <button id="tb-goto-do">Go</button>
  </span>
  <span class="spacer"></span>
  <button id="tb-csv-plot" title="Open the plot output CSV" disabled>Plot CSV</button>
  <button id="tb-csv-trades" title="Open the trades output CSV" disabled hidden>Trades CSV</button>
</div>
<div id="chart-area">
  <div id="chart"></div>
  <button id="to-realtime" title="Scroll to the latest bar" hidden>⇥</button>
</div>
<div id="bottom" class="collapsed">
  <div class="tab-bar">
    <button id="tab-trades" class="active">Trades</button>
    <button id="tab-stats">Stats</button>
    <span class="spacer"></span>
    <button id="tab-toggle" title="Show/hide panel">▴</button>
  </div>
  <div class="tab-body" id="tab-body"></div>
</div>
<script src="${scriptUri}"></script>
</body>
</html>`;
  }
}
