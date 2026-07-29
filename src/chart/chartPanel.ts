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
import { toCandleStyleId, type CandleStyleId } from './candleStyle';
import { isChartablePath, openChartKeys } from './chartKey';
import type { ChartBreakpointTarget, ChartInMessage, ChartOutMessage } from './messages';

/** Chart appearance is a persisted user preference, not per-panel state: every
 * chart in every window follows this one setting. */
const CANDLE_STYLE_SETTING = 'pyneide.chart.candleStyle';

function readCandleStyle(): CandleStyleId {
  return toCandleStyleId(vscode.workspace.getConfiguration('pyneide').get('chart.candleStyle'));
}

/**
 * Write the toolbar's pick back into settings. Global by default, but a
 * workspace override already in place wins the effective value — writing Global
 * under one would leave the toolbar visibly stuck on the old style, so the
 * write follows wherever the value actually lives.
 */
function persistCandleStyle(style: CandleStyleId): void {
  const config = vscode.workspace.getConfiguration('pyneide');
  const target =
    config.inspect<string>('chart.candleStyle')?.workspaceValue !== undefined
      ? vscode.ConfigurationTarget.Workspace
      : vscode.ConfigurationTarget.Global;
  void config.update('chart.candleStyle', style, target);
}

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
  private breakpointTargets: ChartBreakpointTarget[] = [];
  private breakpointSelectionLabel: string | undefined;
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
    private readonly onWebviewClosed?: () => void,
    private readonly onViewStateChanged?: (active: boolean) => void,
    private readonly onSelectBreakpointBar?: (timestamp: number) => void,
    private readonly onRemoveBreakpointBar?: (timestamp: number) => void,
    private readonly onCancelBreakpointSelection?: () => void
  ) {
    this.title = `${path.parse(chartKey).name} — Chart`;
  }

  /** Whether the chart currently has a live webview tab (not just a dormant snapshot). */
  isOpen(): boolean {
    return this.panel !== undefined;
  }

  /** Push the persisted candle style to the live webview (no-op while none is
   * open: `ready` replays the current setting anyway). */
  setCandleStyle(style: CandleStyleId): void {
    this.post({ type: 'candleStyle', style });
  }

  setBreakpointTargets(targets: ChartBreakpointTarget[]): void {
    this.breakpointTargets = targets;
    this.post({ type: 'breakpoints', targets });
  }

  beginBreakpointSelection(label: string): void {
    this.breakpointSelectionLabel = label;
    this.post({ type: 'breakpointSelection', label });
  }

  endBreakpointSelection(): void {
    if (!this.breakpointSelectionLabel) return;
    this.breakpointSelectionLabel = undefined;
    this.post({ type: 'breakpointSelection' });
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
    this.panel.onDidChangeViewState((e) => this.onViewStateChanged?.(e.webviewPanel.active));
    this.onViewStateChanged?.(this.panel.active);
    this.panel.onDidDispose(() => {
      // The webview is gone, but the snapshot lives on: this panel stays in the
      // manager's map (dormant) until reconcile retires it, so reopening the
      // chart replays the snapshot. Closing the tab is not "delete the chart".
      this.panel = undefined;
      this.ready = false;
      if (this.breakpointSelectionLabel) {
        this.breakpointSelectionLabel = undefined;
        this.onCancelBreakpointSelection?.();
      }
      this.onViewStateChanged?.(false);
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
        this.post({ type: 'candleStyle', style: readCandleStyle() });
        this.replayFromSnapshot();
        this.post({ type: 'breakpoints', targets: this.breakpointTargets });
        if (this.breakpointSelectionLabel) {
          this.post({ type: 'breakpointSelection', label: this.breakpointSelectionLabel });
        }
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
      case 'setCandleStyle':
        // The config change echoes back through ChartManager, which is what
        // actually applies it here and in every other open chart.
        persistCandleStyle(msg.style);
        break;
      case 'selectBreakpointBar':
        this.breakpointSelectionLabel = undefined;
        this.onSelectBreakpointBar?.(msg.timestamp);
        break;
      case 'removeBreakpointBar':
        this.onRemoveBreakpointBar?.(msg.timestamp);
        break;
      case 'cancelBreakpointSelection':
        this.breakpointSelectionLabel = undefined;
        this.onCancelBreakpointSelection?.();
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
    flex: 0 0 36px; display: flex; align-items: center; gap: 0;
    box-sizing: border-box; padding: 3px 6px; user-select: none;
    border-bottom: 1px solid var(--vscode-panel-border, #444);
    background: var(--vscode-editor-background);
  }
  #toolbar .toolbar-group { display: flex; align-items: center; gap: 2px; min-width: 0; }
  #toolbar button {
    border: 0; color: var(--vscode-foreground); background: transparent;
    cursor: pointer; font: inherit;
  }
  #toolbar button:focus-visible {
    outline: 1px solid var(--vscode-focusBorder, #007fd4); outline-offset: -1px;
  }
  #toolbar button:hover:not(:disabled) {
    background: var(--vscode-toolbar-hoverBackground, var(--vscode-list-hoverBackground, #333));
  }
  #toolbar button:disabled { opacity: 0.35; cursor: default; }
  #toolbar .symbol-button {
    display: flex; align-items: center; gap: 7px; max-width: min(280px, 34vw);
    height: 28px; min-width: 0; padding: 0 8px 0 5px; border-radius: 7px;
  }
  #toolbar .symbol-mark {
    display: flex; align-items: center; justify-content: center; flex: 0 0 auto;
    width: 22px; height: 22px; border-radius: 50%;
    color: var(--vscode-button-foreground, #fff);
    background: var(--vscode-button-background, #2962ff);
  }
  #toolbar .symbol-mark svg { width: 14px; height: 14px; }
  #toolbar .symbol-copy { display: flex; align-items: baseline; gap: 6px; min-width: 0; }
  #toolbar .symbol-name {
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    font-size: 12px; font-weight: 600; letter-spacing: 0.01em;
  }
  #toolbar .symbol-period {
    flex: 0 0 auto; color: var(--vscode-descriptionForeground);
    font-size: 11px; font-variant-numeric: tabular-nums;
  }
  #toolbar .icon-button {
    position: relative; display: inline-flex; align-items: center; justify-content: center;
    width: 28px; height: 28px; padding: 0; border-radius: 5px;
  }
  #toolbar .icon-button[hidden] { display: none; }
  #toolbar .icon-button svg {
    width: 17px; height: 17px; fill: none; stroke: currentColor;
    stroke-width: 1.45; stroke-linecap: round; stroke-linejoin: round;
  }
  #toolbar .icon-button.active {
    color: var(--vscode-button-foreground, #fff);
    background: var(--vscode-button-background, #0e639c);
  }
  /* Struck-through variant of an icon, drawn only while the button is on. */
  #toolbar .icon-button .slash { display: none; }
  #toolbar .icon-button.active .slash { display: inline; }
  #toolbar .count-badge {
    position: absolute; right: 1px; top: 1px; min-width: 11px; height: 11px;
    box-sizing: border-box; padding: 0 2px; border-radius: 6px;
    color: var(--vscode-badge-foreground, #fff);
    background: var(--vscode-badge-background, #4d4d4d);
    font-size: 8px; font-weight: 700; line-height: 11px; text-align: center;
  }
  #toolbar .sep {
    width: 1px; height: 20px; flex: 0 0 auto;
    background: var(--vscode-panel-border, #444); margin: 0 6px;
  }
  #toolbar .spacer { flex: 1; }
  #goto-popup {
    position: absolute; z-index: 20; display: flex; align-items: center; gap: 4px;
    box-sizing: border-box; width: min(340px, calc(100% - 12px)); padding: 6px;
    background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
    border: 1px solid var(--vscode-panel-border, #444); border-radius: 4px;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.35); user-select: none;
  }
  #goto-popup[hidden] { display: none; }
  #goto-popup input[type="datetime-local"] {
    flex: 1 1 auto; width: 0; min-width: 0; box-sizing: border-box;
    background: var(--vscode-input-background); color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, var(--vscode-panel-border, #444));
    border-radius: 3px; padding: 1px 4px; font-size: 11px; height: 22px;
    color-scheme: light dark;
  }
  #goto-popup button {
    flex: 0 0 auto; white-space: nowrap; height: 22px; padding: 2px 8px;
    background: var(--vscode-button-secondaryBackground, transparent);
    color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
    border: 1px solid var(--vscode-panel-border, #444); border-radius: 3px;
    cursor: pointer; font-size: 11px;
  }
  #goto-popup button:hover {
    background: var(--vscode-button-secondaryHoverBackground, var(--vscode-list-hoverBackground, #333));
  }
  #plots-popup {
    position: absolute; z-index: 20; display: flex; flex-direction: column; gap: 1px;
    min-width: 140px; max-width: 320px; max-height: 60%; overflow: auto;
    padding: 4px; font-size: 11px; user-select: none;
    background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
    border: 1px solid var(--vscode-panel-border, #444); border-radius: 4px;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.35);
  }
  #plots-popup[hidden] { display: none; }
  #plots-popup .plot-row {
    display: flex; align-items: center; gap: 6px; padding: 2px 6px;
    cursor: pointer; border-radius: 3px;
  }
  #plots-popup .plot-row:hover { background: var(--vscode-list-hoverBackground, #333); }
  #plots-popup .plot-swatch { width: 9px; height: 9px; flex: 0 0 auto; border-radius: 2px; }
  #plots-popup .plot-name { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  #plots-popup .plot-sep { height: 1px; margin: 3px 4px; background: var(--vscode-panel-border, #444); }
  #plots-popup .plot-section {
    padding: 3px 6px 1px; font-size: 10px; text-transform: uppercase;
    letter-spacing: 0.04em; color: var(--vscode-descriptionForeground);
  }
  #candle-popup {
    position: absolute; z-index: 20; display: flex; flex-direction: column; gap: 1px;
    min-width: 165px; padding: 4px; font-size: 11px; user-select: none;
    background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
    border: 1px solid var(--vscode-panel-border, #444); border-radius: 4px;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.35);
  }
  #candle-popup[hidden] { display: none; }
  #candle-popup .candle-row {
    display: flex; align-items: center; gap: 7px; padding: 3px 6px;
    cursor: pointer; border-radius: 3px;
  }
  #candle-popup .candle-row:hover { background: var(--vscode-list-hoverBackground, #333); }
  #candle-popup .candle-row.active {
    color: var(--vscode-list-activeSelectionForeground, var(--vscode-foreground));
    background: var(--vscode-list-activeSelectionBackground, #04395e);
  }
  #candle-popup .candle-row svg {
    flex: 0 0 auto; width: 16px; height: 16px; display: block;
    fill: none; stroke: currentColor; stroke-width: 1.2;
    stroke-linecap: round; stroke-linejoin: round;
  }
  #candle-popup .candle-name { flex: 1 1 auto; white-space: nowrap; }
  #candle-popup .candle-check { flex: 0 0 auto; width: 10px; text-align: center; }
  #breakpoints-popup {
    position: absolute; z-index: 20; display: flex; flex-direction: column; gap: 1px;
    min-width: 250px; max-width: min(420px, calc(100% - 12px)); max-height: 60%;
    overflow: auto; padding: 4px; font-size: 11px; user-select: none;
    background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
    border: 1px solid var(--vscode-panel-border, #444); border-radius: 4px;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.35);
  }
  #breakpoints-popup[hidden] { display: none; }
  #breakpoints-popup .breakpoint-row {
    display: flex; align-items: center; gap: 7px; padding: 3px 4px 3px 7px;
    cursor: pointer; border-radius: 3px;
  }
  #breakpoints-popup .breakpoint-row:hover {
    background: var(--vscode-list-hoverBackground, #333);
  }
  #breakpoints-popup .breakpoint-dot {
    width: 9px; height: 9px; flex: 0 0 auto; border-radius: 50%;
  }
  #breakpoints-popup .breakpoint-label {
    flex: 1 1 auto; min-width: 0; white-space: nowrap;
    overflow: hidden; text-overflow: ellipsis;
  }
  #breakpoints-popup .breakpoint-delete {
    flex: 0 0 auto; width: 20px; height: 20px; padding: 0; border: none;
    border-radius: 3px; background: transparent; color: var(--vscode-foreground);
    cursor: pointer; font-size: 14px; line-height: 20px;
  }
  #breakpoints-popup .breakpoint-delete:hover {
    background: var(--vscode-toolbar-hoverBackground, var(--vscode-list-hoverBackground, #333));
  }
  #chart-area { flex: 1; min-height: 0; position: relative; }
  #chart { position: absolute; inset: 0; }
  #breakpoint-pick {
    position: absolute; z-index: 12; top: 8px; left: 50%; transform: translateX(-50%);
    display: flex; align-items: center; gap: 8px; max-width: calc(100% - 24px);
    box-sizing: border-box; padding: 5px 8px; border-radius: 4px;
    color: var(--vscode-editorWidget-foreground, var(--vscode-foreground));
    background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
    border: 1px solid var(--vscode-focusBorder, #007fd4);
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.35); font-size: 11px; user-select: none;
  }
  #breakpoint-pick[hidden] { display: none; }
  /* Shown over a held frame while a re-run recomputes (see freezeChart). */
  #chart-busy {
    position: absolute; z-index: 5; top: 10px; left: 50%; transform: translateX(-50%);
    width: 14px; height: 14px; box-sizing: border-box; border-radius: 50%;
    border: 2px solid var(--vscode-panel-border, #444);
    border-top-color: var(--vscode-progressBar-background, var(--vscode-focusBorder, #007fd4));
    opacity: 0.7; pointer-events: none; animation: chart-busy-spin 0.9s linear infinite;
  }
  #chart-busy[hidden] { display: none; }
  @keyframes chart-busy-spin { to { transform: translateX(-50%) rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { #chart-busy { animation: none; } }
  #breakpoint-pick-label { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  #breakpoint-pick button {
    flex: 0 0 auto; border: none; background: transparent; cursor: pointer;
    color: var(--vscode-foreground); padding: 1px 3px; font-size: 13px;
  }
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
    flex: 0 0 auto; height: var(--bottom-height, min(300px, 42vh));
    min-height: 0; display: flex; flex-direction: column;
    background: var(--vscode-editor-background);
    color: var(--vscode-editor-foreground);
  }
  #bottom.collapsed {
    height: 27px; border-top: 1px solid var(--vscode-panel-border, #444);
  }
  #bottom.collapsed .tab-body { display: none; }
  #panel-splitter {
    position: relative; flex: 0 0 5px; cursor: row-resize; touch-action: none;
    background: var(--vscode-editor-background); outline: none;
  }
  #panel-splitter::after {
    content: ""; position: absolute; inset: 2px 0 auto; height: 1px;
    background: var(--vscode-panel-border, #444);
  }
  #panel-splitter:hover::after, #panel-splitter:focus-visible::after,
  body.panel-resizing #panel-splitter::after {
    top: 1px; height: 3px;
    background: var(--vscode-focusBorder, #007fd4);
  }
  #panel-splitter[hidden] { display: none; }
  body.panel-resizing { cursor: row-resize; user-select: none; }
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
  .performance-view {
    height: 100%; min-height: 0; display: flex; flex-direction: column;
    box-sizing: border-box; padding: 8px 10px 6px;
  }
  .performance-summary {
    flex: 0 0 auto; display: grid; grid-template-columns: repeat(4, minmax(110px, 1fr));
    gap: 8px; margin-bottom: 6px;
  }
  .performance-metric {
    min-width: 0; padding: 4px 7px; border-left: 2px solid var(--vscode-panel-border, #444);
  }
  .performance-metric span, .performance-metric small {
    display: block; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .performance-metric span {
    color: var(--vscode-descriptionForeground); font-size: 10px; text-transform: uppercase;
  }
  .performance-metric strong { display: block; margin-top: 1px; font-size: 15px; font-weight: 600; }
  .performance-metric small { color: var(--vscode-descriptionForeground); font-size: 10px; }
  .equity-chart-wrap { flex: 1 1 auto; min-height: 80px; position: relative; }
  .equity-chart-title {
    position: absolute; z-index: 1; top: 2px; left: 10px; font-size: 10px;
    color: var(--vscode-descriptionForeground); pointer-events: none;
  }
  #equity-canvas { display: block; width: 100%; height: 100%; }
  @media (max-width: 620px) {
    .performance-summary { grid-template-columns: repeat(2, minmax(100px, 1fr)); }
    .performance-metric:nth-child(n+3) { display: none; }
  }
  .pos { color: var(--vscode-charts-green, #26a69a); }
  .neg { color: var(--vscode-charts-red, #ef5350); }
  .muted { color: var(--vscode-descriptionForeground); padding: 8px; display: block; }
</style>
</head>
<body>
<div id="toolbar">
  <div class="toolbar-group">
    <button id="tb-data" class="symbol-button" title="Select the OHLCV data for this script">
      <span class="symbol-mark" aria-hidden="true">
        <svg viewBox="0 0 16 16">
          <path d="M4 3.5v9M2.5 6h3v4h-3zM11.5 2.5v11M10 5h3v5h-3z"
                fill="none" stroke="currentColor" stroke-width="1.35"></path>
        </svg>
      </span>
      <span class="symbol-copy">
        <span id="tb-symbol-name" class="symbol-name">Select data</span>
        <span id="tb-symbol-period" class="symbol-period"></span>
      </span>
    </button>
  </div>
  <span class="sep"></span>
  <div class="toolbar-group">
    <button id="tb-layers" class="icon-button" title="Layers and indicators"
            aria-label="Layers and indicators" aria-pressed="false">
      <svg viewBox="0 0 20 20" aria-hidden="true">
        <path d="m10 3-7 3.6 7 3.6 7-3.6L10 3Z"></path>
        <path d="m4.5 9.5-1.5.8 7 3.7 7-3.7-1.5-.8M4.5 13.2l-1.5.8 7 3.5 7-3.5-1.5-.8"></path>
      </svg>
    </button>
    <button id="tb-candle" class="icon-button" title="Chart style"
            aria-label="Chart style" aria-pressed="false">
      <svg viewBox="0 0 20 20" aria-hidden="true">
        <path d="M6 3v3.2M6 13.8V17M14 5v2.2M14 14.8V17"></path>
        <rect x="3.6" y="6.2" width="4.8" height="7.6" rx="0.8"></rect>
        <rect x="11.6" y="7.2" width="4.8" height="7.6" rx="0.8"
              fill="currentColor" stroke="none"></rect>
      </svg>
    </button>
    <button id="tb-legend" class="icon-button" title="Hide the chart legend"
            aria-label="Hide the chart legend" aria-pressed="false">
      <svg viewBox="0 0 20 20" aria-hidden="true">
        <rect x="2.5" y="4" width="15" height="12" rx="1.5"></rect>
        <path d="M5.5 8h3M5.5 11.5h3M11 8h3.5M11 11.5h3.5"></path>
        <path class="slash" d="M4 16 16 4"></path>
      </svg>
    </button>
  </div>
  <span class="sep"></span>
  <div class="toolbar-group">
    <button id="tb-measure" class="icon-button" title="Measure price movement"
            aria-label="Measure price movement" aria-pressed="false">
      <svg viewBox="0 0 20 20" aria-hidden="true">
        <path d="M3 3.5v3M17 3.5v3M3 5h14"></path>
        <rect x="3" y="10" width="14" height="6" rx="1.2"></rect>
        <path d="M6 10v2.5M9 10v1.6M12 10v2.5M15 10v1.6"></path>
      </svg>
    </button>
    <button id="tb-goto" class="icon-button" title="Go to date"
            aria-label="Go to date" aria-pressed="false">
      <svg viewBox="0 0 20 20" aria-hidden="true">
        <rect x="3" y="4.5" width="14" height="12.5" rx="2"></rect>
        <path d="M6.5 2.8v3.4M13.5 2.8v3.4M3 8h14M7.5 12h5M10.8 9.7 13 12l-2.2 2.3"></path>
      </svg>
    </button>
    <button id="tb-breakpoints" class="icon-button" title="Chart breakpoints"
            aria-label="Chart breakpoints" aria-pressed="false" hidden>
      <svg viewBox="0 0 20 20" aria-hidden="true">
        <circle cx="10" cy="10" r="6"></circle>
        <circle cx="10" cy="10" r="2.5" fill="currentColor" stroke="none"></circle>
      </svg>
      <span id="tb-breakpoints-count" class="count-badge"></span>
    </button>
  </div>
  <span class="spacer"></span>
  <span class="sep"></span>
  <div class="toolbar-group">
    <button id="tb-csv-plot" class="icon-button" title="Open plot output CSV"
            aria-label="Open plot output CSV" disabled>
      <svg viewBox="0 0 20 20" aria-hidden="true">
        <path d="M3 15.5h14M4.5 13l3.4-3.5 2.7 2 4.9-5"></path>
        <path d="M13 6.5h2.5V9"></path>
      </svg>
    </button>
    <button id="tb-csv-trades" class="icon-button" title="Open trades output CSV"
            aria-label="Open trades output CSV" disabled hidden>
      <svg viewBox="0 0 20 20" aria-hidden="true">
        <rect x="3" y="3.5" width="14" height="13" rx="1.5"></rect>
        <path d="M3 8h14M8 3.5v13M12.5 8v8.5"></path>
      </svg>
    </button>
  </div>
</div>
<div id="chart-area">
  <div id="chart"></div>
  <div id="chart-busy" role="progressbar" aria-label="Recomputing the chart" hidden></div>
  <div id="breakpoint-pick" hidden>
    <span id="breakpoint-pick-label"></span>
    <button id="breakpoint-pick-cancel" title="Cancel (Escape)">×</button>
  </div>
  <div id="goto-popup" hidden>
    <input type="datetime-local" id="tb-goto-input" step="1">
    <button id="tb-goto-do">Go</button>
  </div>
  <button id="to-realtime" title="Scroll to the latest bar" hidden>⇥</button>
</div>
<div id="panel-splitter" role="separator" aria-orientation="horizontal"
     aria-label="Resize chart and bottom panel" tabindex="0" hidden></div>
<div id="bottom" class="collapsed">
  <div class="tab-bar">
    <button id="tab-performance" hidden>Performance</button>
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
  private activeChartKey: string | undefined;
  /** Data-preview panels keyed by `.ohlcv` path: kept alive by their own
   * webview (not an editor tab), retired when that webview is closed. */
  private readonly dataPreviews = new Set<string>();
  /** Set by the host: invoked when a panel's Data button is clicked, with the
   * script's chart key, to re-pick and reload that chart's data. */
  onSelectData: ((chartKey: string) => void) | undefined;
  /** Native source breakpoints projected into visual timestamps for a script. */
  breakpointTargetsForChart: ((chartKey: string) => ChartBreakpointTarget[]) | undefined;
  onSelectBreakpointBar: ((chartKey: string, timestamp: number) => void) | undefined;
  onRemoveBreakpointBar: ((chartKey: string, timestamp: number) => void) | undefined;
  onCancelBreakpointSelection: ((chartKey: string) => void) | undefined;
  /** Set by the host: a chart is pinned (kept alive with no open source tab)
   * while a run/preview/debug is streaming to it. */
  isPinned: ((chartKey: string) => boolean) | undefined;

  constructor(private readonly context: vscode.ExtensionContext) {
    context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (!e.affectsConfiguration(CANDLE_STYLE_SETTING)) return;
        const style = readCandleStyle();
        for (const panel of this.panels.values()) panel.setCandleStyle(style);
      })
    );
  }

  /** Script backing the currently active chart tab, if that chart can own
   * inputs. Raw data previews deliberately return no script. */
  activeInputScriptPath(): string | undefined {
    const key = this.activeChartKey;
    return key && isChartablePath(key) ? key : undefined;
  }

  onEvent(event: BridgeEvent, chartKey: string): void {
    // A real run takes ownership of a chart that may have been created by
    // opening its persisted output. From here on it follows normal script
    // chart lifetime and the run updates the already-open tab in place.
    this.dataPreviews.delete(chartKey);
    this.panelFor(chartKey).handleEvent(event);
  }

  onFinished(_chartKey: string): void {
    // The 'end' event already closed out the chart state.
  }

  /** Whether this script's chart tab is currently open. */
  hasOpenChart(chartKey: string): boolean {
    return this.panels.get(chartKey)?.isOpen() === true;
  }

  refreshBreakpointTargets(): void {
    for (const [chartKey, panel] of this.panels) {
      if (!isChartablePath(chartKey)) continue;
      panel.setBreakpointTargets(this.breakpointTargetsForChart?.(chartKey) ?? []);
    }
  }

  beginBreakpointSelection(chartKey: string, label: string): boolean {
    const panel = this.panels.get(chartKey);
    if (!panel?.isOpen()) return false;
    this.endBreakpointSelection();
    panel.beginBreakpointSelection(label);
    panel.reveal();
    return true;
  }

  endBreakpointSelection(chartKey?: string): void {
    if (chartKey) this.panels.get(chartKey)?.endBreakpointSelection();
    else for (const panel of this.panels.values()) panel.endBreakpointSelection();
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
        () => this.retirePreview(filePath),
        (active) => this.updateActiveChart(filePath, active)
      );
      this.panels.set(filePath, panel);
    }
    this.dataPreviews.add(filePath);
    panel.previewData(start, bars);
  }

  /** Open a persisted CSV + native viz-NDJSON result. The supplied events use
   * the same protocol as a live run, so ChartPanel records/replays them without
   * a separate rendering path. */
  openOutputPreview(chartKey: string, events: BridgeEvent[]): void {
    // A persisted output that resolves back to a script is a normal script
    // chart: in particular, its Data button must retain the real picker
    // callback. Only orphan output files use the self-owned preview lifecycle.
    if (isChartablePath(chartKey)) {
      this.dataPreviews.delete(chartKey);
      const panel = this.panelFor(chartKey);
      for (const event of events) panel.handleEvent(event);
      return;
    }

    let panel = this.panels.get(chartKey);
    if (!panel) {
      panel = new ChartPanel(
        this.context,
        chartKey,
        () => {},
        () => {
          if (this.dataPreviews.has(chartKey)) this.retirePreview(chartKey);
        },
        (active) => this.updateActiveChart(chartKey, active)
      );
      this.panels.set(chartKey, panel);
      this.dataPreviews.add(chartKey);
    }
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
      panel = new ChartPanel(
        this.context,
        chartKey,
        () => this.onSelectData?.(chartKey),
        undefined,
        (active) => this.updateActiveChart(chartKey, active),
        (timestamp) => this.onSelectBreakpointBar?.(chartKey, timestamp),
        (timestamp) => this.onRemoveBreakpointBar?.(chartKey, timestamp),
        () => this.onCancelBreakpointSelection?.(chartKey)
      );
      panel.setBreakpointTargets(this.breakpointTargetsForChart?.(chartKey) ?? []);
      this.panels.set(chartKey, panel);
    }
    return panel;
  }

  private updateActiveChart(chartKey: string, active: boolean): void {
    if (active) this.activeChartKey = chartKey;
    else if (this.activeChartKey === chartKey) this.activeChartKey = undefined;
    void vscode.commands.executeCommand(
      'setContext',
      'pyneide.chartHasInputs',
      this.activeInputScriptPath() !== undefined
    );
  }
}
