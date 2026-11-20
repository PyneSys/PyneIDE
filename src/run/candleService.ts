/**
 * The candles of live charts without a script. With a provider hub, all such
 * charts of a Python environment and workdir share one bridge process
 * (`pyneide_bridge --candle-service`), a client of the hub: each chart is a
 * thread of it, not a process. Without a hub, or when that process cannot
 * start, a chart runs a bridge of its own (`--live --data-only`), as a script
 * does.
 *
 * The shared process starts with the first chart and ends a while after the
 * last one. It holds the hub for as long as it runs.
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

interface Chart {
  onEvent: (event: BridgeEvent) => void;
  exit: (code: number | null) => void;
}

/** One shared candle process. */
class CandleProcess {
  private readonly charts = new Map<number, Chart>();
  private nextChart = 1;
  private linger: ReturnType<typeof setTimeout> | undefined;
  private readonly child: ChildProcessWithoutNullStreams;
  private ended = false;
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
    onClosed: () => void
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
      chart.onEvent(bridgeEvent.e === 'start' ? { ...bridgeEvent, workdir: this.workdir } : bridgeEvent);
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
        // A chart whose `exit` never came ends as a crashed bridge does
        for (const chart of charts) chart.exit(code === 0 ? 1 : code);
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

  open(opts: CandleRunOptions): CandleRun {
    const id = this.nextChart++;
    if (this.linger) clearTimeout(this.linger);
    this.linger = undefined;
    let exit: (code: number | null) => void = () => undefined;
    const exited = new Promise<number | null>((resolve) => (exit = resolve));
    this.charts.set(id, { onEvent: opts.onEvent, exit });
    this.write({ cmd: 'open', chart: id, provider: opts.provider, from: opts.from });
    return {
      exited,
      cancel: () => this.write({ cmd: 'close', chart: id }),
      kill: () => {
        if (!this.charts.delete(id)) return;
        this.write({ cmd: 'close', chart: id });
        exit(null);
        this.idle();
      },
    };
  }

  /** Ends the process; its charts end with it. */
  end(): void {
    if (this.ended) return;
    this.ended = true;
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
  private disposed = false;

  /**
   * @param hubs The provider hubs the shared processes are clients of.
   * @param bridgeRoot Directory that contains the `pyneide_bridge` package.
   * @param log Receives the shared processes' log lines.
   * @param lingerMs How long a shared process without a chart stays up.
   * @param startTimeoutMs How long a shared process may take to accept charts.
   */
  constructor(
    private readonly hubs: ProviderHubs,
    private readonly bridgeRoot: string,
    private readonly log: (line: string) => void,
    private readonly lingerMs = CANDLES_LINGER_MS,
    private readonly startTimeoutMs = CANDLES_START_TIMEOUT_MS
  ) {}

  /** Starts the candles of a live chart without a script. */
  async start(opts: CandleRunOptions): Promise<CandleRun> {
    const key = `${opts.pythonBin}\0${opts.workdir}`;
    // A process that ended between its lookup and the open is replaced once
    for (let attempt = 0; attempt < 2 && !this.failed.has(key) && !this.disposed; attempt++) {
      const shared = await this.process(key, opts.pythonBin, opts.workdir);
      if (!shared) break;
      if (shared.usable) return shared.open(opts);
      await shared.closed;
    }
    return this.own(opts);
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
      });
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
    onClosed: () => void
  ): Promise<CandleProcess | undefined> {
    const lease = await this.hubs.acquire(pythonBin, workdir);
    // Without a hub every chart would build its provider in the one process
    if (!Object.keys(lease.env).length || this.disposed) {
      lease.release();
      return undefined;
    }
    const shared = new CandleProcess(
      pythonBin, workdir, this.bridgeRoot, lease, this.log, this.lingerMs, this.startTimeoutMs, onClosed
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
  private async own(opts: CandleRunOptions): Promise<CandleRun> {
    const lease = await this.hubs.acquire(opts.pythonBin, opts.workdir);
    const run = BridgeRun.start({
      pythonBin: opts.pythonBin,
      bridgeRoot: this.bridgeRoot,
      workdir: opts.workdir,
      dataOnly: true,
      live: { provider: opts.provider, from: opts.from },
      env: lease.env,
      onEvent: opts.onEvent,
      onLog: opts.onLog,
    });
    void run.exited.then(() => lease.release());
    return run;
  }
}
