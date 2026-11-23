/**
 * The candles of live charts without a script. With a provider hub, all such
 * charts of a Python environment and workdir share one bridge process
 * (`pyneide_bridge --candle-service`), a client of the hub: each chart is a
 * thread of it, not a process. Without a hub, or when that process cannot
 * start, a chart runs a bridge of its own (`--live --data-only`), as a script
 * does.
 *
 * The shared process starts with the first chart and ends a while after the
 * last one. It holds the hub for as long as it runs. When it dies, its charts
 * move to a new one and go on from their last bar; one that keeps dying leaves
 * them to bridges of their own.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import * as path from 'node:path';

import { trackInterpreter } from '../env/usage';
import { BridgeRun, type BridgeEvent } from './bridgeClient';
import type { HubLease, ProviderHubs } from './providerHub';

/** How long the shared process stays up without a chart. */
export const CANDLES_LINGER_MS = 10_000;

/** How long the shared process may take to accept charts. */
export const CANDLES_START_TIMEOUT_MS = 30_000;

/** A dying shared process is started again at most this many times within the window. */
const MAX_RESTARTS = 3;
export const CANDLES_RESTART_WINDOW_MS = 60_000;

/** How long a stopped process may take to exit before it is killed. */
const STOP_GRACE_MS = 4000;

/** A running stream of candles: the part of a bridge run a chart handles. */
export interface CandleRun {
  /** Resolves with the exit code when the stream is over (null when killed). */
  readonly exited: Promise<number | null>;
  /** Graceful stop: the stream sends its `end` event. */
  cancel(): void;
  /** Stops at once; no further event arrives. */
  kill(): void;
}

export interface CandleRunOptions {
  /** Python interpreter of the (managed) venv with pynecore installed. */
  pythonBin: string;
  /** Resolved pyne workdir. */
  workdir: string;
  /** The provider string, with the timeframe. */
  provider: string;
  /** History start (date, days or -N bars). */
  from?: string;
  onEvent: (event: BridgeEvent) => void;
  /** stderr lines of a bridge of the chart's own; the shared process logs to the services' log. */
  onLog?: (line: string) => void;
}

/** What streams a chart's candles at the moment: a shared process or a bridge. */
interface Source {
  cancel(): void;
  kill(): void;
}

/**
 * The candles of one chart, across the processes that stream them. A process
 * that takes the chart over streams from the chart's last bar on, and the
 * chart gets what it has not seen: no second `hello`, `start` or `live`, no bar older
 * than its last one.
 */
class ChartCandles implements CandleRun {
  readonly exited: Promise<number | null>;
  private resolve: (code: number | null) => void = () => undefined;
  private source: Source | undefined;
  private started = false;
  private live = false;
  /** Times of the chart's last bar and of the one before it, -1 without one. */
  private lastTime = -1;
  private previousTime = -1;
  /** A cancel or a kill was asked for. */
  stopped = false;
  /** The stream is over. */
  done = false;

  constructor(readonly opts: CandleRunOptions) {
    this.exited = new Promise<number | null>((resolve) => (this.resolve = resolve));
  }

  /**
   * The history start for a process that takes the chart over: the bar before
   * the chart's last one, which has closed, so the history is never empty.
   */
  get from(): string | undefined {
    const time = this.previousTime >= 0 ? this.previousTime : this.lastTime;
    return time >= 0 ? new Date(time).toISOString() : this.opts.from;
  }

  /** The chart's candles now come from `source`. */
  attach(source: Source): void {
    this.source = source;
  }

  /** The chart's process is gone; another one may take the chart over. */
  detach(): void {
    this.source = undefined;
    if (this.live) {
      this.opts.onEvent({
        e: 'feedStatus', state: 'reconnecting', attempt: 1, offlineSeconds: 0, error: 'the candle process ended',
      });
    }
  }

  deliver(event: BridgeEvent): void {
    if (this.done) return;
    switch (event.e) {
      case 'hello':
        if (this.started) return;
        break;
      case 'start':
        if (this.started) return;
        this.started = true;
        break;
      case 'bars': {
        const rows = event.d.filter((row) => row[0] >= this.lastTime);
        if (!rows.length) return;
        for (const row of rows) {
          if (row[0] === this.lastTime) continue;
          this.previousTime = this.lastTime;
          this.lastTime = row[0];
        }
        this.opts.onEvent(rows.length === event.d.length ? event : { ...event, d: rows });
        return;
      }
      case 'live':
        if (this.live) {
          // The chart is live already: it only learns that its feed is back
          this.opts.onEvent({ e: 'feedStatus', state: 'live', attempt: 0, offlineSeconds: null, error: null });
          return;
        }
        this.live = true;
        break;
      case 'download':
      case 'progress':
        // The history a live chart's new process loads is not the chart's
        if (this.live) return;
        break;
    }
    this.opts.onEvent(event);
  }

