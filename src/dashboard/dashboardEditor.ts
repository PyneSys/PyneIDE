/**
 * The dashboard editor: a custom editor of `dashboards/*.toml` that shows the
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
import type { ChartManager } from '../chart/chartPanel';
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
  insertBeside,
  MAX_CHARTS,
  parseDashboard,
  removeFromLayout,
  resizeSplit,
  scriptIdFor,
  scriptLimitReason,
  serializeDashboard,
  type Dashboard,
  type DashboardChart,
  type DashboardScript,
  type ScriptKind,
  type SplitDirection,
} from './model';
import { listDashboardScripts, scriptKindOf } from './scripts';

/** How long a stopped bridge may take to exit before it is killed. */
const STOP_GRACE_MS = 4000;

/** Chart keys of the chart tabs that mirror a dashboard chart start with this. */
const MIRROR_KEY_PREFIX = 'pyneide-dashboard:';

/** Whether a chart key is a chart tab mirroring a dashboard chart. */
export function isDashboardMirrorKey(chartKey: string): boolean {
  return chartKey.startsWith(MIRROR_KEY_PREFIX);
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
  chartManager: ChartManager;
  hubs: ProviderHubs;
  candles: CandleServices;
}

export class DashboardEditorProvider implements vscode.CustomTextEditorProvider {
  static readonly viewType = 'pyneide.dashboard';
  private readonly sessions = new Set<DashboardSession>();
  /** Chart tabs mirroring a dashboard chart, by their chart key. */
  private readonly mirrors = new Map<string, ChartRun>();
  private nextMirror = 1;
  /**
   * Chart runners still stopping, by output directory. They outlive their
   * chart and its dashboard tab: a chart removed and added again, or a
   * dashboard closed and opened again, starts on the same output files.
   */
  private readonly stopping = new Map<string, Promise<void>>();

  constructor(private readonly deps: DashboardDeps) {}

  /** A chart tab key for a dashboard chart's mirror. */
  mirrorKey(run: ChartRun): string {
    const key = `${MIRROR_KEY_PREFIX}${this.nextMirror++}`;
    this.mirrors.set(key, run);
    return key;
  }

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

  /** The mirror's tab closed (or its chart went away). */
  onMirrorClosed(chartKey: string): void {
    this.mirrors.get(chartKey)?.detachMirror(chartKey);
    this.mirrors.delete(chartKey);
  }

  onMirrorSelectTimeframe(chartKey: string, timeframe: string | undefined): void {
    this.mirrors.get(chartKey)?.changeTimeframe(timeframe).catch(reportEditError);
  }

  onMirrorSelectData(chartKey: string): void {
    this.mirrors.get(chartKey)?.changeSymbol().catch(reportEditError);
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
      vscode.commands.registerCommand('pyneide.dashboardAddChart', () =>
        this.activeSession()?.addChart(undefined, undefined).catch(reportEditError)),
      vscode.commands.registerCommand('pyneide.dashboardOpenText', () =>
        this.activeSession()?.openText()),
      { dispose: () => { for (const session of this.sessions) session.dispose(); } }
    );
  }

  /** The dashboard of the active editor tab. */
  private activeSession(): DashboardSession | undefined {
    return [...this.sessions].find((session) => session.active);
  }

  resolveCustomTextEditor(document: vscode.TextDocument, panel: vscode.WebviewPanel): void {
    const session = new DashboardSession(this.deps, this, document, panel);
    this.sessions.add(session);
    panel.onDidDispose(() => {
      this.sessions.delete(session);
      session.dispose();
    });
  }
}

/** Show why a dashboard edit was not made. */
function reportEditError(err: unknown): void {
  void vscode.window.showWarningMessage(`PyneIDE: ${err instanceof Error ? err.message : String(err)}`);
}

