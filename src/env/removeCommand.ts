import * as fs from 'node:fs';

import * as vscode from 'vscode';

import { pineLsRoot } from '../pinels/installer';
import type { PineLsService } from '../pinels/service';
import { cliWorkdirPath } from '../plugins/installed';
import { SETUP_DOWNLOAD_MB } from './constants';
import type { EnvManager } from './manager';
import {
  formatBytes,
  removableComponents,
  removePaths,
  type RemovableComponent,
} from './remove';

interface PickItem extends vscode.QuickPickItem {
  component: RemovableComponent;
}

/**
 * "Remove Environment" and "Reveal Environment Folder".
 *
 * Uninstalling the extension leaves globalStorage behind, so without a remove
 * command the only way to get the disk space back is to find the folder by
 * hand — which is also why Reveal sits next to it.
 */
export function registerRemoveEnvironment(
  context: vscode.ExtensionContext,
  manager: EnvManager,
  pineLs: PineLsService,
  output: vscode.OutputChannel
): vscode.Disposable[] {
  const storageDir = context.globalStorageUri.fsPath;
  return [
    vscode.commands.registerCommand('pyneide.removeEnvironment', () =>
      removeEnvironment(storageDir, manager, pineLs, output)
    ),
    vscode.commands.registerCommand('pyneide.revealEnvironmentFolder', async () => {
      // globalStorage is created lazily, so it may not exist before a setup.
      await fs.promises.mkdir(storageDir, { recursive: true });
      await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(storageDir));
    }),
  ];
}

async function removeEnvironment(
  storageDir: string,
  manager: EnvManager,
  pineLs: PineLsService,
  output: vscode.OutputChannel
): Promise<void> {
  if (manager.state.kind === 'working') {
    void vscode.window.showInformationMessage(
      'PyneIDE: the environment is busy. Wait for it to finish (or cancel it) before removing it.'
    );
    return;
  }

  const components = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: 'PyneIDE: measuring the environment…' },
    () =>
      removableComponents(storageDir, {
        pineLsRoot: pineLsRoot(storageDir),
        cliWorkdir: cliWorkdirPath(storageDir),
      })
  );
  if (components.length === 0) {
    void vscode.window.showInformationMessage(
      'PyneIDE: there is nothing to remove — no downloaded environment was found.'
    );
    return;
  }

  const picked = await vscode.window.showQuickPick(
    components.map((component) => toItem(component)),
    {
      title: 'PyneIDE — Remove Environment',
      placeHolder: 'Select what to delete from PyneIDE storage',
      canPickMany: true,
    }
  );
  if (!picked || picked.length === 0) return;

  const selected = picked.map((item) => item.component);
  const freed = selected.reduce((sum, component) => sum + component.bytes, 0);
  const lines = selected.map(
    (component) => `${component.label} — ${formatBytes(component.bytes)}`
  );
  const reinstall = selected.some((component) => component.id === 'python')
    ? ` Setting the Python environment up again downloads about ${SETUP_DOWNLOAD_MB} MB.`
    : '';
  const confirm = await vscode.window.showWarningMessage(
    'Remove the downloaded PyneIDE environment?',
    {
      modal: true,
      detail:
        `${lines.join('\n')}\n\nFrees about ${formatBytes(freed)}. ` +
        `This cannot be undone.${reinstall}\n\n` +
        'Your scripts, data and project files are not touched.',
    },
    'Remove'
  );
  if (confirm !== 'Remove') return;

  const removingPineLs = selected.some((component) => component.id === 'pine-ls');
  try {
    // The server runs from the directory about to be deleted; on Windows that
    // alone makes the removal fail.
    if (removingPineLs) await pineLs.stopServer();
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'PyneIDE: removing the environment',
        cancellable: false,
      },
      async () => {
        for (const component of selected) {
          await removePaths(component.paths, (message) => output.appendLine(message));
        }
      }
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    output.appendLine(`Removing the environment failed: ${message}`);
    const choice = await vscode.window.showErrorMessage(
      `PyneIDE: removing the environment failed: ${message}. ` +
        'A running PyneIDE process may still hold files open — reloading the window releases them.',
      'Reload Window',
      'Show Log'
    );
    if (choice === 'Reload Window') {
      await vscode.commands.executeCommand('workbench.action.reloadWindow');
    } else if (choice === 'Show Log') {
      output.show();
    }
    return;
  }

  await manager.check();
  if (removingPineLs) await pineLs.restart();
  void vscode.window.showInformationMessage(
    `PyneIDE: removed ${selected.map((component) => component.label.toLowerCase()).join(' and ')}. ` +
      `Freed about ${formatBytes(freed)}.`
  );
}

function toItem(component: RemovableComponent): PickItem {
  return {
    label: component.label,
    description: formatBytes(component.bytes),
    detail: component.note,
    // The Python environment is what the disk space is in, and reinstalling it
    // is one click; the Pine LS has to be downloaded again, so it is opt-in.
    picked: component.id === 'python',
    component,
  };
}
