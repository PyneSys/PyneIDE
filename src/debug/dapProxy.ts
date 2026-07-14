/**
 * DAP proxy between VSCode and the bridge's debugpy listener.
 *
 * Instead of pointing VSCode directly at the endpoint (DebugAdapterServer),
 * an inline adapter relays the wire protocol so the Locals scope can be
 * enriched with the script's Pine-level state: persistent and series
 * variables live in anonymous `__state__[N]` slots at runtime, and only the
 * transform layout still knows their source names. On every Locals fetch the
 * proxy resolves the names in-session (an `evaluate` on the bridge's
 * pyneide_bridge.debug_inspect helper, which reads `__pyne_slot_layout__`)
 * and injects the named variables at the top of the list.
 *
 * The proxy also reports execution state (stopped at a breakpoint / resumed,
 * plus the thread id) so the RunService can compose bar-level controls with
 * debugger stops ("Next bar" while stopped = arm a feed pause + continue).
 */
import * as net from 'node:net';

import * as vscode from 'vscode';

/** Own requests use this seq range so they never collide with the client's. */
const INTERNAL_SEQ_BASE = 1 << 30;
const INTERNAL_TIMEOUT_MS = 5000;
/** Upper bound on injected variables — a runaway layout must not stall the UI. */
const MAX_PINE_SLOTS = 100;

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
  owner: string;
  own: boolean;
}

/** Current bar_index + OHLCV, rendered by the bridge helper (scalars). */
interface PineContextEntry {
  name: string;
  value: string;
  type: string;
}

interface PineData {
  context: PineContextEntry[];
  slots: PineSlot[];
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
  private readonly pendingStackTrace = new Set<number>();
  private readonly pendingScopes = new Map<number, number>(); // seq -> frameId
  private readonly pendingLocals = new Map<number, number>(); // seq -> frameId
  private readonly pendingResumes = new Set<number>();

  // Last breakpoint requests the client sent, replayed to toggle the debuggee's
  // breakpoints for the run-to-bar fast path (source path -> setBreakpoints args).
  private readonly clientBreakpoints = new Map<string, Record<string, unknown>>();
  private clientExceptionBreakpoints: Record<string, unknown> | undefined;

  // "Run to bar N": set while a run-to-bar is in flight (see setRunToBarTarget).
  private runToBarTarget: number | undefined;

  // Valid for the current stop only; cleared on every stopped event.
  private stopGeneration = 0;
  private readonly frameNames = new Map<number, string>();
  private readonly localsRefs = new Map<number, number>(); // variablesReference -> frameId
  private readonly pineDataCache = new Map<number, Promise<PineData>>(); // frameId

