/**
 * Run Pyne/Pine scripts through the runner bridge.
 *
 * Owns the `pyneide.runScript` / `pyneide.debugScript` commands, the Run and
 * Debug CodeLenses / editor-title buttons (via the `pyneide.isPyneScript`
 * context key), the minimal data picker, the run lifecycle (status bar,
 * cancellation, logs), the bar-level controls (pause / next bar / run to
 * bar N — commands surfaced in the debug toolbar and a status bar menu),
 * and the debug flow (bridge with a debugpy listener + `pyne` attach
 * session). The chart webview subscribes to the same event stream.
 *
 * Bar controls compose with debugger stops: while execution sits at a
 * breakpoint, "Next bar" arms a feed pause at the next bar boundary and
 * continues the debugger; "Run to bar N" additionally auto-continues
 * intermediate breakpoint hits until the target bar is reached.
 */
import * as path from 'node:path';

import * as vscode from 'vscode';

import type { CompileService } from '../compile/service';
import type { DebugBreakpointControl } from '../debug/dapProxy';
import type { EnvManager } from '../env/manager';
import { resolveWorkspaceWorkdir } from '../env/workdirConfig';
import { detectPyne, DETECT_HEAD_BYTES } from '../pyneDetect';
import { BridgeRun, type BridgeEvent, type TradeRecord } from './bridgeClient';
import { pickRunData } from './dataSelect';

export interface RunListener {
  onEvent(event: BridgeEvent): void;
  onFinished(): void;
}

export type RunControlAction = 'pause' | 'resume' | 'step' | 'cancel';

/** How long a debug launch waits for the bridge to report its debugpy port. */
const DEBUG_ENDPOINT_TIMEOUT_MS = 30000;
/** Grace given to a cancelled run to exit before a restart hard-kills it. */
const RUN_DRAIN_GRACE_MS = 4000;

interface PreparedRun {
  pythonBin: string;
  scriptPath: string;
  data: string;
  workdir: string;
}

