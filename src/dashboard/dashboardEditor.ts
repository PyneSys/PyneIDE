/**
 * The dashboard editor: a custom editor of `*.dashboard.toml` files that shows the
 * file's charts live, and edits the file when the user adds, removes or
 * rearranges something. The file stays the single source: every UI action is
 * written into it (and saved), and every change of it — from the UI or typed by
 * hand — is what restarts the charts it touched.
 *
 * A chart gets its candles from the workdir's candle process (`CandleServices`)
 * and runs one bridge per script (PyneCore runs one script per process);
 * `ChartComposer` merges them into the
 * one stream a chart iframe draws. The scripts start once the candles' history
 * is in, from its first bar, so every process runs on the same bars.
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import * as vscode from 'vscode';

import {
  persistChartSetting,
  readCandleStyle,
  readColorScheme,
  readPriceScale,
} from '../chart/chartPanel';
import { chartHtml } from '../chart/chartHtml';
import { ChartStream } from '../chart/chartStream';
import type { ChartCell, ChartCellAction, ChartCellScript, ChartInMessage, ChartOutMessage } from '../chart/messages';
import type { CompileService } from '../compile/service';
import { BridgeRun, type BridgeEvent, type DownloadEvent } from '../run/bridgeClient';
import type { CandleRun, CandleServices } from '../run/candleService';
import { askTimeframe, offerLiveCoreUpdate, LIVE_UNSUPPORTED, type LiveChartEnv, type PickLiveTarget } from '../run/liveChartService';
import { providerSymbol, providerTimeframe, withTimeframe } from '../run/liveTarget';
import type { ProviderHubs } from '../run/providerHub';
import { ChartComposer } from './composer';
import type {
  DashboardChartState,
  DashboardInMessage,
  DashboardOutMessage,
  DashboardView,
  DashboardViewChart,
} from './messages';
import {
  chartKeyFor,
  DashboardFormatError,
  dashboardStem,
  insertBeside,
  layoutKeys,
  layoutOf,
  MAX_CHARTS,
  moveInLayout,
  parseDashboard,
  removeChart,
  removeWindow,
  resizeSplit,
  scriptIdFor,
  scriptLimitReason,
  serializeDashboard,
  uniqueKey,
  windowOf,
  withLayout,
  type Dashboard,
  type DashboardChart,
  type DashboardScript,
  type ScriptKind,
  type SplitDirection,
} from './model';
import { listDashboardScripts, scriptKindOf } from './scripts';

/** Where {@link DashboardSession.addChart} puts a chart that opens a window of its own. */
const NEW_WINDOW = Symbol('new window');
/** How long a stopped bridge may take to exit before it is killed. */
const STOP_GRACE_MS = 4000;
/** The view type of a dashboard's further windows (`windows.<key>`). */
const WINDOW_VIEW_TYPE = 'pyneide.dashboardWindow';
/** How long a dashboard that has just opened waits for VS Code to restore its
 * windows from the last session before it opens them anew. */
const RESTORE_WAIT_MS = 3000;
/** How long a new window's panel may take to become the active editor, which
 * the command moving it into a window of its own acts on. */
const ACTIVATE_WAIT_MS = 2000;

/** What a further window's page keeps for VS Code to restore it with. */
interface WindowState {
  /** The dashboard file. */
  uri: string;
  /** The window's key in it. */
  window: string;
}

function isWindowState(value: unknown): value is WindowState {
  return typeof value === 'object' && value !== null &&
    typeof (value as WindowState).uri === 'string' && typeof (value as WindowState).window === 'string';
}

/** Resolves once `panel` is the active editor, or after `ms`; true when it is. */
function whenActive(panel: vscode.WebviewPanel, ms: number): Promise<boolean> {
  if (panel.active) return Promise.resolve(true);
  return new Promise((resolve) => {
    const done = (active: boolean): void => {
      clearTimeout(timer);
      listener.dispose();
      resolve(active);
    };
    const timer = setTimeout(() => done(false), ms);
    const listener = panel.onDidChangeViewState((e) => {
      if (e.webviewPanel.active) done(true);
    });
  });
}

/** Edit a dashboard script's inputs; resolves with the new overrides, or
 * undefined when the form was closed without saving. */
export type EditDashboardInputs = (request: {
  scriptUri: vscode.Uri;
  /** The entry's identity: the dashboard file, the chart key and the script id. */
  key: string;
  title: string;
  inputs: Record<string, unknown>;
  settings: Record<string, unknown>;
  save: (inputs: Record<string, unknown>, settings: Record<string, unknown>) => Promise<void>;
}) => Promise<void>;

export interface DashboardDeps {
  context: vscode.ExtensionContext;
  output: vscode.OutputChannel;
  resolveEnv: () => Promise<LiveChartEnv | undefined>;
  pickLive: PickLiveTarget;
  compile: CompileService;
  editInputs: EditDashboardInputs;
  hubs: ProviderHubs;
  candles: CandleServices;
}

export class DashboardEditorProvider implements vscode.CustomTextEditorProvider {
  static readonly viewType = 'pyneide.dashboard';
  private readonly sessions = new Set<DashboardSession>();
  /**
   * Chart runners still stopping, by output directory. They outlive their
   * chart and its dashboard tab: a chart removed and added again, or a
   * dashboard closed and opened again, starts on the same output files.
   */
  private readonly stopping = new Map<string, Promise<void>>();
  /**
   * Windows VS Code restored from the last session whose dashboard is not
   * open yet, by dashboard file and window key. The dashboard takes them when
   * it opens, so they stay where the user put them.
   */
  private readonly orphans = new Map<string, Map<string, Orphan>>();
  private readonly restored = new vscode.EventEmitter<void>();

  constructor(private readonly deps: DashboardDeps) {}

  /** Runners writing into `outputDir` are stopping until `stop` settles. */
  trackStop(outputDir: string, stop: Promise<void>): void {
    const all = Promise.all([this.stopping.get(outputDir), stop]).then(() => undefined);
    this.stopping.set(outputDir, all);
    void all.then(() => {
      if (this.stopping.get(outputDir) === all) this.stopping.delete(outputDir);
    });
  }

  /** Settles once every runner stopped so far that wrote into `outputDir` has exited. */
  stopped(outputDir: string): Promise<void> {
    return this.stopping.get(outputDir) ?? Promise.resolve();
  }

