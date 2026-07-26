import * as fs from 'node:fs';

import * as vscode from 'vscode';

import { bootstrapManagedEnv, markerUpToDate, verifyPython, type VerifyResult } from './bootstrap';
import {
  installPackages as uvInstallPackages,
  uninstallPackages as uvUninstallPackages,
} from './packages';
import { managedVenvDir, venvPythonPath } from './uv';

export type EnvState =
  | { kind: 'unknown' }
  | { kind: 'needs-setup'; reason: string; cause: SetupCause }
  | { kind: 'working'; step: string }
  | { kind: 'ready'; pythonBin: string; source: EnvSource; verify: VerifyResult }
  | { kind: 'error'; message: string };

/**
 * Why the managed environment needs setup: never installed (`missing`), the
 * pinned versions changed under an existing install (`outdated`), or an
 * otherwise-present install failed verification (`broken`). Drives whether the
 * user is actively notified and how the prompt is worded.
 */
export type SetupCause = 'missing' | 'outdated' | 'broken';

export type EnvSource = 'managed' | 'venvPath' | 'pythonPath';

interface ResolvedTarget {
  source: EnvSource;
  pythonBin: string;
}

/**
 * Owns the Python environment used by PyneIDE: the managed uv venv in
 * globalStorage, or a user-provided interpreter/venv via settings.
 */
export class EnvManager {
  private readonly onDidChangeStateEmitter = new vscode.EventEmitter<EnvState>();
  readonly onDidChangeState = this.onDidChangeStateEmitter.event;

  private stateValue: EnvState = { kind: 'unknown' };
  private setupRunning = false;

  constructor(
    private readonly storageDir: string,
    private readonly output: vscode.OutputChannel
  ) {}

  get state(): EnvState {
    return this.stateValue;
  }

  private setState(state: EnvState): void {
    this.stateValue = state;
    // The walkthrough's setup step completes off this key: an environment that
    // is already working must show up as done, not as a pending first step.
    void vscode.commands.executeCommand('setContext', 'pyneide.envReady', state.kind === 'ready');
    this.onDidChangeStateEmitter.fire(state);
  }

  private log = (message: string): void => {
    this.output.appendLine(message);
  };

  private config() {
    return vscode.workspace.getConfiguration('pyneide');
  }

  private resolveTarget(): ResolvedTarget {
    const venvPath = this.config().get<string>('venvPath')?.trim();
    if (venvPath) {
      return { source: 'venvPath', pythonBin: venvPythonPath(venvPath) };
    }
    const pythonPath = this.config().get<string>('pythonPath')?.trim();
    if (pythonPath) {
      return { source: 'pythonPath', pythonBin: pythonPath };
    }
    return { source: 'managed', pythonBin: venvPythonPath(managedVenvDir(this.storageDir)) };
  }

  private proxyUrl(): string | undefined {
    return (
      vscode.workspace.getConfiguration('http').get<string>('proxy')?.trim() ||
      process.env.HTTPS_PROXY ||
      process.env.https_proxy ||
      undefined
    );
  }

  /** Non-destructive status check; never installs anything. */
  async check(): Promise<EnvState> {
    const target = this.resolveTarget();
    this.setState({ kind: 'working', step: 'Checking environment' });

    if (target.source !== 'managed') {
      if (!fs.existsSync(target.pythonBin)) {
        const setting = target.source === 'venvPath' ? 'pyneide.venvPath' : 'pyneide.pythonPath';
        this.setState({
          kind: 'error',
          message: `${setting}: interpreter not found at ${target.pythonBin}`,
        });
        return this.stateValue;
      }
      const verify = await verifyPython(target.pythonBin, this.log);
      this.setState(
        verify.ok
          ? { kind: 'ready', pythonBin: target.pythonBin, source: target.source, verify }
          : {
              kind: 'error',
              message: `Environment at ${target.pythonBin} is not usable: ${verify.error}`,
            }
      );
      return this.stateValue;
    }

    if (!fs.existsSync(target.pythonBin)) {
      this.setState({
        kind: 'needs-setup',
        reason: 'The Python environment is not set up yet.',
        cause: 'missing',
      });
      return this.stateValue;
    }
    if (!markerUpToDate(this.storageDir)) {
      this.setState({
        kind: 'needs-setup',
        reason: 'The Python environment is outdated (new pinned versions).',
        cause: 'outdated',
      });
      return this.stateValue;
    }
    const verify = await verifyPython(target.pythonBin, this.log);
    this.setState(
      verify.ok
        ? { kind: 'ready', pythonBin: target.pythonBin, source: 'managed', verify }
        : { kind: 'needs-setup', reason: `Environment check failed: ${verify.error}`, cause: 'broken' }
    );
    return this.stateValue;
  }

