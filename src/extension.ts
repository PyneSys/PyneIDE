import * as fs from 'node:fs';
import * as path from 'node:path';

import * as vscode from 'vscode';

import { AuthService } from './api/auth';
import { ChartManager } from './chart/chartPanel';
import { CompileService } from './compile/service';
import { registerStrictCompileToggle } from './compile/strictCompile';
import { OhlcvEditorProvider } from './data/ohlcvEditor';
import { buildOhlcvPreview } from './data/ohlcvPreview';
import { SymbolBrowserPanel, type SecurityPrefill } from './data/symbolBrowserPanel';
import { SymbolMapPanel } from './data/symbolMapPanel';
import { ChartBreakpointService } from './debug/chartBreakpoints';
import { registerPyneDebug } from './debug/pyneDebug';
import { currentMarker } from './env/bootstrap';
import { PYNECORE_VERSION, SETUP_DOWNLOAD_MB } from './env/constants';
import { EnvManager, type EnvState } from './env/manager';
import { EnvStatusBar } from './env/statusBar';
import { pyneBinPath } from './env/uv';
import {
  ensurePyneSnippets,
  ensurePyrightConfig,
  hideGeneratedFiles,
  markProjectAsWorkdir,
  recommendTomlExtension,
  scaffoldWorkdirWithCli,
} from './env/workdir';
import { resolvePyneIdeWorkdir, resolveWorkspaceWorkdir } from './env/workdirConfig';
import { PineLsService } from './pinels/service';
import { PluginsPanel } from './plugins/panel';
import { PluginService } from './plugins/service';
import { registerReportCommand } from './report/command';
import { logHub } from './report/logTee';
import { PyneDecorationProvider } from './pyneDecorations';
import { downloadData, downloadOtherTimeframe, truncateData, updateData } from './run/dataSelect';
import { RunService } from './run/runService';
import { ensureSymbolMapFile } from './run/symbolMapFile';
import { EdgeQuickFixProvider } from './typing/edgeQuickFix';
import { PyneCheckerService } from './typing/pyneChecker';
import { SecurityStatusService } from './typing/securityStatus';
import { PyneHoverProvider } from './typing/pyneHover';
import { PYLANCE_EXTENSION, PyrightService } from './typing/pyrightService';
import { SeriesAnalyzer } from './typing/seriesAnalyzer';
import { InputsViewManager } from './workspace/inputsView';
import { registerLibraryCompletion } from './workspace/libraryCompletion';
import { registerLibraryDefinition } from './workspace/libraryDefinition';
import { LibraryCallDiagnostics } from './workspace/libraryDiagnostics';
import { registerLibraryHelp } from './workspace/libraryHelp';
import { registerWorkspaceView } from './workspace/tree';

const SETUP_PROMPTED_KEY = 'pyneide.setupPrompted';
const UPDATE_PROMPTED_KEY = 'pyneide.updatePromptedFor';

/** Stable tag of the pinned target, so an outdated-env prompt fires once per new pin. */
function pinnedTargetTag(): string {
  const m = currentMarker();
  return `${m.schema}-${m.python}-${m.pynecore}-${m.debugpy}`;
}

