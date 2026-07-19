import * as fs from 'node:fs';
import * as path from 'node:path';

import * as vscode from 'vscode';

import { AuthService } from './api/auth';
import { ChartManager } from './chart/chartPanel';
import { CompileService } from './compile/service';
import { registerStrictCompileToggle } from './compile/strictCompile';
import { OhlcvEditorProvider } from './data/ohlcvEditor';
import { registerPyneDebug } from './debug/pyneDebug';
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
import { resolveWorkspaceWorkdir } from './env/workdirConfig';
import { PineLsService } from './pinels/service';
import { PyneDecorationProvider } from './pyneDecorations';
import { RunService } from './run/runService';
import { PyneCheckerService } from './typing/pyneChecker';
import { PyneHoverProvider } from './typing/pyneHover';
import { PYLANCE_EXTENSION, PyrightService } from './typing/pyrightService';
import { SeriesAnalyzer } from './typing/seriesAnalyzer';

const SETUP_PROMPTED_KEY = 'pyneide.setupPrompted';

export function activate(context: vscode.ExtensionContext): void {
  new PyneDecorationProvider().register(context);

  context.subscriptions.push(new OhlcvEditorProvider(context).register());

  const output = vscode.window.createOutputChannel('PyneIDE Environment');
  const manager = new EnvManager(context.globalStorageUri.fsPath, output);
  context.subscriptions.push(output, manager);

  const compileOutput = vscode.window.createOutputChannel('PyneIDE Compiler');
  const auth = new AuthService(context, compileOutput);

  const pineLsOutput = vscode.window.createOutputChannel('Pine Language Server');
  const pineLs = new PineLsService(context, pineLsOutput);
  context.subscriptions.push(pineLsOutput);
  pineLs.register();

  new EnvStatusBar(manager, auth, pineLs).register(context);

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
  const compileService = new CompileService(context, auth, compileOutput);
  compileService.register();
  registerStrictCompileToggle(context);

  const runService = new RunService(context, manager, compileService);
  runService.register();
  registerPyneDebug(context, runService);
  const chartManager = new ChartManager(context);
  runService.attachChart(chartManager);
  chartManager.onSelectData = (chartKey) => void runService.reselectChartData(chartKey);
  // A chart lives as long as its script (the .pine OR its compiled .py) is open
  // in a tab, or a run/debug is streaming to it. Closing the last such tab
  // retires the chart; closing only the chart's own tab keeps it dormant so it
  // can be reopened with its state intact.
  context.subscriptions.push(
    vscode.window.tabGroups.onDidChangeTabs(() => chartManager.reconcile())
  );

  // Existing workdirs predating the generated typing config get it on
  // activation; user-authored configs are never touched.
  const workdir = resolveWorkspaceWorkdir();
  if (workdir?.exists) {
    ensurePyrightConfig(workdir.path);
    const wsFolder = vscode.workspace.workspaceFolders?.[0];
    if (wsFolder) {
      hideGeneratedFiles(wsFolder.uri.fsPath);
      ensurePyneSnippets(wsFolder.uri.fsPath, context.extensionPath);
    }
    void takeOverPythonAnalysis();
  }

  // Once the interpreter is known, point the generated config at it: where
  // pynecore lives for an editable/dev install, and which Python version to
  // analyze against (see reconcilePyrightConfig).
  context.subscriptions.push(
    manager.onDidChangeState((state) => reconcilePyrightConfig(state))
  );
  reconcilePyrightConfig(manager.state);

  const pyrightOutput = vscode.window.createOutputChannel('Pyne Typing (pyright)');
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
  // Declared-type hovers when Pylance (or another pyright) supersedes the
  // bundled server — there is no LSP middleware to rewrite through then.
  new PyneHoverProvider(seriesAnalyzer, () => !pyright.running).register(context);

  void initialCheck(context, manager);
  void pineLs.initialize();
}

async function initialCheck(
  context: vscode.ExtensionContext,
  manager: EnvManager
): Promise<void> {
  const state = await manager.check();
  if (state.kind !== 'needs-setup') return;

  // Ask once instead of silently downloading ~100 MB on first activation.
  if (context.globalState.get<boolean>(SETUP_PROMPTED_KEY)) return;
  await context.globalState.update(SETUP_PROMPTED_KEY, true);
  const choice = await vscode.window.showInformationMessage(
    'PyneIDE needs a Python environment to run Pyne scripts ' +
      '(downloads uv + Python + PyneCore into extension storage). Set it up now?',
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
 * Written once at workspace scope. An explicit workspace-level value the user
 * set themselves — including switching back to "Pylance" — is respected and
 * never overwritten.
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
  const root = state.verify.pynecoreRoot;
  const editable = root !== undefined && path.basename(root) !== 'site-packages';
  const workdir = resolveWorkspaceWorkdir();
  if (!workdir?.exists) return;
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
    if (!markProjectAsWorkdir(baseDir)) {
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
