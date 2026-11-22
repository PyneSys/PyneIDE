/**
 * Live charts without a script: a provider's candles, history then live feed,
 * each in a chart tab of its own, their candles from the {@link CandleServices}.
 * They run beside the one script run slot of the RunService, so a script run
 * never stops them; closing the tab stops the chart.
 */
import * as vscode from 'vscode';

import type { ChartManager } from '../chart/chartPanel';
import type { LivePickRequest } from '../data/symbolBrowserPanel';
import { parseTimeframe } from '../data/timeframes';
import type { CandleRun, CandleServices } from './candleService';
import { LiveDownloadProgress } from './liveDownloadProgress';
import {
  DEFAULT_LIVE_FROM,
  liveChartTitle,
  providerTimeframe,
  withTimeframe,
  type LiveTarget,
} from './liveTarget';

/** Chart keys of live charts without a script start with this. */
const LIVE_CHART_KEY_PREFIX = 'pyneide-live:';

/** The history window the last live chart without a script was opened with. */
const LAST_FROM_KEY = 'pyneide.liveChart.from';

/** How long a stopped live chart's bridge may take to exit before it is killed. */
const STOP_GRACE_MS = 4000;

export interface LiveChartEnv {
  workdir: string;
  pythonBin: string;
  resource: vscode.Uri;
}

export const LIVE_UNSUPPORTED = 'LiveUnsupported';

export async function offerLiveCoreUpdate(resource: vscode.Uri): Promise<void> {
  const choice = await vscode.window.showWarningMessage(
    'PyneIDE: the installed PyneCore does not support live charts. Update PyneCore and try again.',
    'Update PyneCore'
  );
  if (choice === 'Update PyneCore') {
    await vscode.commands.executeCommand('pyneide.updatePyneCore', resource);
  }
}

/** Picks a live chart's symbol, timeframe and history in the Symbol Browser. */
export type PickLiveTarget = (
  request: LivePickRequest,
  env: LiveChartEnv
) => Promise<LiveTarget | undefined>;

interface LiveChart {
  target: LiveTarget;
  env: LiveChartEnv;
  run: CandleRun | undefined;
}

/** Whether a chart key is a live chart without a script. */
export function isLiveChartKey(chartKey: string): boolean {
  return chartKey.startsWith(LIVE_CHART_KEY_PREFIX);
}