export function activate(context: vscode.ExtensionContext): void {
  new PyneDecorationProvider().register(context);

  context.subscriptions.push(new OhlcvEditorProvider(context).register());

  const output = logHub.wrap(vscode.window.createOutputChannel('PyneIDE Environment'));
  const manager = new EnvManager(context.globalStorageUri.fsPath, output);
  context.subscriptions.push(output, manager);

  const compileOutput = logHub.wrap(vscode.window.createOutputChannel('PyneIDE Compiler'));
  const auth = new AuthService(context, compileOutput);

  const pineLsOutput = logHub.wrap(vscode.window.createOutputChannel('Pine Language Server'));
  const pineLs = new PineLsService(context, pineLsOutput);
  context.subscriptions.push(pineLsOutput);
  pineLs.register();

  const plugins = new PluginService(context, manager, auth, output);
  context.subscriptions.push(plugins);
  // A changed plugin set changes the provider list, the tree counts and the
  // panel's own model — everything downstream refreshes from one event.
  context.subscriptions.push(
    plugins.onDidChange(() => {
      PluginsPanel.refresh();
      SymbolBrowserPanel.reloadProviders();
      void vscode.commands.executeCommand('pyneide.workspace.refresh');
    })
  );

  new EnvStatusBar(manager, auth, pineLs, plugins).register(context);

  context.subscriptions.push(
    vscode.commands.registerCommand('pyneide.setupEnvironment', () => manager.setup()),
    vscode.commands.registerCommand('pyneide.showEnvironmentLog', () => output.show()),
    vscode.commands.registerCommand('pyneide.createWorkspace', () =>
      initProjectCommand(context, manager, output)
    )
  );

  // Let the bare `pyne` CLI in the integrated terminal find the workdir even
  // when the project folder itself is the workdir (name-based upward search
  // would miss it).
  context.environmentVariableCollection.description =
    'Points the pyne CLI at the workdir resolved by PyneIDE';
  updateTerminalWorkdirEnv(context);
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('pyneide.workdir')) updateTerminalWorkdirEnv(context);
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => updateTerminalWorkdirEnv(context))
  );

  context.subscriptions.push(
    compileOutput,
    vscode.commands.registerCommand('pyneide.signIn', () => auth.signIn()),
    vscode.commands.registerCommand('pyneide.signOut', () => auth.signOut())
  );
  const compileService = new CompileService(context, auth, compileOutput, pineLs);
  compileService.register();
  registerStrictCompileToggle(context);

  const libraryDiagnostics = new LibraryCallDiagnostics(context);
  libraryDiagnostics.register();
  const runService = new RunService(
    context,
    manager,
    compileService,
    libraryDiagnostics
  );
  runService.register();
  registerPyneDebug(context, runService);
  const chartManager = new ChartManager(context);
  runService.attachChart(chartManager);
  chartManager.onSelectData = (chartKey) => void runService.reselectChartData(chartKey);
  new ChartBreakpointService(context, chartManager).register();
  // A chart lives as long as its script (the .pine OR its compiled .py) is open
  // in a tab, or a run/debug is streaming to it. Closing the last such tab
  // retires the chart; closing only the chart's own tab keeps it dormant so it
  // can be reopened with its state intact.
  context.subscriptions.push(
    vscode.window.tabGroups.onDidChangeTabs(() => {
      chartManager.reconcile();
      inputsView.reconcile();
    })
  );

  // Refresh the generated scaffolding of a project PyneIDE set up itself, so a
  // shipped snippet change or a new config field reaches it. Everything here is
  // gated on our own marker in the workdir's config, never on a merely
  // resolvable workdir: that search walks parent directories, so a single
  // `workdir` folder high up would drag every plain Python project below it
  // into the Pyne setup — including having its Python analysis taken over.
  // Setting a project up in the first place is what the init command is for.
  const pyneWorkdir = resolvePyneIdeWorkdir();
  if (pyneWorkdir) {
    ensurePyrightConfig(pyneWorkdir.path);
    const wsFolder = vscode.workspace.workspaceFolders?.[0];
    if (wsFolder) ensurePyneSnippets(wsFolder.uri.fsPath, context.extensionPath);
  }

  // Once the interpreter is known, point the generated config at it: where
  // pynecore lives for an editable/dev install, and which Python version to
  // analyze against (see reconcilePyrightConfig).
  context.subscriptions.push(
    manager.onDidChangeState((state) => reconcilePyrightConfig(state))
  );
  reconcilePyrightConfig(manager.state);

  const pyrightOutput = logHub.wrap(vscode.window.createOutputChannel('Pyne Typing (pyright)'));
  // One worker feeds both the pyright index filter (L5c) and the Pyne checker
  // (L5d); its lifecycle lives here so neither service owns the other.
  const seriesAnalyzer = new SeriesAnalyzer(
    context.asAbsolutePath(path.join('python', 'pyneide_series.py')),
    manager,
    pyrightOutput
  );
  context.subscriptions.push(pyrightOutput, seriesAnalyzer);
  const pyright = new PyrightService(context, manager, pyrightOutput, seriesAnalyzer);
  pyright.register();
  const pyneChecker = new PyneCheckerService(context, seriesAnalyzer, pyrightOutput);
  pyneChecker.register();
  // Editor status for request.security() data requirements (own diagnostic
  // collection, computed locally from the symbol map + data tomls).
  const securityStatus = new SecurityStatusService(context, seriesAnalyzer, pyrightOutput);
  securityStatus.register();
  // A run-time security resolution (map/override write) refreshes the status.
  runService.setOnSecurityResolved(() => securityStatus.refreshAll());
  // The security "Download…" choice opens the Symbol Browser armed with a
  // prefill (callback injection avoids a run<->data dependency cycle).
  runService.setShowSymbolBrowser((prefill) =>
    void openSymbolBrowser(context, manager, output, prefill)
  );
  // "Convert to full @pyne" quick fix on Edge-profile violations.
  new EdgeQuickFixProvider().register(context);
  // Declared-type hovers when Pylance (or another pyright) supersedes the
  // bundled server — there is no LSP middleware to rewrite through then.
  new PyneHoverProvider(seriesAnalyzer, () => !pyright.running).register(context);
  registerLibraryCompletion(context);
  registerLibraryDefinition(context);
  registerLibraryHelp(context);

  registerWorkspaceView(context, chartManager, plugins);
  const inputsView = new InputsViewManager(
    context,
    manager,
    output,
    (chartKey) => runService.refreshChartAfterInputsSave(chartKey)
  );
  context.subscriptions.push(
    registerReportCommand(context, { context, manager, pineLs }, auth, compileOutput),
    vscode.commands.registerCommand('pyneide.editInputs', async (arg?: { uri?: vscode.Uri } | vscode.Uri) => {
      const explicitUri = arg instanceof vscode.Uri ? arg : arg?.uri;
      const explicitScript = explicitUri && /\.(?:pine|py)$/i.test(explicitUri.fsPath)
        ? explicitUri
        : undefined;
      const chartScript = chartManager.activeInputScriptPath();
      const target = explicitScript ?? (chartScript ? vscode.Uri.file(chartScript) : undefined);
      const uri = await editInputsUri(target, compileService);
      if (uri) void inputsView.open(uri);
    }),
    vscode.commands.registerCommand('pyneide.dataDownloadWizard', () =>
      openSymbolBrowser(context, manager, output)
    ),
    vscode.commands.registerCommand('pyneide.openSymbolBrowser', () =>
      openSymbolBrowser(context, manager, output)
    ),
    vscode.commands.registerCommand('pyneide.openPlugins', () =>
      PluginsPanel.show(context, plugins)
    ),
    vscode.commands.registerCommand('pyneide.dataUpdate', (node?: { uri?: vscode.Uri }) =>
      dataFileAction(manager, output, node, updateData)
    ),
    vscode.commands.registerCommand('pyneide.dataTruncate', (node?: { uri?: vscode.Uri }) =>
      dataFileAction(manager, output, node, truncateData)
    ),
    vscode.commands.registerCommand('pyneide.dataDownloadTimeframe', (node?: { uri?: vscode.Uri }) =>
      dataFileAction(manager, output, node, downloadOtherTimeframe)
    ),
    vscode.commands.registerCommand('pyneide.dataPreviewChart', (node?: { uri?: vscode.Uri }) =>
      previewDataChart(chartManager, node)
    ),
    vscode.commands.registerCommand('pyneide.editSymbolMap', () => editSymbolMapCommand()),
    vscode.commands.registerCommand('pyneide.openSymbolMap', () =>
      openSymbolMapCommand(context, manager, output, securityStatus)
    ),
    vscode.commands.registerCommand('pyneide.showDataRequirements', (uri?: vscode.Uri) =>
      runService.showDataRequirements(uri)
    )
  );

  watchForLostPlugins(context, manager, plugins);
  void initialCheck(context, manager);
  void pineLs.initialize();
}

