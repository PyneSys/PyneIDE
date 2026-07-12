import * as fs from 'node:fs';
import * as path from 'node:path';

import * as vscode from 'vscode';

import { AuthService } from './api/auth';
import { CompileService } from './compile/service';
import { EnvManager } from './env/manager';
import { EnvStatusBar } from './env/statusBar';
import { pyneBinPath } from './env/uv';
import { markProjectAsWorkdir, recommendTomlExtension, scaffoldWorkdirWithCli } from './env/workdir';
import { resolveWorkspaceWorkdir } from './env/workdirConfig';
import { PyneDecorationProvider } from './pyneDecorations';

const SETUP_PROMPTED_KEY = 'pyneide.setupPrompted';

export function activate(context: vscode.ExtensionContext): void {
  new PyneDecorationProvider().register(context);

  const output = vscode.window.createOutputChannel('PyneIDE Environment');
  const manager = new EnvManager(context.globalStorageUri.fsPath, output);
  context.subscriptions.push(output, manager);

  new EnvStatusBar(manager).register(context);

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

  const auth = new AuthService(context);
  const compileOutput = vscode.window.createOutputChannel('PyneIDE Compiler');
  context.subscriptions.push(
    compileOutput,
    vscode.commands.registerCommand('pyneide.signIn', () => auth.signIn()),
    vscode.commands.registerCommand('pyneide.signOut', () => auth.signOut())
  );
  new CompileService(context, auth, compileOutput).register();

  void initialCheck(context, manager);
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

function updateTerminalWorkdirEnv(context: vscode.ExtensionContext): void {
  const workdir = resolveWorkspaceWorkdir();
  if (workdir?.exists) {
    context.environmentVariableCollection.replace('PYNE_WORK_DIR', workdir.path);
  } else {
    context.environmentVariableCollection.delete('PYNE_WORK_DIR');
  }
}

/**
 * Scaffolding is delegated to the pynecore CLI (single source of truth), so
 * the Python environment must be ready first. Returns the pyne binary path,
 * or undefined when the environment is unavailable (after informing the user).
 */
async function ensurePyneCli(manager: EnvManager): Promise<string | undefined> {
  let state = manager.state.kind === 'ready' ? manager.state : await manager.check();
  if (state.kind === 'needs-setup') {
    const choice = await vscode.window.showInformationMessage(
      'Initializing a Pyne project uses the pyne CLI, so the Python environment ' +
        'must be set up first.',
      'Setup Now'
    );
    if (choice !== 'Setup Now') return undefined;
    await manager.setup();
    state = manager.state;
  }
  if (state.kind !== 'ready') {
    void vscode.window.showErrorMessage(
      'PyneIDE: the Python environment is not available, cannot initialize the project.'
    );
    return undefined;
  }
  const pyneBin = pyneBinPath(state.pythonBin);
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
      recommendTomlExtension(folder.uri.fsPath);
      updateTerminalWorkdirEnv(context);
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
    recommendTomlExtension(baseDir);
    await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(baseDir));
  } catch (err) {
    void vscode.window.showErrorMessage(
      `PyneIDE: failed to initialize project: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

export function deactivate(): void {}