/** A dashboard's name from its file name: `btc-scalping.toml` -> `btc-scalping`. */
function fileStem(uri: vscode.Uri): string {
  return path.basename(uri.fsPath).replace(/\.toml$/i, '');
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

class DashboardSession {
  private dashboard: Dashboard | undefined;
  private error: string | undefined;
  private readonly charts = new Map<string, ChartRun>();
  private ready = false;
  private disposed = false;
  private env: Promise<LiveChartEnv | undefined> | undefined;
  /** Edits are applied one after the other, each on the file the last one left. */
  private editQueue: Promise<void> = Promise.resolve();
  private readonly subscriptions: vscode.Disposable[] = [];

  constructor(
    private readonly deps: DashboardDeps,
    readonly provider: DashboardEditorProvider,
    private readonly document: vscode.TextDocument,
    private readonly panel: vscode.WebviewPanel
  ) {
    const distRoot = vscode.Uri.joinPath(deps.context.extensionUri, 'dist');
    panel.webview.options = { enableScripts: true, localResourceRoots: [distRoot] };
    const icons = vscode.Uri.joinPath(deps.context.extensionUri, 'icons');
    panel.iconPath = {
      light: vscode.Uri.joinPath(icons, 'dashboard-light.svg'),
      dark: vscode.Uri.joinPath(icons, 'dashboard-dark.svg'),
    };
    panel.webview.html = this.html(panel.webview, distRoot);
    this.subscriptions.push(
      panel.webview.onDidReceiveMessage((msg: DashboardOutMessage) => void this.onMessage(msg).catch(reportEditError)),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document === document && e.contentChanges.length) this.sync();
      })
    );
    this.sync();
  }

  /** The dashboard's tab is the active editor. */
  get active(): boolean {
    return !this.disposed && this.panel.active;
  }

  openText(): Thenable<unknown> {
    return vscode.commands.executeCommand('vscode.openWith', this.document.uri, 'default');
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const chart of this.charts.values()) chart.dispose();
    this.charts.clear();
    for (const s of this.subscriptions) s.dispose();
  }

  get name(): string {
    return this.dashboard?.name ?? fileStem(this.document.uri);
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

  /** The file changed (or was opened): start, restart and stop its charts. */
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
    const charts = this.dashboard.charts;
    for (const [key, run] of [...this.charts]) {
      if (!charts[key]) {
        run.dispose();
        this.charts.delete(key);
      }
    }
    for (const [key, chart] of Object.entries(charts)) {
      const run = this.charts.get(key);
      if (!run) {
        const next = new ChartRun(this.deps, this, key, chart);
        this.charts.set(key, next);
        void next.start();
      } else if (chartSignature(run.config) !== chartSignature(chart)) {
        run.config = chart;
        void run.start();
      } else {
        run.config = chart;
      }
    }
    this.postView();
  }

  postView(): void {
    if (!this.ready || this.disposed) return;
    const view: DashboardView = this.error !== undefined || !this.dashboard
      ? { name: fileStem(this.document.uri), layout: undefined, charts: {}, error: this.error }
      : {
          name: this.name,
          layout: this.dashboard.layout,
          charts: Object.fromEntries([...this.charts].map(([key, run]) => [key, run.view()])),
        };
    void this.panel.webview.postMessage({ type: 'view', view } satisfies DashboardInMessage);
    for (const run of this.charts.values()) run.postCell();
  }

  /** Why no chart can join the dashboard, when none can. */
  addChartBlocked(): string | undefined {
    return this.dashboard && Object.keys(this.dashboard.charts).length >= MAX_CHARTS
      ? `A dashboard holds at most ${MAX_CHARTS} charts.`
      : undefined;
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
      case 'openFullChart':
        this.charts.get(key)?.openMirror();
        break;
      case 'removeChart':
        await this.edit((d) => {
          delete d.charts[key];
          d.layout = removeFromLayout(d.layout, key);
          return d;
        });
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
    void this.panel.webview.postMessage({ type: 'chart', key, message } satisfies DashboardInMessage);
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

  private async onMessage(msg: DashboardOutMessage): Promise<void> {
    switch (msg.type) {
      case 'ready':
        this.ready = true;
        this.postView();
        break;
      case 'frame':
        this.charts.get(msg.key)?.onFrameMessage(msg.message);
        break;
      case 'openText':
        await this.openText();
        break;
      case 'addChart':
        await this.addChart(undefined, undefined);
        break;
      case 'resize':
        await this.edit((d) => ({ ...d, layout: resizeSplit(d.layout, msg.path, msg.sizes) }));
        break;
      case 'restartChart':
        void this.charts.get(msg.key)?.start();
        break;
    }
  }

  async addChart(beside: string | undefined, direction: SplitDirection | undefined): Promise<void> {
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
      const key = chartKeyFor(target.provider, Object.keys(d.charts));
      d.charts[key] = { provider: target.provider, history: target.from, scripts: [] };
      d.layout = insertBeside(d.layout, beside, key, direction ?? 'horizontal');
      return d;
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

  private html(webview: vscode.Webview, distRoot: vscode.Uri): string {
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
    return dashboardHtml(webview.cspSource, nonce, asset('dashboard-webview.js'), frameJson);
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
  /** The chart tab mirroring this chart, while one is open. */
  private mirror: string | undefined;

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

  /** Open (or reveal) a chart tab that mirrors this chart: the whole chart page,
   * with a strategy's trades, performance and stats under it. */
  openMirror(): void {
    const manager = this.deps.chartManager;
    const title = `${this.session.name} · ${this.key}`;
    if (this.mirror) {
      manager.openLiveChart(this.mirror, title);
      return;
    }
    const chartKey = this.session.provider.mirrorKey(this);
    this.mirror = chartKey;
    manager.openLiveChart(chartKey, title);
    if (this.stream.snap) manager.loadSnapshot(chartKey, this.stream.snap);
  }

  detachMirror(chartKey: string): void {
    if (this.mirror === chartKey) this.mirror = undefined;
  }

  private closeMirror(): void {
    const chartKey = this.mirror;
    if (!chartKey) return;
    this.mirror = undefined;
    this.deps.chartManager.closeChart(chartKey);
    this.session.provider.onMirrorClosed(chartKey);
  }

  pushChartSettings(): void {
    if (!this.frameReady) return;
    this.session.postChart(this.key, { type: 'candleStyle', style: readCandleStyle() });
    this.session.postChart(this.key, { type: 'priceScale', scale: readPriceScale() });
    this.session.postChart(this.key, { type: 'colorScheme', scheme: readColorScheme() });
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
    this.closeMirror();
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
        if (this.mirror) this.deps.chartManager.onEvent(event, this.mirror);
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

function dashboardHtml(cspSource: string, nonce: string, scriptUri: string, frameJson: string): string {
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
<script src="${scriptUri}"></script>
</body>
</html>`;
}