/**
 * Open the symbol browser (searchable list + live syminfo + inline download).
 * If the provider service cannot start, the browser offers to fall back to the
 * F9C QuickPick download wizard.
 */
async function openSymbolBrowser(
  context: vscode.ExtensionContext,
  manager: EnvManager,
  output: vscode.OutputChannel,
  prefill?: SecurityPrefill
): Promise<void> {
  const workdir = resolveWorkspaceWorkdir();
  if (!workdir?.exists) {
    void vscode.window.showWarningMessage(
      'PyneIDE: no Pyne workspace found — initialize one first.'
    );
    return;
  }
  const pythonBin = await manager.ensureReady(
    'The symbol browser uses the pyne provider service, so the Python environment must be set up first.'
  );
  if (!pythonBin) return;
  SymbolBrowserPanel.show(
    context,
    {
      pythonBin,
      bridgeRoot: vscode.Uri.joinPath(context.extensionUri, 'python').fsPath,
      workdir: workdir.path,
      output,
      onServiceUnavailable: () => void legacyDownloadWizard(context, manager, output),
    },
    prefill
  );
}

/**
 * The F9C multi-step QuickPick download wizard (provider -> symbol -> timeframe
 * -> range), shelling out to `pyne data download`. Fallback when the provider
 * service is unavailable.
 */