  /**
   * Set up (or repair) the managed environment with progress UI.
   * With venvPath/pythonPath overrides this only re-runs the check.
   */
  async setup(options: { recreate?: boolean } = {}): Promise<void> {
    if (this.setupRunning) {
      void vscode.window.showInformationMessage('PyneIDE: environment setup is already running.');
      return;
    }
    const target = this.resolveTarget();
    if (target.source !== 'managed') {
      const setting = target.source === 'venvPath' ? 'pyneide.venvPath' : 'pyneide.pythonPath';
      this.log(`${setting} is set — PyneIDE does not install into user-provided environments.`);
      await this.check();
      if (this.stateValue.kind === 'error') {
        void vscode.window.showErrorMessage(`PyneIDE: ${this.stateValue.message}`);
      }
      return;
    }

    this.setupRunning = true;
    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'PyneIDE: setting up Python environment',
          cancellable: false,
        },
        async (progress) => {
          const step = (message: string): void => {
            progress.report({ message });
            this.setState({ kind: 'working', step: message });
          };
          step('Preparing uv + Python…');
          const { verify } = await bootstrapManagedEnv({
            storageDir: this.storageDir,
            log: (msg) => {
              this.log(msg);
              if (msg.startsWith('Downloading') || msg.startsWith('Creating') || msg.startsWith('Installing')) {
                step(msg);
              }
            },
            proxyUrl: this.proxyUrl(),
            useOwnPynecore: this.config().get<boolean>('useOwnPynecore') ?? false,
            recreate: options.recreate,
          });
          if (!verify.ok) {
            throw new Error(verify.error ?? 'unknown verification error');
          }
        }
      );
      await this.check();
      const state = this.stateValue;
      if (state.kind === 'ready') {
        void vscode.window.showInformationMessage(
          `PyneIDE: environment ready (Python ${state.verify.pythonVersion}, ` +
            `pynecore ${state.verify.pynecoreVersion}).`
        );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log(`Setup failed: ${message}`);
      this.setState({ kind: 'error', message });
      const choice = await vscode.window.showErrorMessage(
        `PyneIDE: environment setup failed: ${message}`,
        'Retry',
        'Repair (clean reinstall)',
        'Show Log'
      );
      if (choice === 'Retry') {
        void this.setup();
      } else if (choice === 'Repair (clean reinstall)') {
        void this.setup({ recreate: true });
      } else if (choice === 'Show Log') {
        this.output.show();
      }
    } finally {
      this.setupRunning = false;
    }
  }

  /** True when PyneIDE owns the environment, i.e. may install into it. */
  get managesEnvironment(): boolean {
    return this.resolveTarget().source === 'managed';
  }

  /**
   * Install extra packages (plugins) into the managed venv, with progress UI.
   * Refuses user-provided environments — PyneIDE never writes into those.
   */
  async installPackages(packages: string[], title: string): Promise<void> {
    await this.runPackageOperation(packages, title, uvInstallPackages);
  }

  /** Remove packages from the managed venv. Same rules as installPackages. */
  async uninstallPackages(packages: string[], title: string): Promise<void> {
    await this.runPackageOperation(packages, title, uvUninstallPackages);
  }

  private async runPackageOperation(
    packages: string[],
    title: string,
    operation: (op: {
      storageDir: string;
      pythonBin: string;
      packages: string[];
      log: (message: string) => void;
      proxyUrl?: string;
    }) => Promise<void>
  ): Promise<void> {
    const target = this.resolveTarget();
    if (target.source !== 'managed') {
      throw new Error(
        'PyneIDE does not install into user-provided environments ' +
          `(${target.source === 'venvPath' ? 'pyneide.venvPath' : 'pyneide.pythonPath'} is set).`
      );
    }
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title, cancellable: false },
      async () => {
        await operation({
          storageDir: this.storageDir,
          pythonBin: target.pythonBin,
          packages,
          log: this.log,
          proxyUrl: this.proxyUrl(),
        });
      }
    );
    await this.check();
  }

  /**
   * Ensure a usable Python environment, offering setup when missing.
   * Returns the interpreter path, or undefined when the user declined or
   * setup failed (after informing them).
   */
  async ensureReady(reason: string): Promise<string | undefined> {
    let state = this.stateValue.kind === 'ready' ? this.stateValue : await this.check();
    if (state.kind === 'needs-setup') {
      const choice = await vscode.window.showInformationMessage(reason, 'Setup Now');
      if (choice !== 'Setup Now') return undefined;
      await this.setup();
      state = this.stateValue;
    }
    if (state.kind !== 'ready') {
      void vscode.window.showErrorMessage(
        'PyneIDE: the Python environment is not available.'
      );
      return undefined;
    }
    return state.pythonBin;
  }

  dispose(): void {
    this.onDidChangeStateEmitter.dispose();
  }
}
