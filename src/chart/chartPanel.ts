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
 * dormant chart, once neither the script nor a run/debug references it.
 */
import * as path from 'path';
import { fileURLToPath } from 'node:url';

import * as vscode from 'vscode';

import type { BarRow, BridgeEvent, StartEvent } from '../run/bridgeClient';
import type { RunListener } from '../run/runService';
import { toCandleStyleId, type CandleStyleId } from './candleStyle';
import { isChartablePath, openChartKeys } from './chartKey';
import { chartHtml } from './chartHtml';
import { ChartStream, type ChartSnapshot } from './chartStream';
import { parseLabelLink } from './labelLinks';
import { toColorSchemeId, type ColorSchemeId } from './colorScheme';
import { toPriceScaleId, type PriceScaleId } from './priceScale';
import type { ChartDebugPosition, ChartBreakpointTarget, ChartInMessage, ChartOutMessage } from './messages';

/** Chart appearance is a persisted user preference, not per-panel state: every
 * chart in every window follows this one setting. */
export const CANDLE_STYLE_SETTING = 'pyneide.chart.candleStyle';
export const PRICE_SCALE_SETTING = 'pyneide.chart.priceScale';
export const COLOR_SCHEME_SETTING = 'pyneide.chart.colorScheme';

export function readCandleStyle(): CandleStyleId {
  return toCandleStyleId(vscode.workspace.getConfiguration('pyneide').get('chart.candleStyle'));
}

export function readPriceScale(): PriceScaleId {
  return toPriceScaleId(vscode.workspace.getConfiguration('pyneide').get('chart.priceScale'));
}

export function readColorScheme(): ColorSchemeId {
  return toColorSchemeId(vscode.workspace.getConfiguration('pyneide').get('chart.colorScheme'));
}

/**
 * Write a toolbar pick back into settings. Global by default, but a workspace
 * override already in place wins the effective value — writing Global under one
 * would leave the toolbar visibly stuck on the old value, so the write follows
 * wherever the value actually lives.
 */
export function persistChartSetting(
  key: 'chart.candleStyle' | 'chart.priceScale' | 'chart.colorScheme',
  value: string
): void {
  const config = vscode.workspace.getConfiguration('pyneide');
  const target =
    config.inspect<string>(key)?.workspaceValue !== undefined
      ? vscode.ConfigurationTarget.Workspace
      : vscode.ConfigurationTarget.Global;
  void config.update(key, value, target);
}

