/**
 * DAP proxy between VSCode and the bridge's debugpy listener.
 *
 * Instead of pointing VSCode directly at the endpoint (DebugAdapterServer),
 * an inline adapter relays the wire protocol so the variable scopes can be
 * recomposed into what a Pine developer actually wants to see. At every stop
 * the proxy presents three scopes (see pyneide_bridge.debug_inspect):
 *
 *  - **Pyne** — a synthetic scope the proxy answers itself: the current bar's
 *    runtime values (bar_index + OHLCV + derived sources + time), read live
 *    off `pynecore.lib` via an in-session `evaluate`.
 *  - **Locals** — the frame's real locals plus the script's named
 *    persistent/series state. That state lives in anonymous `__state__[N]`
 *    slots at runtime; only the module's `__pyne_slot_layout__` still knows
 *    the source names, so the proxy resolves them in-session and injects them.
 *  - **Globals** — replaced with the script's meaningful module globals only
 *    (imported value sources + user constants); the pynecore module noise is
 *    dropped.
 *
 * The proxy also reports execution state (stopped at a breakpoint / resumed,
 * plus the thread id) so the RunService can compose bar-level controls with
 * debugger stops ("Next bar" while stopped = arm a feed pause + continue).
 *
 * For a session launched from a `.pine` (a PineSourceMapper is present) the
 * proxy additionally IS the Pine debugger: breakpoints set in the .pine are
 * forwarded against the compiled sibling .py through the line-level sourcemap,
 * stack frames / breakpoint verifications come back mapped to Pine lines,
 * stepping is repeated invisibly while the top frame stays on the same Pine
 * statement, and compiler-renamed identifiers are shown demangled.
 */
import * as net from 'node:net';
import * as path from 'node:path';

import * as vscode from 'vscode';

import { demangleVariables } from './demangle';
import type { PineSourceMapper } from './sourceMapper';

/** Own requests use this seq range so they never collide with the client's. */
const INTERNAL_SEQ_BASE = 1 << 30;
const INTERNAL_TIMEOUT_MS = 5000;
/** Upper bound on injected variables — a runaway layout must not stall the UI. */
const MAX_PINE_SLOTS = 100;
/**
 * Upper bound on the hidden re-steps of one user step (Pine-statement
 * stepping): one Pine statement compiles to a handful of Python statements,
 * so the cap is never reached legitimately — it only stops a runaway if the
 * same-line heuristic ever misfires.
 */
const MAX_AUTO_STEPS = 50;
/** variablesReference range for the proxy's own synthetic scopes (Pyne). */
const SYNTHETIC_REF_BASE = 1_500_000_000;
/** seq range for responses the proxy sends the client without a server round-trip. */
const SYNTHETIC_SEQ_BASE = 1_400_000_000;

/** debug_inspect helper expressions, evaluated in the stopped frame. */
const PINE_BAR_EXPR =
  '__import__("pyneide_bridge.debug_inspect", fromlist=["pine_bar"]).pine_bar()';
const PINE_GLOBALS_EXPR =
  '__import__("pyneide_bridge.debug_inspect", fromlist=["pine_globals"]).pine_globals(globals())';

/**
 * Wrap a raw conditional-breakpoint expression so pydevd evaluates it with the
 * Pine builtins live. `debug_inspect.cond` re-evaluates the ORIGINAL condition
 * in a namespace where `bar_index`/`close`/... hold the current bar's values
 * (and `lib`/`pynecore` resolve), so a natural `bar_index == 10` works even
 * though the transform stripped those imports. The condition text is embedded
 * as a Python string literal via JSON encoding (Python accepts the same escape
 * forms JSON emits).
 */
const wrapCondition = (expr: string): string =>
  `__import__("pyneide_bridge.debug_inspect",fromlist=["cond"]).cond(${JSON.stringify(
    expr
  )},globals(),locals())`;

/** Evaluate contexts routed through the Pine-aware `watch` helper (see below). */
const WATCH_CONTEXTS = new Set(['watch', 'hover', 'clipboard']);

/**
 * Wrap a watch/hover expression so Pine series and persistent state resolve.
 * `debug_inspect.watch` re-evaluates the ORIGINAL expression in a namespace
 * where `basis[5]`/`close[1]` index the series' history buffer (a bare `basis`
 * is only the current scalar and not subscriptable) and a persistent `p` — kept
 * in a hidden state slot, not a local — binds by name. The result object is
 * returned unchanged, so pydevd still renders it with full type/expansion.
 * `frameName` scopes the state lookup; the empty string is a safe fallback
 * (bare builtins still resolve, only the series/state rewrite is skipped).
 */
const wrapWatch = (expr: string, frameName: string): string =>
  `__import__("pyneide_bridge.debug_inspect",fromlist=["watch"]).watch(${JSON.stringify(
    expr
  )},globals(),locals(),${JSON.stringify(frameName)})`;

interface DapMessage {
  seq: number;
  type: 'request' | 'response' | 'event';
  command?: string;
  event?: string;
  request_seq?: number;
  success?: boolean;
  message?: string;
  arguments?: Record<string, unknown>;
  body?: Record<string, unknown>;
}

interface PineSlot {
  name: string;
  param: string;
  slot: number;
  kind: 'var' | 'series';
  /** Source-level type label (`Series[float]`, `Persistent[int]`). */
  type: string;
  owner: string;
  own: boolean;
}

/** A rendered scalar variable from a bridge helper (Pyne / Globals scopes). */
interface PineEntry {
  name: string;
  value: string;
  type: string;
}

export interface PyneDapProxyHooks {
  /** Debugger execution state: stopped (with thread + stop reason) or resumed. */
  onExecState(stopped: boolean, threadId?: number, reason?: string): void;
}

/**
 * Breakpoint control used by the run-to-bar fast path: while flying to a far
 * target bar, ALL breakpoints are removed from the debuggee so pydevd stops
 * tracing the per-bar main() (with any breakpoint active, every line runs
 * under the tracer — orders of magnitude slower), then restored so the target
 * bar stops. VSCode's own breakpoint view is untouched: these are own-seq
 * requests it never sees.
 */