  register(): void {
    this.deps.context.subscriptions.push(
      vscode.window.registerCustomEditorProvider(DashboardEditorProvider.viewType, this, {
        webviewOptions: { retainContextWhenHidden: true },
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (!e.affectsConfiguration('pyneide.chart')) return;
        for (const session of this.sessions) session.pushChartSettings();
      }),
      vscode.window.registerWebviewPanelSerializer(WINDOW_VIEW_TYPE, {
        deserializeWebviewPanel: async (panel, state) => this.restoreWindow(panel, state),
      }),
      vscode.commands.registerCommand('pyneide.dashboardAddChart', () => {
        const session = this.activeSession();
        session?.addChart(undefined, undefined, session.activeWindow()).catch(reportEditError);
      }),
      vscode.commands.registerCommand('pyneide.dashboardOpenText', () =>
        this.activeSession()?.openText()),
      vscode.commands.registerCommand('pyneide.dashboardReopenWindows', () =>
        this.activeSession()?.reopenWindows()),
      vscode.commands.registerCommand('pyneide.dashboardRemoveWindow', () => {
        const session = this.activeSession();
        session?.removeWindow(session.activeWindow(), true).catch(reportEditError);
      }),
      this.restored,
      {
        dispose: () => {
          for (const session of this.sessions) session.dispose();
          for (const panels of this.orphans.values()) for (const orphan of panels.values()) orphan.panel.dispose();
        },
      }
    );
  }

  /** The dashboard of the active editor tab (its own or one of its windows). */
  private activeSession(): DashboardSession | undefined {
    return [...this.sessions].find((session) => session.active);
  }

  /** Show "Reopen Closed Dashboard Windows" while the active dashboard has a closed window. */
  refreshContext(): void {
    const closed = (this.activeSession()?.closedWindowCount ?? 0) > 0;
    void vscode.commands.executeCommand('setContext', 'pyneide.dashboardHasClosedWindows', closed);
  }

  resolveCustomTextEditor(document: vscode.TextDocument, panel: vscode.WebviewPanel): void {
    const session = new DashboardSession(this.deps, this, document, panel);
    this.sessions.add(session);
    panel.onDidDispose(() => {
      this.sessions.delete(session);
      session.dispose();
    });
    const key = document.uri.toString();
    const restored = this.orphans.get(key);
    this.orphans.delete(key);
    for (const [window, orphan] of restored ?? []) {
      orphan.placeholder.dispose();
      session.adoptWindow(window, orphan.panel);
    }
    session.openWindows(true);
  }

  /** VS Code restored a dashboard window of the last session. */
  private restoreWindow(panel: vscode.WebviewPanel, state: unknown): void {
    if (!isWindowState(state) || !fs.existsSync(vscode.Uri.parse(state.uri).fsPath)) {
      panel.dispose();
      return;
    }
    const session = [...this.sessions].find((s) => s.uri.toString() === state.uri);
    if (session) {
      session.adoptWindow(state.window, panel);
    } else {
      // It waits for its dashboard, which VS Code opens once its tab shows
      const panels = this.orphans.get(state.uri) ?? new Map<string, Orphan>();
      panels.get(state.window)?.panel.dispose();
      panels.set(state.window, { panel, placeholder: showOrphan(this.deps.context, panel, state) });
      this.orphans.set(state.uri, panels);
      panel.onDidDispose(() => {
        if (this.orphans.get(state.uri)?.get(state.window)?.panel !== panel) return;
        panels.delete(state.window);
        if (!panels.size) this.orphans.delete(state.uri);
      });
    }
    this.restored.fire();
  }

  /**
   * Settles once VS Code has handed over every dashboard window it restores
   * from the last session (every such tab has a panel here), or after
   * {@link RESTORE_WAIT_MS}.
   */
  async restoresSettled(): Promise<void> {
    const deadline = Date.now() + RESTORE_WAIT_MS;
    while (this.unclaimedWindowTabs() > 0 && Date.now() < deadline) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          listener.dispose();
          resolve();
        }, deadline - Date.now());
        const listener = this.restored.event(() => {
          clearTimeout(timer);
          listener.dispose();
          resolve();
        });
      });
    }
  }

  /** Dashboard window tabs VS Code shows that no panel of this extension holds yet. */
  private unclaimedWindowTabs(): number {
    const tabs = vscode.window.tabGroups.all.flatMap((group) => group.tabs)
      .filter((tab) => tab.input instanceof vscode.TabInputWebview && tab.input.viewType.endsWith(WINDOW_VIEW_TYPE))
      .length;
    let held = 0;
    for (const session of this.sessions) held += session.windowCount;
    for (const panels of this.orphans.values()) held += panels.size;
    return tabs - held;
  }
}

/** A restored window waiting for its dashboard, and what its placeholder listens to. */
interface Orphan {
  panel: vscode.WebviewPanel;
  placeholder: vscode.Disposable;
}

