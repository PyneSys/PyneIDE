import * as fs from 'node:fs';

import * as vscode from 'vscode';

import { PINE_LS_BASE_URL } from './constants';
import {
  installPineLs,
  isSupportedTarget,
  readInstalled,
  rollbackPineLs,
  rollbackTarget,
  targetKey,
} from './installer';

export type PineLsState =
  | { kind: 'unknown' }
  | { kind: 'disabled' }
  | { kind: 'unsupported'; target: string }
  | { kind: 'needs-install' }
  | { kind: 'working'; step: string }
  | { kind: 'ready'; version: string; executablePath: string; source: PineLsSource }
  | { kind: 'error'; message: string };

export type PineLsSource = 'managed' | 'custom';

const UPDATE_CHECK_KEY = 'pyneide.pineLs.lastUpdateCheck';
const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Owns the Pine language server install under globalStorage: signed release
 * resolution, atomic install/update, rollback. Never touches the network in
 * `check()`, so an installed LS keeps working fully offline.
 */
export class PineLsManager {
  private readonly onDidChangeStateEmitter = new vscode.EventEmitter<PineLsState>();
  readonly onDidChangeState = this.onDidChangeStateEmitter.event;

  private stateValue: PineLsState = { kind: 'unknown' };
  private installRunning = false;

  constructor(
    private readonly storageDir: string,
    private readonly output: vscode.OutputChannel
  ) {}

  get state(): PineLsState {
    return this.stateValue;
  }

  private setState(state: PineLsState): void {
    this.stateValue = state;
    this.onDidChangeStateEmitter.fire(state);
  }

  private log = (message: string): void => {
    this.output.appendLine(message);
  };

  private config() {
    return vscode.workspace.getConfiguration('pyneide.pineLs');
  }

  private baseUrl(): string {
    return this.config().get<string>('baseUrl')?.trim() || PINE_LS_BASE_URL;
  }

  enabled(): boolean {
    return this.config().get<boolean>('enabled') ?? true;
  }

  autoUpdateEnabled(): boolean {
    return this.config().get<boolean>('autoUpdate') ?? true;
  }

  canRollback(): boolean {
    return rollbackTarget(this.storageDir) !== undefined;
  }

  /** Local-only status check; never installs or goes online. */
  check(): PineLsState {
    if (!this.enabled()) {
      this.setState({ kind: 'disabled' });
      return this.stateValue;
    }
    const customPath = this.config().get<string>('path')?.trim();
    if (customPath) {
      this.setState(
        fs.existsSync(customPath)
          ? { kind: 'ready', version: 'custom', executablePath: customPath, source: 'custom' }
          : { kind: 'error', message: `pyneide.pineLs.path: no executable at ${customPath}` }
      );
      return this.stateValue;
    }
    if (!isSupportedTarget()) {
      this.setState({ kind: 'unsupported', target: targetKey() });
      return this.stateValue;
    }
    const installed = readInstalled(this.storageDir);
    this.setState(
      installed
        ? {
            kind: 'ready',
            version: installed.version,
            executablePath: installed.executablePath,
            source: 'managed',
          }
        : { kind: 'needs-install' }
    );
    return this.stateValue;
  }

  /**
   * Install or update to the newest compatible signed release.
   * `silent` runs are for background auto-update: no progress UI, failures
   * only go to the log (offline must stay quiet).
   */
  async installOrUpdate(options: { silent?: boolean } = {}): Promise<void> {
    if (this.installRunning) {
      if (!options.silent) {
        void vscode.window.showInformationMessage('PyneIDE: Pine LS install is already running.');
      }
      return;
    }
    if (!this.enabled() || this.config().get<string>('path')?.trim()) {
      this.check();
      return;
    }
    this.installRunning = true;
    const previous = this.stateValue;
    try {
      if (options.silent) {
        const outcome = await installPineLs(this.storageDir, this.baseUrl(), this.log);
        if (outcome.status !== 'up-to-date') {
          this.log(`Pine LS auto-update: ${outcome.status} ${outcome.installed.version}`);
        }
        this.check();
        return;
      }
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'PyneIDE: installing Pine language server',
          cancellable: false,
        },
        async (progress) => {
          const step = (message: string): void => {
            progress.report({ message });
            this.setState({ kind: 'working', step: message });
          };
          step('Resolving signed release…');
          const outcome = await installPineLs(this.storageDir, this.baseUrl(), (msg) => {
            this.log(msg);
            if (msg.startsWith('Downloading')) step(msg);
          });
          this.check();
          if (outcome.status === 'up-to-date') {
            void vscode.window.showInformationMessage(
              `PyneIDE: Pine language server ${outcome.installed.version} is up to date.`
            );
          } else {
            void vscode.window.showInformationMessage(
              `PyneIDE: Pine language server ${outcome.installed.version} installed.`
            );
          }
        }
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log(`Pine LS install failed: ${message}`);
      if (options.silent) {
        // Auto-update: keep the working install live, stay quiet.
        this.setState(previous.kind === 'working' ? { kind: 'unknown' } : previous);
        this.check();
        return;
      }
      this.setState({ kind: 'error', message });
      const choice = await vscode.window.showErrorMessage(
        `PyneIDE: Pine language server install failed: ${message}`,
        'Retry',
        'Show Log'
      );
      if (choice === 'Retry') {
        void this.installOrUpdate();
      } else if (choice === 'Show Log') {
        this.output.show();
      }
    } finally {
      this.installRunning = false;
    }
  }

  /** Revert to the previous version after a bad update. */
  async rollback(): Promise<boolean> {
    try {
      const reverted = await rollbackPineLs(this.storageDir, this.log);
      this.check();
      void vscode.window.showInformationMessage(
        `PyneIDE: rolled back to Pine language server ${reverted.version}.`
      );
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log(`Pine LS rollback failed: ${message}`);
      void vscode.window.showErrorMessage(`PyneIDE: Pine LS rollback failed: ${message}`);
      return false;
    }
  }

  /**
   * Background update check, at most once a day. Never blocks startup and
   * never surfaces network errors — offline use must stay undisturbed.
   */
  async autoUpdateCheck(globalState: vscode.Memento): Promise<void> {
    if (!this.enabled() || !this.autoUpdateEnabled()) return;
    if (this.config().get<string>('path')?.trim() || !isSupportedTarget()) return;
    if (!readInstalled(this.storageDir)) return;
    const last = globalState.get<number>(UPDATE_CHECK_KEY) ?? 0;
    if (Date.now() - last < UPDATE_CHECK_INTERVAL_MS) return;
    await globalState.update(UPDATE_CHECK_KEY, Date.now());
    await this.installOrUpdate({ silent: true });
  }

  dispose(): void {
    this.onDidChangeStateEmitter.dispose();
  }
}
