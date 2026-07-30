import * as fs from 'node:fs';

import * as vscode from 'vscode';

import { describeNetworkError, flattenErrorMessage, SETUP_TARGET } from '../net/errors';
import { showNetworkError } from '../net/notify';
import {
  bootstrapManagedEnv,
  markerUpToDate,
  readMarker,
  verifyPython,
  type VerifyResult,
} from './bootstrap';
import { isCancelledError } from './cancel';
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
    // An interpreter with no marker at all means a setup that started and never
    // finished — most likely cancelled. Reporting that as "outdated" would name
    // a cause that never happened.
    if (!readMarker(this.storageDir)) {
      this.setState({
        kind: 'needs-setup',
        reason: 'The Python environment setup did not finish.',
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
    // Chosen in the catch, run after the finally: `setupRunning` is only
    // cleared there, so a retry started from inside the catch would hit the
    // "already running" guard and silently do nothing.
    let followUp: 'retry' | 'repair' | undefined;
    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'PyneIDE: setting up Python environment',
          cancellable: true,
        },
        async (progress, token) => {
          // withProgress takes increments, the bootstrap reports an absolute
          // position: keep the running total to convert, and never emit a
          // negative step (the recreate pass may report from further back).
          let reported = 0;
          const { verify } = await bootstrapManagedEnv({
            storageDir: this.storageDir,
            log: this.log,
            proxyUrl: this.proxyUrl(),
            useOwnPynecore: this.config().get<boolean>('useOwnPynecore') ?? false,
            recreate: options.recreate,
            cancel: token,
            progress: ({ message, percent }) => {
              const increment = Math.max(0, percent * 100 - reported);
              reported += increment;
              progress.report({ message, increment });
              this.setState({ kind: 'working', step: message });
            },
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
      if (isCancelledError(err)) {
        this.log('Setup cancelled.');
        await this.check();
        void vscode.window.showInformationMessage(
          'PyneIDE: environment setup cancelled. What was downloaded is kept, ' +
            'so running setup again continues from there.'
        );
        return;
      }
      const message = flattenErrorMessage(err);
      this.log(`Setup failed: ${message}`);
      const friendly = describeNetworkError(err, SETUP_TARGET);
      this.setState({ kind: 'error', message: friendly?.summary ?? message });
      await showNetworkError({
        headline: 'environment setup failed',
        error: err,
        target: SETUP_TARGET,
        retry: () => {
          followUp = 'retry';
        },
        actions: [
          {
            title: 'Repair (clean reinstall)',
            run: () => {
              followUp = 'repair';
            },
          },
        ],
        showLog: () => this.output.show(),
      });
    } finally {
      this.setupRunning = false;
    }
    if (followUp) await this.setup({ recreate: followUp === 'repair' });
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
      // setup() already reported why it did not finish — cancelling it must not
      // also produce a generic "not available" error on top.
      if (state.kind !== 'ready') return undefined;
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