/** A restored window whose dashboard is not open yet: a button opens it. */
function showOrphan(
  context: vscode.ExtensionContext,
  panel: vscode.WebviewPanel,
  state: WindowState
): vscode.Disposable {
  const uri = vscode.Uri.parse(state.uri);
  panel.webview.options = { enableScripts: true, localResourceRoots: [] };
  const icons = vscode.Uri.joinPath(context.extensionUri, 'icons');
  panel.iconPath = {
    light: vscode.Uri.joinPath(icons, 'dashboard-light.svg'),
    dark: vscode.Uri.joinPath(icons, 'dashboard-dark.svg'),
  };
  const nonce = crypto.randomBytes(16).toString('base64');
  const name = escapeHtml(fileStem(uri));
  panel.webview.html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline';">
<style>
  html, body { height: 100%; margin: 0; }
  body {
    display: flex; flex-direction: column; gap: 14px; align-items: center; justify-content: center;
    font-family: var(--vscode-font-family); font-size: 12px; color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
  }
  p { margin: 0; color: var(--vscode-descriptionForeground); }
  button {
    height: 28px; padding: 0 14px; border: 0; border-radius: 4px; cursor: pointer; font: inherit;
    background: var(--vscode-button-background, #0e639c); color: var(--vscode-button-foreground, #fff);
  }
  button:hover { background: var(--vscode-button-hoverBackground, #1177bb); }
</style>
</head>
<body>
<p>This window shows charts of the dashboard ${name}.</p>
<button id="open">Open dashboard</button>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  vscode.setState(${JSON.stringify(state).replace(/</g, '\\u003c')});
  document.getElementById('open').addEventListener('click', () => vscode.postMessage({ type: 'openDashboard' }));
</script>
</body>
</html>`;
  return panel.webview.onDidReceiveMessage((msg: { type?: unknown }) => {
    if (msg?.type !== 'openDashboard') return;
    void vscode.commands.executeCommand('vscode.openWith', uri, DashboardEditorProvider.viewType, {
      viewColumn: vscode.ViewColumn.One,
    });
  });
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** Show why a dashboard edit was not made. */
function reportEditError(err: unknown): void {
  void vscode.window.showWarningMessage(`PyneIDE: ${err instanceof Error ? err.message : String(err)}`);
}

/** A dashboard's name from its file's URI. */
function fileStem(uri: vscode.Uri): string {
  return dashboardStem(path.basename(uri.fsPath));
}

/** What a chart runs: a change of it restarts the chart. */
function chartSignature(chart: DashboardChart): string {
  return JSON.stringify({
    provider: chart.provider,
    history: chart.history,
    scripts: chart.scripts.map((s) => ({
      id: s.id, path: s.path, inputs: s.inputs ?? {}, settings: s.settings ?? {},
      tradeOnHistory: s.tradeOnHistory ?? true,
    })),
  });
}

/** The inputs a dashboard script entry sets, short: `length 20, source close`. */
function inputSummary(script: DashboardScript): string {
  return Object.entries(script.inputs ?? {})
    .map(([name, value]) => `${name} ${typeof value === 'string' ? value : JSON.stringify(value)}`)
    .join(', ');
}

/** One page of a dashboard: its own tab, or one of its further windows. */
interface DashboardPage {
  /** The window's key; undefined for the dashboard's own tab. */
  window: string | undefined;
  panel: vscode.WebviewPanel;
  /** The page script answered: it takes views. */
  ready: boolean;
  subscriptions: vscode.Disposable[];
}

class DashboardSession {
  private dashboard: Dashboard | undefined;
  private error: string | undefined;
  private readonly charts = new Map<string, ChartRun>();
  /** The window each chart is in (undefined: the dashboard's own tab). */
  private chartWindows = new Map<string, string | undefined>();
  private readonly main: DashboardPage;
  /** The open further windows, by key. */
  private readonly windows = new Map<string, DashboardPage>();
  /** Windows the user closed: the file keeps them, and they open again with
   * the dashboard or on "Reopen Closed Dashboard Windows". */
  private readonly closedWindows = new Set<string>();
  /** Charts stopped because their window is closed: they start again when it opens. */
  private readonly paused = new Set<string>();
  /** Windows are opened one after the other (each new one becomes the active
   * editor before it moves into a window of its own). */
  private windowQueue: Promise<void> = Promise.resolve();
  /** The windows open with the file's changes once the dashboard has taken
   * those VS Code restores (see {@link DashboardSession.openWindows}). */
  private windowsStarted = false;
  private disposed = false;
  private env: Promise<LiveChartEnv | undefined> | undefined;
  /** Edits are applied one after the other, each on the file the last one left. */
  private editQueue: Promise<void> = Promise.resolve();
  private readonly subscriptions: vscode.Disposable[] = [];
  private readonly distRoot: vscode.Uri;

  constructor(
    private readonly deps: DashboardDeps,
    readonly provider: DashboardEditorProvider,
    private readonly document: vscode.TextDocument,
    panel: vscode.WebviewPanel
  ) {
    this.distRoot = vscode.Uri.joinPath(deps.context.extensionUri, 'dist');
    this.main = this.attach(undefined, panel);
    this.subscriptions.push(
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document === document && e.contentChanges.length) this.sync();
      })
    );
    this.sync();
  }

  get uri(): vscode.Uri {
    return this.document.uri;
  }

  /** The dashboard's tab, or one of its windows, is the active editor. */
  get active(): boolean {
    return !this.disposed && [this.main, ...this.windows.values()].some((page) => page.panel.active);
  }

  /** The window of the active editor (undefined: the dashboard's own tab). */
  activeWindow(): string | undefined {
    return [...this.windows.values()].find((page) => page.panel.active)?.window;
  }

  /** The further windows open now. */
  get windowCount(): number {
    return this.windows.size;
  }

  /** The further windows the user closed. */
  get closedWindowCount(): number {
    return this.closedWindows.size;
  }

  openText(): Thenable<unknown> {
    return vscode.commands.executeCommand('vscode.openWith', this.document.uri, 'default');
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const chart of this.charts.values()) chart.dispose();
    this.charts.clear();
    for (const page of this.windows.values()) {
      for (const s of page.subscriptions) s.dispose();
      page.panel.dispose();
    }
    this.windows.clear();
    for (const s of this.main.subscriptions) s.dispose();
    for (const s of this.subscriptions) s.dispose();
  }

  get name(): string {
    return this.dashboard?.name ?? fileStem(this.document.uri);
  }

  /** A further window's title: the dashboard's name and the window's. */
  private windowTitle(window: string): string {
    return `${this.name} · ${this.dashboard?.windows[window]?.title ?? window}`;
  }

  /** Show `panel` as a page of the dashboard. */
  private attach(window: string | undefined, panel: vscode.WebviewPanel): DashboardPage {
    const page: DashboardPage = { window, panel, ready: false, subscriptions: [] };
    panel.webview.options = { enableScripts: true, localResourceRoots: [this.distRoot] };
    const icons = vscode.Uri.joinPath(this.deps.context.extensionUri, 'icons');
    panel.iconPath = {
      light: vscode.Uri.joinPath(icons, 'dashboard-light.svg'),
      dark: vscode.Uri.joinPath(icons, 'dashboard-dark.svg'),
    };
    const state: WindowState | undefined = window === undefined
      ? undefined
      : { uri: this.document.uri.toString(), window };
    panel.webview.html = this.html(panel.webview, state);
    page.subscriptions.push(
      panel.webview.onDidReceiveMessage((msg: DashboardOutMessage) =>
        void this.onMessage(page, msg).catch(reportEditError)),
      panel.onDidChangeViewState(() => this.provider.refreshContext())
    );
    if (window !== undefined) {
      panel.title = this.windowTitle(window);
      page.subscriptions.push(panel.onDidDispose(() => {
        if (this.disposed || this.windows.get(window) !== page) return;
        // Closed by the user: the file keeps the window, and its charts stop until it opens again
        for (const s of page.subscriptions) s.dispose();
        this.windows.delete(window);
        this.closedWindows.add(window);
        for (const [key, run] of this.charts) if (this.chartWindows.get(key) === window) run.frameGone();
        this.updatePaused();
        this.provider.refreshContext();
        void this.offerClosed(window).catch(reportEditError);
      }));
      this.windows.set(window, page);
    }
    return page;
  }

  /** Whether chart `key` is in a window the user closed. */
  private isHidden(key: string): boolean {
    const window = this.chartWindows.get(key);
    return window !== undefined && this.closedWindows.has(window);
  }

  /** Stop the charts of the closed windows, and start those of the reopened ones again. */
  private updatePaused(): void {
    for (const [key, run] of this.charts) {
      const hidden = this.isHidden(key);
      if (hidden && !this.paused.has(key)) {
        this.paused.add(key);
        run.stop();
      } else if (!hidden && this.paused.has(key)) {
        this.paused.delete(key);
        void run.start();
      }
    }
  }

  /** A window was closed: say it opens again, and offer to reopen or remove it. */
  private async offerClosed(window: string): Promise<void> {
    const title = this.dashboard?.windows[window]?.title ?? window;
    const choice = await vscode.window.showInformationMessage(
      `PyneIDE: the window "${title}" of ${this.name} is closed and its charts are stopped. ` +
      'It opens again with the dashboard.',
      'Reopen',
      'Remove from Dashboard'
    );
    if (this.disposed || !this.closedWindows.has(window)) return;
    if (choice === 'Reopen') this.reopenWindows([window]);
    else if (choice === 'Remove from Dashboard') await this.removeWindow(window, false);
  }

  /** "Remove Window from Dashboard": the window and its charts leave the file;
   * `confirm` asks first. */
  async removeWindow(window: string | undefined, confirm: boolean): Promise<void> {
    const entry = window === undefined ? undefined : this.dashboard?.windows[window];
    if (window === undefined || !entry) return;
    if (confirm) {
      const count = layoutKeys(entry.layout).length;
      const answer = await vscode.window.showWarningMessage(
        `Remove the window "${entry.title ?? window}" and its ${count === 1 ? 'chart' : `${count} charts`} ` +
        'from the dashboard?',
        { modal: true, detail: 'Their scripts, inputs and drawings leave the dashboard file.' },
        'Remove'
      );
      if (answer !== 'Remove') return;
    }
    await this.edit((d) => removeWindow(d, window));
  }

  /** Take a window VS Code restored from the last session, in place of one
   * opened anew (the restored one is where the user put it). */
  adoptWindow(window: string, panel: vscode.WebviewPanel): void {
    if (this.disposed || (this.dashboard && !this.dashboard.windows[window])) {
      panel.dispose();
      return;
    }
    const previous = this.windows.get(window);
    if (previous) {
      this.windows.delete(window);
      for (const s of previous.subscriptions) s.dispose();
      previous.panel.dispose();
    }
    this.closedWindows.delete(window);
    for (const [key, run] of this.charts) if (this.chartWindows.get(key) === window) run.frameGone();
    this.attach(window, panel);
    this.updatePaused();
    this.provider.refreshContext();
  }

  /** Open the file's windows that are not open; `first`: the dashboard has
   * just opened, so the windows VS Code restores are waited for first. */
  openWindows(first = false): void {
    if (first) this.windowsStarted = true;
    if (!this.windowsStarted) return;
    const run = async (): Promise<void> => {
      if (first) await this.provider.restoresSettled();
      for (const window of Object.keys(this.dashboard?.windows ?? {})) {
        if (this.disposed) return;
        if (this.windows.has(window) || this.closedWindows.has(window)) continue;
        await this.openWindow(window);
      }
    };
    this.windowQueue = this.windowQueue.then(run, run).catch(reportEditError);
  }

  /** "Reopen Closed Dashboard Windows": open `windows` (all closed ones by
   * default) again, and start their charts. */
  reopenWindows(windows: string[] = [...this.closedWindows]): void {
    for (const window of windows) this.closedWindows.delete(window);
    this.updatePaused();
    this.provider.refreshContext();
    this.openWindows();
  }

  /** Open a further window: a panel moved into a window of its own. */
  private async openWindow(window: string): Promise<void> {
    const panel = vscode.window.createWebviewPanel(
      WINDOW_VIEW_TYPE,
      this.windowTitle(window),
      { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [this.distRoot] }
    );
    this.attach(window, panel);
    // The command moves the active editor
    if (await whenActive(panel, ACTIVATE_WAIT_MS)) {
      await vscode.commands.executeCommand('workbench.action.moveEditorToNewWindow');
    }
  }

  /** The workdir-relative output directory of a chart. */
  outputDir(chartKey: string): string {
    return path.join('output', 'dashboards', fileStem(this.document.uri), chartKey);
  }

  environment(): Promise<LiveChartEnv | undefined> {
    this.env ??= this.deps.resolveEnv().then((env) => {
      // A refused setup is asked again on the next start
      if (!env) this.env = undefined;
      return env;
    });
    return this.env;
  }

  pushChartSettings(): void {
    for (const chart of this.charts.values()) chart.pushChartSettings();
  }

  /** The file changed (or was opened): start, restart and stop its charts,
   * and open and close its windows. */
  private sync(): void {
    if (this.disposed) return;
    try {
      this.dashboard = parseDashboard(this.document.getText());
      this.error = undefined;
    } catch (err) {
      this.error = err instanceof DashboardFormatError || err instanceof Error ? err.message : String(err);
      this.postView();
      return;
    }
    const dashboard = this.dashboard;
    const charts = dashboard.charts;
    const chartWindows = new Map(Object.keys(charts).map((key) => [key, windowOf(dashboard, key)]));
    for (const [key, run] of [...this.charts]) {
      if (!charts[key]) {
        run.dispose();
        this.charts.delete(key);
        this.paused.delete(key);
      } else if (chartWindows.get(key) !== this.chartWindows.get(key)) {
        // Its chart page is in another window now
        run.frameGone();
      }
    }
    this.chartWindows = chartWindows;
    for (const [key, chart] of Object.entries(charts)) {
      const run = this.charts.get(key);
      if (!run) {
        const next = new ChartRun(this.deps, this, key, chart);
        this.charts.set(key, next);
        if (this.isHidden(key)) this.paused.add(key);
        else void next.start();
      } else if (chartSignature(run.config) !== chartSignature(chart)) {
        run.config = chart;
        // A stopped chart starts on its new config when its window opens
        if (!this.paused.has(key)) void run.start();
      } else {
        run.config = chart;
      }
    }
    for (const [window, page] of [...this.windows]) {
      if (dashboard.windows[window]) {
        page.panel.title = this.windowTitle(window);
        continue;
      }
      this.windows.delete(window);
      for (const s of page.subscriptions) s.dispose();
      page.panel.dispose();
    }
    for (const window of [...this.closedWindows]) {
      if (!dashboard.windows[window]) this.closedWindows.delete(window);
    }
    // A chart may have left a closed window by a text edit
    this.updatePaused();
    this.provider.refreshContext();
    this.postView();
    this.openWindows();
  }

  postView(): void {
    if (this.disposed) return;
    for (const page of [this.main, ...this.windows.values()]) this.postPageView(page);
    for (const run of this.charts.values()) run.postCell();
  }

  private postPageView(page: DashboardPage): void {
    if (!page.ready) return;
    const title = page.window === undefined ? this.name : this.windowTitle(page.window);
    const view: DashboardView = this.error !== undefined || !this.dashboard
      ? { name: fileStem(this.document.uri), layout: undefined, charts: {}, error: this.error }
      : {
          name: title,
          layout: layoutOf(this.dashboard, page.window),
          charts: Object.fromEntries([...this.charts]
            .filter(([key]) => this.chartWindows.get(key) === page.window)
            .map(([key, run]) => [key, run.view()])),
        };
    void page.panel.webview.postMessage({ type: 'view', view } satisfies DashboardInMessage);
  }

  /** The open page that shows chart `key`. */
  private pageOf(key: string): DashboardPage | undefined {
    const window = this.chartWindows.get(key);
    return window === undefined ? this.main : this.windows.get(window);
  }

  /** Why no chart can join the dashboard, when none can. */
  addChartBlocked(): string | undefined {
    return this.dashboard && Object.keys(this.dashboard.charts).length >= MAX_CHARTS
      ? `A dashboard holds at most ${MAX_CHARTS} charts.`
      : undefined;
  }

  /** Whether chart `key` can be dragged to another place: its window holds another chart. */
  chartMovable(key: string): boolean {
    return this.dashboard !== undefined && layoutKeys(layoutOf(this.dashboard, this.chartWindows.get(key))).length > 1;
  }

  /** A chart's toolbar or Layers menu asked for a cell action. */
  async onCellAction(key: string, action: ChartCellAction): Promise<void> {
    switch (action.kind) {
      case 'addScript':
        await this.addScript(key);
        break;
      case 'editScript':
        await this.editScript(key, action.id);
        break;
      case 'removeScript':
        await this.edit((d) => {
          const chart = d.charts[key];
          if (!chart) return undefined;
          chart.scripts = chart.scripts.filter((s) => s.id !== action.id);
          return d;
        });
        break;
      case 'addChart':
        await this.addChart(key, action.direction);
        break;
      case 'removeChart':
        await this.edit((d) => removeChart(d, key));
        break;
      case 'addChartWindow':
        await this.addChart(undefined, undefined, NEW_WINDOW);
        break;
      case 'restart':
        void this.charts.get(key)?.start();
        break;
      case 'drawings':
        await this.edit((d) => {
          const chart = d.charts[key];
          // A save from before a symbol change belongs to the old symbol
          if (!chart || providerSymbol(chart.provider) !== action.symbol) return undefined;
          if (action.records.length) chart.drawings = action.records;
          else delete chart.drawings;
          return d;
        });
        break;
    }
  }

  postChart(key: string, message: ChartInMessage): void {
    if (this.disposed) return;
    void this.pageOf(key)?.panel.webview.postMessage({ type: 'chart', key, message } satisfies DashboardInMessage);
  }

  /** Rewrite the file through `change` (on the document's current text) and
   * save it. Rejects while the text is not a valid dashboard: rewriting it from
   * an older parse would drop the newer text. */
  edit(change: (d: Dashboard) => Dashboard | undefined): Promise<void> {
    const run = async (): Promise<void> => {
      if (this.disposed) return;
      let current: Dashboard;
      try {
        current = parseDashboard(this.document.getText());
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`The dashboard file has an error; fix it first (${message}).`);
      }
      const next = change(current);
      if (!next) return;
      const text = serializeDashboard(next);
      if (text === this.document.getText()) return;
      const edit = new vscode.WorkspaceEdit();
      const end = this.document.lineAt(this.document.lineCount - 1).range.end;
      edit.replace(this.document.uri, new vscode.Range(new vscode.Position(0, 0), end), text);
      if (await vscode.workspace.applyEdit(edit)) await this.document.save();
    };
    this.editQueue = this.editQueue.then(run, run);
    return this.editQueue;
  }

  private async onMessage(page: DashboardPage, msg: DashboardOutMessage): Promise<void> {
    switch (msg.type) {
      case 'ready':
        // A page (re)loaded, as one moved into another window does: its charts load anew
        page.ready = true;
        for (const [key, run] of this.charts) if (this.chartWindows.get(key) === page.window) run.frameGone();
        this.postPageView(page);
        break;
      case 'frame':
        // A chart page left behind in a window the chart has just left
        if (this.chartWindows.get(msg.key) !== page.window) break;
        this.charts.get(msg.key)?.onFrameMessage(msg.message);
        break;
      case 'openText':
        await this.openText();
        break;
      case 'addChart':
        await this.addChart(undefined, undefined, page.window);
        break;
      case 'resize':
        await this.edit((d) => withLayout(d, page.window, resizeSplit(layoutOf(d, page.window), msg.path, msg.sizes)));
        break;
      case 'moveChart':
        await this.edit((d) =>
          withLayout(d, page.window, moveInLayout(layoutOf(d, page.window), msg.key, msg.target, msg.side)));
        break;
      case 'restartChart':
        void this.charts.get(msg.key)?.start();
        break;
    }
  }

  /** Add a chart beside chart `beside` (in its window), or, without one, at
   * the right edge of `window` (undefined: the dashboard's own tab;
   * {@link NEW_WINDOW}: a new window). */
  async addChart(
    beside: string | undefined,
    direction: SplitDirection | undefined,
    window?: string | typeof NEW_WINDOW
  ): Promise<void> {
    if (!this.dashboard) return;
    if (Object.keys(this.dashboard.charts).length >= MAX_CHARTS) {
      void vscode.window.showWarningMessage(`PyneIDE: a dashboard holds at most ${MAX_CHARTS} charts.`);
      return;
    }
    const env = await this.environment();
    if (!env) return;
    const target = await this.deps.pickLive({ scriptName: '', strategy: false, from: '-500', historyTrades: false }, env);
    if (!target) return;
    await this.edit((d) => {
      if (Object.keys(d.charts).length >= MAX_CHARTS) return undefined;
      const into = beside !== undefined ? windowOf(d, beside)
        : window === NEW_WINDOW ? uniqueKey('window', Object.keys(d.windows)) : window;
      const key = chartKeyFor(target.provider, Object.keys(d.charts));
      d.charts[key] = { provider: target.provider, history: target.from, scripts: [] };
      return withLayout(d, into, insertBeside(layoutOf(d, into), beside, key, direction ?? 'horizontal'));
    });
  }

  /** Kinds of a chart's scripts, read from their sources. */
  private async kinds(workdir: string, chart: DashboardChart): Promise<ScriptKind[]> {
    return chart.scripts
      .map((s) => scriptKindOf(path.resolve(workdir, s.path)))
      .filter((k): k is ScriptKind => k !== undefined);
  }

  private async addScript(key: string): Promise<void> {
    const chart = this.dashboard?.charts[key];
    const env = await this.environment();
    if (!chart || !env) return;
    const kinds = await this.kinds(env.workdir, chart);
    const items = listDashboardScripts(env.workdir).map((file) => {
      const blocked = scriptLimitReason(kinds, file.kind);
      return {
        label: file.path.replace(/^scripts\//, ''),
        description: file.kind,
        detail: blocked,
        file,
        blocked,
      };
    });
    if (!items.length) {
      void vscode.window.showInformationMessage(
        'PyneIDE: this workspace has no indicator or strategy to add. Create one first.'
      );
      return;
    }
    const picked = await vscode.window.showQuickPick(items, {
      title: `Add a script to ${key}`,
      placeHolder: 'An indicator or a strategy of the workspace',
      matchOnDescription: true,
    });
    if (!picked) return;
    if (picked.blocked) {
      void vscode.window.showWarningMessage(`PyneIDE: ${picked.blocked}`);
      return;
    }
    await this.edit((d) => {
      const c = d.charts[key];
      if (!c) return undefined;
      const id = scriptIdFor(picked.file.path, c.scripts.map((s) => s.id));
      c.scripts.push({ id, path: picked.file.path });
      return d;
    });
  }

  private async editScript(key: string, id: string): Promise<void> {
    const script = this.dashboard?.charts[key]?.scripts.find((s) => s.id === id);
    const env = await this.environment();
    if (!script || !env) return;
    await this.deps.editInputs({
      scriptUri: vscode.Uri.file(path.resolve(env.workdir, script.path)),
      key: `${this.document.uri.toString()}#${key}#${id}`,
      title: `${this.name} · ${key} · ${id}`,
      inputs: script.inputs ?? {},
      settings: script.settings ?? {},
      save: (inputs, settings) => this.edit((d) => {
        const s = d.charts[key]?.scripts.find((x) => x.id === id);
        if (!s) throw new Error(`The dashboard has no script ${id} on chart ${key} any more.`);
        s.inputs = Object.keys(inputs).length ? inputs : undefined;
        s.settings = Object.keys(settings).length ? settings : undefined;
        return d;
      }),
    });
  }

  private html(webview: vscode.Webview, state: WindowState | undefined): string {
    const distRoot = this.distRoot;
    const asset = (name: string): string => webview.asWebviewUri(vscode.Uri.joinPath(distRoot, name)).toString();
    const code = (name: string): string => fs.readFileSync(path.join(distRoot.fsPath, name), 'utf8');
    // The chart iframes are `srcdoc` documents, whose requests the webview's
    // resource worker does not serve: their scripts go in inline, under a nonce
    // that both their policy and the dashboard page's (which they inherit) allow.
    const nonce = crypto.randomBytes(16).toString('base64');
    const frame = chartHtml({
      cspSource: webview.cspSource,
      scripts: [{ code: code('dashboard-frame.js') }, { code: code('chart-webview.js') }],
      nonce,
      embedded: true,
    });
    // Data, not code: `<` escaped so the page cannot end the script element early
    const frameJson = JSON.stringify(frame).replace(/</g, '\\u003c');
    const stateJson = JSON.stringify(state ?? null).replace(/</g, '\\u003c');
    return dashboardHtml(webview.cspSource, nonce, asset('dashboard-webview.js'), frameJson, stateJson);
  }
}

