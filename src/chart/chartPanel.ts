/**
 * Chart webview panels: one per script (keyed by its canonical chart key —
 * a `.pine` and its compiled `.py` share one), so every script can have its
 * own chart open at once. `ChartManager` owns the map and routes the bridge
 * event stream (tagged with a chart key by RunService) to the right panel;
 * `ChartPanel` owns a single WebviewPanel lifecycle and forwards events to its
 * webview (see webview/main.ts for chart logic).
 *
 * The panel keeps a host-side SNAPSHOT of the whole stream (start + all bars +
 * plotKeys + trades + stats + end), so it survives the webview being closed:
 * reopening the chart replays the snapshot and shows exactly what was there,
 * as if it had never been closed. The panel therefore outlives its webview —
 * `ChartManager.reconcile` (driven by editor tabs) is what actually retires a
 * chart, once neither the script nor a run/debug references it anymore.
 */
import * as path from 'path';

import * as vscode from 'vscode';

import type {
  BarRow,
  BridgeEvent,
  ColorDeltaRow,
  DrawingEventRecord,
  PlotMetaRecord,
  StartEvent,
  TradeRecord,
} from '../run/bridgeClient';
import type { RunListener } from '../run/runService';
import { openChartKeys } from './chartKey';
import type { ChartInMessage, ChartOutMessage } from './messages';

/**
 * Everything needed to rebuild a chart's webview from scratch. plotKeys is the
 * latest full list (the bridge only ever APPENDS keys, so a bar's shorter plot
 * row still aligns against the final list); trades accumulate; openTrades/stats
 * are single end-of-run snapshots.
 */
interface ChartSnapshot {
  start: StartEvent;
  bars: BarRow[];
  plotKeys: string[];
  /** Plot style metadata keyed by plot id — upserted, a repeated id is an
   * update (a plot turning dynamic re-emits its meta). */
  plotMeta: Map<string, PlotMetaRecord>;
  /** Accumulated per-bar dynamic color deltas (sparse, only-on-change). */
  colors: ColorDeltaRow[];
  /** Live drawing objects keyed by "family#vid": create/update upserts the
   * latest state, delete removes it — replay sends only what still exists. */
  drawings: Map<string, DrawingEventRecord>;
  trades: TradeRecord[];
  openTrades: TradeRecord[];
  stats: Record<string, number | null> | undefined;
  ended: { bars: number; cancelled: boolean } | undefined;
}

/** One chart webview, bound to a single script's chart key. */
export class ChartPanel {
  private panel: vscode.WebviewPanel | undefined;
  private ready = false;
  /** Host-side stream snapshot; survives the webview being closed so reopening
   * replays the same chart. Undefined until the first `start` event. */
  private snap: ChartSnapshot | undefined;
  /** Stable tab title (`<script> — Chart`); never changes on run/debug so the
   * tab stays recognizable across previews, runs and debug sessions. */
  private readonly title: string;

  constructor(
    private readonly context: vscode.ExtensionContext,
    chartKey: string,
    private readonly onSelectData: () => void,
    private readonly onWebviewClosed?: () => void
  ) {
    this.title = `${path.parse(chartKey).name} — Chart`;
  }

  /**
   * Show a bars-only preview of an `.ohlcv` file (no run): install the
   * host-built snapshot and replay it. The webview replays `snap` on its
   * `ready` message, so a fresh panel needs no extra push here.
   */
  previewData(start: StartEvent, bars: BarRow[]): void {
    this.snap = {
      start,
      bars,
      plotKeys: [],
      plotMeta: new Map(),
      colors: [],
      drawings: new Map(),
      trades: [],
      openTrades: [],
      stats: undefined,
      ended: { bars: bars.length, cancelled: false },
    };
    this.reveal();
    if (this.ready) this.replayFromSnapshot();
  }