  /** The stream is over. */
  exit(code: number | null): void {
    if (this.done) return;
    this.done = true;
    this.source = undefined;
    this.resolve(code);
  }

  cancel(): void {
    if (this.done) return;
    this.stopped = true;
    if (this.source) {
      this.source.cancel();
      return;
    }
    // Between two processes: nothing streams, so nothing else would end it
    this.opts.onEvent({ e: 'end', bars: 0, cancelled: true });
    this.exit(0);
  }

  kill(): void {
    if (this.done) return;
    this.stopped = true;
    const source = this.source;
    this.exit(null);
    source?.kill();
  }
}

/** One shared candle process. */
class CandleProcess {
  private readonly charts = new Map<number, ChartCandles>();
  private nextChart = 1;
  private linger: ReturnType<typeof setTimeout> | undefined;
  private readonly child: ChildProcessWithoutNullStreams;
  private ended = false;
  /** The process was asked to end. */
  private ending = false;
  /** Resolves with whether the process accepts charts. */
  readonly ready: Promise<boolean>;
  /** Resolves when the process is gone. */
  readonly closed: Promise<void>;

  constructor(
    readonly pythonBin: string,
    private readonly workdir: string,
    bridgeRoot: string,
    lease: HubLease,
    private readonly log: (line: string) => void,
    private readonly lingerMs: number,
    startTimeoutMs: number,
    onClosed: () => void,
    onLost: (charts: ChartCandles[], code: number | null) => void
  ) {
    const child = spawn(
      pythonBin,
      ['-X', 'utf8', '-m', 'pyneide_bridge', '--candle-service', '--workdir', workdir],
      {
        cwd: workdir,
        env: {
          ...process.env,
          PYTHONPATH: process.env.PYTHONPATH ? `${bridgeRoot}${path.delimiter}${process.env.PYTHONPATH}` : bridgeRoot,
          PYNE_WORK_DIR: workdir,
          PYTHONUNBUFFERED: '1',
          PYNE_NO_COLOR_LOG: '1',
          ...lease.env,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      }
    );
    trackInterpreter(child, pythonBin);
    this.child = child;

    let accept: (ready: boolean) => void = () => undefined;
    this.ready = new Promise<boolean>((resolve) => (accept = resolve));
    const startTimer = setTimeout(() => {
      this.log(`[candles] the candle process did not start within ${Math.round(startTimeoutMs / 1000)} s`);
      accept(false);
      this.end();
    }, startTimeoutMs);
    void this.ready.then(() => clearTimeout(startTimer));

    lines(child.stdout, (line) => {
      let event: { e?: string; chart?: number; code?: number } & Record<string, unknown>;
      try {
        event = JSON.parse(line) as typeof event;
      } catch {
        this.log(`[candles] unparseable event: ${line.slice(0, 200)}`);
        return;
      }
      if (event.e === 'candles') {
        accept(true);
        return;
      }
      if (typeof event.chart !== 'number') {
        // The process's own failure: its charts end with its exit code
        if (event.e === 'error') this.log(`[candles] ${String(event.message)}\n${String(event.traceback ?? '')}`);
        return;
      }
      const chart = this.charts.get(event.chart);
      if (!chart) return;
      if (event.e === 'exit') {
        this.charts.delete(event.chart);
        chart.exit(typeof event.code === 'number' ? event.code : 1);
        this.idle();
        return;
      }
      const { chart: _chart, ...rest } = event;
      const bridgeEvent = rest as unknown as BridgeEvent;
      chart.deliver(bridgeEvent.e === 'start' ? { ...bridgeEvent, workdir: this.workdir } : bridgeEvent);
    });
    lines(child.stderr, (line) => {
      if (line.trim()) this.log(line);
    });
    child.on('error', (err) => this.log(`[candles] spawn failed: ${err.message}`));
    this.closed = new Promise<void>((resolve) => {
      child.on('close', (code) => {
        this.ended = true;
        if (this.linger) clearTimeout(this.linger);
        this.linger = undefined;
        accept(false);
        lease.release();
        onClosed();
        const charts = [...this.charts.values()];
        this.charts.clear();
        // A chart whose `exit` never came ends as a crashed bridge does, unless
        // the process died under it: then another one may take it over
        const failure = code === 0 ? 1 : code;
        const lost = this.ending ? [] : charts.filter((chart) => !chart.stopped);
        for (const chart of charts) if (!lost.includes(chart)) chart.exit(failure);
        if (lost.length) onLost(lost, failure);
        resolve();
      });
    });
  }

  get chartCount(): number {
    return this.charts.size;
  }

  /** Whether charts can still be opened in the process. */
  get usable(): boolean {
    return !this.ended && this.child.stdin.writable;
  }

  /** Streams a chart's candles, from its last bar on when it had a process before. */
  open(chart: ChartCandles): void {
    const id = this.nextChart++;
    if (this.linger) clearTimeout(this.linger);
    this.linger = undefined;
    this.charts.set(id, chart);
    chart.attach({
      cancel: () => this.write({ cmd: 'close', chart: id }),
      kill: () => {
        if (!this.charts.delete(id)) return;
        this.write({ cmd: 'close', chart: id });
        this.idle();
      },
    });
    this.write({ cmd: 'open', chart: id, provider: chart.opts.provider, from: chart.from });
  }

  /** Ends the process; its charts end with it. */
  end(): void {
    if (this.ended) return;
    this.ended = true;
    this.ending = true;
    if (this.linger) clearTimeout(this.linger);
    this.linger = undefined;
    const child = this.child;
    if (child.exitCode !== null || child.signalCode !== null) return;
    // The process runs until its standard input closes
    child.stdin.end();
    const killer = setTimeout(() => child.kill('SIGKILL'), STOP_GRACE_MS);
    child.once('close', () => clearTimeout(killer));
  }

  private idle(): void {
    if (this.charts.size || this.ended || this.linger) return;
    this.linger = setTimeout(() => {
      this.linger = undefined;
      if (!this.charts.size) this.end();
    }, this.lingerMs);
  }

  private write(message: object): void {
    if (this.child.stdin.writable) this.child.stdin.write(JSON.stringify(message) + '\n');
  }
}

/** Calls `onLine` with every complete line of a stream. */
function lines(stream: NodeJS.ReadableStream, onLine: (line: string) => void): void {
  let buffer = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk: string) => {
    buffer += chunk;
    let nl: number;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line) onLine(line);
    }
  });
}