/** One chart of a dashboard: its bridges, their merged stream, its iframe. */
class ChartRun {
  private readonly stream = new ChartStream();
  private frameReady = false;
  /** Bumped on every (re)start: events of a superseded launch are dropped. */
  private generation = 0;
  private runs: CandleRun[] = [];
  private state: DashboardChartState = 'starting';
  private message: string | undefined;
  private readonly scriptStates = new Map<string, { state: ChartCellScript['state']; message?: string }>();
  private readonly scriptKinds = new Map<string, ScriptKind>();
  /** Each script's title, from its run's start. */
  private readonly scriptTitles = new Map<string, string>();

  constructor(
    private readonly deps: DashboardDeps,
    private readonly session: DashboardSession,
    private readonly key: string,
    public config: DashboardChart
  ) {}

  view(): DashboardViewChart {
    return { state: this.state, message: this.message };
  }

  /** The script's name in the Layers menu: its title and the inputs the
   * dashboard sets, or its id when another entry of the chart has the same
   * title and no inputs tell them apart. */
  private scriptLabel(script: DashboardScript): string {
    const title = (s: DashboardScript): string =>
      this.scriptTitles.get(s.id) ?? path.basename(s.path).replace(/\.[^.]+$/, '');
    const inputs = inputSummary(script);
    if (inputs) return `${title(script)} · ${inputs}`;
    const twin = this.config.scripts.some((s) => s.id !== script.id && title(s) === title(script));
    return twin ? `${title(script)} · ${script.id}` : title(script);
  }

