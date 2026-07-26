import * as vscode from 'vscode';

import type { AuthService } from '../api/auth';
import type { Usage } from '../api/client';
import { isStrictCompile } from '../compile/strictCompile';
import type { PineLsService } from '../pinels/service';
import type { PluginService } from '../plugins/service';
import type { EnvManager, EnvState } from './manager';

type MenuItem = vscode.QuickPickItem & {
  action?: () => void;
  keepOpen?: boolean;
};

type UsageState =
  | { kind: 'loading' }
  | { kind: 'signed-out' }
  | { kind: 'ready'; usage: Usage }
  | { kind: 'error'; message: string };

type PluginsState =
  | { kind: 'loading' }
  | { kind: 'ready'; installed: number; updates: number }
  | { kind: 'unknown' };

/** Status bar item reflecting the environment state, with a quickpick menu. */
export class EnvStatusBar {
  private readonly item: vscode.StatusBarItem;

  constructor(
    private readonly manager: EnvManager,
    private readonly auth: AuthService,
    private readonly pineLs: PineLsService,
    private readonly plugins: PluginService
  ) {
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
    const menuHint = ' Click for compile usage and PyneIDE actions.';
    switch (state.kind) {
      case 'unknown':
        this.item.text = '$(question) PyneIDE';
        this.item.tooltip = `PyneIDE: environment state unknown.${menuHint}`;
        break;
      case 'needs-setup':
        this.item.text = '$(warning) PyneIDE';
        this.item.tooltip = `PyneIDE: ${state.reason}.${menuHint}`;
        this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        break;
      case 'working':
        this.item.text = '$(sync~spin) PyneIDE';
        this.item.tooltip = `PyneIDE: ${state.step}.${menuHint}`;
        break;
      case 'ready': {
        this.item.text = '$(check) PyneIDE';
        const source =
          state.source === 'managed' ? 'managed environment' : `custom (${state.source})`;
        this.item.tooltip =
          `PyneIDE: ready — Python ${state.verify.pythonVersion}, ` +
          `pynecore ${state.verify.pynecoreVersion}, debugpy ${state.verify.debugpyVersion} ` +
          `(${source}).${menuHint}`;
        break;
      }
      case 'error':
        this.item.text = '$(error) PyneIDE';
        this.item.tooltip = `PyneIDE: ${state.message}.${menuHint}`;
        this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
        break;
    }
  }