export class CandleServices {
  private readonly processes = new Map<string, Promise<CandleProcess | undefined>>();
  /** Environments and workdirs whose shared process could not start. */
  private readonly failed = new Set<string>();
  /** When the shared process of an environment and workdir was started again. */
  private readonly restarts = new Map<string, number[]>();
  private disposed = false;

  /**
   * @param hubs The provider hubs the shared processes are clients of.
   * @param bridgeRoot Directory that contains the `pyneide_bridge` package.
   * @param log Receives the shared processes' log lines.
   * @param lingerMs How long a shared process without a chart stays up.
   * @param startTimeoutMs How long a shared process may take to accept charts.
   * @param restartWindowMs The window a dying shared process is started again at most three times in.
   */
  constructor(
    private readonly hubs: ProviderHubs,
    private readonly bridgeRoot: string,
    private readonly log: (line: string) => void,
    private readonly lingerMs = CANDLES_LINGER_MS,
    private readonly startTimeoutMs = CANDLES_START_TIMEOUT_MS,
    private readonly restartWindowMs = CANDLES_RESTART_WINDOW_MS
  ) {}

  /** Starts the candles of a live chart without a script. */
  async start(opts: CandleRunOptions): Promise<CandleRun> {
    const chart = new ChartCandles(opts);
    await this.stream(chart);
    return chart;
  }

  /** Gives the chart a process: the shared one, or a bridge of its own. */
  private async stream(chart: ChartCandles): Promise<void> {
    const { pythonBin, workdir } = chart.opts;
    const key = `${pythonBin}\0${workdir}`;
    // A process that ended between its lookup and the open is replaced once
    for (let attempt = 0; attempt < 2 && !this.failed.has(key) && !this.disposed; attempt++) {
      const shared = await this.process(key, pythonBin, workdir);
      if (!shared) break;
      if (chart.done) return;
      if (shared.usable) {
        shared.open(chart);
        return;
      }
      await shared.closed;
    }
    if (!chart.done) await this.own(chart);
  }

