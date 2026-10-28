import * as fs from 'node:fs';
import * as path from 'node:path';

import * as vscode from 'vscode';

import { describeNetworkError, flattenErrorMessage, SETUP_TARGET } from '../net/errors';
import { showNetworkError } from '../net/notify';
import {
  bootstrapManagedEnv,
  markerUpToDate,
  readMarker,
  verifyPython,
  validateCoreVersion,
  type VerifyResult,
} from './bootstrap';
import { isCancelledError } from './cancel';
import {
  installPackages as uvInstallPackages,
  uninstallPackages as uvUninstallPackages,
} from './packages';
import { interpreterInUse } from './usage';
import { managedVenvDir, venvPythonPath } from './uv';

export type EnvState =
  | { kind: 'unknown' }
  | { kind: 'needs-setup'; reason: string; cause: SetupCause }
  | { kind: 'working'; step: string }
  | { kind: 'ready'; pythonBin: string; source: EnvSource; verify: VerifyResult }
  | { kind: 'error'; message: string };

/**
 * Why the managed environment needs setup: never installed (`missing`), the
 * selected toolchain changed under an existing install (`outdated`), or an
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
 * Routes operations to project-owned environments, or checks a user-provided
 * interpreter. Shared uv/Python downloads stay in extension storage.
 */
export class EnvManager {
  private readonly onDidChangeStateEmitter = new vscode.EventEmitter<EnvState>();
  readonly onDidChangeState = this.onDidChangeStateEmitter.event;

  private readonly projectEmitter = new vscode.EventEmitter<{ manager: EnvManager; state: EnvState }>();
  readonly onDidChangeProjectState = this.projectEmitter.event;
  private readonly projects = new Map<string, EnvManager>();
  private activeProject?: vscode.Uri;
  private readonly subscriptions: vscode.Disposable[] = [];
  private updatePromise?: Promise<void>;
  private lastUpdateCheck = 0;
  private stateValue: EnvState = { kind: 'unknown' };
  private setupRunning = false;
  private checkRevision = 0;
  private readonly settingsWatcher: vscode.Disposable;

