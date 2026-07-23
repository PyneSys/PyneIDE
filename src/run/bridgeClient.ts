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

export const BRIDGE_PROTOCOL_VERSION = 3;

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
  scriptType: 'indicator' | 'strategy' | 'library';
  /** Script-level `overlay=` from indicator()/strategy(): plots default to the price pane. */
  overlay: boolean;
  /** Strategy starting balance; absent for indicators and legacy persisted outputs. */
  initialCapital?: number;
  /** True for a data-only chart preview (raw candles, no script/plots). */
  dataOnly?: boolean;
  syminfo: Record<string, string | number | boolean | null>;
  data: string;
  range: { from: number; to: number; bars: number };
  outputs: {
    plot: string;
    strat: string | null;
    trades: string | null;
    /** Native PyneCore visualization sidecar (newline-delimited JSON). */
    viz?: string | null;
  };
}

/**
 * Serialized pynecore PlotMeta (viz layer, pynecore >= 6.6): the static
 * style metadata of one plot-family output. Emitted lazily on the first bar
 * the plot fires; a repeated `id` is an UPDATE (a plot turning `dynamic`
 * re-emits its meta). Only the core fields are typed — kind-specific extras
 * pass through untyped.
 */
export interface PlotMetaRecord {
  id: string;
  kind:
    | 'plot'
    | 'shape'
    | 'char'
    | 'arrow'
    | 'candle'
    | 'bar'
    | 'bgcolor'
    | 'barcolor'
    | 'hline'
    | 'fill';
  title?: string;
  /** Static color as #RRGGBBAA (alpha last, FF = opaque). */
  color?: string;
  linewidth?: number;
  /** Style name, e.g. 'line' | 'histogram' | 'circles' (kind 'plot'). */
  style?: string;
  histbase?: number;
  trackprice?: boolean;
  offset?: number;
  show_last?: number;
  display?: string;
  format?: string;
  precision?: number;
  force_overlay?: boolean;
  /** Fixed price level (kind 'hline'). */
  price?: number;
  /** 'solid' | 'dotted' | 'dashed' (kind 'hline'). */
  linestyle?: string;
  /** Marker glyph (kind 'char'). */
  char?: string;
  /** 'abovebar' | 'belowbar' | 'top' | 'bottom' | 'absolute' (shape/char). */
  location?: string;
  /** 'auto' | 'tiny' | 'small' | 'normal' | 'large' | 'huge' (shape/char). */
  size?: string;
  /** Text drawn with the marker (shape/char). */
  text?: string;
  textcolor?: string;
  /** Up/down arrow colors (kind 'arrow'). */
  colorup?: string;
  colordown?: string;
  /** Arrow length bounds in pixels (kind 'arrow'). */
  minheight?: number;
  maxheight?: number;
  /** Wick/border colors (kind 'candle'). */
  wickcolor?: string;
  bordercolor?: string;
  /** Referenced plot titles or hline ids (kind 'fill'). */
  plot1?: string;
  plot2?: string;
  hline1?: string;
  hline2?: string;
  /** True: the fill continues across na gaps (kind 'fill'). */
  fillgaps?: boolean;
  /** True once per-bar colors flow on this plot's channel in `colors`. */
  dynamic?: boolean;
  [key: string]: unknown;
}

/**
 * One dynamic color channel value: #RRGGBBAA, null (off/na), or an array
 * for compound families (shape/char: [color, textcolor]; arrow: [up, down];
 * candle: [color, wick, border]; fill gradient: [topVal, bottomVal,
 * topColor, bottomColor]).
 */
export type ColorEnc = string | number | null | (string | number | null)[];

/**
 * Per-bar color deltas: [timeMs, {channelId: enc}]. Delta semantics — a
 * channel appears only when its value changed; carry the last value forward.
 * `timeMs` always refers to an already-delivered bar row.
 */
export type ColorDeltaRow = [number, Record<string, ColorEnc>];

/** Drawing object families of the pynecore viz journal. */
export type DrawingFamily = 'line' | 'label' | 'box' | 'table' | 'polyline' | 'linefill';

/**
 * One drawing journal event (pynecore viz layer, protocol v3): the live
 * drawing registries diffed per bar. `id` is the object's run-stable vid;
 * `s` is the full serialized state (absent for deletes) — colors are
 * #RRGGBBAA, enums are names (xloc 'bar_index'|'bar_time', extend
 * 'none'|'left'|'right'|'both', line style 'solid'|'dotted'|'dashed'|
 * 'arrow_*', ...), na coordinates are null. `i` is the 0-based bar index
 * the change was detected on and always refers to an already-delivered bar.
 */
export interface DrawingEventRecord {
  i: number;
  op: 'create' | 'update' | 'delete';
  obj: DrawingFamily;
  id: number;
  s?: Record<string, unknown>;
}

export type BridgeEvent =
  | { e: 'hello'; protocol: number; pid: number }
  | { e: 'debugpy'; host: string; port: number }
  | { e: 'debugMain'; file: string; line: number }
  | { e: 'chartBreakpoint'; phase: 'enter' | 'leave'; time: number }
  | StartEvent
  | { e: 'bars'; d: BarRow[] }
  | { e: 'plotKeys'; keys: string[] }
  | { e: 'plotMeta'; metas: PlotMetaRecord[] }
  | { e: 'colors'; d: ColorDeltaRow[] }
  | { e: 'drawings'; d: DrawingEventRecord[] }
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
  /** Script path or bare name (resolved against `<workdir>/scripts`).
   * Omitted for a data-only preview. */
  script?: string;
  /** .ohlcv path or bare name (resolved against `<workdir>/data`). */
  data: string;
  /** Stream raw candles only (chart preview), no script run. */
  dataOnly?: boolean;
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
  /**
   * Start a debugpy listener in the bridge and wait for the IDE to attach
   * before running the script (0 = pick a free port). The actual endpoint
   * arrives in the `debugpy` event.
   */
  debugpyPort?: number;
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
    const args = ['-X', 'utf8', '-m', 'pyneide_bridge', '--data', opts.data, '--workdir', opts.workdir];
    if (opts.script) args.push('--script', opts.script);
    if (opts.dataOnly) args.push('--data-only');
    if (opts.timeFrom !== undefined) args.push('--time-from', String(opts.timeFrom));
    if (opts.timeTo !== undefined) args.push('--time-to', String(opts.timeTo));
    if (opts.timeframe) args.push('--timeframe', opts.timeframe);
    for (const sec of opts.security ?? []) args.push('--security', sec);
    if (opts.batchSize) args.push('--batch-size', String(opts.batchSize));
    if (opts.debugpyPort !== undefined) args.push('--debugpy-port', String(opts.debugpyPort));

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

  /** Pure chart-breakpoint timestamps handled at the bridge's bar boundary. */
  setChartBreakpointTimestamps(timestamps: readonly number[]): void {
    this.send({ cmd: 'chartBreakpoints', timestamps });
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
