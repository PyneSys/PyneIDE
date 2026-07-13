/**
 * Client for the pyneide_bridge Python process (vscode-free).
 *
 * Spawns `<python> -m pyneide_bridge ...` with PYTHONPATH pointing at the
 * extension's `python/` directory, parses the NDJSON event stream from
 * stdout, forwards stderr lines (pynecore logs + user print()s) to a log
 * callback, and writes control commands (pause/resume/step/cancel) to stdin.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import * as path from 'node:path';

export const BRIDGE_PROTOCOL_VERSION = 1;

/**
 * One bar row: [timeMs, open, high, low, close, volume, plots, equity].
 * `plots` aligns to the most recent `plotKeys` event; rows may carry fewer
 * plot columns than the current key list (missing trailing values are null).
 * `equity` is only present for strategies.
 */
export type BarRow = [
  number,
  number | null,
  number | null,
  number | null,
  number | null,
  number | null,
  (number | null)[] | null,
  (number | null)?,
];

export interface TradeRecord {
  entryId: string | null;
  entryBar: number;
  entryTime: number;
  entryPrice: number | null;
  entryComment: string | null;
  exitId: string | null;
  exitBar: number;
  exitTime: number;
  exitPrice: number | null;
  exitComment: string | null;
  size: number | null;
  commission: number | null;
  profit: number | null;
  profitPct: number | null;
  cumProfit: number | null;
  cumProfitPct: number | null;
}

export interface StartEvent {
  e: 'start';
  script: string;
  scriptTitle: string | null;
  scriptType: 'indicator' | 'strategy' | 'library';
  /** Script-level `overlay=` from indicator()/strategy(): plots default to the price pane. */
  overlay: boolean;
  syminfo: Record<string, string | number | boolean | null>;
  data: string;
  range: { from: number; to: number; bars: number };
  outputs: { plot: string; strat: string | null; trades: string | null };
}

export type BridgeEvent =
  | { e: 'hello'; protocol: number; pid: number }
  | StartEvent
  | { e: 'bars'; d: BarRow[] }
  | { e: 'plotKeys'; keys: string[] }
  | { e: 'trades'; d: TradeRecord[] }
  | { e: 'openTrades'; d: TradeRecord[] }
  | { e: 'progress'; done: number; total: number }
  | { e: 'state'; state: 'paused' | 'running' }
  | { e: 'stats'; d: Record<string, number | null> }
  | { e: 'log'; level: string; message: string }
  | { e: 'error'; message: string; kind: string; traceback: string }
  | { e: 'end'; bars: number; cancelled: boolean };

export interface BridgeRunOptions {
  /** Python interpreter of the (managed) venv with pynecore installed. */
  pythonBin: string;
  /** Directory that CONTAINS the pyneide_bridge package (`<ext>/python`). */
  bridgeRoot: string;
  /** Script path or bare name (resolved against `<workdir>/scripts`). */
  script: string;
  /** .ohlcv path or bare name (resolved against `<workdir>/data`). */
  data: string;
  /** Resolved pyne workdir (always explicit — never rely on cwd). */
  workdir: string;
  /** Run window start/end, epoch seconds UTC. */
  timeFrom?: number;
  timeTo?: number;
  /** Chart timeframe override (TradingView format, e.g. "60", "1D"). */
  timeframe?: string;
  /** Security data mappings, "TIMEFRAME=file" or "SYMBOL:TIMEFRAME=file". */
  security?: string[];
  batchSize?: number;
  onEvent: (event: BridgeEvent) => void;
  /** stderr lines: pynecore logs and user print() output. */
  onLog?: (line: string) => void;
}

export class BridgeRun {
  /** Resolves with the process exit code (null when killed by signal). */
  readonly exited: Promise<number | null>;

  private readonly child: ChildProcessWithoutNullStreams;

  private constructor(child: ChildProcessWithoutNullStreams) {
    this.child = child;
    this.exited = new Promise((resolve) => {
      child.on('close', (code) => resolve(code));
    });
  }

  static start(opts: BridgeRunOptions): BridgeRun {
    const args = [
      '-X',
      'utf8',
      '-m',
      'pyneide_bridge',
      '--script',
      opts.script,
      '--data',
      opts.data,
      '--workdir',
      opts.workdir,
    ];
    if (opts.timeFrom !== undefined) args.push('--time-from', String(opts.timeFrom));
    if (opts.timeTo !== undefined) args.push('--time-to', String(opts.timeTo));
    if (opts.timeframe) args.push('--timeframe', opts.timeframe);
    for (const sec of opts.security ?? []) args.push('--security', sec);
    if (opts.batchSize) args.push('--batch-size', String(opts.batchSize));

    const pythonPath = process.env.PYTHONPATH
      ? `${opts.bridgeRoot}${path.delimiter}${process.env.PYTHONPATH}`
      : opts.bridgeRoot;
    const child = spawn(opts.pythonBin, args, {
      cwd: opts.workdir,
      env: {
        ...process.env,
        PYTHONPATH: pythonPath,
        PYNE_WORK_DIR: opts.workdir,
        PYTHONUNBUFFERED: '1',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdoutBuf = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdoutBuf += chunk;
      let nl: number;
      while ((nl = stdoutBuf.indexOf('\n')) >= 0) {
        const line = stdoutBuf.slice(0, nl).trim();
        stdoutBuf = stdoutBuf.slice(nl + 1);
        if (!line) continue;
        let event: BridgeEvent;
        try {
          event = JSON.parse(line) as BridgeEvent;
        } catch {
          opts.onLog?.(`[bridge] unparseable event: ${line.slice(0, 200)}`);
          continue;
        }
        opts.onEvent(event);
      }
    });

    let stderrBuf = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderrBuf += chunk;
      let nl: number;
      while ((nl = stderrBuf.indexOf('\n')) >= 0) {
        const line = stderrBuf.slice(0, nl);
        stderrBuf = stderrBuf.slice(nl + 1);
        if (line.trim()) opts.onLog?.(line);
      }
    });

    child.on('error', (err) => {
      opts.onLog?.(`[bridge] spawn failed: ${err.message}`);
    });

    return new BridgeRun(child);
  }

  pause(): void {
    this.send({ cmd: 'pause' });
  }

  resume(): void {
    this.send({ cmd: 'resume' });
  }

  /** While paused: advance N bars, then pause again (bar-stepping basis). */
  step(bars = 1): void {
    this.send({ cmd: 'step', bars });
  }

  /** Graceful stop: the runner finishes the current bar and cleans up. */
  cancel(): void {
    this.send({ cmd: 'cancel' });
  }

  /** Hard stop; prefer cancel(). */
  kill(): void {
    this.child.kill('SIGTERM');
  }

  private send(cmd: object): void {
    if (this.child.stdin.writable) {
      this.child.stdin.write(JSON.stringify(cmd) + '\n');
    }
  }
}
