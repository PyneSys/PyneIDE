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

import { canonicalChartKey } from '../chart/chartKey';
import type { ChartManager } from '../chart/chartPanel';
import type { CompileService } from '../compile/service';
import { mapTracebackFrames } from '../compile/sourcemap';
import { buildOutputPreview, resolveScriptOutputPair } from '../data/outputPreview';
import type { DebugBreakpointControl } from '../debug/dapProxy';
import type { EnvManager } from '../env/manager';
import { resolveWorkspaceWorkdir } from '../env/workdirConfig';
import { detectPineVersion } from '../pineVersion';
import { detectPyne, DETECT_HEAD_BYTES } from '../pyneDetect';
import { BridgeRun, type BridgeEvent, type TradeRecord } from './bridgeClient';
import { getRememberedData, pickRunData } from './dataSelect';

export interface RunListener {
  /** `chartKey` identifies which script's chart the event belongs to (the
   * user's source path — .pine for Pine, not the compiled .py). */
  onEvent(event: BridgeEvent, chartKey: string): void;
  onFinished(chartKey: string): void;
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
  /** The user's source path — the chart key this run streams to (Part B). */
  chartKey: string;
}

export class RunService {
  private readonly output = vscode.window.createOutputChannel('PyneIDE Run');
  /** Runtime errors mapped back to the Pine source via the .py.map sourcemap. */
  private readonly runtimeDiagnostics = vscode.languages.createDiagnosticCollection('pyne-runtime');
  private readonly statusItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    90
  );
  private activeRun: BridgeRun | undefined;
  /** True while the active bridge run belongs to a debug launch, including
   * the short interval before VSCode publishes its DebugSession. */
  private activeRunIsDebug = false;
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
  /** Typed handle to the same object as `listener`, for revealing panels and
   * routing data-only previews (set via attachChart). */
  private chartManager: ChartManager | undefined;
  /** Live data-only preview processes, one per chart key. A real run for a
   * chart supersedes (cancels) its preview so both never drive one panel. */
  private readonly previewRuns = new Map<string, BridgeRun>();
  /** Chart key of the currently active real run (undefined when idle). */
  private activeChartKey: string | undefined;

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
      this.runtimeDiagnostics,
      vscode.commands.registerCommand('pyneide.runScript', (uri?: vscode.Uri) =>
        this.runFromCommand(uri)
      ),
      vscode.commands.registerCommand('pyneide.debugScript', (uri?: vscode.Uri) =>
        this.debugFromCommand(uri)
      ),
      vscode.commands.registerCommand('pyneide.changeRunData', (uri?: vscode.Uri) =>
        this.changeRunData(uri)
      ),
      vscode.commands.registerCommand('pyneide.openChart', (uri?: vscode.Uri) =>
        this.openChart(uri)
      ),
      vscode.commands.registerCommand('pyneide.toggleChartFullscreen', () =>
        vscode.commands.executeCommand('workbench.action.toggleMaximizeEditorGroup')
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

  /** Wire the chart manager (also the RunListener) so runs/previews can reveal
   * panels and route data-only previews. */
  attachChart(chartManager: ChartManager): void {
    this.listener = chartManager;
    this.chartManager = chartManager;
    chartManager.isPinned = (chartKey) => this.isChartPinned(chartKey);
  }

  /** A chart is pinned (kept alive even with no open source tab) while a run,
   * debug session or data-only preview is streaming to it — the source tab
   * reopens itself on the next debugger step, so a momentary close must not
   * discard the chart. */
  private isChartPinned(chartKey: string): boolean {
    return this.activeChartKey === chartKey || this.previewRuns.has(chartKey);
  }

  /** Resolve the pieces actions that spawn a data preview need. Persisted
   * output loading deliberately does not require the Python environment. */
  private async resolveChartContext(
    uri?: vscode.Uri
  ): Promise<{ doc: vscode.TextDocument; workdir: string; pythonBin: string } | undefined> {
    const doc = await this.resolveDocument(uri);
    if (!doc) return undefined;
    if (doc.languageId !== 'pine' && doc.languageId !== 'python') {
      void vscode.window.showWarningMessage('PyneIDE: open a Pyne (.py) or Pine (.pine) script.');
      return undefined;
    }
    const pythonBin = await this.manager.ensureReady(
      'Selecting data needs the Python environment. Set it up now?'
    );
    if (!pythonBin) return undefined;
    const workdir = await this.resolveOrInitWorkdir(doc, doc.uri.fsPath);
    if (!workdir) return undefined;
    return { doc, workdir, pythonBin };
  }

  /**
   * Re-pick the OHLCV data bound to a script (its source path) without running.
   * The choice is remembered, so the next run/chart-open uses it silently; if a
   * chart is open for the script (and no run is streaming to it) its preview
   * reloads on the new data. Returns the picked data name, or undefined.
   */
  async changeRunData(uri?: vscode.Uri): Promise<string | undefined> {
    const ctx = await this.resolveChartContext(uri);
    if (!ctx) return undefined;
    const chartKey = canonicalChartKey(ctx.doc.uri.fsPath);
    const data = await pickRunData(this.context, ctx.workdir, chartKey, ctx.pythonBin, this.output);
    if (data && this.activeChartKey !== chartKey) {
      this.startPreview(chartKey, ctx.workdir, ctx.pythonBin, data);
    }
    return data;
  }

  /**
   * Open a script's chart from its persisted CSV + visualization NDJSON.
   * Disk is authoritative whenever no run is actively streaming to this
   * chart, so this works after extension reload and never depends on a dormant
   * in-memory snapshot. Before the first run (no output pair yet), fall back to
   * the bound OHLCV data as a bars-only preview.
   */
  async openChart(uri?: vscode.Uri): Promise<void> {
    const doc = await this.resolveDocument(uri);
    if (!doc) return;
    if (doc.languageId !== 'pine' && doc.languageId !== 'python') {
      void vscode.window.showWarningMessage('PyneIDE: open a Pyne (.py) or Pine (.pine) script.');
      return;
    }
    const workdir = await this.resolveOrInitWorkdir(doc, doc.uri.fsPath);
    if (!workdir) return;
    const chartKey = canonicalChartKey(doc.uri.fsPath);

    // While a run is live, its stream is newer than the files being written.
    // Keep showing that transient state; the next idle click reloads from disk.
    if (this.activeChartKey === chartKey) {
      this.chartManager?.reveal(chartKey);
      return;
    }

    const rememberedData = getRememberedData(this.context, workdir, chartKey);
    const dataPath = rememberedData
      ? path.join(workdir, 'data', `${rememberedData}.ohlcv`)
      : undefined;
    const pair = resolveScriptOutputPair(workdir, doc.uri.fsPath);
    if (pair) {
      this.supersedePreview(chartKey);
      try {
        const preview = buildOutputPreview(pair, dataPath);
        this.chartManager?.openOutputPreview(chartKey, preview.events);
        if (preview.warnings.length) {
          void vscode.window.showWarningMessage(
            `PyneIDE: chart opened with ${preview.warnings.length} ignored output record(s).`
          );
        }
      } catch (err) {
        void vscode.window.showErrorMessage(
          `PyneIDE: could not open saved chart — ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      }
      return;
    }

    const pythonBin = await this.manager.ensureReady(
      'Previewing OHLCV data needs the Python environment. Set it up now?'
    );
    if (!pythonBin) return;
    let data = rememberedData;
    if (!data) {
      data = await pickRunData(this.context, workdir, chartKey, pythonBin, this.output);
    }
    if (!data) return;
    this.chartManager?.reveal(chartKey);
    this.startPreview(chartKey, workdir, pythonBin, data);
  }

  /**
   * Called when the chart's Data button is clicked (webview -> host): re-pick
   * and reload the preview for the script bound to `chartKey`.
   */
  async reselectChartData(chartKey: string): Promise<void> {
    const doc = await vscode.workspace.openTextDocument(chartKey).then(
      (d) => d,
      () => undefined
    );
    await this.changeRunData(doc?.uri);
  }

  /** Spawn (or replace) a data-only preview streaming raw candles to a chart. */
  private startPreview(chartKey: string, workdir: string, pythonBin: string, data: string): void {
    this.supersedePreview(chartKey);
    let run: BridgeRun;
    run = BridgeRun.start({
      pythonBin,
      bridgeRoot: vscode.Uri.joinPath(this.context.extensionUri, 'python').fsPath,
      data,
      workdir,
      dataOnly: true,
      onEvent: (event) => {
        // A later preview or a real run may have superseded this one; drop its
        // trailing events so they never land on a panel showing something else.
        if (this.previewRuns.get(chartKey) === run) this.listener?.onEvent(event, chartKey);
      },
      onLog: (line) => this.output.appendLine(line),
    });
    this.previewRuns.set(chartKey, run);
    void run.exited.then(() => {
      if (this.previewRuns.get(chartKey) === run) {
        this.previewRuns.delete(chartKey);
        // Preview no longer pins the chart: retire it if its source tab is gone.
        this.chartManager?.reconcile();
      }
    });
  }

  /** Stop the chart's active preview (if any) so it stops emitting events. */
  private supersedePreview(chartKey: string): void {
    const preview = this.previewRuns.get(chartKey);
    if (preview) {
      this.previewRuns.delete(chartKey);
      preview.cancel();
    }
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

  /** Re-run a visible script chart after its canonical input TOML was saved. */
  async refreshChartAfterInputsSave(chartKey: string): Promise<void> {
    if (
      this.debugSession ||
      this.activeRunIsDebug ||
      !this.chartManager?.hasOpenChart(chartKey)
    ) {
      return;
    }

    if (this.activeRun) {
      // Never interrupt an unrelated script just because another form was saved.
      if (this.activeChartKey !== chartKey) return;
      await this.drainActiveRun();
    }

    // State may have changed while the previous normal run was draining.
    if (this.debugSession || this.activeRunIsDebug || !this.chartManager.hasOpenChart(chartKey)) {
      return;
    }
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(chartKey));
    await this.runDocument(doc);
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

    // Debugging needs a truthful sourcemap, which only exists for v6 (a v4/v5
    // source is compiled through an internal v6 conversion). Offer an in-place
    // upgrade; plain run stays available for v4/v5 above.
    if (doc.languageId === 'pine') {
      const version = detectPineVersion(doc.getText().slice(0, DETECT_HEAD_BYTES));
      if (version === undefined || version < 6) {
        const label = version === undefined ? '(unversioned)' : `v${version}`;
        const choice = await vscode.window.showWarningMessage(
          `PyneIDE: debugging requires Pine v6. This script is Pine ${label}. ` +
            'Convert it to v6 now? (in-place; you can Undo)',
          { modal: true },
          'Convert to v6'
        );
        if (choice !== 'Convert to v6') return null;
        if (!(await this.compile.convertActiveToV6(doc))) return null;
      }
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
      // A .pine launch debugs at the Pine level: the adapter factory builds a
      // sourcemap translator from this (see debug/pyneDebug.ts). Survives a
      // restart along with the rest of the resolved config.
      ...(doc.languageId === 'pine' ? { pineSource: doc.uri.fsPath } : {}),
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

    // Data is bound to the user's source file, folded onto the canonical chart
    // key (a .pine and its compiled .py share one chart + one data binding), so
    // it stays stable across recompiles and matches the chart's key (Part B).
    const sourceKey = canonicalChartKey(doc.uri.fsPath);
    let data = overrides?.data ?? getRememberedData(this.context, workdir, sourceKey);
    if (!data) {
      this.output.appendLine(`Workdir resolved: ${workdir} — opening data picker.`);
      data = await pickRunData(this.context, workdir, sourceKey, pythonBin, this.output);
    }
    if (!data) {
      this.output.appendLine('Run stopped: no data selected.');
      return undefined;
    }

    return { pythonBin, scriptPath, data, workdir, chartKey: sourceKey };
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
   * run ends) before the crawl handoff re-arms them. Disarm the bar stop first
   * so the restore does not re-add it (manual control means: no bar stop).
   */
  private abortFly(): void {
    if (!this.flyToBar) return;
    this.flyToBar = undefined;
    this.debugControl?.setBarStopArmed(false);
    void this.debugControl?.restoreBreakpoints();
  }

  /**
   * Next bar while stopped in the debugger: arm the hidden bar-stop breakpoint
   * (top of the next bar) and continue, so one press advances exactly one bar
   * regardless of the user's breakpoints. Without a known bar-stop location,
   * fall back to a plain continue (relies on a per-bar user breakpoint).
   */
  private async nextBarDebug(): Promise<void> {
    if (this.debugControl?.canBarStop()) {
      await this.debugControl.armBarStop();
    }
    await this.continueDebugger();
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
        void this.debugControl?.disarmBarStop();
        run.pause();
        break;
      case 'resume':
        void this.debugControl?.disarmBarStop();
        run.resume();
        if (this.debugStopped) void this.continueDebugger();
        break;
      case 'step':
        if (this.debugStopped) {
          // Stop at the top of the next bar via the hidden bar-stop breakpoint
          // (one press, one bar) — works with a conditional or no user
          // breakpoint too. The feed is not gated (the breakpoint suspends
          // execution); arming a feed pause here would block the next bar before
          // its breakpoint could hit (the old two-press bug).
          void this.nextBarDebug();
        } else if (this.paused) {
          run.step(1);
        } else {
          run.pause(); // while running, "next bar" means: stop at the next one
        }
        break;
      case 'cancel':
        void this.debugControl?.disarmBarStop();
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
      // At a breakpoint: any active breakpoint would otherwise stop (and trace)
      // every bar on the way — unusably slow. Fast path: remove breakpoints so
      // the debuggee runs untraced, arm a BRIDGE-side run-to target so the feed
      // self-pauses (on its own thread, race-free) a couple bars short of the
      // goal, then restore breakpoints while it is parked and crawl the last few
      // bars to land exactly on `target`. The crawl lands on the hidden bar-stop
      // breakpoint (top of each bar) — so run-to-bar no longer needs a user
      // breakpoint at all; it falls back to a per-bar user breakpoint only when
      // the bar-stop location is unknown.
      const control = this.debugControl;
      const canBarStop = control?.canBarStop() ?? false;
      const canLand = canBarStop || (control?.hasBreakpoints() ?? false);
      const crawl = RunService.RUN_TO_BAR_CRAWL;
      const runto = target - crawl; // bridge parks the feed here (bars_done)
      if (control && runto > currentBar && canLand) {
        this.flyToBar = { target };
        // Arm the bar stop for the crawl: the restore that precedes the last
        // bars re-sends it, so the target bar suspends even without a user bp.
        if (canBarStop) control.setBarStopArmed(true);
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
            // proxy still lands the crawl at target on the bar-stop breakpoint.
            this.flyToBar = undefined;
            control.setBarStopArmed(false);
            await control.restoreBreakpoints().catch(() => {});
          }
          // A manual control while we were arming aborts the fly — don't release.
          if (armed && this.flyToBar?.target !== target) return;
          this.continueDebugger();
        })();
        return;
      }
      // Target is within the crawl window (or nothing to fly): arm the bar stop
      // and crawl straight to the target; the proxy auto-continues intermediate
      // bars and lands on `target`.
      if (canBarStop) await control!.armBarStop();
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
    chartKey: string;
    debug?: { onEndpoint: (host: string, port: number) => void };
  }): Promise<void> {
    const scriptName = path.basename(opts.scriptPath);
    const chartKey = opts.chartKey;
    // A real run owns the chart: stop any data-only preview streaming to it.
    this.supersedePreview(chartKey);
    this.activeChartKey = chartKey;
    this.activeRunIsDebug = opts.debug !== undefined;
    this.output.appendLine(
      `--- ${opts.debug ? 'Debug' : 'Run'}: ${scriptName} on ${opts.data} (workdir: ${opts.workdir})`
    );

    let stats: Record<string, number | null> | undefined;
    let errorMessage: string | undefined;
    let errorPineLocation: { pinePath: string; pineLine: number } | undefined;
    const trades: TradeRecord[] = [];
    let endBars = 0;
    let cancelled = false;

    // A fresh run invalidates previous runtime-error markers.
    this.runtimeDiagnostics.clear();

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
          case 'debugMain':
            // Where the debugger's hidden "bar stop" breakpoint lands (main's
            // first executable line) — drives Next bar / Run to bar regardless
            // of the user's breakpoints.
            this.debugControl?.setBarStopLocation(event.file, event.line);
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
            // Map traceback frames back to the Pine source (needs the
            // .py.map written at compile time); the deepest mapped frame
            // is where the user should look.
            try {
              const frames = mapTracebackFrames(event.traceback);
              const deepest = frames[frames.length - 1];
              if (deepest) {
                errorPineLocation = deepest;
                for (const f of frames) {
                  this.output.appendLine(
                    `  -> ${path.basename(f.pinePath)}:${f.pineLine} (${path.basename(f.pyPath)}:${f.pyLine})`
                  );
                }
              }
            } catch {
              // Mapping is best-effort; the raw traceback is already logged.
            }
            break;
          case 'log':
            this.output.appendLine(`[${event.level}] ${event.message}`);
            break;
          case 'end':
            endBars = event.bars;
            cancelled = event.cancelled;
            break;
        }
        this.listener?.onEvent(event, chartKey);
      },
      onLog: (line) => this.output.appendLine(line),
    });
    this.activeRun = run;

    const code = await run.exited;
    this.activeRun = undefined;
    this.activeChartKey = undefined;
    this.activeRunIsDebug = false;
    this.debugControl?.setRunToBarTarget(undefined);
    this.flyToBar = undefined;
    this.setRunActive(false);
    this.listener?.onFinished(chartKey);
    // The run no longer pins this chart: if its source tab was closed while it
    // ran (kept alive only by the run), retire it now.
    this.chartManager?.reconcile();
    // The debuggee is gone; close the debug session with it.
    if (this.debugSession) {
      void vscode.debug.stopDebugging(this.debugSession);
    }
    if (code !== 0 && !errorMessage) {
      errorMessage = `runner exited with code ${code}`;
    }

    if (errorMessage) {
      let location = '';
      if (errorPineLocation) {
        // Surface the mapped Pine line in the Problems panel too.
        const { pinePath, pineLine } = errorPineLocation;
        try {
          const pineDoc = await vscode.workspace.openTextDocument(vscode.Uri.file(pinePath));
          const line = Math.max(0, Math.min(pineLine - 1, pineDoc.lineCount - 1));
          const diagnostic = new vscode.Diagnostic(
            pineDoc.lineAt(line).range,
            errorMessage,
            vscode.DiagnosticSeverity.Error
          );
          diagnostic.source = 'Pyne runtime';
          this.runtimeDiagnostics.set(pineDoc.uri, [diagnostic]);
        } catch {
          // The .pine may have vanished meanwhile; the log still has the mapping.
        }
        location = ` (${path.basename(pinePath)}:${pineLine})`;
      }
      const choice = await vscode.window.showErrorMessage(
        `PyneIDE: run failed: ${errorMessage}${location}`,
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