export class RunService {
  private readonly output = vscode.window.createOutputChannel('PyneIDE Run');
  private readonly statusItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    90
  );
  private activeRun: BridgeRun | undefined;
  private activeScriptName = '';
  private paused = false;
  private barsDone = 0;
  private barsTotal = 0;
  private debugSession: vscode.DebugSession | undefined;
  /**
   * Endpoint of the bridge a launch just spawned, handed to the adapter factory
   * (createDebugAdapterDescriptor). Consumed once; a restart finds it empty (or
   * mismatched) and spawns a fresh bridge instead (see acquireDebugEndpoint).
   */
  private pendingDebugEndpoint: { host: string; port: number } | undefined;
  /** Debugger execution state, reported by the DAP proxy. */
  private debugStopped = false;
  private debugThreadId: number | undefined;
  /**
   * Run-to-bar fast path: while set, breakpoints are removed from the debuggee
   * and the feed flies at native speed under a bridge-side run-to target. When
   * the feed self-pauses at that target (a `state:paused` event) breakpoints are
   * restored and the feed resumed so the last few bars crawl on the per-bar
   * breakpoint and land exactly on `target`. Undefined once handed off (or
   * aborted).
   */
  private flyToBar: { target: number } | undefined;
  /** Breakpoint toggle on the active debug proxy (run-to-bar fast path). */
  private debugControl: DebugBreakpointControl | undefined;
  /** External subscriber (chart webview) for the live event stream. */
  listener: RunListener | undefined;

  /** How many trailing bars of a run-to-bar crawl on the per-bar breakpoint
   * (the rest fly with breakpoints removed). */
  private static readonly RUN_TO_BAR_CRAWL = 2;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly manager: EnvManager,
    private readonly compile: CompileService
  ) {}

  register(): void {
    const selector = [{ language: 'python' }, { language: 'pine' }];
    this.statusItem.command = 'pyneide.runControlMenu';
    this.statusItem.tooltip = 'Pyne run — bar-level controls';
    this.context.subscriptions.push(
      this.output,
      this.statusItem,
      vscode.commands.registerCommand('pyneide.runScript', (uri?: vscode.Uri) =>
        this.runFromCommand(uri)
      ),
      vscode.commands.registerCommand('pyneide.debugScript', (uri?: vscode.Uri) =>
        this.debugFromCommand(uri)
      ),
      vscode.commands.registerCommand('pyneide.pauseRun', () => this.control('pause')),
      vscode.commands.registerCommand('pyneide.resumeRun', () => this.control('resume')),
      vscode.commands.registerCommand('pyneide.stepBar', () => this.control('step')),
      vscode.commands.registerCommand('pyneide.cancelRun', () => this.control('cancel')),
      vscode.commands.registerCommand('pyneide.runToBar', () => this.runToBar()),
      vscode.commands.registerCommand('pyneide.runControlMenu', () => this.controlMenu()),
      vscode.debug.onDidStartDebugSession((session) => {
        if (session.type === 'pyne') this.debugSession = session;
      }),
      vscode.debug.onDidTerminateDebugSession((session) => {
        if (session !== this.debugSession) return;
        this.debugSession = undefined;
        this.debugStopped = false;
        this.debugThreadId = undefined;
        this.flyToBar = undefined;
        this.debugControl = undefined;
        // Stopping the debug session stops the run: a detached-but-running
        // backtest with no debugger and no chart control would be a trap.
        this.activeRun?.cancel();
      }),
      vscode.languages.registerCodeLensProvider(selector, new RunCodeLensProvider()),
      vscode.window.onDidChangeActiveTextEditor(() => this.updateContextKey()),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document === vscode.window.activeTextEditor?.document) this.updateContextKey();
      })
    );
    this.updateContextKey();
  }

  private updateContextKey(): void {
    const doc = vscode.window.activeTextEditor?.document;
    const isPyne =
      doc?.languageId === 'pine' ||
      (doc?.languageId === 'python' &&
        detectPyne(doc.getText().slice(0, DETECT_HEAD_BYTES)) !== undefined);
    void vscode.commands.executeCommand('setContext', 'pyneide.isPyneScript', isPyne === true);
  }

  private async runFromCommand(uri?: vscode.Uri): Promise<void> {
    const doc = await this.resolveDocument(uri);
    if (!doc) return;
    await this.runDocument(doc);
  }

  /** The Debug button/CodeLens routes through the `pyne` debug type, so the
   * launch pipeline and launch.json configs share one code path. */
  private async debugFromCommand(uri?: vscode.Uri): Promise<void> {
    const doc = await this.resolveDocument(uri);
    if (!doc) return;
    const folder = vscode.workspace.getWorkspaceFolder(doc.uri);
    await vscode.debug.startDebugging(folder, {
      type: 'pyne',
      request: 'launch',
      name: `Debug ${path.basename(doc.uri.fsPath)}`,
      script: doc.uri.fsPath,
    });
  }

  private async resolveDocument(uri?: vscode.Uri): Promise<vscode.TextDocument | undefined> {
    if (uri) return vscode.workspace.openTextDocument(uri);
    return vscode.window.activeTextEditor?.document;
  }

  async runDocument(doc: vscode.TextDocument): Promise<void> {
    const prepared = await this.prepareRun(doc);
    if (!prepared) return;
    await this.executeRun(prepared);
  }

  /**
   * Resolve a `pyne` launch config into an attach config on the bridge's
   * debugpy endpoint (see debug/pyneDebug.ts). Starts the run in the
   * background; returns null (silently aborting the debug session) when any
   * pipeline step is declined or the endpoint never arrives.
   */
  async resolveDebugLaunch(
    _folder: vscode.WorkspaceFolder | undefined,
    config: vscode.DebugConfiguration
  ): Promise<vscode.DebugConfiguration | null> {
    const doc = config.script
      ? await vscode.workspace.openTextDocument(String(config.script))
      : vscode.window.activeTextEditor?.document;
    if (!doc) {
      void vscode.window.showWarningMessage('PyneIDE: no script to debug.');
      return null;
    }

    // "Run Without Debugging" falls back to a plain run.
    if (config.noDebug) {
      void this.runDocument(doc);
      return null;
    }

    const prepared = await this.prepareRun(doc, {
      data: typeof config.data === 'string' && config.data ? config.data : undefined,
    });
    if (!prepared) return null;

    const ep = await this.spawnDebugRun(prepared);
    if (!ep) return null;
    // Hand the live endpoint to the adapter factory. On a restart VSCode reuses
    // THIS resolved config (dead port and all) without re-resolving, so the
    // factory reads pyneManaged/data to spawn a fresh bridge (acquireDebugEndpoint).
    this.pendingDebugEndpoint = ep;

    const justMyCode =
      typeof config.justMyCode === 'boolean'
        ? config.justMyCode
        : vscode.workspace
            .getConfiguration('pyneide', doc.uri)
            .get<boolean>('debug.justMyCode', true);
    return {
      ...config,
      request: 'attach',
      connect: { host: ep.host, port: ep.port },
      pyneManaged: true,
      // Freeze the resolved data so a restart reuses it instead of re-prompting.
      data: prepared.data,
      justMyCode,
      // Keep stepping inside the user's Pyne script, never in the runner.
      // Both the bridge and (in dev) the editable pynecore checkout live
      // outside site-packages, so justMyCode would treat them as user code
      // and stepping past the last line of a bar would surface runner
      // internals (script_runner.run_main, lib._plot_data.update, ...).
      rules: [
        { path: '**/pyneide_bridge/**', include: false },
        { path: '**/pynecore/**', include: false },
      ],
      // Methods and class-valued attributes are noise when expanding a value, so
      // pydevd hides them globally. `special` (dunders) and `protected` (`_name`)
      // are INLINE, not hidden: PyneComp emits meaningful dunder locals
      // (`__block_result__`, `__switch__`, ...) and `_name`-renamed params
      // (`_type`), all of which the developer needs — the DAP proxy curates the
      // frame (drops only the `__state__` plumbing) and strips dunder noise from
      // object expansions itself, which a single global flag can't separate.
      // NB: debugpy defaults every unset key to `all` ("group"), not pydevd's
      // per-key default, so protected/special MUST be set explicitly. launch.json
      // can override any group.
      variablePresentation: {
        special: 'inline',
        protected: 'inline',
        function: 'hide',
        class: 'hide',
        ...((config.variablePresentation as Record<string, unknown> | undefined) ?? {}),
      },
    };
  }

  /**
   * Provide the debugpy endpoint the `pyne` adapter factory should connect to.
   *
   * VSCode restart reuses the RESOLVED attach config (whose port died with the
   * first launch's bridge) and re-invokes the factory WITHOUT re-running config
   * resolution — so a fresh live endpoint is minted here, not in resolveDebugLaunch:
   *  - user-authored `attach`: connect to their endpoint verbatim;
   *  - initial launch: hand over the endpoint resolveDebugLaunch just spawned;
   *  - restart: drain the run the terminated session left cancelling, then spawn
   *    a fresh bridge for the same script (recompiling, reusing the picked data).
   */
  async acquireDebugEndpoint(
    config: vscode.DebugConfiguration
  ): Promise<{ host: string; port: number } | undefined> {
    const connect = config.connect as { host?: string; port?: number } | undefined;
    if (!config.pyneManaged) {
      return connect?.port ? { host: connect.host ?? '127.0.0.1', port: connect.port } : undefined;
    }
    const pending = this.pendingDebugEndpoint;
    if (pending && connect?.port === pending.port) {
      this.pendingDebugEndpoint = undefined;
      return pending;
    }
    return this.relaunchDebug(config);
  }

  /** Spawn a bridge run in the background and resolve once it reports its
   * debugpy endpoint; undefined if the run dies or times out first. */
  private async spawnDebugRun(
    prepared: PreparedRun
  ): Promise<{ host: string; port: number } | undefined> {
    let onEndpoint: (ep: { host: string; port: number }) => void;
    const endpoint = new Promise<{ host: string; port: number } | undefined>((resolve) => {
      onEndpoint = resolve;
      setTimeout(() => resolve(undefined), DEBUG_ENDPOINT_TIMEOUT_MS);
    });
    const runDone = this.executeRun({
      ...prepared,
      debug: { onEndpoint: (host, port) => onEndpoint({ host, port }) },
    });
    // A run that dies before reporting the endpoint (spawn failure, bad
    // script) must abort the debug session instead of waiting for the timeout.
    const ep = await Promise.race([endpoint, runDone.then(() => undefined)]);
    if (!ep) {
      this.output.appendLine('Debug launch aborted: no debugpy endpoint from the bridge.');
      this.activeRun?.cancel();
      return undefined;
    }
    return ep;
  }

  /** Restart path: rebuild the run pipeline for a resolved config and spawn a
   * fresh bridge, after draining the previous run the terminate left cancelling. */
  private async relaunchDebug(
    config: vscode.DebugConfiguration
  ): Promise<{ host: string; port: number } | undefined> {
    await this.drainActiveRun();
    const script = typeof config.script === 'string' ? config.script : undefined;
    if (!script) {
      void vscode.window.showWarningMessage('PyneIDE: cannot restart debugging — no script.');
      return undefined;
    }
    const doc = await vscode.workspace.openTextDocument(script);
    const prepared = await this.prepareRun(doc, {
      data: typeof config.data === 'string' && config.data ? config.data : undefined,
    });
    if (!prepared) return undefined;
    return this.spawnDebugRun(prepared);
  }

  /** Cancel the active run and wait for the process to exit (hard-kill on
   * grace timeout), so a restart's fresh launch never hits the "in progress"
   * guard. executeRun clears `activeRun` on exit, before this await resumes. */
  private async drainActiveRun(): Promise<void> {
    const run = this.activeRun;
    if (!run) return;
    run.cancel();
    const killer = setTimeout(() => run.kill(), RUN_DRAIN_GRACE_MS);
    try {
      await run.exited;
    } finally {
      clearTimeout(killer);
    }
  }

  /** Shared pipeline: compile (Pine), env, workdir, data. */
  private async prepareRun(
    doc: vscode.TextDocument,
    overrides?: { data?: string }
  ): Promise<PreparedRun | undefined> {
    if (this.activeRun) {
      void vscode.window.showWarningMessage(
        'PyneIDE: a run is already in progress. Cancel it first.'
      );
      return undefined;
    }
    if (doc.isDirty) await doc.save();

    // Resolve the runnable .py: a Pine run always compiles in the background
    // (content-hash cache skips the API when nothing changed).
    this.output.appendLine(`Run requested: ${doc.uri.fsPath} (${doc.languageId})`);
    let scriptPath = doc.uri.fsPath;
    if (doc.languageId === 'pine') {
      const compiled = await this.compile.ensureCompiledForRun(doc);
      if (!compiled) {
        this.output.appendLine('Run stopped: compilation did not produce a runnable .py.');
        return undefined;
      }
      scriptPath = compiled;
    } else if (doc.languageId === 'python') {
      if (detectPyne(doc.getText().slice(0, DETECT_HEAD_BYTES)) === undefined) {
        void vscode.window.showWarningMessage(
          'PyneIDE: this is not a Pyne script (the module docstring must start with @pyne).'
        );
        return undefined;
      }
    } else {
      void vscode.window.showWarningMessage(
        'PyneIDE: open a Pyne (.py) or Pine (.pine) script to run.'
      );
      return undefined;
    }

    this.output.appendLine(`Compiled OK, checking Python environment for: ${scriptPath}`);
    const pythonBin = await this.manager.ensureReady(
      'Running Pyne scripts needs the Python environment. Set it up now?'
    );
    if (!pythonBin) {
      this.output.appendLine('Run stopped: no Python environment available.');
      return undefined;
    }

    const workdir = await this.resolveOrInitWorkdir(doc, scriptPath);
    if (!workdir) {
      this.output.appendLine('Run stopped: no Pyne workdir resolved.');
      return undefined;
    }

    let data = overrides?.data;
    if (!data) {
      this.output.appendLine(`Workdir resolved: ${workdir} — opening data picker.`);
      data = await pickRunData(this.context, workdir, scriptPath, pythonBin, this.output);
    }
    if (!data) {
      this.output.appendLine('Run stopped: no data selected.');
      return undefined;
    }

    return { pythonBin, scriptPath, data, workdir };
  }

  /**
   * Resolve the workdir for a run; when the chain finds nothing, offer the
   * one-click project initialization — never silently adopt a folder.
   */
  private async resolveOrInitWorkdir(
    doc: vscode.TextDocument,
    scriptPath: string
  ): Promise<string | undefined> {
    const folder = vscode.workspace.getWorkspaceFolder(doc.uri);
    const resolve = (): string | undefined => {
      const res = resolveWorkspaceWorkdir(folder, path.dirname(scriptPath));
      return res?.exists ? res.path : undefined;
    };
    const existing = resolve();
    if (existing) return existing;

    const choice = await vscode.window.showInformationMessage(
      'PyneIDE: no Pyne workdir found for this script. Initialize the project first?',
      'Initialize Project'
    );
    if (choice !== 'Initialize Project') return undefined;
    await vscode.commands.executeCommand('pyneide.createWorkspace');
    return resolve();
  }

  // --- bar-level controls ---------------------------------------------------

  /** Debugger execution state, reported by the DAP proxy (real stops only —
   * intermediate run-to-bar stops are swallowed in the proxy). */
  onDebugExecState(stopped: boolean, threadId?: number): void {
    this.debugStopped = stopped;
    if (threadId !== undefined) this.debugThreadId = threadId;
  }

  /** The active debug proxy registers here so run-to-bar can toggle breakpoints. */
  setDebugControl(control: DebugBreakpointControl): void {
    this.debugControl = control;
  }

  /**
   * Abort an in-flight run-to-bar fly: breakpoints were removed for the fast
   * stretch, so they MUST be restored if the user takes manual control (or the
   * run ends) before the crawl handoff re-arms them.
   */
  private abortFly(): void {
    if (!this.flyToBar) return;
    this.flyToBar = undefined;
    void this.debugControl?.restoreBreakpoints();
  }

  /**
   * Run-to-bar handoff: the feed has flown (breakpoints off) to near the
   * target. Restore breakpoints, then free the feed — the per-bar breakpoint
   * now fires and the proxy auto-continues the last few bars until `target`.
   */
  private async handoffFly(): Promise<void> {
    const run = this.activeRun;
    if (!run || !this.debugControl) return;
    // Order matters: the breakpoints must be armed in the debuggee BEFORE the
    // feed is released, or the target bar's main() runs untraced and flies past.
    await this.debugControl.restoreBreakpoints();
    run.resume();
  }

  private async continueDebugger(): Promise<void> {
    if (!this.debugSession || this.debugThreadId === undefined) return;
    try {
      await this.debugSession.customRequest('continue', { threadId: this.debugThreadId });
    } catch {
      // Session died in the meantime: the run-end path cleans up.
    }
  }

  /** Route a control action to the active run (commands + control menu). */
  control(action: RunControlAction): void {
    const run = this.activeRun;
    if (!run) return;
    // Any manual control aborts a run-to-bar: restore the fly's breakpoints and
    // disarm the proxy's target bar.
    this.abortFly();
    this.debugControl?.setRunToBarTarget(undefined);
    switch (action) {
      case 'pause':
        run.pause();
        break;
      case 'resume':
        run.resume();
        if (this.debugStopped) void this.continueDebugger();
        break;
      case 'step':
        if (this.debugStopped) {
          // Stopped at a breakpoint: just continue. The feed is not gated
          // (the breakpoint is what suspends execution), so continuing runs
          // exactly one bar forward and the per-bar breakpoint re-fires — one
          // press, one bar. Arming a feed pause here would instead block the
          // next bar before its breakpoint could hit (the old two-press bug).
          void this.continueDebugger();
        } else if (this.paused) {
          run.step(1);
        } else {
          run.pause(); // while running, "next bar" means: stop at the next one
        }
        break;
      case 'cancel':
        run.cancel();
        break;
    }
  }

  private async runToBar(): Promise<void> {
    if (!this.activeRun) return;
    // When stopped at a breakpoint the LIVE bar_index is the true current bar;
    // this.barsDone (the async progress counter) can lag it badly under the
    // debug batchSize=1 chart-render backlog. Read it once and use it for the
    // prompt, the validation, AND sizing the fly below — a stale base makes the
    // fly overshoot the target (the "stopped at 153" bug).
    const liveBar = this.debugStopped
      ? await this.debugControl?.currentBarIndex(this.debugThreadId)
      : undefined;
    const currentBar = liveBar ?? this.barsDone;
    const value = await vscode.window.showInputBox({
      prompt: `Run to bar (current: ${currentBar.toLocaleString()}, total: ${this.barsTotal.toLocaleString()})`,
      validateInput: (input) => {
        const n = Number(input);
        if (!Number.isInteger(n)) return 'Enter a whole bar number';
        if (n <= currentBar) return `Must be greater than the current bar (${currentBar})`;
        return undefined;
      },
    });
    const target = Number(value);
    const run = this.activeRun;
    if (!value || !Number.isInteger(target) || !run || target <= currentBar) return;
    // The proxy lands the stop exactly at bar_index === target, reading the live
    // bar_index in-session (race-free); the fly below only gets the feed close.
    this.debugControl?.setRunToBarTarget(target);

    if (this.debugStopped) {
      // At a breakpoint: the per-bar breakpoint would otherwise stop (and trace)
      // every bar on the way — unusably slow. Fast path: remove breakpoints so
      // the debuggee runs untraced, arm a BRIDGE-side run-to target so the feed
      // self-pauses (on its own thread, race-free) a couple bars short of the
      // goal, then restore breakpoints while it is parked and crawl the last few
      // bars on the per-bar breakpoint to land exactly on `target`.
      const crawl = RunService.RUN_TO_BAR_CRAWL;
      const runto = target - crawl; // bridge parks the feed here (bars_done)
      // Only fly a real distance and only when there is a breakpoint to land on.
      if (runto > currentBar && this.debugControl?.hasBreakpoints()) {
        this.flyToBar = { target };
        const control = this.debugControl;
        // Suppress bp (untraced fly) and arm the bridge run-to BEFORE releasing
        // the debugger — both must land while the debuggee is still suspended.
        void (async () => {
          let armed = false;
          try {
            await control.suppressBreakpoints();
            await control.armBridgeRunTo(this.debugThreadId, runto);
            armed = true;
          } catch {
            // Could not arm the fast path: fall back to a plain continue; the
            // proxy still lands the crawl at target on the per-bar breakpoint.
            this.flyToBar = undefined;
            await control.restoreBreakpoints().catch(() => {});
          }
          // A manual control while we were arming aborts the fly — don't release.
          if (armed && this.flyToBar?.target !== target) return;
          this.continueDebugger();
        })();
        return;
      }
      // Target is within the crawl window: just continue; the per-bar
      // breakpoint + proxy auto-continue land on the target directly.
      void this.continueDebugger();
    } else if (this.paused) {
      // Feed paused at a bar boundary: budget covers bars currentBar+1 .. target.
      // A breakpoint hit on the way is auto-continued by the armed target.
      run.step(target - currentBar);
    } else {
      // Free-running with no active stop: pause and budget the feed to the
      // target boundary (the in-flight bar consumes no budget).
      run.pause();
      const budget = target - currentBar - 1;
      if (budget > 0) run.step(budget);
    }
  }

  private async controlMenu(): Promise<void> {
    if (!this.activeRun) return;
    type Item = vscode.QuickPickItem & { action: RunControlAction | 'runToBar' };
    const items: Item[] =
      this.paused || this.debugStopped
        ? [
            ...(this.paused ? [{ label: '$(debug-continue) Resume', action: 'resume' } as Item] : []),
            { label: '$(debug-step-over) Next bar', action: 'step' },
            { label: '$(run-below) Run to bar…', action: 'runToBar' },
            { label: '$(debug-stop) Cancel run', action: 'cancel' },
          ]
        : [
            { label: '$(debug-pause) Pause at next bar', action: 'pause' },
            { label: '$(run-below) Run to bar…', action: 'runToBar' },
            { label: '$(debug-stop) Cancel run', action: 'cancel' },
          ];
    const pick = await vscode.window.showQuickPick(items, {
      placeHolder: `${this.activeScriptName}: bar ${this.barsDone} / ${this.barsTotal}`,
    });
    if (!pick) return;
    if (pick.action === 'runToBar') await this.runToBar();
    else this.control(pick.action);
  }

  private setRunActive(active: boolean): void {
    void vscode.commands.executeCommand('setContext', 'pyneide.runActive', active);
    if (!active) this.setPaused(false);
    this.updateStatusItem(active);
  }

  private setPaused(paused: boolean): void {
    this.paused = paused;
    void vscode.commands.executeCommand('setContext', 'pyneide.runPaused', paused);
  }

  private updateStatusItem(active: boolean): void {
    if (!active) {
      this.statusItem.hide();
      return;
    }
    const bars = `${this.barsDone.toLocaleString()}/${this.barsTotal.toLocaleString()}`;
    this.statusItem.text = this.paused
      ? `$(debug-pause) ${this.activeScriptName} ${bars} (paused)`
      : `$(pulse) ${this.activeScriptName} ${bars}`;
    this.statusItem.show();
  }

  // --- run execution ----------------------------------------------------------

  private async executeRun(opts: {
    pythonBin: string;
    scriptPath: string;
    data: string;
    workdir: string;
    debug?: { onEndpoint: (host: string, port: number) => void };
  }): Promise<void> {
    const scriptName = path.basename(opts.scriptPath);
    this.output.appendLine(
      `--- ${opts.debug ? 'Debug' : 'Run'}: ${scriptName} on ${opts.data} (workdir: ${opts.workdir})`
    );

    let stats: Record<string, number | null> | undefined;
    let errorMessage: string | undefined;
    const trades: TradeRecord[] = [];
    let endBars = 0;
    let cancelled = false;

    this.activeScriptName = scriptName;
    this.barsDone = 0;
    this.barsTotal = 0;
    this.setRunActive(true);

    // No progress notification on purpose: the status bar item carries the
    // bar counter (and opens the control menu), the chart shows the stream.
    const run = BridgeRun.start({
      pythonBin: opts.pythonBin,
      bridgeRoot: vscode.Uri.joinPath(this.context.extensionUri, 'python').fsPath,
      script: opts.scriptPath,
      data: opts.data,
      workdir: opts.workdir,
      // Debug: listen on a free port and per-bar flushes, so the chart
      // shows every processed bar while execution sits at a breakpoint.
      ...(opts.debug ? { debugpyPort: 0, batchSize: 1 } : {}),
      onEvent: (event) => {
        switch (event.e) {
          case 'debugpy':
            opts.debug?.onEndpoint(event.host, event.port);
            break;
          case 'trades':
            trades.push(...event.d);
            break;
          case 'progress':
            this.barsDone = event.done;
            this.barsTotal = event.total;
            this.updateStatusItem(true);
            break;
          case 'state':
            if (event.state === 'paused' && this.flyToBar !== undefined) {
              // Run-to-bar fly: the feed self-paused at the bridge run-to target.
              // Restore breakpoints (it is parked, so they take effect before it
              // moves) and resume — the last few bars crawl on the per-bar
              // breakpoint and the proxy lands exactly on the target. Do NOT
              // surface this as a user-facing pause; it resumes immediately.
              this.flyToBar = undefined;
              void this.handoffFly();
            } else {
              this.setPaused(event.state === 'paused');
            }
            this.updateStatusItem(true);
            break;
          case 'stats':
            stats = event.d;
            break;
          case 'error':
            errorMessage = event.message;
            this.output.appendLine(event.traceback);
            break;
          case 'log':
            this.output.appendLine(`[${event.level}] ${event.message}`);
            break;
          case 'end':
            endBars = event.bars;
            cancelled = event.cancelled;
            break;
        }
        this.listener?.onEvent(event);
      },
      onLog: (line) => this.output.appendLine(line),
    });
    this.activeRun = run;

    const code = await run.exited;
    this.activeRun = undefined;
    this.debugControl?.setRunToBarTarget(undefined);
    this.flyToBar = undefined;
    this.setRunActive(false);
    this.listener?.onFinished();
    // The debuggee is gone; close the debug session with it.
    if (this.debugSession) {
      void vscode.debug.stopDebugging(this.debugSession);
    }
    if (code !== 0 && !errorMessage) {
      errorMessage = `runner exited with code ${code}`;
    }

    if (errorMessage) {
      const choice = await vscode.window.showErrorMessage(
        `PyneIDE: run failed: ${errorMessage}`,
        'Show Log'
      );
      if (choice === 'Show Log') this.output.show();
      return;
    }

    this.output.appendLine(
      `Run finished: ${endBars} bars` +
        (cancelled ? ' (cancelled)' : '') +
        (trades.length ? `, ${trades.length} closed trades` : '')
    );
    const netProfit = stats?.['Net Profit'];
    const summary =
      `PyneIDE: run finished — ${endBars} bars` +
      (trades.length ? `, ${trades.length} trades` : '') +
      (netProfit !== undefined && netProfit !== null ? `, net profit ${netProfit.toFixed(2)}` : '');
    // Non-intrusive: the chart toolbar now owns CSV access, so a transient
    // status-bar note replaces the old dismissable notification toast.
    vscode.window.setStatusBarMessage(summary, 6000);
  }
}

/** "Run ..." / "Debug" CodeLenses on the first line of Pyne/Pine scripts. */
class RunCodeLensProvider implements vscode.CodeLensProvider {
  provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    let title: string | undefined;
    if (doc.languageId === 'pine') {
      title = '$(play) Run Pine Script';
    } else if (
      doc.languageId === 'python' &&
      detectPyne(doc.getText().slice(0, DETECT_HEAD_BYTES)) !== undefined
    ) {
      title = '$(play) Run Pyne code';
    }
    if (!title) return [];
    const range = new vscode.Range(0, 0, 0, 0);
    return [
      new vscode.CodeLens(range, {
        title,
        command: 'pyneide.runScript',
        arguments: [doc.uri],
      }),
      new vscode.CodeLens(range, {
        title: '$(bug) Debug',
        command: 'pyneide.debugScript',
        arguments: [doc.uri],
      }),
    ];
  }
}