export interface DebugBreakpointControl {
  /** Whether the debuggee currently has any line breakpoint to land on. */
  hasBreakpoints(): boolean;
  suppressBreakpoints(): Promise<void>;
  restoreBreakpoints(): Promise<void>;
  /**
   * Location of the script's `main` first executable line, reported by the
   * bridge (`debugMain`). Enables the synthetic "bar stop" breakpoint below.
   */
  setBarStopLocation(file: string, line: number): void;
  /** Whether a bar-stop location is known (bridge reported `debugMain`). */
  canBarStop(): boolean;
  /**
   * Arm the hidden "bar stop" breakpoint at `main`'s first line for exactly the
   * next continue: the debuggee suspends at the top of the following bar,
   * regardless of the user's breakpoints (a conditional breakpoint no longer
   * runs the bar controls past their target). The proxy auto-disarms it the
   * moment it surfaces a stop to the client, so a plain Continue stays free.
   * Sends the merged (user + synthetic) breakpoint set to the debuggee now.
   */
  armBarStop(): Promise<void>;
  /**
   * Set the armed flag WITHOUT sending — for the run-to-bar fast path, where
   * suppress/restore already drive the debuggee's breakpoints and the synthetic
   * one must ride along on the restore that precedes the final crawl.
   */
  setBarStopArmed(armed: boolean): void;
  /** Disarm the bar-stop breakpoint and re-send the user's breakpoints only. */
  disarmBarStop(): Promise<void>;
  /**
   * "Run to bar N": arm (number) or disarm (undefined) the target bar. While
   * armed, the proxy swallows every per-bar breakpoint stop until the debuggee
   * has actually reached `bar_index === target`, deciding on the live bar_index
   * read in-session — NOT on the async NDJSON progress counter, which lags the
   * DAP stop channel and made the run overshoot the target.
   */
  setRunToBarTarget(target: number | undefined): void;
  /**
   * Live `bar_index` of the suspended debuggee, or undefined if it can't be
   * read. Used for the run-to-bar prompt and to decide whether a fly is worth
   * it. Undefined on any failure.
   */
  currentBarIndex(threadId: number | undefined): Promise<number | undefined>;
  /**
   * Arm the bridge's run-to-bar target (bars_done) via an in-session evaluate.
   * MUST be done this way, not over stdin: while pydevd holds every thread
   * suspended at a breakpoint the bridge's stdin reader is frozen, so an stdin
   * pause/step lands only AFTER the run is released — by then the feed has
   * already flown past. The evaluate runs in the debuggee itself, so the target
   * is set on the feed thread BEFORE it is released and the stop is race-free.
   */
  armBridgeRunTo(threadId: number | undefined, bar: number): Promise<void>;
}

const RESUME_COMMANDS = new Set(['continue', 'next', 'stepIn', 'stepOut', 'stepBack', 'goto']);

export class PyneDapProxy implements vscode.DebugAdapter, DebugBreakpointControl {
  private readonly emitter = new vscode.EventEmitter<vscode.DebugProtocolMessage>();
  readonly onDidSendMessage = this.emitter.event;

  private socket: net.Socket | undefined;
  private connected = false;
  private disposed = false;
  private readonly outQueue: DapMessage[] = [];
  private buffer = Buffer.alloc(0);

  private internalSeq = INTERNAL_SEQ_BASE;
  private readonly internalPending = new Map<
    number,
    { resolve: (body: Record<string, unknown>) => void; reject: (err: Error) => void }
  >();

  // Client request bookkeeping (seq -> what the response means).
  private readonly pendingStackTrace = new Map<
    number,
    { threadId: number | undefined; topFrame: boolean }
  >();
  private readonly pendingScopes = new Map<number, number>(); // seq -> frameId
  private readonly pendingLocals = new Map<number, number>(); // seq -> frameId
  private readonly pendingResumes = new Set<number>();
  // setBreakpoints requests translated from a .pine source: how to rebuild the
  // client-facing response (original per-breakpoint order, dropped entries
  // re-inserted unverified; the debuggee only saw the mappable ones).
  private readonly pendingPineBreakpoints = new Map<
    number,
    { pyPath: string; requested: boolean[] }
  >();
  // gotoTargets requests translated pine -> py; the response's target lines
  // must come back py -> pine.
  private readonly pendingGotoTargets = new Map<number, string>(); // seq -> pyPath

  // Synthetic-scope allocation: the Pyne scope's variablesReference and the
  // seq the proxy stamps on responses it answers itself (both in their own
  // high ranges so they never collide with the debuggee's).
  private syntheticRef = SYNTHETIC_REF_BASE;
  private syntheticSeq = SYNTHETIC_SEQ_BASE;

  // Last breakpoint requests the client sent, replayed to toggle the debuggee's
  // breakpoints for the run-to-bar fast path (source path -> setBreakpoints args).
  private readonly clientBreakpoints = new Map<string, Record<string, unknown>>();
  private clientExceptionBreakpoints: Record<string, unknown> | undefined;

  // "Run to bar N": set while a run-to-bar is in flight (see setRunToBarTarget).
  private runToBarTarget: number | undefined;

  // Hidden "bar stop" breakpoint at main's first executable line (bridge's
  // `debugMain`). Armed for exactly one continue by the bar controls, then
  // auto-disarmed on the surfaced stop; VSCode's breakpoint view never sees it.
  private barStopFile: string | undefined;
  private barStopLine: number | undefined;
  private barStopArmed = false;

  // Pine-statement stepping: while a user step is being auto-repeated (the
  // top frame still maps to the SAME .pine line — one Pine statement spans
  // several Python statements), intermediate stops are swallowed and the same
  // step command re-issued. Cleared the moment any stop is surfaced.
  private stepContext:
    | {
        threadId: number;
        command: string;
        pinePath: string;
        pineLine: number;
        frameName: string;
        autoSteps: number;
      }
    | undefined;
  // Last surfaced top frame per thread, in Pine terms (only set when it maps):
  // the reference location a step command measures progress against.
  private readonly lastTopFrame = new Map<
    number,
    { pinePath: string; pineLine: number; frameName: string }
  >();

  // Valid for the current stop only; cleared on every stopped event.
  private stopGeneration = 0;
  private readonly frameNames = new Map<number, string>();
  private readonly localsRefs = new Map<number, number>(); // variablesReference -> frameId
  // Scopes the proxy answers itself (no server round-trip): the synthetic Pyne
  // scope, and the (real) Globals scope whose contents are wholly replaced.
  private readonly pyneScopeRefs = new Map<number, number>(); // ref -> frameId
  private readonly globalsScopeRefs = new Map<number, number>(); // ref -> frameId
  private readonly pineSlotsCache = new Map<number, Promise<PineSlot[]>>(); // frameId

  constructor(
    host: string,
    port: number,
    private readonly hooks: PyneDapProxyHooks,
    /**
     * Present when the session was launched from a `.pine`: every source
     * reference is translated through it (breakpoints pine -> py, frames and
     * verifications py -> pine) and compiler-renamed identifiers are shown
     * demangled. Absent for plain Pyne (.py) sessions — zero behavior change.
     */
    private readonly mapper?: PineSourceMapper
  ) {
    const socket = net.createConnection({ host, port });
    this.socket = socket;
    socket.on('connect', () => {
      this.connected = true;
      for (const msg of this.outQueue.splice(0)) this.write(msg);
    });
    socket.on('data', (chunk) => this.onData(chunk));
    // debugpy normally sends `terminated` itself; this covers a torn socket.
    socket.on('error', () => this.emitTerminated());
    socket.on('close', () => this.emitTerminated());
  }

  // --- vscode.DebugAdapter --------------------------------------------------

