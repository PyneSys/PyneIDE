import * as fs from 'node:fs';
import * as path from 'node:path';

import * as vscode from 'vscode';
import {
  DidChangeConfigurationNotification,
  LanguageClient,
  RevealOutputChannelOn,
  State,
  TransportKind,
  type ServerOptions,
} from 'vscode-languageclient/node';

import type { EnvManager } from '../env/manager';
import { resolveWorkspaceWorkdir } from '../env/workdirConfig';
import { detectPyne, DETECT_HEAD_BYTES } from '../pyneDetect';

/**
 * Extensions that already run a pyright-family language server for Python.
 * Starting a second instance next to them would double every diagnostic, so
 * the bundled server defers to any of these (L5a's generated pyrightconfig
 * covers those setups instead).
 */
const SUPERSEDING_EXTENSIONS = [
  'ms-python.vscode-pylance',
  'ms-pyright.pyright',
  'detachhead.basedpyright',
];

/**
 * The Python extension without Pylance serves completion/hover via Jedi.
 * The bundled pyright then runs with language services disabled so only its
 * diagnostics remain (no duplicate completion lists).
 */
const JEDI_HOST_EXTENSION = 'ms-python.python';

type PyrightStatus =
  | { kind: 'off'; reason: string }
  | { kind: 'starting' }
  | { kind: 'running'; version: string }
  | { kind: 'error'; message: string };

/**
 * Bundled pyright language server for Pyne workspaces (F7/L5b).
 *
 * The stubs + generated pyrightconfig.json from L5a do the heavy lifting;
 * this service makes them work without Pylance (VSCodium / Open VSX installs,
 * where Pylance is not licensed) by shipping pyright-langserver in the VSIX
 * (dist/pyright, MIT) and running it on the extension host's Node.
 *
 * LSP middleware:
 * - workspace/configuration: injects the managed venv interpreter as
 *   python.pythonPath, so pynecore imports resolve without the ms-python
 *   extension; re-pushed whenever the environment state changes.
 * - handleDiagnostics: rule-level filter — reportIndexIssue is dropped in
 *   `@pyne` documents (series history indexing like `close[1]` is valid Pyne;
 *   the transparent `Series[T] = T` alias cannot express it). Non-Pyne Python
 *   files keep the rule. Precise (series-name) filtering is L5c.
 */