  /**
   * Route a bridge event (already known to belong to this chart) into both the
   * host snapshot and the live webview. A `start` resets the snapshot (a new
   * run/preview replaces whatever was shown before).
   */
  handleEvent(event: BridgeEvent): void {
    switch (event.e) {
      case 'start':
        this.snap = {
          start: event,
          bars: [],
          plotKeys: [],
          plotMeta: new Map(),
          colors: [],
          drawings: new Map(),
          trades: [],
          openTrades: [],
          stats: undefined,
          ended: undefined,
        };
        this.reveal();
        this.post({ type: 'reset', start: event });
        break;
      case 'bars':
        if (this.snap) for (const row of event.d) this.snap.bars.push(row);
        this.post({ type: 'bars', rows: event.d });
        break;
      case 'plotKeys':
        if (this.snap) this.snap.plotKeys = event.keys;
        this.post({ type: 'plotKeys', keys: event.keys });
        break;
      case 'plotMeta':
        if (this.snap) for (const m of event.metas) this.snap.plotMeta.set(m.id, m);
        this.post({ type: 'plotMeta', metas: event.metas });
        break;
      case 'colors':
        if (this.snap) for (const row of event.d) this.snap.colors.push(row);
        this.post({ type: 'colors', d: event.d });
        break;
      case 'drawings':
        if (this.snap) {
          for (const rec of event.d) {
            const key = `${rec.obj}#${rec.id}`;
            if (rec.op === 'delete') this.snap.drawings.delete(key);
            else this.snap.drawings.set(key, rec);
          }
        }
        this.post({ type: 'drawings', d: event.d });
        break;
      case 'trades':
        if (this.snap) for (const t of event.d) this.snap.trades.push(t);
        this.post({ type: 'trades', trades: event.d });
        break;
      case 'openTrades':
        if (this.snap) this.snap.openTrades = event.d;
        this.post({ type: 'openTrades', trades: event.d });
        break;
      case 'stats':
        if (this.snap) this.snap.stats = event.d;
        this.post({ type: 'stats', stats: event.d });
        break;
      case 'end':
        if (this.snap) this.snap.ended = { bars: event.bars, cancelled: event.cancelled };
        this.post({ type: 'end', bars: event.bars, cancelled: event.cancelled });
        break;
      default:
        break;
    }
  }