  handleMessage(message: vscode.DebugProtocolMessage): void {
    const msg = message as DapMessage;
    if (msg.type === 'request' && typeof msg.seq === 'number') {
      // Variables requests for a proxy-owned scope are answered in-session and
      // never forwarded (the Pyne scope is synthetic; the Globals scope's real
      // contents are discarded in favour of the curated list).
      if (msg.command === 'variables') {
        const ref = (msg.arguments ?? {}).variablesReference;
        if (typeof ref === 'number') {
          const pyneFrame = this.pyneScopeRefs.get(ref);
          if (pyneFrame !== undefined) {
            void this.answerSyntheticScope(msg.seq, PINE_BAR_EXPR, pyneFrame);
            return;
          }
          const globalsFrame = this.globalsScopeRefs.get(ref);
          if (globalsFrame !== undefined) {
            void this.answerSyntheticScope(msg.seq, PINE_GLOBALS_EXPR, globalsFrame);
            return;
          }
        }
      }
      // breakpointLocations for a mapped .pine is answered from the sourcemap
      // itself — the mapped pine lines ARE the breakpointable lines; the
      // debuggee only knows the generated .py, so forwarding would need a
      // lossy line-range translation for an answer the map already holds.
      if (msg.command === 'breakpointLocations' && this.mapper) {
        const args = msg.arguments ?? {};
        const source = args.source as { path?: string } | undefined;
        const line = typeof args.line === 'number' ? args.line : undefined;
        if (source?.path && line !== undefined && this.mapper.hasPineMapping(source.path)) {
          const endLine = typeof args.endLine === 'number' ? args.endLine : line;
          this.emit({
            seq: this.syntheticSeq++,
            type: 'response',
            request_seq: msg.seq,
            success: true,
            command: 'breakpointLocations',
            body: {
              breakpoints: this.mapper
                .mappedPineLines(source.path, line, endLine)
                .map((l) => ({ line: l })),
            },
          });
          return;
        }
      }
      // Route watch/hover expressions through the Pine-aware `watch` helper so
      // series history (`basis[5]`) and persistent state resolve. Left as a
      // plain forward for the Debug Console (`repl`), which may carry statements
      // the wrapper's expression context could not hold.
      if (msg.command === 'evaluate') {
        const args = msg.arguments ?? {};
        const context = args.context;
        if (
          typeof args.expression === 'string' &&
          typeof args.frameId === 'number' &&
          typeof context === 'string' &&
          WATCH_CONTEXTS.has(context)
        ) {
          args.expression = wrapWatch(args.expression, this.frameNames.get(args.frameId) ?? '');
        }
      }
      this.trackClientRequest(msg);
    }
    if (!this.connected) {
      this.outQueue.push(msg);
      return;
    }
    this.write(msg);
  }

  dispose(): void {
    this.disposed = true;
    this.socket?.destroy();
    this.socket = undefined;
    for (const pending of this.internalPending.values()) {
      pending.reject(new Error('DAP proxy disposed'));
    }
    this.internalPending.clear();
    this.emitter.dispose();
  }

  // --- wire -------------------------------------------------------------------

