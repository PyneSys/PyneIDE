import * as vscode from 'vscode';

import { AuthService } from './api/auth';
import { CompileService } from './compile/service';
import { EnvManager } from './env/manager';
import { EnvStatusBar } from './env/statusBar';
import { createPyneWorkspace } from './env/workdir';
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
    vscode.commands.registerCommand('pyneide.createWorkspace', () => createWorkspaceCommand())
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

async function createWorkspaceCommand(): Promise<void> {
  let baseDir = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!baseDir) {
    const picked = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      openLabel: 'Create Pyne workspace here',
    });
    baseDir = picked?.[0]?.fsPath;
  }
  if (!baseDir) return;

  try {
    const result = createPyneWorkspace(baseDir);
    const doc = await vscode.workspace.openTextDocument(result.demoScript);
    await vscode.window.showTextDocument(doc);
    void vscode.window.showInformationMessage(
      result.created
        ? `PyneIDE: Pyne workspace created at ${result.workdir}`
        : `PyneIDE: existing workdir completed at ${result.workdir} (nothing was overwritten)`
    );
  } catch (err) {
    void vscode.window.showErrorMessage(
      `PyneIDE: failed to create workspace: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

export function deactivate(): void {}