async function legacyDownloadWizard(
  context: vscode.ExtensionContext,
  manager: EnvManager,
  output: vscode.OutputChannel
): Promise<void> {
  const workdir = resolveWorkspaceWorkdir();
  if (!workdir?.exists) return;
  const pythonBin = await manager.ensureReady(
    'Downloading OHLCV data uses the pyne CLI, so the Python environment must be set up first.'
  );
  if (!pythonBin) return;
  await downloadData(context, workdir.path, pythonBin, output);
}

/**
 * Resolve the compiled `.py` to inspect for the "Edit inputs" command, from a
 * tree node, an explicit Uri (editor/title), or the active editor. The bridge
 * imports the `.py`, so a `.pine` source is compiled on demand first — exactly
 * like a run: the content-hash cache skips the API when nothing changed, a
 * stale output recompiles, and a `.py` the user has edited triggers the same
 * overwrite prompt. Returns undefined if compilation did not produce a `.py`.
 */
async function editInputsUri(
  arg: { uri?: vscode.Uri } | vscode.Uri | undefined,
  compile: CompileService
): Promise<vscode.Uri | undefined> {
  let uri: vscode.Uri | undefined;
  if (arg instanceof vscode.Uri) uri = arg;
  else if (arg && arg.uri instanceof vscode.Uri) uri = arg.uri;
  else uri = vscode.window.activeTextEditor?.document.uri;
  if (!uri) return undefined;

  if (/\.py$/i.test(uri.fsPath)) return uri;

  if (/\.pine$/i.test(uri.fsPath)) {
    const doc = await vscode.workspace.openTextDocument(uri);
    if (doc.isDirty) await doc.save();
    const compiled = await compile.ensureCompiledForRun(doc);
    return compiled ? vscode.Uri.file(compiled) : undefined;
  }

  void vscode.window.showWarningMessage(
    'PyneIDE: input editing needs a Pyne (.py) or Pine (.pine) script.'
  );
  return undefined;
}

/**
 * Data-item "Preview chart" action: decode the `.ohlcv` host-side and open a
 * bars-only ChartPanel preview — no bridge run.
 */