  private write(msg: DapMessage): void {
    const payload = JSON.stringify(msg);
    this.socket?.write(`Content-Length: ${Buffer.byteLength(payload)}\r\n\r\n${payload}`);
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd < 0) return;
      const header = this.buffer.subarray(0, headerEnd).toString('ascii');
      const lengthMatch = /Content-Length:\s*(\d+)/i.exec(header);
      if (!lengthMatch) {
        this.buffer = this.buffer.subarray(headerEnd + 4);
        continue;
      }
      const total = headerEnd + 4 + Number(lengthMatch[1]);
      if (this.buffer.length < total) return;
      const body = this.buffer.subarray(headerEnd + 4, total).toString('utf8');
      this.buffer = this.buffer.subarray(total);
      try {
        this.onServerMessage(JSON.parse(body) as DapMessage);
      } catch {
        // Malformed frame: drop it rather than kill the session.
      }
    }
  }

  private emit(msg: DapMessage): void {
    if (this.disposed) return;
    this.emitter.fire(msg as vscode.DebugProtocolMessage);
  }

  private terminatedSent = false;
  private emitTerminated(): void {
    if (this.terminatedSent || this.disposed) return;
    this.terminatedSent = true;
    this.emit({ seq: 0, type: 'event', event: 'terminated' });
  }

  // --- message routing ----------------------------------------------------------

  private trackClientRequest(msg: DapMessage): void {
    const args = msg.arguments ?? {};
    switch (msg.command) {
      case 'setBreakpoints': {
        // Breakpoints set in a mapped .pine are the debuggee's .py breakpoints:
        // translate source + lines in place FIRST, so everything downstream
        // (condition wrapping, the stored replay args, the bar-stop merge)
        // uniformly sees the .py form.
        this.translatePineBreakpoints(msg);
        // Rewrite each condition so bare Pine builtins resolve live (see
        // wrapBreakpointConditions). Mutated in place BEFORE the args are
        // stored + forwarded, so the run-to-bar restore replays the wrapped
        // form too and the debuggee only ever sees Pyne-aware conditions.
        wrapBreakpointConditions(args);
        const source = args.source as { path?: string; name?: string } | undefined;
        const key = source?.path ?? source?.name;
        if (key) this.clientBreakpoints.set(key, args);
        break;
      }
      case 'setExceptionBreakpoints':
        this.clientExceptionBreakpoints = args;
        break;
      case 'stackTrace':
        this.pendingStackTrace.set(msg.seq, {
          threadId: typeof args.threadId === 'number' ? args.threadId : undefined,
          topFrame: !args.startFrame,
        });
        break;
      case 'gotoTargets': {
        // Jump-to-cursor in a mapped .pine: the target location must be the
        // generated .py line; the response's candidate lines come back mapped.
        const source = args.source as { path?: string; name?: string } | undefined;
        if (
          this.mapper &&
          source?.path &&
          typeof args.line === 'number' &&
          this.mapper.hasPineMapping(source.path)
        ) {
          const mapped = this.mapper.pineToPy(source.path, args.line);
          if (mapped) {
            args.source = { name: path.basename(mapped.path), path: mapped.path };
            args.line = mapped.line;
            this.pendingGotoTargets.set(msg.seq, mapped.path);
          }
        }
        break;
      }
      case 'scopes':
        if (typeof args.frameId === 'number') this.pendingScopes.set(msg.seq, args.frameId);
        break;
      case 'variables': {
        const ref = args.variablesReference;
        const frameId = typeof ref === 'number' ? this.localsRefs.get(ref) : undefined;
        // Only the plain full fetch is enriched; paged/filtered requests
        // (start/count/filter) must keep their exact shape.
        if (
          frameId !== undefined &&
          args.filter === undefined &&
          args.start === undefined &&
          args.count === undefined
        ) {
          this.pendingLocals.set(msg.seq, frameId);
        }
        break;
      }
      default:
        if (msg.command && RESUME_COMMANDS.has(msg.command)) {
          this.pendingResumes.add(msg.seq);
          this.armStepContext(msg.command, args);
        }
    }
  }

  /**
   * Pine-statement stepping: remember where a step command departs from (the
   * thread's last surfaced top frame, in Pine terms). While the top frame
   * still maps to this same .pine line, the resulting stops are swallowed and
   * the step repeated — one user step, one Pine statement (see handleStopped).
   * Any non-step resume clears the context; a step from an unmapped location
   * steps plain Python, exactly as before.
   */
  private armStepContext(command: string, args: Record<string, unknown>): void {
    this.stepContext = undefined;
    if (!this.mapper) return;
    if (command !== 'next' && command !== 'stepIn' && command !== 'stepOut') return;
    const threadId = args.threadId;
    if (typeof threadId !== 'number') return;
    const top = this.lastTopFrame.get(threadId);
    if (!top) return;
    this.stepContext = { threadId, command, ...top, autoSteps: 0 };
  }

  /**
   * Rewrite a setBreakpoints request for a mapped .pine in place: the source
   * becomes the compiled .py and every line the first generated line of its
   * Pine statement (snapping forward over non-emitting lines). A line past the
   * last mapped statement has no image — it is withheld from the debuggee and
   * re-inserted unverified into the response, which must answer the client's
   * breakpoints one-to-one, in order (see the pendingPineBreakpoints replay in
   * onServerMessage). An empty request (clearing the file's breakpoints) still
   * translates, so the clear reaches the .py.
   */
  private translatePineBreakpoints(msg: DapMessage): void {
    const args = msg.arguments ?? {};
    const source = args.source as { path?: string; name?: string } | undefined;
    const pinePath = source?.path;
    if (!this.mapper || !pinePath || !this.mapper.hasPineMapping(pinePath)) return;
    const bps = Array.isArray(args.breakpoints)
      ? (args.breakpoints as Record<string, unknown>[])
      : [];
    const forwarded: Record<string, unknown>[] = [];
    const requested: boolean[] = [];
    let pyPath: string | undefined;
    for (const bp of bps) {
      const mapped =
        typeof bp.line === 'number' ? this.mapper.pineToPy(pinePath, bp.line) : undefined;
      requested.push(mapped !== undefined);
      if (mapped) {
        pyPath = mapped.path;
        forwarded.push({ ...bp, line: mapped.line });
      }
    }
    // No mappable breakpoint (or none at all): the .py path still comes from
    // the map, so a clear / all-unmappable set reaches the right file.
    pyPath ??= this.mapper.pineToPy(pinePath, 1)?.path;
    if (!pyPath) return;
    args.source = { name: path.basename(pyPath), path: pyPath };
    args.breakpoints = forwarded;
    args.lines = forwarded.map((bp) => bp.line);
    this.pendingPineBreakpoints.set(msg.seq, { pyPath, requested });
  }

  private onServerMessage(msg: DapMessage): void {
    if (msg.type === 'response' && (msg.request_seq ?? 0) >= INTERNAL_SEQ_BASE) {
      const pending = this.internalPending.get(msg.request_seq!);
      if (pending) {
        this.internalPending.delete(msg.request_seq!);
        if (msg.success) pending.resolve(msg.body ?? {});
        else pending.reject(new Error(msg.message ?? `${msg.command} failed`));
      }
      return; // never forwarded to the client
    }

    // Pine-style NA presentation on everything headed for the client: the
    // parametrized repr moves into the type column, the value reads `na`, the
    // node is not expandable (its children would be CPython internals).
    if (msg.type === 'response' && msg.success && msg.body) {
      if (msg.command === 'variables' && Array.isArray(msg.body.variables)) {
        // Object expansions (everything but the Locals scope, which enrichLocals
        // curates) drop CPython dunder attributes — `special:'inline'` surfaces
        // them so the frame's PyneComp `__block_result__` locals show, but on an
        // expanded value they are just noise.
        const isLocalsScope =
          typeof msg.request_seq === 'number' && this.pendingLocals.has(msg.request_seq);
        if (!isLocalsScope) {
          msg.body.variables = (msg.body.variables as Record<string, unknown>[]).filter(
            (v) => typeof v.name !== 'string' || !isDunder(v.name)
          );
          // Compiler-renamed names read as their Pine originals (UDT fields
          // carry the canonical `__ren__` suffix). The Locals scope gets the
          // same pass in enrichLocals, after the state-slot merge.
          if (this.mapper) {
            demangleVariables(msg.body.variables as Record<string, unknown>[]);
          }
        }
        normalizeNaVariables(msg.body.variables as Record<string, unknown>[]);
      } else if (msg.command === 'evaluate') {
        normalizeNaEvaluate(msg.body);
      }
    }

    if (msg.type === 'response' && typeof msg.request_seq === 'number') {
      const seq = msg.request_seq;
      const stackMeta = this.pendingStackTrace.get(seq);
      if (stackMeta !== undefined) {
        this.pendingStackTrace.delete(seq);
        if (msg.success) {
          const frames = (msg.body?.stackFrames ?? []) as {
            id: number;
            name: string;
            line?: number;
            column?: number;
            source?: { path?: string; name?: string };
          }[];
          for (const frame of frames) this.frameNames.set(frame.id, frame.name);
          if (this.mapper) {
            // Present the stack in Pine terms: any frame whose .py maps back
            // to a .pine (main script or a compiled Pine library) is shown at
            // its Pine source line. Unmapped frames (generated header, plain
            // Python) stay as they are.
            for (const frame of frames) {
              if (!frame.source?.path || typeof frame.line !== 'number') continue;
              const pine = this.mapper.pyToPine(frame.source.path, frame.line);
              if (!pine) continue;
              frame.source = { ...frame.source, name: path.basename(pine.path), path: pine.path };
              frame.line = pine.line;
              // Column positions belong to the generated Python; on the (often
              // shorter) Pine line they would point mid-air.
              frame.column = 1;
            }
            // The step reference location for this thread: where the user
            // sees execution standing (only a mapped top frame can anchor
            // Pine-statement stepping).
            const top = frames[0];
            if (stackMeta.topFrame && stackMeta.threadId !== undefined && top) {
              const pinePath = top.source?.path;
              if (pinePath && pinePath.toLowerCase().endsWith('.pine') && top.line !== undefined) {
                this.lastTopFrame.set(stackMeta.threadId, {
                  pinePath,
                  pineLine: top.line,
                  frameName: top.name,
                });
              } else {
                this.lastTopFrame.delete(stackMeta.threadId);
              }
            }
          }
        }
      }
      const pineBps = this.pendingPineBreakpoints.get(seq);
      if (pineBps !== undefined) {
        this.pendingPineBreakpoints.delete(seq);
        if (msg.success && msg.body) {
          // Answer the client's original breakpoint list one-to-one, in order:
          // the debuggee's verifications (mapped back to Pine lines) for the
          // forwarded ones, an unverified placeholder for the withheld ones.
          const serverBps = Array.isArray(msg.body.breakpoints)
            ? (msg.body.breakpoints as Record<string, unknown>[])
            : [];
          let next = 0;
          msg.body.breakpoints = pineBps.requested.map((wasForwarded) => {
            if (!wasForwarded) {
              return { verified: false, message: 'No executable Pine line here.' };
            }
            const bp = serverBps[next++] ?? { verified: false };
            this.translateBreakpointToPine(bp, pineBps.pyPath);
            return bp;
          });
        }
      }
      const gotoPyPath = this.pendingGotoTargets.get(seq);
      if (gotoPyPath !== undefined) {
        this.pendingGotoTargets.delete(seq);
        if (msg.success && Array.isArray(msg.body?.targets) && this.mapper) {
          for (const target of msg.body.targets as Record<string, unknown>[]) {
            if (typeof target.line !== 'number') continue;
            const pine = this.mapper.pyToPine(gotoPyPath, target.line);
            if (pine) target.line = pine.line;
          }
        }
      }
      const scopesFrame = this.pendingScopes.get(seq);
      if (scopesFrame !== undefined) {
        this.pendingScopes.delete(seq);
        if (msg.success && msg.body) {
          const scopes = (msg.body.scopes ?? []) as {
            name: string;
            presentationHint?: string;
            variablesReference: number;
          }[];
          for (const scope of scopes) {
            if (scope.presentationHint === 'locals' || scope.name === 'Locals') {
              this.localsRefs.set(scope.variablesReference, scopesFrame);
            } else if (scope.presentationHint === 'globals' || scope.name === 'Globals') {
              // Keep the scope, but the proxy answers its variables request with
              // the curated list (see handleMessage) — the raw pynecore module
              // namespace is never fetched.
              this.globalsScopeRefs.set(scope.variablesReference, scopesFrame);
            }
          }
          // Lead with a synthetic Pyne scope (the current-bar runtime dashboard):
          // bar_index + OHLCV + derived sources + time, answered in-session.
          const pyneRef = this.syntheticRef++;
          this.pyneScopeRefs.set(pyneRef, scopesFrame);
          msg.body.scopes = [
            { name: 'Pyne', variablesReference: pyneRef, expensive: false },
            ...scopes,
          ];
        }
      }
      const localsFrame = this.pendingLocals.get(seq);
      if (localsFrame !== undefined) {
        this.pendingLocals.delete(seq);
        if (msg.success && Array.isArray(msg.body?.variables)) {
          void this.enrichLocals(localsFrame, msg); // emits when done
          return;
        }
      }
      if (this.pendingResumes.delete(seq) && msg.success) {
        this.hooks.onExecState(false);
      }
    }

    if (msg.type === 'event') {
      if (msg.event === 'stopped') {
        const threadId = typeof msg.body?.threadId === 'number' ? msg.body.threadId : undefined;
        const reason = typeof msg.body?.reason === 'string' ? msg.body.reason : undefined;
        // Deciding whether to surface the stop may need an in-session bar_index
        // read (run-to-bar), so handle it out of band: onServerMessage must keep
        // running to route the own-seq stackTrace/evaluate responses that read
        // arrives on. handleStopped emits the stopped event itself when it lands.
        void this.handleStopped(msg, threadId, reason);
        return;
      } else if (msg.event === 'continued') {
        this.hooks.onExecState(false);
      } else if (msg.event === 'breakpoint') {
        if (this.isSyntheticBreakpointEvent(msg)) {
          // A `changed`/`new` event for the hidden bar-stop breakpoint would draw a
          // phantom gutter marker at main's first line; the client never asked for
          // it, so never tell it about it.
          return;
        }
        // A verification/relocation event for a user breakpoint arrives in .py
        // terms; the client's breakpoint lives in the .pine.
        const bp = msg.body?.breakpoint as
          | { line?: number; source?: { path?: string; name?: string } }
          | undefined;
        if (bp?.source?.path) this.translateBreakpointToPine(bp, bp.source.path);
      }
    }

    this.emit(msg);
  }

  /**
   * Map a debuggee-reported breakpoint (a setBreakpoints verification or a
   * `breakpoint` event) back to Pine terms, in place. `pyPath` locates the
   * sourcemap when the breakpoint carries no source of its own.
   */
  private translateBreakpointToPine(
    bp: { line?: number; endLine?: number; source?: { path?: string; name?: string } },
    pyPath: string
  ): void {
    if (!this.mapper || typeof bp.line !== 'number') return;
    const sourcePath = bp.source?.path ?? pyPath;
    const pine = this.mapper.pyToPine(sourcePath, bp.line);
    if (!pine) return;
    bp.line = pine.line;
    if (typeof bp.endLine === 'number') {
      bp.endLine = this.mapper.pyToPine(sourcePath, bp.endLine)?.line ?? pine.line;
    }
    bp.source = { name: path.basename(pine.path), path: pine.path };
  }

  /**
   * True if a `breakpoint` event describes the synthetic bar-stop breakpoint:
   * it sits on `barStopLine` of the main file and the user has no breakpoint of
   * their own on that exact line (theirs must always be surfaced).
   */
  private isSyntheticBreakpointEvent(msg: DapMessage): boolean {
    if (this.barStopLine === undefined) return false;
    const bp = msg.body?.breakpoint as
      | { line?: number; source?: { path?: string } }
      | undefined;
    if (!bp || bp.line !== this.barStopLine) return false;
    const source = bp.source?.path;
    if (source !== undefined && !this.isMainFileKey(source)) return false;
    const clientBps = this.mainFileClientArgs()?.breakpoints;
    if (Array.isArray(clientBps)) {
      for (const cb of clientBps as { line?: number }[]) {
        if (cb.line === this.barStopLine) return false; // the user owns this line
      }
    }
    return true;
  }

  /**
   * Decide the fate of a `stopped` event. On the run-to-bar fast path a per-bar
   * breakpoint fires on every bar on the way to the target; swallow (resume
   * before VSCode sees it) until the debuggee has actually reached the target
   * bar. Surfacing an intermediate stop would jump the editor to the breakpoint
   * line and re-enrich the Locals every bar — so the run must fly, not crawl.
   *
   * The target check reads the LIVE `bar_index` in-session rather than the
   * async progress counter: that counter lags the DAP stop channel (the bridge
   * thread is suspended at the breakpoint, so the current bar's progress cannot
   * have arrived) and comparing against it overshot the target by a bar or two.
   */
  private async handleStopped(
    msg: DapMessage,
    threadId: number | undefined,
    reason: string | undefined
  ): Promise<void> {
    const target = this.runToBarTarget;
    const eligible = reason === 'breakpoint' || reason === 'step';
    if (threadId !== undefined && target !== undefined && eligible) {
      let barIndex: number | undefined;
      try {
        barIndex = await this.readBarIndex(threadId);
      } catch {
        barIndex = undefined; // read failed: fall through and stop (never run away)
      }
      if (barIndex !== undefined && barIndex < target) {
        this.resume(threadId);
        return; // swallow: no stopped event, no exec-state change
      }
      this.runToBarTarget = undefined; // reached the target bar: land here
    }
    // Pine-statement stepping: a user step that landed on another Python
    // statement of the SAME Pine statement (same .pine line, same function) is
    // not progress the user can see — swallow the stop and step again. The
    // moment the top frame maps to a different Pine line (or enters another
    // function, or stops for any other reason), the stop surfaces.
    if (reason === 'step' && threadId !== undefined && this.stepContext?.threadId === threadId) {
      const ctx = this.stepContext;
      if (ctx.autoSteps < MAX_AUTO_STEPS) {
        let samePineStatement = false;
        try {
          const top = await this.readTopFrame(threadId);
          if (top?.path !== undefined && top.line !== undefined) {
            const pine = this.mapper?.pyToPine(top.path, top.line);
            samePineStatement =
              pine !== undefined &&
              pine.path === ctx.pinePath &&
              pine.line === ctx.pineLine &&
              top.name === ctx.frameName;
          }
        } catch {
          samePineStatement = false; // can't tell: surface the stop, never spin
        }
        if (samePineStatement) {
          ctx.autoSteps++;
          this.write({
            seq: this.internalSeq++,
            type: 'request',
            command: ctx.command,
            arguments: { threadId },
          });
          return; // swallow: the client never sees the intermediate stop
        }
      }
    }
    this.stepContext = undefined;
    // Surfacing a real stop: the bar-stop breakpoint (if armed for this hop) has
    // done its job — disarm it so a plain Continue runs free to the next user
    // breakpoint instead of stopping on every bar.
    if (this.barStopArmed) {
      this.barStopArmed = false;
      await this.sendMainFileBreakpoints(false);
    }
    this.stopGeneration++;
    this.frameNames.clear();
    this.localsRefs.clear();
    this.pyneScopeRefs.clear();
    this.globalsScopeRefs.clear();
    this.pineSlotsCache.clear();
    // Bind the script's imported source names into the module globals BEFORE
    // surfacing the stop, so a watch expression like `close` resolves to
    // lib.close instead of a NameError (the transform rewrote all bare source
    // references to lib.* and dropped the import). Best-effort; refreshed here
    // every stop.
    if (threadId !== undefined) {
      try {
        await this.bindSources(threadId);
      } catch {
        // watch source-name binding is a convenience; a failure just leaves
        // bare `close` unresolved, exactly as before.
      }
    }
    this.hooks.onExecState(true, threadId, reason);
    this.emit(msg);
  }

  /** Bind imported source names into the module globals (see debug_inspect). */
  private async bindSources(threadId: number): Promise<void> {
    const stack = await this.request('stackTrace', { threadId, levels: 1 });
    const frames = stack.stackFrames as { id: number }[] | undefined;
    const frameId = frames?.[0]?.id;
    if (typeof frameId !== 'number') return;
    await this.evaluate(
      '__import__("pyneide_bridge.debug_inspect", fromlist=["bind_sources"]).bind_sources(globals())',
      frameId
    );
  }

  /** Top stack frame of a suspended thread (own-seq; raw .py terms). */
  private async readTopFrame(
    threadId: number
  ): Promise<{ path?: string; line?: number; name?: string } | undefined> {
    const stack = await this.request('stackTrace', { threadId, levels: 1 });
    const frames = stack.stackFrames as
      | { name?: string; line?: number; source?: { path?: string } }[]
      | undefined;
    const top = frames?.[0];
    if (!top) return undefined;
    return { path: top.source?.path, line: top.line, name: top.name };
  }

  /** Live `bar_index` of the suspended debuggee (pynecore.lib, module scope). */
  private async readBarIndex(threadId: number): Promise<number> {
    const stack = await this.request('stackTrace', { threadId, levels: 1 });
    const frames = stack.stackFrames as { id: number }[] | undefined;
    const frameId = frames?.[0]?.id;
    if (typeof frameId !== 'number') throw new Error('no frame for bar_index');
    const body = await this.evaluate(
      '__import__("pynecore.lib", fromlist=["bar_index"]).bar_index',
      frameId
    );
    const value = Number(body.result);
    if (!Number.isFinite(value)) throw new Error(`bad bar_index: ${String(body.result)}`);
    return value;
  }

  // --- variable scope composition -----------------------------------------------

  /**
   * Answer a proxy-owned scope's `variables` request in-session, without a
   * server round-trip: evaluate the debug_inspect helper (Pyne bar data or
   * curated Globals), then send the client a variables response stamped with
   * its own request seq. On any failure the scope comes back empty rather than
   * surfacing the error to VSCode.
   */
  private async answerSyntheticScope(
    requestSeq: number,
    expr: string,
    frameId: number
  ): Promise<void> {
    let entries: PineEntry[] = [];
    try {
      entries = await this.evalEntries(expr, frameId);
    } catch {
      entries = [];
    }
    const variables = entries.map((e) => ({
      name: e.name,
      value: e.value,
      type: e.type,
      variablesReference: 0,
      presentationHint: { kind: 'data' },
    }));
    normalizeNaVariables(variables);
    this.emit({
      seq: this.syntheticSeq++,
      type: 'response',
      request_seq: requestSeq,
      success: true,
      command: 'variables',
      body: { variables },
    });
  }

  private async enrichLocals(frameId: number, msg: DapMessage): Promise<void> {
    const body = msg.body as { variables: Record<string, unknown>[] };
    // Curate the raw Locals: hide the transform's hidden state param
    // (`__state__`, `__state·main__`) and any pydevd group pseudo-nodes
    // ("special variables" — a space no identifier can have). What remains is
    // the script's own locals, including PyneComp's `__block_result__` etc.
    const userLocals = body.variables.filter(
      (v) => typeof v.name === 'string' && !isJunkLocal(v.name)
    );
    try {
      // The scope's named persistent/series state leads, then the real locals.
      // A state slot whose name is also a real local of this frame (a series
      // assignment keeps the current value in the variable's own name) is ONE
      // variable to the user: the plain local's value stays behind the equals
      // sign, and for a series the entry expands into the slot's history
      // instead of listing twice.
      const injected = await this.pineSlotVariables(frameId);
      const localIndex = new Map<string, number>();
      userLocals.forEach((v, i) => localIndex.set(String(v.name), i));
      const merged = new Set<number>();
      const lead: Record<string, unknown>[] = [];
      for (const { slot, variable } of injected) {
        const idx = slot.own ? localIndex.get(slot.name) : undefined;
        if (idx === undefined) {
          lead.push(variable);
          continue;
        }
        // The plain local keeps the current scalar behind the equals sign, but
        // takes the slot's source type (`Series[float]`) and — for a series —
        // the buffer's variablesReference so it expands into history. The scalar
        // may itself be NA (shown `na`); the series buffer still expands.
        merged.add(idx);
        const localVar = userLocals[idx];
        lead.push({
          ...localVar,
          type: slot.type,
          value: localVar.type === 'NA' ? 'na' : localVar.value,
          ...(slot.kind === 'series'
            ? { variablesReference: variable.variablesReference ?? 0 }
            : { variablesReference: localVar.type === 'NA' ? 0 : localVar.variablesReference }),
        });
      }
      body.variables = [...lead, ...userLocals.filter((_, i) => !merged.has(i))];
    } catch {
      // Enrichment is best-effort: on failure the filtered Locals still pass.
      body.variables = userLocals;
    }
    // The injected entries come from own-seq evaluates the client-facing NA
    // pass never saw.
    normalizeNaVariables(body.variables);
    // Compiler-renamed locals/state read as their Pine originals; a name that
    // would collide (two block-scoped Pine `x`s in one frame) stays mangled.
    if (this.mapper) demangleVariables(body.variables);
    this.emit(msg);
  }

  /** The frame's named persistent/series state slots as Locals variables. */
  private async pineSlotVariables(
    frameId: number
  ): Promise<{ slot: PineSlot; variable: Record<string, unknown> }[]> {
    const generation = this.stopGeneration;
    let slotsPromise = this.pineSlotsCache.get(frameId);
    if (!slotsPromise) {
      slotsPromise = this.fetchPineSlots(frameId);
      this.pineSlotsCache.set(frameId, slotsPromise);
    }
    const slots = await slotsPromise;
    if (generation !== this.stopGeneration) return [];

    const slotVars = await Promise.all(
      slots.map(async (slot) => {
        const expr = slotExpression(slot);
        try {
          const body = await this.evaluate(expr, frameId);
          if (generation !== this.stopGeneration) return undefined;
          // Pine state reads apart from plain locals through its source-level
          // TYPE, not a name tag: `Series[float]` / `Persistent[int]` (the
          // SeriesImpl repr / raw scalar type would hide what it is). An NA slot
          // shows a plain `na` and does not expand (its children are internals).
          const isNa = body.type === 'NA';
          return {
            slot,
            variable: {
              name: slot.name,
              value: isNa ? 'na' : String(body.result ?? ''),
              type: slot.type,
              variablesReference:
                !isNa && typeof body.variablesReference === 'number'
                  ? body.variablesReference
                  : 0,
              evaluateName: expr,
              presentationHint: { kind: 'data' },
            },
          };
        } catch {
          return undefined;
        }
      })
    );
    return slotVars.filter((v): v is NonNullable<typeof v> => v !== undefined);
  }

  private async fetchPineSlots(frameId: number): Promise<PineSlot[]> {
    const frameName = this.frameNames.get(frameId);
    if (!frameName || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(frameName)) return [];
    const expr =
      '__import__("pyneide_bridge.debug_inspect", fromlist=["pine_slots"])' +
      `.pine_slots(locals(), globals(), "${frameName}")`;
    const slots = (await this.evalEntries(expr, frameId)) as unknown as PineSlot[];
    return slots.slice(0, MAX_PINE_SLOTS);
  }

  /**
   * Evaluate a debug_inspect helper (whose result is repr(str) of a base64 JSON
   * array) and decode it. Returns [] if the result is not the expected shape.
   */
  private async evalEntries(expr: string, frameId: number): Promise<PineEntry[]> {
    const body = await this.evaluate(expr, frameId);
    const match = /^'([A-Za-z0-9+/=]*)'$/.exec(String(body.result ?? ''));
    if (!match) return [];
    const decoded = JSON.parse(Buffer.from(match[1], 'base64').toString('utf8'));
    return Array.isArray(decoded) ? (decoded as PineEntry[]) : [];
  }

  /**
   * Resume the debuggee with an own-seq `continue` the client never sees (the
   * response is filtered out by the INTERNAL_SEQ_BASE range). Used to skip
   * intermediate run-to-bar stops without surfacing them to VSCode.
   */
  private resume(threadId: number): void {
    const seq = this.internalSeq++;
    this.write({ seq, type: 'request', command: 'continue', arguments: { threadId } });
  }

  // --- run-to-bar breakpoint toggle -------------------------------------------

  /** Arm/disarm the run-to-bar target bar (see DebugBreakpointControl). */
  setRunToBarTarget(target: number | undefined): void {
    this.runToBarTarget = target;
  }

  /** Live bar_index of the suspended debuggee, undefined on any failure. */
  async currentBarIndex(threadId: number | undefined): Promise<number | undefined> {
    if (threadId === undefined) return undefined;
    try {
      return await this.readBarIndex(threadId);
    } catch {
      return undefined;
    }
  }

  /** Arm the bridge's run-to-bar target in-session (see DebugBreakpointControl). */
  async armBridgeRunTo(threadId: number | undefined, bar: number): Promise<void> {
    if (threadId === undefined) throw new Error('no thread to arm run-to-bar on');
    const stack = await this.request('stackTrace', { threadId, levels: 1 });
    const frames = stack.stackFrames as { id: number }[] | undefined;
    const frameId = frames?.[0]?.id;
    if (typeof frameId !== 'number') throw new Error('no frame to arm run-to-bar on');
    await this.evaluate(
      `__import__("pyneide_bridge.control", fromlist=["request_runto"]).request_runto(${Math.trunc(bar)})`,
      frameId
    );
  }

  /** True if any source has active line breakpoints (something to land on). */
  hasBreakpoints(): boolean {
    for (const args of this.clientBreakpoints.values()) {
      const bps = args.breakpoints;
      if (Array.isArray(bps) && bps.length > 0) return true;
    }
    return false;
  }

  /** Remove all breakpoints from the debuggee (VSCode's view is untouched). */
  async suppressBreakpoints(): Promise<void> {
    const reqs: Promise<unknown>[] = [];
    let mainCovered = false;
    for (const [key, args] of this.clientBreakpoints) {
      reqs.push(this.request('setBreakpoints', { ...args, breakpoints: [] }).catch(() => {}));
      if (this.isMainFileKey(key)) mainCovered = true;
    }
    // The synthetic bar-stop breakpoint may live in the main file even when the
    // user set no breakpoints there — clear it too so the fly runs untraced.
    if (this.barStopFile !== undefined && !mainCovered) {
      reqs.push(
        this
          .request('setBreakpoints', {
            source: { path: this.barStopFile },
            breakpoints: [],
            lines: [],
            sourceModified: false,
          })
          .catch(() => {})
      );
    }
    if (this.clientExceptionBreakpoints) {
      reqs.push(
        this
          .request('setExceptionBreakpoints', { filters: [], filterOptions: [], exceptionOptions: [] })
          .catch(() => {})
      );
    }
    await Promise.all(reqs);
  }

  /** Re-arm the breakpoints exactly as the client last set them (plus the
   * bar-stop breakpoint when it is armed, so the run-to-bar crawl lands). */
  async restoreBreakpoints(): Promise<void> {
    const reqs: Promise<unknown>[] = [];
    let mainCovered = false;
    for (const [key, args] of this.clientBreakpoints) {
      if (this.isMainFileKey(key)) {
        reqs.push(
          this.request('setBreakpoints', this.mainFileBreakpoints(this.barStopArmed)).catch(() => {})
        );
        mainCovered = true;
      } else {
        reqs.push(this.request('setBreakpoints', args).catch(() => {}));
      }
    }
    if (this.barStopArmed && this.barStopFile !== undefined && !mainCovered) {
      reqs.push(this.request('setBreakpoints', this.mainFileBreakpoints(true)).catch(() => {}));
    }
    if (this.clientExceptionBreakpoints) {
      reqs.push(
        this.request('setExceptionBreakpoints', this.clientExceptionBreakpoints).catch(() => {})
      );
    }
    await Promise.all(reqs);
  }

  // --- bar-stop breakpoint (Next bar / Run to bar) -----------------------------

  setBarStopLocation(file: string, line: number): void {
    this.barStopFile = file;
    this.barStopLine = line;
  }

  canBarStop(): boolean {
    return this.barStopFile !== undefined && this.barStopLine !== undefined;
  }

  setBarStopArmed(armed: boolean): void {
    this.barStopArmed = armed;
  }

  async armBarStop(): Promise<void> {
    if (!this.canBarStop()) return;
    this.barStopArmed = true;
    await this.sendMainFileBreakpoints(true);
  }

  async disarmBarStop(): Promise<void> {
    if (!this.barStopArmed) return;
    this.barStopArmed = false;
    await this.sendMainFileBreakpoints(false);
  }

  /** True if `key` (a client source path) is the script's main file. */
  private isMainFileKey(key: string): boolean {
    if (this.barStopFile === undefined) return false;
    return path.resolve(key).toLowerCase() === path.resolve(this.barStopFile).toLowerCase();
  }

  /** The client's stored setBreakpoints args for the main file, if any. */
  private mainFileClientArgs(): Record<string, unknown> | undefined {
    for (const [key, args] of this.clientBreakpoints) {
      if (this.isMainFileKey(key)) return args;
    }
    return undefined;
  }

  /**
   * setBreakpoints args for the main file: the user's own breakpoints plus,
   * when `withSynthetic`, the hidden bar-stop breakpoint at main's first line.
   * Reuses the client's `source` object so pydevd keys the same file.
   */
  private mainFileBreakpoints(withSynthetic: boolean): Record<string, unknown> {
    const clientArgs = this.mainFileClientArgs();
    const clientBps = Array.isArray(clientArgs?.breakpoints)
      ? (clientArgs.breakpoints as Record<string, unknown>[])
      : [];
    const breakpoints = withSynthetic
      ? [...clientBps, { line: this.barStopLine }]
      : [...clientBps];
    return {
      source: clientArgs?.source ?? { path: this.barStopFile },
      breakpoints,
      lines: breakpoints.map((b) => b.line),
      sourceModified: false,
    };
  }

  /** Own-seq setBreakpoints for the main file (with/without the bar stop). */
  private async sendMainFileBreakpoints(withSynthetic: boolean): Promise<void> {
    if (this.barStopFile === undefined || this.barStopLine === undefined) return;
    await this.request('setBreakpoints', this.mainFileBreakpoints(withSynthetic)).catch(() => {});
  }

  private evaluate(expression: string, frameId: number): Promise<Record<string, unknown>> {
    // 'watch' context: silent (no debug-console echo), errors come back as a
    // failed response instead of raising in the debuggee.
    return this.request('evaluate', { expression, frameId, context: 'watch' });
  }

  /** Send an own-seq request to the debuggee and await its (filtered) response. */
  private request(command: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const seq = this.internalSeq++;
    const request: DapMessage = { seq, type: 'request', command, arguments: args };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.internalPending.delete(seq);
        reject(new Error(`${command} timeout`));
      }, INTERNAL_TIMEOUT_MS);
      this.internalPending.set(seq, {
        resolve: (body) => {
          clearTimeout(timer);
          resolve(body);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
      if (this.connected) this.write(request);
      else this.outQueue.push(request);
    });
  }
}

