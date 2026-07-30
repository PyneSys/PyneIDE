import * as fs from 'node:fs';

import * as vscode from 'vscode';

import type { AuthService } from '../api/auth';
import type { Usage } from '../api/client';
import { isStrictCompile } from '../compile/strictCompile';
import type { PineLsService } from '../pinels/service';
import type { PluginService } from '../plugins/service';
import { detectPyne, DETECT_HEAD_BYTES } from '../pyneDetect';
import type { EnvManager, EnvState } from './manager';
import { resolvePyneIdeWorkdir } from './workdirConfig';

type MenuItem = vscode.QuickPickItem & {
  action?: () => void;
  keepOpen?: boolean;
};

/**
 * The environment state as the menu shows it, next to the one-sentence tooltip
 * body the status bar hover shows. The menu gets the parts separately because a
 * quickpick row has room the status bar does not: `detail` is a full-width line,
 * while the tooltip has to fit everything into one sentence.
 */
interface EnvSummary {
  icon: string;
  /** Short state word for the menu title and the row label. */
  state: string;
  /** Right-aligned qualifier — which environment the state is about. */
  source?: string;
  /** Versions when ready, the reason or error message otherwise. */
  detail?: string;
  /** Tooltip sentence without the trailing period and the click hint. */
  tooltip: string;
}

/** Only true on the status bar item — inside the open menu it is nonsense. */
const MENU_HINT = ' Click for compile usage and PyneIDE actions.';

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
  /** Emptiness per workspace folder path — see `inFreshFolder`. */
  private readonly freshFolders = new Map<string, boolean>();
  /** Written by `update`, read by the menu. */
  private summary: EnvSummary = {
    icon: '$(question)',
    state: 'unknown',
    tooltip: 'PyneIDE: environment state unknown',
  };

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
    const refresh = (): void => this.update(this.manager.state);
    context.subscriptions.push(
      this.item,
      this.manager.onDidChangeState((state) => this.update(state)),
      // Opening the first `.pine` or `@pyne` file is what turns a plain folder
      // into somewhere PyneIDE belongs, so the item follows the open set.
      vscode.workspace.onDidOpenTextDocument(refresh),
      vscode.workspace.onDidCloseTextDocument(refresh),
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        this.freshFolders.clear();
        refresh();
      }),
      // A folder stops being fresh the moment it has a file in it.
      vscode.workspace.onDidCreateFiles(() => {
        this.freshFolders.clear();
        refresh();
      }),
      vscode.commands.registerCommand('pyneide.environmentMenu', () => this.showMenu())
    );
    this.item.show();
  }

  private update(state: EnvState): void {
    this.item.backgroundColor = undefined;
    // A missing environment is a global fact, and calling for attention about
    // it in a window with no Pyne work in it is just noise — a JS project has
    // nothing to set up. The state is still reported, only without the colour.
    const wanted = this.isWantedHere();
    switch (state.kind) {
      case 'unknown':
        this.item.text = '$(question) PyneIDE';
        this.summary = {
          icon: '$(question)',
          state: 'unknown',
          tooltip: 'PyneIDE: environment state unknown',
        };
        break;
      case 'needs-setup':
        this.item.text = wanted ? '$(warning) PyneIDE' : '$(circle-large-outline) PyneIDE';
        this.summary = {
          icon: '$(warning)',
          state: 'needs setup',
          detail: state.reason,
          tooltip: `PyneIDE: ${state.reason}`,
        };
        if (wanted) {
          this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        }
        break;
      case 'working':
        this.item.text = '$(sync~spin) PyneIDE';
        this.summary = {
          icon: '$(sync~spin)',
          state: 'working',
          detail: state.step,
          tooltip: `PyneIDE: ${state.step}`,
        };
        break;
      case 'ready': {
        this.item.text = '$(check) PyneIDE';
        const source =
          state.source === 'managed' ? 'managed environment' : `custom (${state.source})`;
        const versions =
          `Python ${state.verify.pythonVersion}, ` +
          `pynecore ${state.verify.pynecoreVersion}, debugpy ${state.verify.debugpyVersion}`;
        this.summary = {
          icon: '$(check)',
          state: 'ready',
          source,
          detail: versions,
          tooltip: `PyneIDE: ready — ${versions} (${source})`,
        };
        break;
      }
      case 'error':
        this.item.text = wanted ? '$(error) PyneIDE' : '$(circle-large-outline) PyneIDE';
        this.summary = {
          icon: '$(error)',
          state: 'error',
          detail: state.message,
          tooltip: `PyneIDE: ${state.message}`,
        };
        if (wanted) {
          this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
        }
        break;
    }
    this.item.tooltip = `${this.summary.tooltip}.${MENU_HINT}`;
  }

  /**
   * Whether this window is somewhere PyneIDE is plausibly wanted: an
   * initialized Pyne project, a Pine or Pyne file the user has open, or a fresh
   * empty folder — the state someone is in when they are about to start one.
   */
  private isWantedHere(): boolean {
    if (resolvePyneIdeWorkdir()) return true;
    const open = vscode.workspace.textDocuments.some(
      (doc) =>
        doc.languageId === 'pine' ||
        (doc.languageId === 'python' &&
          detectPyne(doc.getText().slice(0, DETECT_HEAD_BYTES)) !== undefined)
    );
    return open || this.inFreshFolder();
  }

  /**
   * A single workspace folder with nothing visible in it. Dot-entries are
   * ignored so a folder holding only `.git` still counts as a fresh start.
   * Memoized per path: this runs on every editor switch, and the answer only
   * changes when the folder set does.
   */
  private inFreshFolder(): boolean {
    const folders = vscode.workspace.workspaceFolders;
    if (folders?.length !== 1) return false;
    const dir = folders[0].uri.fsPath;
    const cached = this.freshFolders.get(dir);
    if (cached !== undefined) return cached;
    let fresh = false;
    try {
      fresh = fs.readdirSync(dir).every((entry) => entry.startsWith('.'));
    } catch {
      // Unreadable folder — treat as occupied rather than invite setup into it.
    }
    this.freshFolders.set(dir, fresh);
    return fresh;
  }

  private async showMenu(): Promise<void> {
    const picker = vscode.window.createQuickPick<MenuItem>();
    // The state goes in the title (short enough not to be elided) and, in full,
    // into the Environment row — never into the placeholder, which is a filter
    // hint the input box truncates to one line.
    picker.placeholder = 'Type to filter PyneIDE actions';
    picker.matchOnDescription = true;
    picker.matchOnDetail = true;

    let usageState: UsageState = { kind: 'loading' };
    let pluginsState: PluginsState = { kind: 'loading' };
    let closed = false;

    const render = (): void => {
      if (closed) return;
      const state = this.manager.state;
      picker.title = `PyneIDE — ${this.summary.state}`;
      const items: MenuItem[] = [];
      // Inert row: the versions and the failure reason are the only place in the
      // UI where they are readable in full, and `matchOnDetail` makes them
      // searchable ("pynecore" finds the installed version).
      const environmentItems: MenuItem[] = [
        {
          label: `${this.summary.icon} Environment: ${this.summary.state}`,
          description: this.summary.source,
          detail: this.summary.detail,
        },
      ];
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
          label: '$(book) Documentation',
          description: 'PyneIDE and PyneCore documentation',
          action: () => void vscode.commands.executeCommand('pyneide.openDocs'),
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