function previewDataChart(chartManager: ChartManager, node: { uri?: vscode.Uri } | undefined): void {
  const uri = node?.uri;
  if (!uri) return;
  try {
    const { start, bars } = buildOhlcvPreview(uri.fsPath);
    chartManager.openDataPreview(uri.fsPath, start, bars);
  } catch (err) {
    void vscode.window.showErrorMessage(
      `PyneIDE: could not preview data — ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/**
 * Shared plumbing for the Data-item Update/Truncate actions: resolves the
 * workdir and Python env, then runs `action` against the picked `.ohlcv` path.
 */
async function dataFileAction(
  manager: EnvManager,
  output: vscode.OutputChannel,
  node: { uri?: vscode.Uri } | undefined,
  action: (
    workdir: string,
    pythonBin: string,
    ohlcvPath: string,
    output: vscode.OutputChannel
  ) => Promise<void>
): Promise<void> {
  const uri = node?.uri;
  if (!uri) return;
  const workdir = resolveWorkspaceWorkdir();
  if (!workdir?.exists) {
    void vscode.window.showWarningMessage(
      'PyneIDE: no Pyne workspace found — initialize one first.'
    );
    return;
  }
  const pythonBin = await manager.ensureReady(
    'Downloading OHLCV data uses the pyne CLI, so the Python environment must be set up first.'
  );
  if (!pythonBin) return;
  await action(workdir.path, pythonBin, uri.fsPath, output);
}

/**
 * Open (creating if absent) the workdir's global `config/symbol_map.toml` so
 * the user can hand-edit the TV-symbol -> provider-native mappings.
 */
async function editSymbolMapCommand(): Promise<void> {
  const workdir = resolveWorkspaceWorkdir();
  if (!workdir?.exists) {
    void vscode.window.showWarningMessage(
      'PyneIDE: no Pyne workspace found — initialize one first.'
    );
    return;
  }
  const filePath = ensureSymbolMapFile(workdir.path);
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
  await vscode.window.showTextDocument(doc);
}

/**
 * Open the whole-map Symbol Map webview editor for the active workdir. A map
 * edit inside the panel redirects downloads to the Symbol Browser (reusing the
 * same prefill flow the run-time security "Download…" choice uses) and, via
 * `onChanged`, refreshes the workspace tree and the request.security() status.
 */
function openSymbolMapCommand(
  context: vscode.ExtensionContext,
  manager: EnvManager,
  output: vscode.OutputChannel,
  securityStatus: SecurityStatusService
): void {
  const workdir = resolveWorkspaceWorkdir();
  if (!workdir?.exists) {
    void vscode.window.showWarningMessage(
      'PyneIDE: no Pyne workspace found — initialize one first.'
    );
    return;
  }
  SymbolMapPanel.show(context, {
    workdir: workdir.path,
    showSymbolBrowser: (prefill) => void openSymbolBrowser(context, manager, output, prefill),
    onChanged: () => {
      void vscode.commands.executeCommand('pyneide.workspace.refresh');
      securityStatus.refreshAll();
    },
  });
}

/**
 * A venv rebuild (Repair, or a pin bump raising the env schema) wipes the
 * plugins PyneIDE installed. Nothing else notices — the environment verifies as
 * healthy — so compare what we installed against what is loadable whenever the
 * environment turns ready, and offer to put them back. Declining is remembered
 * for the session only, so the next window asks again.
 */
function watchForLostPlugins(
  context: vscode.ExtensionContext,
  manager: EnvManager,
  plugins: PluginService
): void {
  let running = false;
  let declined = false;
  const check = async (state: EnvState): Promise<void> => {
    if (state.kind !== 'ready' || running || declined) return;
    running = true;
    try {
      const missing = await plugins.missingManagedPlugins();
      if (missing.length === 0) return;
      const names = missing.map((p) => p.package).join(', ');
      const choice = await vscode.window.showInformationMessage(
        `PyneIDE: ${missing.length} plugin${missing.length > 1 ? 's are' : ' is'} ` +
          `missing from the Python environment (${names}). Reinstall?`,
        'Reinstall',
        'Not Now'
      );
      if (choice !== 'Reinstall') {
        declined = true;
        return;
      }
      await plugins.restoreManagedPlugins(missing);
    } catch (err) {
      void vscode.window.showErrorMessage(
        `PyneIDE: reinstalling plugins failed — ${err instanceof Error ? err.message : String(err)}`
      );
    } finally {
      running = false;
    }
  };
  context.subscriptions.push(manager.onDidChangeState((state) => void check(state)));
  void check(manager.state);
}

async function initialCheck(
  context: vscode.ExtensionContext,
  manager: EnvManager
): Promise<void> {
  const state = await manager.check();
  if (state.kind !== 'needs-setup') return;

  if (state.cause === 'outdated') {
    // The env already worked; a new extension release bumped the pinned
    // versions. Prompt once per new pin so declining ("Later") does not renag
    // every window, but the next update prompts again.
    const tag = pinnedTargetTag();
    if (context.globalState.get<string>(UPDATE_PROMPTED_KEY) === tag) return;
    await context.globalState.update(UPDATE_PROMPTED_KEY, tag);
    const choice = await vscode.window.showInformationMessage(
      `PyneIDE bundles a new PyneCore (${PYNECORE_VERSION}). ` +
        'Update the Python environment now?',
      'Update Now',
      'Later'
    );
    if (choice === 'Update Now') {
      await manager.setup();
    }
    return;
  }

  // First install (missing): ask once instead of silently downloading ~80 MB.
  if (context.globalState.get<boolean>(SETUP_PROMPTED_KEY)) return;
  await context.globalState.update(SETUP_PROMPTED_KEY, true);
  const choice = await vscode.window.showInformationMessage(
    'PyneIDE needs a Python environment to run Pyne scripts ' +
      `(downloads uv + Python + PyneCore into extension storage, ~${SETUP_DOWNLOAD_MB} MB, ` +
      'a few minutes on a typical connection). Set it up now?',
    'Setup Now',
    'Later'
  );
  if (choice === 'Setup Now') {
    await manager.setup();
  }
}

/**
 * In a Pyne workspace, Pylance would supersede the bundled pyright, and then
 * neither the per-access index filter nor the hover rewrite can run — another
 * extension's output cannot be modified, only stacked next to (which shows two
 * contradicting types). Pylance honors `python.languageServer`: "None" turns
 * its server off for this workspace, letting the bundled server take over with
 * the full Pyne-aware pipeline, while other (non-Pyne) workspaces keep Pylance.
 *
 * Written once at workspace scope, and only from "Initialize Pyne Project" —
 * turning another extension off is intrusive enough that it must follow an
 * explicit request, never a guess about what kind of project this is. An
 * explicit workspace-level value the user set themselves — including switching
 * back to "Pylance" — is respected and never overwritten.
 */
async function takeOverPythonAnalysis(): Promise<void> {
  if (!vscode.extensions.getExtension(PYLANCE_EXTENSION)) return;
  const config = vscode.workspace.getConfiguration('python');
  if (config.get<string>('languageServer') === 'None') return;
  if (config.inspect<string>('languageServer')?.workspaceValue !== undefined) return;
  try {
    await config.update('languageServer', 'None', vscode.ConfigurationTarget.Workspace);
  } catch {
    // No writable workspace (e.g. no folder open) — nothing to take over.
    return;
  }
  void vscode.window.showInformationMessage(
    'PyneIDE now provides Python analysis in this Pyne workspace instead of Pylance ' +
      '("python.languageServer": "None" in workspace settings — set it back to ' +
      '"Default" to undo).'
  );
}

function updateTerminalWorkdirEnv(context: vscode.ExtensionContext): void {
  const workdir = resolveWorkspaceWorkdir();
  if (workdir?.exists) {
    context.environmentVariableCollection.replace('PYNE_WORK_DIR', workdir.path);
  } else {
    context.environmentVariableCollection.delete('PYNE_WORK_DIR');
  }
}

/**
 * On env-ready, teach the generated pyrightconfig about the interpreter
 * PyneIDE actually runs scripts with:
 *
 * - `extraPaths` gets the pynecore src root, but only for an editable/dev
 *   install, whose import-hook finder type checkers cannot follow. A regular
 *   wheel install resolves through the interpreter (its root is
 *   site-packages), so it needs no entry and the config stays clean.
 * - `pythonVersion` gets the venv's version. Checkers otherwise infer it from
 *   the interpreter the editor selected, and the managed venv sits in
 *   globalStorage where Pylance never sees it — so an old default interpreter
 *   would silently analyze modern stubs against an ancient stdlib.
 * - `venvPath`/`venv` point package resolution at that same environment, which
 *   `pythonVersion` alone does not do: a wheel install gets no `extraPaths`,
 *   so an editor aimed at another interpreter would not find `pynecore` at all.
 */
function reconcilePyrightConfig(state: EnvState): void {
  if (state.kind !== 'ready') return;
  const workdir = resolvePyneIdeWorkdir();
  if (!workdir) return;
  const root = state.verify.pynecoreRoot;
  const editable = root !== undefined && path.basename(root) !== 'site-packages';
  ensurePyrightConfig(workdir.path, {
    extraPaths: editable && root ? [root] : [],
    pythonVersion: state.verify.pythonVersion,
    pythonBin: state.pythonBin,
  });
}

/**
 * Scaffolding is delegated to the pynecore CLI (single source of truth), so
 * the Python environment must be ready first. Returns the pyne binary path,
 * or undefined when the environment is unavailable (after informing the user).
 */
async function ensurePyneCli(manager: EnvManager): Promise<string | undefined> {
  const pythonBin = await manager.ensureReady(
    'Initializing a Pyne project uses the pyne CLI, so the Python environment ' +
      'must be set up first.'
  );
  if (!pythonBin) return undefined;
  const pyneBin = pyneBinPath(pythonBin);
  if (!fs.existsSync(pyneBin)) {
    void vscode.window.showErrorMessage(
      `PyneIDE: pyne CLI not found at ${pyneBin} — ` +
        'the selected Python environment does not have pynecore installed.'
    );
    return undefined;
  }
  return pyneBin;
}

async function initProjectCommand(
  context: vscode.ExtensionContext,
  manager: EnvManager,
  output: vscode.OutputChannel
): Promise<void> {
  const pyneBin = await ensurePyneCli(manager);
  if (!pyneBin) return;
  const log = (msg: string): void => output.appendLine(msg);

  const folder = vscode.workspace.workspaceFolders?.[0];
  if (folder) {
    const choice = await vscode.window.showQuickPick(
      [
        {
          label: '$(root-folder) Use this folder',
          description: 'scripts/, data/, config/, output/ go directly into the workspace folder',
          root: true,
        },
        {
          label: '$(new-folder) Create a workdir/ subfolder',
          description: 'pyne CLI default layout, found by name-based search',
          root: false,
        },
      ],
      { placeHolder: 'Where should the Pyne project structure be created?' }
    );
    if (!choice) return;

    try {
      const target = choice.root ? folder.uri.fsPath : path.join(folder.uri.fsPath, 'workdir');
      const result = await scaffoldWorkdirWithCli(pyneBin, target, log);
      if (choice.root) {
        await vscode.workspace
          .getConfiguration('pyneide', folder.uri)
          .update('workdir', '.', vscode.ConfigurationTarget.WorkspaceFolder);
      }
      if (!choice.root) {
        // Pylance only reads the config at the workspace root, so the
        // workdir/ subfolder layout needs it there too.
        ensurePyrightConfig(folder.uri.fsPath);
      }
      hideGeneratedFiles(folder.uri.fsPath);
      recommendTomlExtension(folder.uri.fsPath);
      ensurePyneSnippets(folder.uri.fsPath, context.extensionPath);
      updateTerminalWorkdirEnv(context);
      void takeOverPythonAnalysis();
      const doc = await vscode.workspace.openTextDocument(result.demoScript);
      await vscode.window.showTextDocument(doc);
      void vscode.window.showInformationMessage(
        result.created
          ? `PyneIDE: Pyne project initialized at ${result.workdir}`
          : `PyneIDE: existing workdir completed at ${result.workdir} (nothing was overwritten)`
      );
    } catch (err) {
      void vscode.window.showErrorMessage(
        `PyneIDE: failed to initialize project: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    return;
  }

  // No folder open: pick one, scaffold it as the project root, then open it.
  const picked = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    openLabel: 'Initialize Pyne project here',
  });
  const baseDir = picked?.[0]?.fsPath;
  if (!baseDir) return;

  try {
    await scaffoldWorkdirWithCli(pyneBin, baseDir, log);
    const pylance = vscode.extensions.getExtension(PYLANCE_EXTENSION) !== undefined;
    if (!markProjectAsWorkdir(baseDir, pylance)) {
      void vscode.window.showWarningMessage(
        'PyneIDE: could not update .vscode/settings.json (unparseable); ' +
          'set "pyneide.workdir": "." there manually.'
      );
    }
    hideGeneratedFiles(baseDir);
    recommendTomlExtension(baseDir);
    ensurePyneSnippets(baseDir, context.extensionPath);
    await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(baseDir));
  } catch (err) {
    void vscode.window.showErrorMessage(
      `PyneIDE: failed to initialize project: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

export function deactivate(): void {}