/**
 * Expression addressing one state slot from the stopped frame. The hidden
 * parameter of a function with nested defs is scope-qualified with a middle
 * dot (`__state·main__`); go through locals() for those instead of betting on
 * the parser accepting the character in an identifier.
 */
function slotExpression(slot: PineSlot): string {
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(slot.param)) return `${slot.param}[${slot.slot}]`;
  return `locals()[${JSON.stringify(slot.param)}][${slot.slot}]`;
}

/**
 * Rewrite every non-empty `condition` of a `setBreakpoints` request in place so
 * bare Pine builtins resolve at evaluation time (see {@link wrapCondition}).
 * `hitCondition` (a pydevd-counted numeric) and `logMessage` are left untouched.
 */
function wrapBreakpointConditions(args: Record<string, unknown>): void {
  const breakpoints = args.breakpoints;
  if (!Array.isArray(breakpoints)) return;
  for (const bp of breakpoints as Record<string, unknown>[]) {
    if (typeof bp.condition === 'string' && bp.condition.trim() !== '') {
      bp.condition = wrapCondition(bp.condition);
    }
  }
}

/**
 * Eldobható plumbing-temp nevek, amiket a function_isolation transformer szór be
 * izolált hívásoknál: `__st__` (child-state walrus), `__b__` (bind temp), `__i__`
 * (loop index) és a loop-hoist számláló/gyereklista párok (`__cnt_0__`,
 * `__chl_0__`, ...). Nem script-változók, csak a hívás-átírás melléktermékei.
 */