  /** What the chart's toolbar and Layers menu show of the cell. */
  cell(): ChartCell {
    const kinds = this.config.scripts
      .map((s) => this.scriptKinds.get(s.id))
      .filter((k): k is ScriptKind => k !== undefined);
    const indicatorBlocked = scriptLimitReason(kinds, 'indicator');
    const strategyBlocked = scriptLimitReason(kinds, 'strategy');
    return {
      state: this.state,
      message: this.message,
      scripts: this.config.scripts.map((s) => {
        const st = this.scriptStates.get(s.id) ?? { state: 'loading' as const };
        return { id: s.id, label: this.scriptLabel(s), state: st.state, message: st.message };
      }),
      addScriptBlocked: indicatorBlocked && strategyBlocked ? 'This chart runs as many scripts as it can.' : undefined,
      addChartBlocked: this.session.addChartBlocked(),
      movable: this.session.chartMovable(this.key),
      drawings: {
        symbol: providerSymbol(this.config.provider),
        timeframe: providerTimeframe(this.config.provider) ?? '',
        records: this.config.drawings ?? [],
      },
    };
  }

  postCell(): void {
    if (this.frameReady) this.session.postChart(this.key, { type: 'cell', cell: this.cell() });
  }

  pushChartSettings(): void {
    if (!this.frameReady) return;
    this.session.postChart(this.key, { type: 'candleStyle', style: readCandleStyle() });
    this.session.postChart(this.key, { type: 'priceScale', scale: readPriceScale() });
    this.session.postChart(this.key, { type: 'colorScheme', scheme: readColorScheme() });
  }