  constructor(
    host: string,
    port: number,
    private readonly hooks: PyneDapProxyHooks
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
    if (msg.type === 'request' && typeof msg.seq === 'number') this.trackClientRequest(msg);
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
        const source = args.source as { path?: string; name?: string } | undefined;
        const key = source?.path ?? source?.name;
        if (key) this.clientBreakpoints.set(key, args);
        break;
      }
      case 'setExceptionBreakpoints':
        this.clientExceptionBreakpoints = args;
        break;
      case 'stackTrace':
        this.pendingStackTrace.add(msg.seq);
        break;
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
        if (msg.command && RESUME_COMMANDS.has(msg.command)) this.pendingResumes.add(msg.seq);
    }
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

    if (msg.type === 'response' && typeof msg.request_seq === 'number') {
      const seq = msg.request_seq;
      if (this.pendingStackTrace.delete(seq) && msg.success) {
        const frames = (msg.body?.stackFrames ?? []) as { id: number; name: string }[];
        for (const frame of frames) this.frameNames.set(frame.id, frame.name);
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
            }
          }
          // Drop the module Globals scope entirely: it is the pynecore module
          // namespace (imported classes, lib functions, dunders) — Python noise
          // that buries the Pine essence. The curated Locals (bar context +
          // named state + user locals) is all a Pine developer needs; watch
          // expressions still reach anything else.
          msg.body.scopes = scopes.filter(
            (scope) => !(scope.presentationHint === 'globals' || scope.name === 'Globals')
          );
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
      }
    }

    this.emit(msg);
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
    this.stopGeneration++;
    this.frameNames.clear();
    this.localsRefs.clear();
    this.pineDataCache.clear();
    this.hooks.onExecState(true, threadId, reason);
    this.emit(msg);
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

  // --- Pine variable enrichment -------------------------------------------------

  private async enrichLocals(frameId: number, msg: DapMessage): Promise<void> {
    const body = msg.body as { variables: Record<string, unknown>[] };
    // Curate the raw Locals: hide the transform's hidden state params and
    // dunders (`__state__`, `__state·main__`, `__builtins__`, ...) and any
    // pydevd group pseudo-nodes ("special variables" — a space no identifier
    // can have). What remains is the script's own plain locals.
    const userLocals = body.variables.filter(
      (v) => typeof v.name === 'string' && !isJunkLocal(v.name)
    );
    try {
      const injected = await this.pineVariables(frameId);
      body.variables = [...injected, ...userLocals];
    } catch {
      // Enrichment is best-effort: on failure the filtered Locals still pass.
      body.variables = userLocals;
    }
    this.emit(msg);
  }

  private async pineVariables(frameId: number): Promise<Record<string, unknown>[]> {
    const generation = this.stopGeneration;
    let dataPromise = this.pineDataCache.get(frameId);
    if (!dataPromise) {
      dataPromise = this.fetchPineData(frameId);
      this.pineDataCache.set(frameId, dataPromise);
    }
    const data = await dataPromise;
    if (generation !== this.stopGeneration) return [];

    // Bar context first (bar_index leads), then named persistent/series slots.
    const contextVars = data.context.map((entry) => ({
      name: entry.name,
      value: entry.value,
      type: entry.type,
      variablesReference: 0,
      presentationHint: { kind: 'data' },
    }));

    const slotVars = await Promise.all(
      data.slots.map(async (slot) => {
        const expr = slotExpression(slot);
        try {
          const body = await this.evaluate(expr, frameId);
          if (generation !== this.stopGeneration) return undefined;
          const suffixParts = [
            ...(slot.kind === 'series' ? ['series'] : []),
            ...(slot.own ? [] : [slot.owner]),
          ];
          const suffix = suffixParts.length ? ` (${suffixParts.join(', ')})` : '';
          return {
            name: `${slot.name}${suffix}`,
            value: String(body.result ?? ''),
            type: typeof body.type === 'string' ? body.type : undefined,
            variablesReference:
              typeof body.variablesReference === 'number' ? body.variablesReference : 0,
            evaluateName: expr,
            presentationHint: { kind: 'data' },
          };
        } catch {
          return undefined;
        }
      })
    );
    return [...contextVars, ...slotVars.filter((v): v is NonNullable<typeof v> => v !== undefined)];
  }

  private async fetchPineData(frameId: number): Promise<PineData> {
    const empty: PineData = { context: [], slots: [] };
    const frameName = this.frameNames.get(frameId);
    if (!frameName || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(frameName)) return empty;
    const expr =
      '__import__("pyneide_bridge.debug_inspect", fromlist=["pine_slots"])' +
      `.pine_slots(locals(), globals(), "${frameName}")`;
    const body = await this.evaluate(expr, frameId);
    // The evaluate result is repr(str) of the base64 payload.
    const match = /^'([A-Za-z0-9+/=]*)'$/.exec(String(body.result ?? ''));
    if (!match) return empty;
    const payload = JSON.parse(Buffer.from(match[1], 'base64').toString('utf8')) as {
      context?: PineContextEntry[];
      slots?: PineSlot[];
    };
    return {
      context: payload.context ?? [],
      slots: (payload.slots ?? []).slice(0, MAX_PINE_SLOTS),
    };
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
    for (const args of this.clientBreakpoints.values()) {
      reqs.push(this.request('setBreakpoints', { ...args, breakpoints: [] }).catch(() => {}));
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

  /** Re-arm the breakpoints exactly as the client last set them. */
  async restoreBreakpoints(): Promise<void> {
    const reqs: Promise<unknown>[] = [];
    for (const args of this.clientBreakpoints.values()) {
      reqs.push(this.request('setBreakpoints', args).catch(() => {}));
    }
    if (this.clientExceptionBreakpoints) {
      reqs.push(
        this.request('setExceptionBreakpoints', this.clientExceptionBreakpoints).catch(() => {})
      );
    }
    await Promise.all(reqs);
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
 * A top-level Locals entry that is Python plumbing rather than script state:
 * the transform's hidden `__state__` params and any dunder, plus pydevd's
 * group pseudo-nodes ("special variables" — the space gives them away, no
 * Python identifier has one).
 */
function isJunkLocal(name: string): boolean {
  return name.startsWith('__') || name.includes(' ');
}