  constructor(
    private readonly storageDir: string,
    private readonly output: vscode.OutputChannel,
    readonly projectUri?: vscode.Uri,
    private readonly owner?: EnvManager
  ) {
    this.settingsWatcher = vscode.workspace.onDidChangeConfiguration((e) => {
      if (!this.projectUri || this.setupRunning) return;
      if (['pyneide.venvPath', 'pyneide.pythonPath', 'pyneide.pynecore.version'].some(
        (key) => e.affectsConfiguration(key, this.projectUri)
      )) {
        void this.check().then(async (state) => {
          if (state.kind === 'needs-setup' && state.cause === 'outdated' && !this.busy) {
            await this.setup();
          }
        });
      }
    });
    if (!projectUri) {
      const editor = vscode.window.activeTextEditor;
      this.activeProject = editor && vscode.workspace.getWorkspaceFolder(editor.document.uri)?.uri;
      this.subscriptions.push(vscode.window.onDidChangeActiveTextEditor((editor) => {
        const folder = editor && vscode.workspace.getWorkspaceFolder(editor.document.uri);
        if (!folder || folder.uri.toString() === this.activeProject?.toString()) return;
        this.activeProject = folder.uri;
        const project = this.forResource(folder.uri);
        this.onDidChangeStateEmitter.fire(project.state);
        void project.check();
      }));
      this.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders((e) => {
        for (const folder of e.removed) {
          this.projects.get(folder.uri.toString())?.dispose();
          this.projects.delete(folder.uri.toString());
        }
        if (this.activeProject && !vscode.workspace.getWorkspaceFolder(this.activeProject)) {
          this.activeProject = undefined;
        }
        for (const folder of e.added) void this.forResource(folder.uri).check();
        this.onDidChangeStateEmitter.fire(this.state);
      }));
    }
  }

  /** Resolve once before awaiting UI, so a focus change cannot retarget an operation. */
  forResource(resource?: vscode.Uri): EnvManager {
    if (this.projectUri) return this;
    const uri = resource ?? vscode.window.activeTextEditor?.document.uri ?? this.activeProject;
    const folder = uri && vscode.workspace.getWorkspaceFolder(uri);
    if (resource && !folder) return this;
    const project = folder?.uri ?? this.activeProject ?? vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!project) return this;
    return this.forProject(project);
  }

  /** Also supports initializing a chosen folder before it is opened in VS Code. */
  forProject(uri: vscode.Uri): EnvManager {
    if (this.projectUri?.toString() === uri.toString()) return this;
    if (this.owner) return this.owner.forProject(uri);
    const key = uri.toString();
    let manager = this.projects.get(key);
    if (!manager) {
      manager = new EnvManager(this.storageDir, this.output, uri, this);
      const scoped = manager;
      this.projects.set(key, scoped);
      this.subscriptions.push(scoped.onDidChangeState((state) => {
        this.projectEmitter.fire({ manager: scoped, state });
        if (this.forResource() === scoped) {
          void vscode.commands.executeCommand('setContext', 'pyneide.envReady', state.kind === 'ready');
          this.onDidChangeStateEmitter.fire(state);
        }
      }));
    }
    return manager;
  }

  get environmentDir(): string | undefined {
    const target = this.forResource();
    return target !== this ? target.environmentDir
      : this.projectUri ? path.join(this.projectUri.fsPath, '.pyneide') : undefined;
  }

  get selection(): string {
    const project = this.forResource();
    if (project !== this) return project.selection;
    return validateCoreVersion(this.config().get<string>('pynecore.version', ''));
  }

  get busy(): boolean {
    const target = this.forResource();
    return target !== this ? target.busy : this.setupRunning || interpreterInUse(this.resolveTarget().pythonBin);
  }

  /** Background checks stay offline-friendly and never update an explicitly selected Core. */
  async autoUpdateCheck(): Promise<void> {
    if (!this.projectUri) {
      await Promise.all((vscode.workspace.workspaceFolders ?? []).map(
        (folder) => this.forProject(folder.uri).autoUpdateCheck()
      ));
      return;
    }
    if (this.updatePromise) return this.updatePromise;
    if (this.busy || !this.managesEnvironment || this.state.kind !== 'ready') return;
    try {
      if (this.selection) return;
    } catch { return; }
    const marker = readMarker(this.environmentDir!);
    if (!marker || Date.now() - Math.max(marker.checkedAt ?? 0, this.lastUpdateCheck) < 24 * 60 * 60 * 1000) return;
    this.lastUpdateCheck = Date.now();
    const previous = this.stateValue;
    this.updatePromise = this.setup({ silent: true }).catch(async (err: unknown) => {
      this.log(`Automatic PyneCore update failed: ${String(err)}`);
      const state = await this.check();
      if (state.kind === 'working') this.setState(previous);
    }).finally(() => { this.updatePromise = undefined; });
    return this.updatePromise;
  }

  get state(): EnvState {
    const target = this.forResource();
    return target !== this ? target.state : this.stateValue;
  }

  private setState(state: EnvState): void {
    this.stateValue = state;
    // The walkthrough's setup step completes off this key: an environment that
    // is already working must show up as done, not as a pending first step.
    if (!this.projectUri) void vscode.commands.executeCommand('setContext', 'pyneide.envReady', state.kind === 'ready');
    this.onDidChangeStateEmitter.fire(state);
  }

  private log = (message: string): void => {
    this.output.appendLine(message);
  };

  private config() {
    return vscode.workspace.getConfiguration('pyneide', this.projectUri);
  }

  private resolveTarget(): ResolvedTarget {
    const venvPath = this.config().get<string>('venvPath')?.trim();
    if (venvPath) {
      return { source: 'venvPath', pythonBin: venvPythonPath(path.resolve(this.projectUri?.fsPath ?? '.', venvPath)) };
    }
    const pythonPath = this.config().get<string>('pythonPath')?.trim();
    if (pythonPath) {
      return { source: 'pythonPath', pythonBin: path.isAbsolute(pythonPath) ? pythonPath : path.resolve(this.projectUri?.fsPath ?? '.', pythonPath) };
    }
    return { source: 'managed', pythonBin: venvPythonPath(managedVenvDir(this.environmentDir ?? this.storageDir)) };
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
    const project = this.forResource();
    if (project !== this) return project.check();
    if (!this.projectUri) return this.stateValue;
    if (this.setupRunning) return this.stateValue;
    const revision = ++this.checkRevision;
    let selection: string;
    try { selection = this.selection; } catch (err) {
      this.setState({ kind: 'error', message: String(err) });
      return this.stateValue;
    }
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
      if (revision !== this.checkRevision || this.setupRunning) return this.stateValue;
      if (verify.ok && selection && verify.pynecoreVersion !== selection) {
        verify.ok = false;
        verify.error = `This project selects PyneCore ${selection}, but the external environment has ${verify.pynecoreVersion}.`;
      }
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
    if (!readMarker(this.environmentDir!)) {
      this.setState({
        kind: 'needs-setup',
        reason: 'The Python environment setup did not finish.',
        cause: 'missing',
      });
      return this.stateValue;
    }
    if (!markerUpToDate(this.environmentDir!, selection)) {
      this.setState({
        kind: 'needs-setup',
        reason: 'The project environment does not match its selected toolchain.',
        cause: 'outdated',
      });
      return this.stateValue;
    }
    const verify = await verifyPython(target.pythonBin, this.log);
    if (revision !== this.checkRevision || this.setupRunning) return this.stateValue;
    if (verify.ok && selection && verify.pynecoreVersion !== selection) {
      verify.ok = false;
      verify.error = `This project selects PyneCore ${selection}, but ${verify.pynecoreVersion} is installed.`;
    }
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
  async setup(options: { recreate?: boolean; silent?: boolean } = {}): Promise<void> {
    const project = this.forResource();
    if (project !== this) return project.setup(options);
    if (!this.projectUri) {
      if (!options.silent) void vscode.window.showInformationMessage('PyneIDE: open a project folder before setting up its environment.');
      return;
    }
    if (interpreterInUse(this.resolveTarget().pythonBin)) {
      if (!options.silent) void vscode.window.showInformationMessage('PyneIDE: this project environment is in use. Stop its running tasks before changing it.');
      return;
    }
    let selection: string;
    try { selection = this.selection; } catch (err) {
      this.setState({ kind: 'error', message: String(err) });
      if (!options.silent) void vscode.window.showErrorMessage(String(err));
      return;
    }
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
    this.checkRevision++;
    this.setState({ kind: 'working', step: 'Preparing project environment' });
    let offerRepair = true;
    // Chosen in the catch, run after the finally: `setupRunning` is only
    // cleared there, so a retry started from inside the catch would hit the
    // "already running" guard and silently do nothing.
    let followUp: 'retry' | 'repair' | undefined;
    try {
      fs.mkdirSync(this.environmentDir!, { recursive: true });
      const ignore = path.join(this.environmentDir!, '.gitignore');
      if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, '*\n');
      await vscode.window.withProgress(
        {
          location: options.silent ? vscode.ProgressLocation.Window : vscode.ProgressLocation.Notification,
          title: 'PyneIDE: setting up project Python environment',
          cancellable: true,
        },
        async (progress, token) => {
          // withProgress takes increments, the bootstrap reports an absolute
          // position: keep the running total to convert, and never emit a
          // negative step (the recreate pass may report from further back).
          let reported = 0;
          const { verify } = await bootstrapManagedEnv({
            storageDir: this.storageDir,
            environmentDir: this.environmentDir,
            pynecoreVersion: selection,
            log: this.log,
            proxyUrl: this.proxyUrl(),
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
            if (verify.failure === 'pynecore-too-old') offerRepair = false;
            throw new Error(verify.error ?? 'unknown verification error');
          }
        }
      );
      this.setupRunning = false;
      await this.check();
      const state = this.stateValue;
      if (state.kind === 'ready' && !options.silent) {
        void vscode.window.showInformationMessage(
          `PyneIDE: environment ready (Python ${state.verify.pythonVersion}, ` +
            `pynecore ${state.verify.pynecoreVersion}).`
        );
      }
    } catch (err) {
      if (options.silent) throw err;
      this.setupRunning = false;
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
        actions: offerRepair
          ? [
            {
              title: 'Repair (clean reinstall)',
              run: () => {
                followUp = 'repair';
              },
            },
          ]
          : [],
        showLog: () => this.output.show(),
      });
    } finally {
      this.setupRunning = false;
    }
    if (followUp) await this.setup({ recreate: followUp === 'repair' });
  }

  /** True when PyneIDE owns the environment, i.e. may install into it. */
  get managesEnvironment(): boolean {
    const project = this.forResource();
    return project !== this ? project.managesEnvironment : Boolean(this.projectUri) && this.resolveTarget().source === 'managed';
  }

  /**
   * Install extra packages (plugins) into the managed venv, with progress UI.
   * Refuses user-provided environments — PyneIDE never writes into those.
   */
  async installPackages(packages: string[], title: string): Promise<void> {
    const project = this.forResource();
    if (project !== this) return project.installPackages(packages, title);
    await this.runPackageOperation(packages, title, uvInstallPackages);
  }

  /** Remove packages from the managed venv. Same rules as installPackages. */
  async uninstallPackages(packages: string[], title: string): Promise<void> {
    const project = this.forResource();
    if (project !== this) return project.uninstallPackages(packages, title);
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
      pynecoreVersion?: string;
    }) => Promise<void>
  ): Promise<void> {
    if (this.busy) throw new Error('The project environment is in use. Stop its running tasks first.');
    const state = await this.check();
    if (state.kind !== 'ready') throw new Error('The project environment is not ready.');
    const target = this.resolveTarget();
    if (target.source !== 'managed') {
      throw new Error(
        'PyneIDE does not install into user-provided environments ' +
          `(${target.source === 'venvPath' ? 'pyneide.venvPath' : 'pyneide.pythonPath'} is set).`
      );
    }
    this.setupRunning = true;
    this.checkRevision++;
    this.setState({ kind: 'working', step: title });
    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title, cancellable: false },
        async () => {
          await operation({
            storageDir: this.storageDir,
            pynecoreVersion: state.verify.pynecoreVersion,
            pythonBin: target.pythonBin,
            packages,
            log: this.log,
            proxyUrl: this.proxyUrl(),
          });
        }
      );
    } finally {
      this.setupRunning = false;
      await this.check();
    }
  }

  /**
   * Ensure a usable Python environment, offering setup when missing.
   * Returns the interpreter path, or undefined when the user declined or
   * setup failed (after informing them).
   */
  async ensureReady(reason: string, resource?: vscode.Uri): Promise<string | undefined> {
    const project = this.forResource(resource);
    if (project !== this) return project.ensureReady(reason);
    if (!this.projectUri) {
      void vscode.window.showWarningMessage('PyneIDE: open a project folder before running Pyne scripts.');
      return undefined;
    }
    if (this.updatePromise) await this.updatePromise;
    let state = await this.check();
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
        state.kind === 'error'
          ? `PyneIDE: ${state.message}`
          : 'PyneIDE: the Python environment is not available.'
      );
      return undefined;
    }
    await this.autoUpdateCheck();
    return this.stateValue.kind === 'ready' ? this.stateValue.pythonBin : undefined;
  }

  dispose(): void {
    this.settingsWatcher.dispose();
    for (const sub of this.subscriptions) sub.dispose();
    for (const project of this.projects.values()) project.dispose();
    this.onDidChangeStateEmitter.dispose();
    this.projectEmitter.dispose();
  }
}
