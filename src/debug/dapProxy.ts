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
 */
import * as net from 'node:net';

import * as vscode from 'vscode';

/** Own requests use this seq range so they never collide with the client's. */
const INTERNAL_SEQ_BASE = 1 << 30;
const INTERNAL_TIMEOUT_MS = 5000;
/** Upper bound on injected variables — a runaway layout must not stall the UI. */
const MAX_PINE_SLOTS = 100;
/** variablesReference range for the proxy's own synthetic scopes (Pyne). */
const SYNTHETIC_REF_BASE = 1_500_000_000;
/** seq range for responses the proxy sends the client without a server round-trip. */
const SYNTHETIC_SEQ_BASE = 1_400_000_000;

/** debug_inspect helper expressions, evaluated in the stopped frame. */
const PINE_BAR_EXPR =
  '__import__("pyneide_bridge.debug_inspect", fromlist=["pine_bar"]).pine_bar()';
const PINE_GLOBALS_EXPR =
  '__import__("pyneide_bridge.debug_inspect", fromlist=["pine_globals"]).pine_globals(globals())';

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
        }
        normalizeNaVariables(msg.body.variables as Record<string, unknown>[]);
      } else if (msg.command === 'evaluate') {
        normalizeNaEvaluate(msg.body);
      }
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
        merged.add(idx);
        lead.push({
          ...userLocals[idx],
          ...(slot.kind === 'series'
            ? { variablesReference: variable.variablesReference ?? 0 }
            : {}),
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
          const suffixParts = [
            ...(slot.kind === 'series' ? ['series'] : []),
            ...(slot.own ? [] : [slot.owner]),
          ];
          const suffix = suffixParts.length ? ` (${suffixParts.join(', ')})` : '';
          return {
            slot,
            variable: {
              name: `${slot.name}${suffix}`,
              value: String(body.result ?? ''),
              type: typeof body.type === 'string' ? body.type : undefined,
              variablesReference:
                typeof body.variablesReference === 'number' ? body.variablesReference : 0,
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
 */
function isJunkLocal(name: string): boolean {
  return (
    name === '__state__' ||
    name.startsWith('__state·') ||
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
