import * as vscode from 'vscode';

import { PineLsClient } from './client';
import { PineLsManager, type PineLsState } from './manager';

const INSTALL_PROMPTED_KEY = 'pyneide.pineLsInstallPrompted';

/**
 * Wires the Pine LS install state to the LanguageClient: starts/stops the
 * server as the state changes, rolls back a bad update when the fresh binary
 * fails to launch, and reflects everything in a pine language status item.
 */
export class PineLsService {
  private readonly manager: PineLsManager;
  private readonly client: PineLsClient;
  private readonly statusItem: vscode.LanguageStatusItem;
  private syncing = false;
  private rollbackAttempted = false;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly output: vscode.OutputChannel
  ) {
    this.manager = new PineLsManager(context.globalStorageUri.fsPath, output);
    this.client = new PineLsClient(output);
    this.statusItem = vscode.languages.createLanguageStatusItem('pyneide.pineLs', {
      language: 'pine',
    });
    this.statusItem.name = 'Pine Language Server';
    this.statusItem.command = { title: 'Show Log', command: 'pyneide.pineLsShowLog' };
  }

  register(): void {
    this.context.subscriptions.push(
      this.manager,
      this.statusItem,
      { dispose: () => void this.client.stop() },
      this.manager.onDidChangeState((state) => {
        this.updateStatusItem(state);
        void this.syncClient(state);
      }),
      vscode.commands.registerCommand('pyneide.pineLsInstall', () =>
        this.manager.installOrUpdate()
      ),
      vscode.commands.registerCommand('pyneide.pineLsRestart', () => this.restart()),
      vscode.commands.registerCommand('pyneide.pineLsShowLog', () => this.output.show()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('pyneide.pineLs')) this.manager.check();
      })
    );
  }

  get state(): PineLsState {
    return this.manager.state;
  }

  get onDidChangeState(): vscode.Event<PineLsState> {
    return this.manager.onDidChangeState;
  }

  get serverRunning(): boolean {
    return this.client.running;
  }

  canRollback(): boolean {
    return this.manager.canRollback();
  }

  installOrUpdate(): Promise<void> {
    return this.manager.installOrUpdate();
  }

  rollback(): Promise<boolean> {
    return this.manager.rollback();
  }

  async restart(): Promise<void> {
    await this.client.stop();
    this.manager.check();
  }

  /** Release the installed binary (it is about to be deleted). */
  async stopServer(): Promise<void> {
    await this.client.stop();
  }

  /** Activation entry: local check, one-time install offer, background update. */
  async initialize(): Promise<void> {
    const state = this.manager.check();
    if (state.kind === 'needs-install') {
      await this.offerInstallOnce();
    }
    await this.manager.autoUpdateCheck(this.context.globalState);
  }

  private async offerInstallOnce(): Promise<void> {
    if (this.context.globalState.get<boolean>(INSTALL_PROMPTED_KEY)) return;
    await this.context.globalState.update(INSTALL_PROMPTED_KEY, true);
    const choice = await vscode.window.showInformationMessage(
      'PyneIDE can install the Pine language server (signed native binary, ~12 MB download) ' +
        'for Pine code diagnostics, completion and navigation. Install it now?',
      'Install Now',
      'Later'
    );
    if (choice === 'Install Now') {
      await this.manager.installOrUpdate();
    }
  }

  private async syncClient(state: PineLsState): Promise<void> {
    if (this.syncing) return;
    this.syncing = true;
    try {
      if (state.kind !== 'ready') {
        if (state.kind !== 'working') await this.client.stop();
        return;
      }
      try {
        await this.client.start(state.executablePath);
        this.rollbackAttempted = false;
        this.updateStatusItem(state);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.output.appendLine(`Pine LS failed to start: ${message}`);
        // A bad update must not break the previously working install: try the
        // kept previous version once, automatically.
        if (state.source === 'managed' && !this.rollbackAttempted && this.manager.canRollback()) {
          this.rollbackAttempted = true;
          this.output.appendLine('Attempting automatic rollback to the previous Pine LS version');
          this.syncing = false;
          await this.manager.rollback();
          return;
        }
        this.statusItem.severity = vscode.LanguageStatusSeverity.Error;
        this.statusItem.text = 'Pine LS failed to start';
        this.statusItem.detail = message;
        void vscode.window
          .showErrorMessage(`PyneIDE: Pine language server failed to start: ${message}`, 'Show Log')
          .then((choice) => {
            if (choice === 'Show Log') this.output.show();
          });
      }
    } finally {
      this.syncing = false;
    }
  }

  private updateStatusItem(state: PineLsState): void {
    this.statusItem.busy = state.kind === 'working';
    this.statusItem.severity = vscode.LanguageStatusSeverity.Information;
    this.statusItem.command = { title: 'Show Log', command: 'pyneide.pineLsShowLog' };
    switch (state.kind) {
      case 'unknown':
      case 'disabled':
        this.statusItem.text = 'Pine LS off';
        this.statusItem.detail =
          state.kind === 'disabled' ? 'Disabled via pyneide.pineLs.enabled' : undefined;
        break;
      case 'unsupported':
        this.statusItem.severity = vscode.LanguageStatusSeverity.Warning;
        this.statusItem.text = 'Pine LS unavailable';
        this.statusItem.detail = `No Pine language server build for ${state.target}`;
        break;
      case 'needs-install':
        this.statusItem.severity = vscode.LanguageStatusSeverity.Warning;
        this.statusItem.text = 'Pine LS not installed';
        this.statusItem.detail = 'Run "PyneIDE: Install / Update Pine Language Server"';
        this.statusItem.command = { title: 'Install', command: 'pyneide.pineLsInstall' };
        break;
      case 'working':
        this.statusItem.text = 'Pine LS';
        this.statusItem.detail = state.step;
        break;
      case 'ready':
        this.statusItem.text =
          state.version === 'custom' ? 'Pine LS (custom)' : `Pine LS ${state.version}`;
        this.statusItem.detail = state.executablePath;
        break;
      case 'error':
        this.statusItem.severity = vscode.LanguageStatusSeverity.Error;
        this.statusItem.text = 'Pine LS error';
        this.statusItem.detail = state.message;
        break;
    }
  }
}