  /** The chart page went away (its window closed, reloaded or is another
   * one now): nothing goes to it until a new one is ready. */
  frameGone(): void {
    this.frameReady = false;
  }

  onFrameMessage(msg: ChartOutMessage): void {
    switch (msg.type) {
      case 'ready':
        this.frameReady = true;
        this.pushChartSettings();
        this.postCell();
        for (const message of this.stream.replay()) this.session.postChart(this.key, message);
        break;
      case 'cell':
        this.session.onCellAction(this.key, msg.action).catch(reportEditError);
        break;
      case 'selectTimeframe':
        this.changeTimeframe(msg.timeframe).catch(reportEditError);
        break;
      case 'selectData':
        this.changeSymbol().catch(reportEditError);
        break;
      case 'setCandleStyle':
        persistChartSetting('chart.candleStyle', msg.style);
        break;
      case 'setPriceScale':
        persistChartSetting('chart.priceScale', msg.scale);
        break;
      case 'setColorScheme':
        persistChartSetting('chart.colorScheme', msg.scheme);
        break;
      case 'copyText':
        if (typeof msg.text === 'string') {
          void vscode.env.clipboard.writeText(msg.text).then(() =>
            vscode.window.setStatusBarMessage(`Copied ${msg.text}`, 2000)
          );
        }
        break;
      default:
        break;
    }
  }