/** One chart webview, bound to a single script's chart key. */
export class ChartPanel {
  private panel: vscode.WebviewPanel | undefined;
  private ready = false;
  private debugPosition: ChartDebugPosition | undefined;
  private breakpointTargets: ChartBreakpointTarget[] = [];
  private breakpointSelectionLabel: string | undefined;
  /** Host-side stream snapshot; survives the webview being closed so reopening
   * replays the same chart. */
  private readonly stream = new ChartStream();
  /** Stable tab title (`<script> — Chart`); never changes on run/debug so the
   * tab stays recognizable across previews, runs and debug sessions. A live
   * chart without a script names its symbol instead, and follows a new pick. */
  private title: string;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly chartKey: string,
    private readonly onSelectData: (live: boolean) => void,
    private readonly onWebviewClosed?: () => void,
    private readonly onViewStateChanged?: (active: boolean) => void,
    private readonly onSelectBreakpointBar?: (timestamp: number) => void,
    private readonly onRemoveBreakpointBar?: (timestamp: number) => void,
    private readonly onCancelBreakpointSelection?: () => void,
    private readonly onSelectTimeframe?: (timeframe?: string) => void,
    title?: string
  ) {
    this.title = title ?? `${path.parse(chartKey).name} — Chart`;
  }

  /** Rename the tab (a live chart without a script on a new symbol). */
  setTitle(title: string): void {
    this.title = title;
    if (this.panel) this.panel.title = title;
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

  setPriceScale(scale: PriceScaleId): void {
    this.post({ type: 'priceScale', scale });
  }

  setColorScheme(scheme: ColorSchemeId): void {
    this.post({ type: 'colorScheme', scheme });
  }

  setDebugPosition(position: ChartDebugPosition | undefined): void {
    this.debugPosition = position;
    this.post({ type: 'debugPosition', position });
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
    this.stream.preview(start, bars);
    this.reveal();
    if (this.ready) this.replayFromSnapshot();
  }

  /** Show a copy of another chart stream's snapshot (see ChartStream.load). */
  loadSnapshot(snap: ChartSnapshot): void {
    this.stream.load(snap);
    this.reveal();
    if (this.ready) this.replayFromSnapshot();
  }

  /**
   * Route a bridge event (already known to belong to this chart) into both the
   * host snapshot and the live webview. A `start` resets the snapshot (a new
   * run/preview replaces whatever was shown before).
   */
  handleEvent(event: BridgeEvent): void {
    if (event.e === 'start') {
      // Use the editor source for the legend, including Pine scripts whose
      // bridge runs the compiled Python sibling and persisted output previews.
      const start = isChartablePath(this.chartKey)
        ? { ...event, script: this.chartKey }
        : event;
      this.reveal();
      for (const message of this.stream.apply(start)) this.post(message);
      return;
    }
    for (const message of this.stream.apply(event)) this.post(message);
  }

  /** Create (if needed) and reveal the panel. The title never changes on
   * run/debug. */
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
        this.post({ type: 'priceScale', scale: readPriceScale() });
        this.post({ type: 'colorScheme', scheme: readColorScheme() });
        this.replayFromSnapshot();
        this.post({ type: 'breakpoints', targets: this.breakpointTargets });
        this.post({ type: 'debugPosition', position: this.debugPosition });
        if (this.breakpointSelectionLabel) {
          this.post({ type: 'breakpointSelection', label: this.breakpointSelectionLabel });
        }
        break;
      case 'openCsv': {
        const file =
          msg.which === 'plot'
            ? this.stream.snap?.start.outputs.plot
            : this.stream.snap?.start.outputs.trades;
        if (file) void vscode.window.showTextDocument(vscode.Uri.file(file));
        break;
      }
      case 'selectData':
        this.onSelectData(this.stream.snap?.start.live !== undefined);
        break;
      case 'selectTimeframe':
        if (msg.timeframe === undefined || typeof msg.timeframe === 'string') {
          this.onSelectTimeframe?.(msg.timeframe);
        }
        break;
      case 'editProperties':
        void vscode.commands.executeCommand('pyneide.editInputs', {
          uri: vscode.Uri.file(this.chartKey),
          tab: 'properties',
        });
        break;
      case 'setCandleStyle':
        // The config change echoes back through ChartManager, which is what
        // actually applies it here and in every other open chart.
        persistChartSetting('chart.candleStyle', msg.style);
        break;
      case 'setPriceScale':
        persistChartSetting('chart.priceScale', msg.scale);
        break;
      case 'setColorScheme':
        persistChartSetting('chart.colorScheme', msg.scheme);
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
      case 'openLabelLink':
        if (typeof msg.target === 'string') void this.openLabelLink(msg.target);
        break;
      case 'copyText':
        if (typeof msg.text === 'string') {
          void vscode.env.clipboard.writeText(msg.text).then(() =>
            vscode.window.setStatusBarMessage(`Copied ${msg.text}`, 2000)
          );
        }
        break;
    }
  }

  private async openLabelLink(raw: string): Promise<void> {
    const link = parseLabelLink(raw);
    if (!link) return;
    const workdir = this.stream.snap?.start.workdir;
    try {
      if (link.kind === 'web') {
        await vscode.env.openExternal(vscode.Uri.parse(link.url.href, true));
        return;
      }
      const file = link.kind === 'file' ? fileURLToPath(link.url) :
        workdir ? path.resolve(workdir, link.path) : undefined;
      if (!file) return;
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
      const line = link.line === undefined ? undefined : Math.min(link.line, document.lineCount) - 1;
      const selection = line === undefined ? undefined : new vscode.Range(line, 0, line, 0);
      await vscode.window.showTextDocument(document, { selection });
    } catch {
      void vscode.window.showWarningMessage(`PyneIDE: Could not open label link ${raw}.`);
    }
  }

  /** Rebuild the current webview from the host snapshot. Safe to call only
   * once the webview is ready. */
  private replayFromSnapshot(): void {
    const webview = this.panel?.webview;
    if (!webview) return;
    for (const message of this.stream.replay()) void webview.postMessage(message);
  }

  /** Deliver a live stream message; dropped while no webview is ready (the
   * snapshot already captured it and will replay on the next open). */
  private post(message: ChartInMessage): void {
    if (!this.panel || !this.ready) return;
    void this.panel.webview.postMessage(message);
  }

  private html(webview: vscode.Webview, distRoot: vscode.Uri): string {
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(distRoot, 'chart-webview.js'));
    return chartHtml({ cspSource: webview.cspSource, scripts: [{ src: scriptUri.toString() }] });
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
  /** Live charts without a script, keyed by their own id: like a data preview,
   * kept alive by their webview and retired when it closes. */
  private readonly liveCharts = new Set<string>();
  /** Set by the host: re-pick the symbol or data for the chart on screen. */
  onSelectData: ((chartKey: string, live: boolean) => void) | undefined;
  /** Set by the host: a live chart's toolbar timeframe pick (undefined: ask
   * for a custom one). */
  onSelectTimeframe: ((chartKey: string, timeframe: string | undefined) => void) | undefined;
  /** Set by the host: the tab of a live chart without a script was closed. */
  onLiveChartClosed: ((chartKey: string) => void) | undefined;
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
        if (e.affectsConfiguration(CANDLE_STYLE_SETTING)) {
          const style = readCandleStyle();
          for (const panel of this.panels.values()) panel.setCandleStyle(style);
        }
        if (e.affectsConfiguration(PRICE_SCALE_SETTING)) {
          const scale = readPriceScale();
          for (const panel of this.panels.values()) panel.setPriceScale(scale);
        }
        if (e.affectsConfiguration(COLOR_SCHEME_SETTING)) {
          const scheme = readColorScheme();
          for (const panel of this.panels.values()) panel.setColorScheme(scheme);
        }
      })
    );
  }

  /** Script backing the currently active chart tab, if that chart can own
   * inputs. Raw data previews deliberately return no script. */
  activeInputScriptPath(): string | undefined {
    const key = this.activeChartKey;
    return key && isChartablePath(key) ? key : undefined;
  }

  async openSource(): Promise<void> {
    const source = this.activeInputScriptPath();
    if (!source) return;

    const uri = vscode.Uri.file(source);
    const doc = await vscode.workspace.openTextDocument(uri).then(
      (document) => document,
      () => undefined
    );
    if (!doc) {
      void vscode.window.showWarningMessage(`PyneIDE: Could not open source file ${path.basename(source)}.`);
      return;
    }

    const groups = vscode.window.tabGroups;
    const existing = groups.all.find((group) => group.tabs.some(
      (tab) => tab.input instanceof vscode.TabInputText && tab.input.uri.toString() === uri.toString()
    ));
    if (existing) {
      await vscode.window.showTextDocument(doc, { viewColumn: existing.viewColumn });
      return;
    }

    const commands = await vscode.commands.getCommands(true);
    if (this.activeChartKey !== source) return;
    const chartGroup = groups.activeTabGroup.viewColumn;
    if (commands.includes('workbench.action.focusLeftGroupWithoutWrap')) {
      await vscode.commands.executeCommand('workbench.action.focusLeftGroupWithoutWrap');
    }
    if (groups.activeTabGroup.viewColumn === chartGroup && commands.includes('workbench.action.newGroupLeft')) {
      await vscode.commands.executeCommand('workbench.action.newGroupLeft');
    }
    await vscode.window.showTextDocument(doc, { viewColumn: groups.activeTabGroup.viewColumn, preview: false });
  }

  onEvent(event: BridgeEvent, chartKey: string): void {
    // A real run takes ownership of a chart that may have been created by
    // opening its persisted output. From here on it follows normal script
    // chart lifetime and the run updates the already-open tab in place.
    this.dataPreviews.delete(chartKey);
    this.panelFor(chartKey).handleEvent(event);
  }

  /** Rebuild a chart from another stream's snapshot (a live chart tab
   * mirroring a dashboard chart). */
  loadSnapshot(chartKey: string, snap: ChartSnapshot): void {
    this.panelFor(chartKey).loadSnapshot(snap);
  }

  onFinished(_chartKey: string): void {
    // The 'end' event already closed out the chart state.
  }

  /** Whether this script's chart tab is currently open. */
  hasOpenChart(chartKey: string): boolean {
    return this.panels.get(chartKey)?.isOpen() === true;
  }

  setDebugPosition(chartKey: string, position: ChartDebugPosition | undefined): void {
    this.panels.get(chartKey)?.setDebugPosition(position);
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

  /**
   * Open (or focus) a live chart without a script, keyed by its own id; its
   * run's events go to it through {@link onEvent}. Closing its tab retires it.
   */
  openLiveChart(chartKey: string, title: string): void {
    let panel = this.panels.get(chartKey);
    if (!panel) {
      panel = this.createPanel(chartKey, () => this.retireLiveChart(chartKey), title);
      this.panels.set(chartKey, panel);
      this.liveCharts.add(chartKey);
    } else {
      panel.setTitle(title);
    }
    panel.reveal();
  }

  private retireLiveChart(chartKey: string): void {
    this.closeChart(chartKey);
    this.onLiveChartClosed?.(chartKey);
  }

  /** Open (or focus) a script's chart panel on demand — used by "Open chart". */
  reveal(chartKey: string): ChartPanel {
    const panel = this.panelFor(chartKey);
    panel.reveal();
    return panel;
  }

  /**
   * Release closed charts once there is no source tab or stream to reuse their
   * snapshot. Open chart tabs keep their results independently of source tabs.
   */
  reconcile(): void {
    const live = openChartKeys();
    for (const [key, panel] of this.panels) {
      if (!panel.isOpen() && !live.has(key) && !this.dataPreviews.has(key) &&
          !this.liveCharts.has(key) && !this.isPinned?.(key)) {
        this.closeChart(key);
      }
    }
  }

  /** Dispose a chart's webview (if any) and drop its snapshot. */
  closeChart(chartKey: string): void {
    this.dataPreviews.delete(chartKey);
    this.liveCharts.delete(chartKey);
    const panel = this.panels.get(chartKey);
    if (!panel) return;
    this.panels.delete(chartKey);
    panel.dispose();
  }

  private panelFor(chartKey: string): ChartPanel {
    let panel = this.panels.get(chartKey);
    if (!panel) {
      panel = this.createPanel(chartKey, () => this.reconcile());
      panel.setBreakpointTargets(this.breakpointTargetsForChart?.(chartKey) ?? []);
      this.panels.set(chartKey, panel);
    }
    return panel;
  }

  private createPanel(chartKey: string, onWebviewClosed: () => void, title?: string): ChartPanel {
    return new ChartPanel(
      this.context,
      chartKey,
      (live) => this.onSelectData?.(chartKey, live),
      onWebviewClosed,
      (active) => this.updateActiveChart(chartKey, active),
      (timestamp) => this.onSelectBreakpointBar?.(chartKey, timestamp),
      (timestamp) => this.onRemoveBreakpointBar?.(chartKey, timestamp),
      () => this.onCancelBreakpointSelection?.(chartKey),
      (timeframe) => this.onSelectTimeframe?.(chartKey, timeframe),
      title
    );
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