  /** Create (if needed) and reveal the panel. The title is fixed at
   * construction and never changes on run/debug. */
  reveal(): void {
    if (this.panel) {
      this.panel.reveal(undefined, true);
      return;
    }
    const distRoot = vscode.Uri.joinPath(this.context.extensionUri, 'dist');
    this.panel = vscode.window.createWebviewPanel(
      'pyneideChart',
      this.title,
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
      // The webview is gone, but the snapshot lives on: this panel stays in the
      // manager's map (dormant) until reconcile retires it, so reopening the
      // chart replays the snapshot. Closing the tab is not "delete the chart".
      this.panel = undefined;
      this.ready = false;
      this.onWebviewClosed?.();
    });
  }

  dispose(): void {
    this.panel?.dispose();
  }

  private handleOutMessage(msg: ChartOutMessage): void {
    switch (msg.type) {
      case 'ready':
        // The webview just (re)loaded: replay the whole snapshot so a freshly
        // opened panel matches what was there, and an in-flight run's bars so
        // far land before its live increments continue (post() gates on ready,
        // so nothing was delivered before this point — no duplicates).
        this.ready = true;
        this.replayFromSnapshot();
        break;
      case 'openCsv': {
        const file =
          msg.which === 'plot' ? this.snap?.start.outputs.plot : this.snap?.start.outputs.trades;
        if (file) void vscode.window.showTextDocument(vscode.Uri.file(file));
        break;
      }
      case 'selectData':
        this.onSelectData();
        break;
    }
  }

  /** Rebuild the current webview from the host snapshot (reset → meta → keys →
   * bars → colors → drawings → trades → stats → end; metas must precede the
   * bars that reference them, colors/drawings follow the bars their
   * timestamps / bar indices join against). Safe to call only once the
   * webview is ready. */
  private replayFromSnapshot(): void {
    const s = this.snap;
    const webview = this.panel?.webview;
    if (!s || !webview) return;
    void webview.postMessage({ type: 'reset', start: s.start });
    if (s.plotMeta.size) {
      void webview.postMessage({ type: 'plotMeta', metas: [...s.plotMeta.values()] });
    }
    if (s.plotKeys.length) void webview.postMessage({ type: 'plotKeys', keys: s.plotKeys });
    if (s.bars.length) void webview.postMessage({ type: 'bars', rows: s.bars });
    if (s.colors.length) void webview.postMessage({ type: 'colors', d: s.colors });
    if (s.drawings.size) {
      void webview.postMessage({ type: 'drawings', d: [...s.drawings.values()] });
    }
    if (s.trades.length) void webview.postMessage({ type: 'trades', trades: s.trades });
    if (s.openTrades.length) void webview.postMessage({ type: 'openTrades', trades: s.openTrades });
    if (s.stats) void webview.postMessage({ type: 'stats', stats: s.stats });
    if (s.ended) {
      void webview.postMessage({ type: 'end', bars: s.ended.bars, cancelled: s.ended.cancelled });
    }
  }

  /** Deliver a live stream message; dropped while no webview is ready (the
   * snapshot already captured it and will replay on the next open). */
  private post(message: ChartInMessage): void {
    if (!this.panel || !this.ready) return;
    void this.panel.webview.postMessage(message);
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
  <button id="tb-data" title="Select the OHLCV data for this script">Data</button>
  <span class="sep"></span>
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

/**
 * Owns one `ChartPanel` per script (keyed by chart key) and routes the run
 * event stream to the matching panel. Implements RunListener: RunService tags
 * every event with the chart key of the script being run.
 */
export class ChartManager implements RunListener {
  private readonly panels = new Map<string, ChartPanel>();
  /** Data-preview panels keyed by `.ohlcv` path: kept alive by their own
   * webview (not an editor tab), retired when that webview is closed. */
  private readonly dataPreviews = new Set<string>();
  /** Set by the host: invoked when a panel's Data button is clicked, with the
   * script's chart key, to re-pick and reload that chart's data. */
  onSelectData: ((chartKey: string) => void) | undefined;
  /** Set by the host: a chart is pinned (kept alive with no open source tab)
   * while a run/preview/debug is streaming to it. */
  isPinned: ((chartKey: string) => boolean) | undefined;

  constructor(private readonly context: vscode.ExtensionContext) {}

  onEvent(event: BridgeEvent, chartKey: string): void {
    this.panelFor(chartKey).handleEvent(event);
  }

  onFinished(_chartKey: string): void {
    // The 'end' event already closed out the chart state.
  }

  /** Whether a (possibly dormant) chart exists for this key. */
  hasChart(chartKey: string): boolean {
    return this.panels.has(chartKey);
  }

  /**
   * Open (or focus) a bars-only chart preview of an `.ohlcv` file, keyed by its
   * path. The preview panel is kept alive by its own webview; closing that tab
   * retires it (unlike a script chart, there is no snapshot to preserve).
   */
  openDataPreview(filePath: string, start: StartEvent, bars: BarRow[]): void {
    let panel = this.panels.get(filePath);
    if (!panel) {
      panel = new ChartPanel(
        this.context,
        filePath,
        () => {},
        () => this.retirePreview(filePath)
      );
      this.panels.set(filePath, panel);
    }
    this.dataPreviews.add(filePath);
    panel.previewData(start, bars);
  }

  /** Open a persisted CSV + native viz-NDJSON result. The supplied events use
   * the same protocol as a live run, so ChartPanel records/replays them without
   * a separate rendering path. */
  openOutputPreview(filePath: string, events: BridgeEvent[]): void {
    let panel = this.panels.get(filePath);
    if (!panel) {
      panel = new ChartPanel(
        this.context,
        filePath,
        () => {},
        () => this.retirePreview(filePath)
      );
      this.panels.set(filePath, panel);
    }
    this.dataPreviews.add(filePath);
    for (const event of events) panel.handleEvent(event);
  }

  private retirePreview(filePath: string): void {
    this.dataPreviews.delete(filePath);
    this.closeChart(filePath);
  }

  /** Open (or focus) a script's chart panel on demand — used by "Open chart". */
  reveal(chartKey: string): ChartPanel {
    const panel = this.panelFor(chartKey);
    panel.reveal();
    return panel;
  }

  /**
   * Retire charts whose script is no longer open in ANY editor tab (neither the
   * `.pine` nor its `.py`) and which no run/debug is streaming to. This is the
   * true chart-close: closing just the chart's own tab keeps it dormant (so it
   * can be reopened), but closing the last script tab discards it for good.
   */
  reconcile(): void {
    const live = openChartKeys();
    for (const key of [...this.panels.keys()]) {
      if (!live.has(key) && !this.dataPreviews.has(key) && !this.isPinned?.(key)) {
        this.closeChart(key);
      }
    }
  }

  /** Dispose a chart's webview (if any) and drop its snapshot. */
  private closeChart(chartKey: string): void {
    const panel = this.panels.get(chartKey);
    if (!panel) return;
    this.panels.delete(chartKey);
    panel.dispose();
  }

  private panelFor(chartKey: string): ChartPanel {
    let panel = this.panels.get(chartKey);
    if (!panel) {
      panel = new ChartPanel(this.context, chartKey, () => this.onSelectData?.(chartKey));
      this.panels.set(chartKey, panel);
    }
    return panel;
  }
}