export class PyrightService {
  private client?: LanguageClient;
  private status: PyrightStatus = { kind: 'off', reason: 'not started' };
  private readonly statusItem: vscode.LanguageStatusItem;
  private syncing = false;
  private syncAgain = false;
  private lastPushedPython?: string;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly env: EnvManager,
    private readonly output: vscode.OutputChannel
  ) {
    this.statusItem = vscode.languages.createLanguageStatusItem('pyneide.pyright', {
      language: 'python',
    });
    this.statusItem.name = 'Pyne Typing';
  }

  register(): void {
    this.context.subscriptions.push(
      this.statusItem,
      { dispose: () => void this.stopClient() },
      vscode.commands.registerCommand('pyneide.pyrightRestart', () => this.restart()),
      vscode.commands.registerCommand('pyneide.pyrightShowLog', () => this.output.show()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('pyneide.pyright')) void this.sync();
      }),
      vscode.extensions.onDidChange(() => void this.sync()),
      vscode.workspace.onDidChangeWorkspaceFolders(() => void this.sync()),
      // A Pyne file opened outside a workdir-based workspace still turns the
      // server on (gating below); cheap no-op once running.
      vscode.workspace.onDidOpenTextDocument((doc) => {
        if (doc.languageId === 'python' && !this.client) void this.sync();
      }),
      this.env.onDidChangeState((state) => {
        if (state.kind === 'ready' || state.kind === 'error') void this.pushEnvironment();
      })
    );
    void this.sync();
  }

  get running(): boolean {
    return this.client?.state === State.Running;
  }

  async restart(): Promise<void> {
    await this.stopClient();
    await this.sync();
  }

  /** Why the server is not running, for menus/log; undefined when it runs. */
  get offReason(): string | undefined {
    return this.status.kind === 'off'
      ? this.status.reason
      : this.status.kind === 'error'
        ? this.status.message
        : undefined;
  }

  private serverModulePath(): string {
    return this.context.asAbsolutePath(path.join('dist', 'pyright', 'langserver.index.js'));
  }

  private bundledVersion(): string {
    try {
      const raw = fs.readFileSync(
        this.context.asAbsolutePath(path.join('dist', 'pyright', 'package.json')),
        'utf8'
      );
      return (JSON.parse(raw) as { version?: string }).version ?? 'unknown';
    } catch {
      return 'unknown';
    }
  }

  private supersededBy(): string | undefined {
    return SUPERSEDING_EXTENSIONS.find((id) => vscode.extensions.getExtension(id));
  }

  private jediHostPresent(): boolean {
    return vscode.extensions.getExtension(JEDI_HOST_EXTENSION) !== undefined;
  }

  /**
   * The server only runs in Pyne contexts: a resolvable workdir in the
   * workspace, or at least one open `@pyne` document. Plain Python projects
   * are left to the user's own tooling.
   */
  private isPyneContext(): boolean {
    if (resolveWorkspaceWorkdir()?.exists) return true;
    return vscode.workspace.textDocuments.some(
      (doc) => doc.languageId === 'python' && this.isPyneDocument(doc)
    );
  }

  private decide(): { start: boolean; reason: string } {
    if (!vscode.workspace.getConfiguration('pyneide').get<boolean>('pyright.enabled', true)) {
      return { start: false, reason: 'disabled via pyneide.pyright.enabled' };
    }
    const superseding = this.supersededBy();
    if (superseding) {
      return { start: false, reason: `${superseding} provides Python analysis` };
    }
    if (!fs.existsSync(this.serverModulePath())) {
      return { start: false, reason: 'bundled pyright missing from this build' };
    }
    if (!this.isPyneContext()) {
      return { start: false, reason: 'no Pyne workdir or open @pyne file' };
    }
    return { start: true, reason: '' };
  }

  /** Serialized start/stop reconciliation; safe to call from any event. */
  private async sync(): Promise<void> {
    if (this.syncing) {
      this.syncAgain = true;
      return;
    }
    this.syncing = true;
    try {
      do {
        this.syncAgain = false;
        const decision = this.decide();
        if (!decision.start) {
          if (this.client) this.output.appendLine(`Stopping pyright: ${decision.reason}`);
          await this.stopClient();
          this.setStatus({ kind: 'off', reason: decision.reason });
        } else if (!this.client) {
          await this.startClient();
        }
      } while (this.syncAgain);
    } finally {
      this.syncing = false;
    }
  }

  private async startClient(): Promise<void> {
    this.setStatus({ kind: 'starting' });
    const serverModule = this.serverModulePath();
    const serverOptions: ServerOptions = {
      run: { module: serverModule, transport: TransportKind.ipc },
      debug: { module: serverModule, transport: TransportKind.ipc },
    };
    const client = new LanguageClient('pyneTyping', 'Pyne Typing (pyright)', serverOptions, {
      documentSelector: [{ scheme: 'file', language: 'python' }],
      outputChannel: this.output,
      revealOutputChannelOn: RevealOutputChannelOn.Never,
      middleware: {
        workspace: {
          configuration: async (params, token, next) => {
            const items = await next(params, token);
            if (!Array.isArray(items)) return items;
            return params.items.map((item, i) => this.amendConfiguration(item.section, items[i]));
          },
        },
        handleDiagnostics: (uri, diagnostics, next) => {
          next(uri, this.filterDiagnostics(uri, diagnostics));
        },
      },
    });
    this.client = client;
    try {
      await client.start();
      this.lastPushedPython = this.readyPythonBin();
      const version = this.bundledVersion();
      this.output.appendLine(`pyright ${version} started (bundled, ${serverModule})`);
      this.setStatus({ kind: 'running', version });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.output.appendLine(`pyright failed to start: ${message}`);
      await this.stopClient();
      this.setStatus({ kind: 'error', message });
    }
  }

  private async stopClient(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    this.lastPushedPython = undefined;
    if (!client) return;
    try {
      if (client.state !== State.Stopped) await client.stop(5000);
    } catch {
      // Already dead — nothing to shut down cleanly.
    }
    await client.dispose();
  }

  private readyPythonBin(): string | undefined {
    const state = this.env.state;
    return state.kind === 'ready' ? state.pythonBin : undefined;
  }

  /**
   * Fill in what a Pylance-less install lacks: the interpreter for the
   * `python` section (pyright still honors python.pythonPath) and pyright's
   * own toggles. User/workspace settings for these sections pass through and
   * win where they exist.
   */
  private amendConfiguration(section: string | undefined, value: unknown): unknown {
    const base = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
    if (section === 'python') {
      const pythonBin = this.readyPythonBin();
      if (pythonBin && !base.pythonPath) return { ...base, pythonPath: pythonBin };
      return base;
    }
    if (section === 'pyright') {
      return {
        disableOrganizeImports: true,
        // Keep diagnostics but leave completion/definition to Jedi when the
        // Python extension is installed without Pylance.
        ...(this.jediHostPresent() ? { disableLanguageServices: true } : {}),
        ...base,
      };
    }
    return value;
  }

  /** Env became ready (or changed): make pyright re-pull configuration. */
  private async pushEnvironment(): Promise<void> {
    if (!this.client || this.client.state !== State.Running) {
      void this.sync();
      return;
    }
    const pythonBin = this.readyPythonBin();
    if (pythonBin === this.lastPushedPython) return;
    this.lastPushedPython = pythonBin;
    await this.client.sendNotification(DidChangeConfigurationNotification.type, {
      settings: null,
    });
  }

  private filterDiagnostics(
    uri: vscode.Uri,
    diagnostics: vscode.Diagnostic[]
  ): vscode.Diagnostic[] {
    if (!diagnostics.some((d) => diagnosticRule(d) === 'reportIndexIssue')) return diagnostics;
    if (!this.isPyneUri(uri)) return diagnostics;
    return diagnostics.filter((d) => diagnosticRule(d) !== 'reportIndexIssue');
  }

  private isPyneUri(uri: vscode.Uri): boolean {
    const open = vscode.workspace.textDocuments.find(
      (doc) => doc.uri.toString() === uri.toString()
    );
    if (open) return this.isPyneDocument(open);
    // Diagnostics for files pyright analyzed without an open editor
    // (imports of open files): check the head on disk.
    try {
      const fd = fs.openSync(uri.fsPath, 'r');
      try {
        const buf = Buffer.alloc(DETECT_HEAD_BYTES);
        const read = fs.readSync(fd, buf, 0, buf.length, 0);
        return detectPyne(buf.subarray(0, read).toString('utf8')) !== undefined;
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return false;
    }
  }

  private isPyneDocument(doc: vscode.TextDocument): boolean {
    return detectPyne(doc.getText().slice(0, DETECT_HEAD_BYTES)) !== undefined;
  }

  private setStatus(status: PyrightStatus): void {
    this.status = status;
    this.statusItem.busy = status.kind === 'starting';
    this.statusItem.severity =
      status.kind === 'error'
        ? vscode.LanguageStatusSeverity.Error
        : vscode.LanguageStatusSeverity.Information;
    this.statusItem.command = { title: 'Show Log', command: 'pyneide.pyrightShowLog' };
    switch (status.kind) {
      case 'off':
        this.statusItem.text = 'Pyne typing off';
        this.statusItem.detail = status.reason;
        break;
      case 'starting':
        this.statusItem.text = 'Pyne typing';
        this.statusItem.detail = 'Starting pyright';
        break;
      case 'running':
        this.statusItem.text = `Pyne typing: pyright ${status.version}`;
        this.statusItem.detail = 'Bundled language server';
        break;
      case 'error':
        this.statusItem.text = 'Pyne typing error';
        this.statusItem.detail = status.message;
        break;
    }
  }
}

/** The pyright rule name of a published diagnostic (code or code.value). */
function diagnosticRule(diagnostic: vscode.Diagnostic): string | undefined {
  const code = diagnostic.code;
  if (typeof code === 'string') return code;
  if (code && typeof code === 'object' && typeof code.value === 'string') return code.value;
  return undefined;
}