  async changeTimeframe(timeframe: string | undefined): Promise<void> {
    const picked = timeframe ?? (await askTimeframe(providerTimeframe(this.config.provider)));
    if (!picked) return;
    await this.session.edit((d) => {
      const chart = d.charts[this.key];
      if (!chart) return undefined;
      chart.provider = withTimeframe(chart.provider, picked);
      return d;
    });
  }

  async changeSymbol(): Promise<void> {
    const env = await this.session.environment();
    if (!env) return;
    const target = await this.deps.pickLive({
      scriptName: '', strategy: false, timeframe: providerTimeframe(this.config.provider),
      from: this.config.history, historyTrades: false,
    }, env);
    if (!target) return;
    await this.session.edit((d) => {
      const chart = d.charts[this.key];
      if (!chart) return undefined;
      // The drawings mark the old symbol's prices
      if (providerSymbol(target.provider) !== providerSymbol(chart.provider)) delete chart.drawings;
      chart.provider = target.provider;
      chart.history = target.from;
      return d;
    });
  }

  private setState(state: DashboardChartState, message?: string): void {
    this.state = state;
    this.message = message;
    this.session.postView();
  }

  private setScript(id: string, state: ChartCellScript['state'], message?: string): void {
    this.scriptStates.set(id, { state, message });
    this.session.postView();
  }

  /** The chart left the dashboard (or the dashboard closed). */
  dispose(): void {
    this.stop();
  }

  stop(): void {
    this.generation++;
    const runs = this.runs;
    this.runs = [];
    if (!runs.length) return;
    const stop = Promise.all(runs.map(stopRun)).then(() => undefined);
    this.session.provider.trackStop(this.session.outputDir(this.key), stop);
  }

  /** (Re)start the chart on its current config. Until the new history is in,
   * the iframe keeps showing the previous one. */
  async start(): Promise<void> {
    this.stop();
    const generation = this.generation;
    const current = (): boolean => generation === this.generation;
    const config = this.config;
    this.scriptStates.clear();
    this.setState('starting');
    // The new runners write the same output files as the stopped ones, even
    // those of a removed chart or a closed dashboard of the same key
    await this.session.provider.stopped(this.session.outputDir(this.key));
    if (!current()) return;
    const env = await this.session.environment();
    if (!current()) return;
    if (!env) {
      this.setState('error', 'The Python environment is not set up.');
      return;
    }
    const scripts = config.scripts;
    for (const s of scripts) {
      const kind = scriptKindOf(path.resolve(env.workdir, s.path));
      if (kind) this.scriptKinds.set(s.id, kind);
    }
    const composer = new ChartComposer(scripts.map((s) => ({ id: s.id })), {
      emit: (event) => {
        if (!current()) return;
        for (const message of this.stream.apply(event)) {
          if (this.frameReady) this.session.postChart(this.key, message);
        }
      },
      schedule: (callback, ms) => void setTimeout(callback, ms),
    });
    const bridgeRoot = vscode.Uri.joinPath(this.deps.context.extensionUri, 'python').fsPath;
    const output = this.deps.output;
    output.appendLine(`--- Dashboard ${this.session.name}: ${this.key} on ${config.provider}`);

    let baseError: string | undefined;
    let baseErrorKind: string | undefined;
    let scriptsLaunched = false;
    // The candles come from the workdir's shared candle process when it has a provider hub
    const base = await this.deps.candles.start({
      pythonBin: env.pythonBin,
      workdir: env.workdir,
      provider: config.provider,
      from: config.history,
      onEvent: (event) => {
        if (!current()) return;
        switch (event.e) {
          case 'download':
            this.setState('loading', downloadMessage(event));
            break;
          case 'start':
            if (!scriptsLaunched) {
              scriptsLaunched = true;
              const from = new Date(event.range.from).toISOString();
              for (const s of scripts) void this.launchScript(s, env, from, composer, current, bridgeRoot);
            }
            this.setState('loading', scripts.length ? 'Running the scripts' : undefined);
            break;
          case 'feedStatus':
            if (composer.isLive() || event.state === 'reconnecting') {
              this.setState(event.state === 'reconnecting' ? 'reconnecting' : event.state === 'live' ? 'live' : this.state);
            }
            break;
          case 'error':
            baseError = event.code ? `${event.code}: ${event.message}` : event.message;
            baseErrorKind = event.kind;
            if (event.traceback) output.appendLine(event.traceback);
            break;
        }
        composer.base(event);
        if (event.e === 'live' || (event.e === 'bars' && composer.isLive() && this.state !== 'live' &&
          this.state !== 'reconnecting')) {
          if (composer.isLive()) this.setState('live');
        }
      },
      onLog: (line) => output.appendLine(`[${this.key}] ${line}`),
    });
    if (!current()) {
      base.kill();
      return;
    }
    this.runs.push(base);
    const code = await base.exited;
    if (!current()) return;
    if (code !== 0 && !baseError) baseError = `the chart's runner exited with code ${code}`;
    if (baseError) {
      output.appendLine(`Dashboard chart ${this.key} stopped: ${baseError}`);
      this.stop();
      this.setState('error', baseError);
      if (baseErrorKind === LIVE_UNSUPPORTED) {
        const env2 = await this.session.environment();
        if (env2) await offerLiveCoreUpdate(env2.resource);
      }
    } else {
      this.setState('stopped');
    }
  }