  /** The shared process died under its charts: they go on in another process. */
  private recover(key: string, charts: ChartCandles[], code: number | null): void {
    if (this.disposed) {
      for (const chart of charts) chart.exit(code);
      return;
    }
    const now = Date.now();
    const restarts = (this.restarts.get(key) ?? []).filter((at) => now - at <= this.restartWindowMs);
    if (restarts.length >= MAX_RESTARTS) {
      if (!this.failed.has(key)) {
        this.failed.add(key);
        this.log(
          `[candles] the candle process ended ${MAX_RESTARTS + 1} times within ${this.restartWindowMs / 1000} s: ` +
          'live charts without a script run a process each'
        );
      }
    } else {
      restarts.push(now);
      this.log(`[candles] the candle process ended (code ${code}); starting it again for ${charts.length} chart(s)`);
    }
    this.restarts.set(key, restarts);
    for (const chart of charts) {
      chart.detach();
      void this.stream(chart).catch((err: unknown) => {
        this.log(`[candles] a chart could not go on: ${err instanceof Error ? err.message : String(err)}`);
        chart.exit(code);
      });
    }
  }

  /**
   * Ends the shared processes of a Python environment that have no chart,
   * without their linger; resolves when they are gone. For a package update,
   * which must not find the environment's files in use.
   */
  async endIdle(pythonBin: string): Promise<void> {
    const processes = await Promise.all([...this.processes.values()]);
    await Promise.all(
      processes
        .filter((shared): shared is CandleProcess => !!shared && shared.pythonBin === pythonBin && !shared.chartCount)
        .map((shared) => {
          shared.end();
          return shared.closed;
        })
    );
  }

  /** The Python environments may have changed: try the shared process again. */
  forgetFailed(): void {
    this.failed.clear();
  }

  dispose(): void {
    this.disposed = true;
    for (const pending of this.processes.values()) void pending.then((shared) => shared?.end());
    this.processes.clear();
  }

  private process(key: string, pythonBin: string, workdir: string): Promise<CandleProcess | undefined> {
    let pending = this.processes.get(key);
    if (!pending) {
      const created: Promise<CandleProcess | undefined> = this.spawn(key, pythonBin, workdir, () => {
        if (this.processes.get(key) === created) this.processes.delete(key);
      }, (charts, code) => this.recover(key, charts, code));
      pending = created;
      this.processes.set(key, pending);
      void created.then((shared) => {
        if (!shared && this.processes.get(key) === created) this.processes.delete(key);
      });
    }
    return pending;
  }

  private async spawn(
    key: string,
    pythonBin: string,
    workdir: string,
    onClosed: () => void,
    onLost: (charts: ChartCandles[], code: number | null) => void
  ): Promise<CandleProcess | undefined> {
    const lease = await this.hubs.acquire(pythonBin, workdir);
    // Without a hub every chart would build its provider in the one process
    if (!Object.keys(lease.env).length || this.disposed) {
      lease.release();
      return undefined;
    }
    const shared = new CandleProcess(
      pythonBin, workdir, this.bridgeRoot, lease, this.log, this.lingerMs, this.startTimeoutMs, onClosed, onLost
    );
    if (await shared.ready) {
      if (this.disposed) shared.end();
      return shared;
    }
    this.failed.add(key);
    this.log('[candles] the candle process did not start: live charts without a script run a process each');
    shared.end();
    return undefined;
  }

  /** A bridge of the chart's own. */
  private async own(chart: ChartCandles): Promise<void> {
    const opts = chart.opts;
    const lease = await this.hubs.acquire(opts.pythonBin, opts.workdir);
    if (chart.done || this.disposed) {
      lease.release();
      chart.exit(null);
      return;
    }
    const run = BridgeRun.start({
      pythonBin: opts.pythonBin,
      bridgeRoot: this.bridgeRoot,
      workdir: opts.workdir,
      dataOnly: true,
      live: { provider: opts.provider, from: chart.from },
      env: lease.env,
      onEvent: (event) => chart.deliver(event),
      onLog: opts.onLog,
    });
    chart.attach(run);
    void run.exited.then((code) => {
      lease.release();
      chart.exit(code);
    });
  }
}