const ISOLATION_TEMP = /^(__st__|__b__|__i__|__cnt_\d+__|__chl_\d+__)$/;

/**
 * A top-level Locals entry that is Python plumbing rather than script state:
 * the transform's hidden state param (`__state__`, or scope-qualified
 * `__state·main__`), the function_isolation temps (see {@link ISOLATION_TEMP}),
 * plus pydevd's group pseudo-nodes ("special variables" — the space gives them
 * away, no Python identifier has one). Everything else stays, including
 * PyneComp's own dunder-named locals (`__block_result__`, `__switch__`,
 * `__eval__`, ...) which are meaningful script variables, not plumbing.
 * `__lib·close` is the hidden buffer a builtin source grows for `close[1]`
 * history — its live value already shows in the Pyne scope, so drop it here.
 */
function isJunkLocal(name: string): boolean {
  return (
    name === '__state__' ||
    name.startsWith('__state·') ||
    name.startsWith('__lib·') ||
    ISOLATION_TEMP.test(name) ||
    name.includes(' ')
  );
}

/** A CPython dunder attribute (`__class__`, `__dict__`, `__doc__`, ...). */
function isDunder(name: string): boolean {
  return name.startsWith('__') && name.endsWith('__');
}

/** repr of a pynecore NA sentinel: `NA` or a parametrized `NA[float]`. */
const NA_REPR = /^NA(\[\w+\])?$/;

/**
 * Present a pynecore NA the way Pine reads it: the parametrized repr
 * (`NA[float]`) moves into the type column, the value is a plain `na`, and
 * the node is not expandable — its children would only be CPython internals
 * (`_type_cache`, dunders, methods).
 */
function normalizeNaVariables(variables: Record<string, unknown>[]): void {
  for (const v of variables) {
    if (v.type === 'NA' && typeof v.value === 'string' && NA_REPR.test(v.value)) {
      v.type = v.value;
      v.value = 'na';
      v.variablesReference = 0;
      delete v.namedVariables;
      delete v.indexedVariables;
    }
  }
}

/** The same NA presentation for evaluate results (watch, hover, repl). */
function normalizeNaEvaluate(body: Record<string, unknown>): void {
  if (body.type === 'NA' && typeof body.result === 'string' && NA_REPR.test(body.result)) {
    body.type = body.result;
    body.result = 'na';
    body.variablesReference = 0;
    delete body.namedVariables;
    delete body.indexedVariables;
  }
}