  private async launchScript(
    script: DashboardScript,
    env: LiveChartEnv,
    from: string,
    composer: ChartComposer,
    current: () => boolean,
    bridgeRoot: string
  ): Promise<void> {
    const fail = (message: string): void => {
      this.deps.output.appendLine(`[${this.key}/${script.id}] ${message}`);
      composer.slot(script.id, { e: 'error', message, kind: 'DashboardScript', traceback: '' });
      this.setScript(script.id, 'error', message);
    };
    let scriptPath = path.resolve(env.workdir, script.path);
    if (/\.pine$/i.test(scriptPath)) {
      try {
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(scriptPath));
        const compiled = await this.deps.compile.ensureCompiledForRun(doc);
        if (!current()) return;
        if (!compiled) {
          fail(`${script.path} did not compile; see the PyneIDE Compiler output.`);
          return;
        }
        scriptPath = compiled;
      } catch (err) {
        if (current()) fail(err instanceof Error ? err.message : String(err));
        return;
      }
    }
    if (!current()) return;
    const hub = await this.deps.hubs.acquire(env.pythonBin, env.workdir);
    if (!current()) {
      hub.release();
      return;
    }
    let error: string | undefined;
    const run = BridgeRun.start({
      pythonBin: env.pythonBin,
      bridgeRoot,
      workdir: env.workdir,
      script: scriptPath,
      live: {
        provider: this.config.provider,
        from,
        historyTrades: script.tradeOnHistory ?? true,
        outputLimitMB: vscode.workspace.getConfiguration('pyneide.live').get<number>('outputLimitMB', 256),
      },
      inputs: script.inputs,
      settings: script.settings,
      outputDir: this.session.outputDir(this.key),
      outputName: script.id,
      // Several processes may run one script: none may rewrite its settings file
      env: { PYNE_SAVE_SCRIPT_TOML: '0', ...hub.env },
      onEvent: (event: BridgeEvent) => {
        if (!current()) return;
        if (event.e === 'error') {
          error = event.code ? `${event.code}: ${event.message}` : event.message;
          if (event.traceback) this.deps.output.appendLine(event.traceback);
          this.setScript(script.id, 'error', error);
        } else if (event.e === 'start') {
          this.scriptKinds.set(script.id, event.scriptType === 'strategy' ? 'strategy' : 'indicator');
          const title = event.scriptShortTitle?.trim() || event.scriptTitle?.trim();
          if (title) this.scriptTitles.set(script.id, title);
        } else if (event.e === 'live') {
          this.setScript(script.id, 'running');
        }
        composer.slot(script.id, event);
        if (composer.isLive() && this.state === 'loading') this.setState('live');
      },
      onLog: (line) => this.deps.output.appendLine(`[${this.key}/${script.id}] ${line}`),
    });
    this.runs.push(run);
    const code = await run.exited;
    hub.release();
    if (!current()) return;
    if (!error) {
      error = code === 0 ? 'stopped' : `the script's runner exited with code ${code}`;
      composer.slot(script.id, { e: 'end', bars: 0, cancelled: code === 0 });
      this.setScript(script.id, 'error', error);
    }
  }
}

function downloadMessage(event: DownloadEvent): string {
  switch (event.step) {
    case 'symbolInfo':
      return 'Symbol info';
    case 'history': {
      const percent = event.total > 0 ? Math.floor((event.done / event.total) * 100) : 0;
      return `Downloading ${Math.max(0, Math.min(100, percent))}%`;
    }
    case 'retry':
      return `Retry ${event.attempt} in ${Math.round(event.delay)} s`;
  }
}

/** Stop a bridge and wait for it to exit. */
async function stopRun(run: CandleRun): Promise<void> {
  run.cancel();
  const killer = setTimeout(() => run.kill(), STOP_GRACE_MS);
  try {
    await run.exited;
  } finally {
    clearTimeout(killer);
  }
}

function dashboardHtml(
  cspSource: string,
  nonce: string,
  scriptUri: string,
  frameJson: string,
  stateJson: string
): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; script-src ${cspSource} 'nonce-${nonce}'; style-src 'unsafe-inline'; frame-src 'self' about:; img-src ${cspSource} data:;">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  html, body { height: 100%; margin: 0; padding: 0; overflow: hidden; }
  body {
    display: flex; flex-direction: column; font-family: var(--vscode-font-family);
    font-size: 12px; color: var(--vscode-foreground); background: var(--vscode-editor-background);
  }
  button { font: inherit; color: inherit; }
  button:disabled { opacity: 0.4; cursor: default; }
  .primary {
    height: 28px; padding: 0 14px; border: 0; border-radius: 4px; cursor: pointer;
    background: var(--vscode-button-background, #0e639c); color: var(--vscode-button-foreground, #fff);
  }
  .primary:hover { background: var(--vscode-button-hoverBackground, #1177bb); }
  #dash-area { position: relative; flex: 1; min-height: 0; }
  .cell {
    position: absolute; display: flex; flex-direction: column; overflow: hidden;
    border: 1px solid var(--vscode-panel-border, #444); box-sizing: border-box;
  }
  .cell-frame { flex: 1; min-height: 0; width: 100%; border: 0; display: block; }
  /* Below the chart's 36px toolbar */
  .cell-overlay {
    position: absolute; inset: 36px 0 0 0; display: flex; flex-direction: column; gap: 12px;
    align-items: center; justify-content: center; padding: 20px; text-align: center;
    background: var(--vscode-editor-background);
  }
  .cell-overlay[hidden] { display: none; }
  .overlay-message { max-width: 520px; white-space: pre-wrap; color: var(--vscode-errorForeground, #f14c4c); }
  .splitter { position: absolute; z-index: 2; }
  .splitter.horizontal { cursor: col-resize; }
  .splitter.vertical { cursor: row-resize; }
  .splitter:hover, body.dragging .splitter { background: var(--vscode-sash-hoverBorder, #007fd4); }
  body.dragging .cell-frame { pointer-events: none; }
  /* A chart dragged by its grip, and where it would land */
  body.moving-chart { cursor: grabbing; }
  .cell.moving { opacity: 0.55; }
  .drop-indicator {
    position: absolute; z-index: 3; pointer-events: none; box-sizing: border-box;
    background: var(--vscode-editorGroup-dropBackground, rgba(83, 89, 93, 0.5));
    border: 1px solid var(--vscode-focusBorder, #007fd4);
    transition: left 80ms ease-out, top 80ms ease-out, width 80ms ease-out, height 80ms ease-out;
  }
  .drop-indicator[hidden] { display: none; }
  @media (prefers-reduced-motion: reduce) { .drop-indicator { transition: none; } }
  /* A maximized chart fills the area; the others keep their size behind it */
  .cell.behind { visibility: hidden; }
  body.has-maximized .splitter { display: none; }
  body.drag-x { cursor: col-resize; }
  body.drag-y { cursor: row-resize; }
  .placeholder {
    position: absolute; inset: 0; display: flex; flex-direction: column; gap: 14px;
    align-items: center; justify-content: center; text-align: center; padding: 24px;
  }
  .placeholder[hidden] { display: none; }
  .placeholder h2 { margin: 0; font-size: 16px; font-weight: 600; }
  .placeholder p { margin: 0; max-width: 460px; color: var(--vscode-descriptionForeground); line-height: 1.5; }
  .error-message {
    max-width: 90%; overflow: auto; text-align: left; white-space: pre;
    color: var(--vscode-errorForeground, #f14c4c); font-family: var(--vscode-editor-font-family);
  }
</style>
</head>
<body>
<div id="dash-area">
  <div id="dash-empty" class="placeholder" hidden>
    <button id="dash-empty-add" class="primary">Add chart</button>
    <p>Pick a live symbol to start.</p>
  </div>
  <div id="dash-error" class="placeholder" hidden>
    <h2>This file is not a valid dashboard</h2>
    <div class="error-message"></div>
    <button id="dash-error-open" class="primary">Open as text</button>
  </div>
</div>
<script id="chart-frame-html" type="application/json">${frameJson}</script>
<script id="dash-window-state" type="application/json">${stateJson}</script>
<script src="${scriptUri}"></script>
</body>
</html>`;
}