  private async showMenu(): Promise<void> {
    const picker = vscode.window.createQuickPick<MenuItem>();
    picker.title = 'PyneIDE';
    picker.placeholder = this.item.tooltip?.toString();
    picker.matchOnDescription = true;
    picker.matchOnDetail = true;

    let usageState: UsageState = { kind: 'loading' };
    let pluginsState: PluginsState = { kind: 'loading' };
    let closed = false;

    const render = (): void => {
      if (closed) return;
      const state = this.manager.state;
      const items: MenuItem[] = [];
      const environmentItems: MenuItem[] = [];
      if (state.kind === 'needs-setup' || state.kind === 'error' || state.kind === 'unknown') {
        environmentItems.push({
          label: '$(cloud-download) Setup Environment',
          description: 'Download uv + Python and install PyneCore',
          action: () => void vscode.commands.executeCommand('pyneide.setupEnvironment'),
        });
      }
      environmentItems.push(
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

      items.push({ label: 'Compile Usage', kind: vscode.QuickPickItemKind.Separator });
      switch (usageState.kind) {
        case 'loading':
          items.push({
            label: '$(loading~spin) Loading daily and hourly usage…',
          });
          break;
        case 'signed-out':
          items.push({
            label: '$(lock) Sign in to view compile usage',
            description: 'A PyneSys API key is required',
          });
          break;
        case 'ready': {
          const formatReset = (value: string): string =>
            `Resets ${new Date(value).toLocaleString()}`;
          const { daily, hourly } = usageState.usage;
          items.push(
            {
              label: `$(calendar) Daily: ${daily.used} / ${daily.limit} used`,
              description: `${daily.remaining} remaining`,
              detail: formatReset(daily.resetAt),
            },
            {
              label: `$(clock) Hourly: ${hourly.used} / ${hourly.limit} used`,
              description: `${hourly.remaining} remaining`,
              detail: formatReset(hourly.resetAt),
            }
          );
          break;
        }
        case 'error':
          items.push({
            label: '$(warning) Compile usage unavailable',
            description: 'Select to retry',
            detail: usageState.message,
            keepOpen: true,
            action: () => void loadUsage(),
          });
          break;
      }

      const strict = isStrictCompile(vscode.window.activeTextEditor?.document.uri);
      items.push({
        label: strict
          ? '$(check) Strict compilation: On'
          : '$(circle-large-outline) Strict compilation: Off',
        description: strict
          ? 'Pine-exact block scoping (every variable renamed)'
          : 'Readable output (surgical renames only)',
        action: () => void vscode.commands.executeCommand('pyneide.toggleStrictCompile'),
      });

      items.push(
        { label: 'Environment', kind: vscode.QuickPickItemKind.Separator },
        ...environmentItems
      );

      items.push({ label: 'Plugins', kind: vscode.QuickPickItemKind.Separator });
      const pluginsLabel = (): { label: string; description?: string } => {
        switch (pluginsState.kind) {
          case 'loading':
            return { label: '$(loading~spin) Plugins: loading…' };
          case 'unknown':
            return {
              label: '$(extensions) Manage Plugins…',
              description: 'Browse and install PyneCore plugins',
            };
          case 'ready':
            return {
              label: `$(extensions) Plugins: ${pluginsState.installed} installed`,
              description: pluginsState.updates
                ? `${pluginsState.updates} update${pluginsState.updates > 1 ? 's' : ''} available`
                : 'Browse and install PyneCore plugins',
            };
        }
      };
      items.push({
        ...pluginsLabel(),
        action: () => void vscode.commands.executeCommand('pyneide.openPlugins'),
      });

      const ls = this.pineLs.state;
      items.push({ label: 'Pine Language Server', kind: vscode.QuickPickItemKind.Separator });
      if (ls.kind === 'ready') {
        items.push({
          label: this.pineLs.serverRunning
            ? `$(check) Pine LS ${ls.version}: running`
            : `$(circle-large-outline) Pine LS ${ls.version}: installed`,
          description: ls.source === 'custom' ? ls.executablePath : undefined,
          action: () => void vscode.commands.executeCommand('pyneide.pineLsRestart'),
        });
      }
      if (ls.kind === 'needs-install' || ls.kind === 'error') {
        items.push({
          label: '$(cloud-download) Install Pine Language Server',
          description: 'Signed native binary for diagnostics, completion and navigation',
          action: () => void vscode.commands.executeCommand('pyneide.pineLsInstall'),
        });
      } else if (ls.kind === 'ready' && ls.source === 'managed') {
        items.push({
          label: '$(cloud-download) Check for Pine LS Updates',
          action: () => void vscode.commands.executeCommand('pyneide.pineLsInstall'),
        });
      }
      if (this.pineLs.canRollback()) {
        items.push({
          label: '$(history) Roll Back Pine LS to Previous Version',
          action: () => void this.pineLs.rollback(),
        });
      }
      if (ls.kind !== 'disabled' && ls.kind !== 'unsupported') {
        items.push({
          label: '$(output) Show Pine LS Log',
          action: () => void vscode.commands.executeCommand('pyneide.pineLsShowLog'),
        });
      }

      items.push({ label: 'PyneSys Account', kind: vscode.QuickPickItemKind.Separator });
      if (usageState.kind === 'signed-out') {
        items.push({
          label: '$(sign-in) Sign In to PyneSys',
          description: 'Store your PyneSys API key',
          action: () => void vscode.commands.executeCommand('pyneide.signIn'),
        });
      } else if (usageState.kind !== 'loading') {
        items.push({
          label: '$(sign-out) Sign Out from PyneSys',
          description: 'Remove the stored API key',
          action: () => void vscode.commands.executeCommand('pyneide.signOut'),
        });
      }

      items.push(
        { label: 'Help', kind: vscode.QuickPickItemKind.Separator },
        {
          label: '$(rocket) Get Started',
          description: 'Setup, first run, debugging and Pine compilation in seven steps',
          action: () => void vscode.commands.executeCommand('pyneide.openWalkthrough'),
        },
        {
          label: '$(report) Report a Problem…',
          description: 'Send an error report to the PyneIDE author',
          action: () => void vscode.commands.executeCommand('pyneide.reportProblem'),
        }
      );

      picker.busy = usageState.kind === 'loading' || pluginsState.kind === 'loading';
      picker.items = items;
    };

    /** Plugin counts come from the same model the panel renders; a failure
     * degrades to the plain "Manage Plugins…" entry rather than an error row. */
    const loadPlugins = async (): Promise<void> => {
      try {
        const model = await this.plugins.model();
        pluginsState = model.env.installedKnown
          ? {
              kind: 'ready',
              installed: model.rows.filter((r) => r.installed && !r.builtin).length,
              updates: model.rows.filter((r) => r.updateAvailable).length,
            }
          : { kind: 'unknown' };
      } catch {
        pluginsState = { kind: 'unknown' };
      }
      render();
    };

    const loadUsage = async (): Promise<void> => {
      usageState = { kind: 'loading' };
      render();
      try {
        const client = await this.auth.client();
        if (!client) {
          usageState = { kind: 'signed-out' };
          render();
          return;
        }
        usageState = { kind: 'ready', usage: await client.usage() };
      } catch (err) {
        usageState = {
          kind: 'error',
          message: err instanceof Error ? err.message : String(err),
        };
      }
      render();
    };

    const acceptSubscription = picker.onDidAccept(() => {
      const picked = picker.selectedItems[0];
      if (!picked?.action) return;
      if (!picked.keepOpen) picker.hide();
      picked.action();
    });
    const hideSubscription = picker.onDidHide(() => {
      closed = true;
      acceptSubscription.dispose();
      hideSubscription.dispose();
      picker.dispose();
    });

    render();
    picker.show();
    void loadUsage();
    void loadPlugins();
  }
}
