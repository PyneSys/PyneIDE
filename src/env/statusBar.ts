import * as vscode from 'vscode';

import type { EnvManager, EnvState } from './manager';

/** Status bar item reflecting the environment state, with a quickpick menu. */
export class EnvStatusBar {
  private readonly item: vscode.StatusBarItem;

  constructor(private readonly manager: EnvManager) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.item.name = 'PyneIDE Environment';
    this.item.command = 'pyneide.environmentMenu';
    this.update(manager.state);
  }

  register(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
      this.item,
      this.manager.onDidChangeState((state) => this.update(state)),
      vscode.commands.registerCommand('pyneide.environmentMenu', () => this.showMenu())
    );
    this.item.show();
  }

  private update(state: EnvState): void {
    this.item.backgroundColor = undefined;
    switch (state.kind) {
      case 'unknown':
        this.item.text = '$(question) PyneIDE';
        this.item.tooltip = 'PyneIDE: environment state unknown';
        break;
      case 'needs-setup':
        this.item.text = '$(warning) PyneIDE';
        this.item.tooltip = `PyneIDE: ${state.reason} Click to set up.`;
        this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        break;
      case 'working':
        this.item.text = '$(sync~spin) PyneIDE';
        this.item.tooltip = `PyneIDE: ${state.step}`;
        break;
      case 'ready': {
        this.item.text = '$(check) PyneIDE';
        const source =
          state.source === 'managed' ? 'managed environment' : `custom (${state.source})`;
        this.item.tooltip =
          `PyneIDE: ready — Python ${state.verify.pythonVersion}, ` +
          `pynecore ${state.verify.pynecoreVersion}, debugpy ${state.verify.debugpyVersion} ` +
          `(${source})`;
        break;
      }
      case 'error':
        this.item.text = '$(error) PyneIDE';
        this.item.tooltip = `PyneIDE: ${state.message}`;
        this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
        break;
    }
  }

  private async showMenu(): Promise<void> {
    const state = this.manager.state;
    const items: (vscode.QuickPickItem & { action: () => void })[] = [];
    if (state.kind === 'needs-setup' || state.kind === 'error' || state.kind === 'unknown') {
      items.push({
        label: '$(cloud-download) Setup Environment',
        description: 'Download uv + Python and install PyneCore',
        action: () => void vscode.commands.executeCommand('pyneide.setupEnvironment'),
      });
    }
    items.push(
      {
        label: '$(refresh) Re-check Environment',
        action: () => void this.manager.check(),
      },
      {
        label: '$(tools) Repair Environment (clean reinstall)',
        action: () => void this.manager.setup({ recreate: true }),
      },
      {
        label: '$(new-folder) Initialize Pyne Project',
        action: () => void vscode.commands.executeCommand('pyneide.createWorkspace'),
      },
      {
        label: '$(output) Show Environment Log',
        action: () => void vscode.commands.executeCommand('pyneide.showEnvironmentLog'),
      },
      {
        label: '$(settings-gear) Open PyneIDE Settings',
        action: () =>
          void vscode.commands.executeCommand('workbench.action.openSettings', 'pyneide'),
      }
    );
    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: this.item.tooltip?.toString(),
    });
    picked?.action();
  }
}