export class LiveChartService implements vscode.Disposable {
  private readonly charts = new Map<string, LiveChart>();
  /** The number of each tab's latest launch. */
  private readonly launches = new Map<string, number>();
  /** Python environments whose charts wait for a PyneCore update to end. */
  private readonly paused = new Set<string>();
  private nextId = 1;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly chartManager: ChartManager,
    private readonly output: vscode.OutputChannel,
    private readonly resolveEnv: () => Promise<LiveChartEnv | undefined>,
    private readonly pickLive: PickLiveTarget,
    private readonly candles: CandleServices
  ) {}

  register(): void {
    this.context.subscriptions.push(
      vscode.commands.registerCommand('pyneide.openLiveChart', () => this.open()),
      this
    );
  }

  /** Pick a symbol in the Symbol Browser and open its live chart. */
  async open(): Promise<void> {
    const env = await this.resolveEnv();
    if (!env) return;
    const target = await this.pickLive(this.pickRequest(this.lastFrom()), env);
    if (target) await this.openTarget(target, env);
  }

  /** Open a live chart of a provider string on the last history window (the
   * Symbol Browser's Live chart button). */
  async openProvider(provider: string, env: LiveChartEnv): Promise<void> {
    await this.openTarget({ provider, from: this.lastFrom(), historyTrades: false }, env);
  }

  /** Open a live chart of a picked target in a new tab. */
  async openTarget(target: LiveTarget, env: LiveChartEnv): Promise<void> {
    const chartKey = `${LIVE_CHART_KEY_PREFIX}${this.nextId++}`;
    this.charts.set(chartKey, { target, env, run: undefined });
    await this.context.globalState.update(LAST_FROM_KEY, target.from);
    this.chartManager.openLiveChart(chartKey, liveChartTitle(target.provider));
    await this.launch(chartKey);
  }

  /** The chart's Data button: pick another symbol for the same tab. */
  async reselect(chartKey: string): Promise<void> {
    const chart = this.charts.get(chartKey);
    if (!chart) return;
    const target = await this.pickLive(this.pickRequest(chart.target.from), chart.env);
    if (!target || this.charts.get(chartKey) !== chart) return;
    chart.target = target;
    await this.context.globalState.update(LAST_FROM_KEY, target.from);
    await this.launch(chartKey);
  }

  /** The toolbar's timeframe pick; without one, ask for a custom timeframe. */
  async setTimeframe(chartKey: string, timeframe: string | undefined): Promise<void> {
    const chart = this.charts.get(chartKey);
    if (!chart) return;
    const picked = timeframe ?? (await askTimeframe(providerTimeframe(chart.target.provider)));
    if (!picked || this.charts.get(chartKey) !== chart) return;
    chart.target = { ...chart.target, provider: withTimeframe(chart.target.provider, picked) };
    await this.launch(chartKey);
  }

  /** The chart's tab was closed: stop its run. */
  onChartClosed(chartKey: string): void {
    const chart = this.charts.get(chartKey);
    if (!chart) return;
    this.charts.delete(chartKey);
    this.launches.delete(chartKey);
    // Detached first: the stopping run's trailing events must not reopen the tab
    const run = chart.run;
    chart.run = undefined;
    if (run) void stopRun(run);
  }

  /** The number of open live charts whose candles come from `pythonBin`. */
  countOn(pythonBin: string): number {
    return [...this.charts.values()].filter((chart) => chart.env.pythonBin === pythonBin).length;
  }

  /**
   * Stops the live charts of `pythonBin` for a PyneCore update. Their tabs stay
   * open and start no run until the returned callback starts them again.
   */
  async pauseForCoreUpdate(pythonBin: string): Promise<() => void> {
    this.paused.add(pythonBin);
    const stopping: Promise<void>[] = [];
    for (const [chartKey, chart] of this.charts) {
      if (chart.env.pythonBin !== pythonBin) continue;
      // A launch still starting its candles drops them when it sees a newer launch
      this.launches.set(chartKey, (this.launches.get(chartKey) ?? 0) + 1);
      if (!chart.run) continue;
      // Detached first, as on a restart: the stopped run must not close the tab
      const run = chart.run;
      chart.run = undefined;
      this.chartManager.onEvent({ e: 'end', bars: 0, cancelled: true }, chartKey);
      stopping.push(stopRun(run));
    }
    await Promise.all(stopping);
    return () => {
      this.paused.delete(pythonBin);
      for (const [chartKey, chart] of this.charts) {
        if (chart.env.pythonBin === pythonBin && !chart.run) void this.launch(chartKey);
      }
    };
  }

  dispose(): void {
    for (const chart of this.charts.values()) {
      const run = chart.run;
      chart.run = undefined;
      run?.kill();
    }
    this.charts.clear();
  }

  private pickRequest(from: string): LivePickRequest {
    return { scriptName: '', strategy: false, from, historyTrades: false };
  }

  private lastFrom(): string {
    return this.context.globalState.get<string>(LAST_FROM_KEY) ?? DEFAULT_LIVE_FROM;
  }

  /** (Re)start the chart's run on its current target. Until the new history
   * arrives, the tab keeps the previous target's candles and title. */
  private async launch(chartKey: string): Promise<void> {
    const chart = this.charts.get(chartKey);
    if (!chart) return;
    const previous = chart.run;
    chart.run = undefined;
    if (previous) {
      // The detached run's own `end` is dropped: end its chart here, so the
      // candles it leaves behind stop claiming LIVE while the new one downloads
      this.chartManager.onEvent({ e: 'end', bars: 0, cancelled: true }, chartKey);
      await stopRun(previous);
    }
    if (this.charts.get(chartKey) !== chart || chart.run) return;
    // A PyneCore update is running: the chart starts on the new one after it
    if (this.paused.has(chart.env.pythonBin)) return;
    const launch = (this.launches.get(chartKey) ?? 0) + 1;
    this.launches.set(chartKey, launch);

    const target = chart.target;
    this.output.appendLine(`--- Live chart: ${target.provider} (workdir: ${chart.env.workdir})`);
    let started = false;
    let error: string | undefined;
    let errorKind: string | undefined;
    let run: CandleRun | undefined;
    // A restart or a closed tab already stops a superseded run
    const download = new LiveDownloadProgress(`PyneIDE: live chart of ${target.provider}`, () => {
      if (run && chart.run === run) void stopRun(run);
    });
    const candles = await this.candles.start({
      pythonBin: chart.env.pythonBin,
      workdir: chart.env.workdir,
      provider: target.provider,
      from: target.from,
      onEvent: (event) => {
        // A restart may have superseded this run, or its tab was closed: its
        // trailing events must not land on the chart the new one is drawing,
        // nor reopen a closed one
        if (!run || chart.run !== run || this.charts.get(chartKey) !== chart) return;
        switch (event.e) {
          case 'download':
            download.update(event);
            break;
          case 'start':
            started = true;
            download.close();
            // The tab names the target whose candles it now draws
            this.chartManager.openLiveChart(chartKey, liveChartTitle(target.provider));
            break;
          case 'error':
            error = event.code ? `${event.code}: ${event.message}` : event.message;
            errorKind = event.kind;
            if (event.traceback) this.output.appendLine(event.traceback);
            break;
        }
        this.chartManager.onEvent(event, chartKey);
      },
      onLog: (line) => this.output.appendLine(line),
    });
    // A later launch of the tab, or its close, came while the candles started
    if (this.charts.get(chartKey) !== chart || this.launches.get(chartKey) !== launch || chart.run) {
      candles.kill();
      download.close();
      return;
    }
    run = candles;
    chart.run = run;

    const code = await run.exited;
    download.close();
    if (chart.run !== run) return;
    chart.run = undefined;
    if (code !== 0 && !error) error = `the live chart's runner exited with code ${code}`;
    if ((!started || error) && this.charts.get(chartKey) === chart) {
      // Nothing to show when no history arrived (an error, or the download was
      // cancelled); a run that failed later closes its chart like a script's
      // live chart does, or its last feed state would claim LIVE over frozen prices
      this.charts.delete(chartKey);
      this.chartManager.closeChart(chartKey);
    }
    if (error) {
      this.output.appendLine(`Live chart of ${target.provider} stopped: ${error}`);
      if (errorKind === LIVE_UNSUPPORTED) {
        await offerLiveCoreUpdate(chart.env.resource);
      } else {
        void vscode.window.showErrorMessage(`PyneIDE: live chart of ${target.provider}: ${error}`);
      }
    }
  }
}

/** Stop a live chart's bridge and wait for it to exit. */
async function stopRun(run: CandleRun): Promise<void> {
  run.cancel();
  const killer = setTimeout(() => run.kill(), STOP_GRACE_MS);
  try {
    await run.exited;
  } finally {
    clearTimeout(killer);
  }
}

/** Ask for a timeframe that is not one of the presets. */
export async function askTimeframe(current: string | undefined): Promise<string | undefined> {
  const text = await vscode.window.showInputBox({
    title: 'Live chart timeframe',
    prompt: 'A TradingView timeframe: minutes (3, 90), or a number with D, W or M (2D, 3M)',
    value: current,
    validateInput: (value) => (parseTimeframe(value) ? undefined : 'Not a timeframe'),
  });
  return text === undefined ? undefined : parseTimeframe(text);
}
