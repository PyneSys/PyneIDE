import * as fs from 'node:fs';
import * as path from 'node:path';

import * as vscode from 'vscode';
import {
  DidChangeConfigurationNotification,
  LanguageClient,
  RevealOutputChannelOn,
  State,
  TransportKind,
  vsdiag,
  type ServerOptions,
} from 'vscode-languageclient/node';

import type { EnvManager } from '../env/manager';
import { ensurePyrightConfig } from '../env/workdir';
import { resolveWorkspaceWorkdir } from '../env/workdirConfig';
import { detectPyne, DETECT_HEAD_BYTES } from '../pyneDetect';
import { SeriesAnalyzer, type SeriesAnalysis } from './seriesAnalyzer';
import { isSeriesAccess, seriesSpanIndex } from './seriesFilter';

/** Pylance's language server is driven by `python.languageServer`. */
export const PYLANCE_EXTENSION = 'ms-python.vscode-pylance';

/**
 * Extensions that already run a pyright-family language server for Python.
 * Starting a second instance next to them would double every diagnostic, so
 * the bundled server defers to any of these (L5a's generated pyrightconfig
 * covers those setups instead). Pylance only counts while
 * `python.languageServer` actually routes to it — Pyne workspaces set the
 * value to "None" so the bundled server can take over (see extension.ts).
 */
const SUPERSEDING_EXTENSIONS = [
  PYLANCE_EXTENSION,
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
 * - handleDiagnostics: per-access reportIndexIssue filter in `@pyne` documents
 *   (L5c). `close[1]` is valid Pyne that the transparent `Series[T] = T` alias
 *   cannot express, so the accesses pynecomp rewrites into series-buffer reads
 *   are dropped and the rest are kept with a Pyne-specific hint. While no
 *   analysis is available the whole rule is dropped, as in L5b. Non-Pyne
 *   Python files keep the rule untouched.
 * - provideHover: puts the declared `Series[...]` back into hovers, which the
 *   transparent alias otherwise renders as the bare element type.
 */
export class PyrightService {
  private client?: LanguageClient;
  private status: PyrightStatus = { kind: 'off', reason: 'not started' };
  private readonly statusItem: vscode.LanguageStatusItem;
  private syncing = false;
  private syncAgain = false;
  private lastPushedPython?: string;
  private readonly analyzer: SeriesAnalyzer;
  /** Unfiltered diagnostics per document, for re-publishing after analysis. */
  private readonly rawDiagnostics = new Map<string, vscode.Diagnostic[]>();
  private publish?: (uri: vscode.Uri, diagnostics: vscode.Diagnostic[]) => void;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly env: EnvManager,
    private readonly output: vscode.OutputChannel,
    analyzer: SeriesAnalyzer
  ) {
    this.statusItem = vscode.languages.createLanguageStatusItem('pyneide.pyright', {
      language: 'python',
    });
    this.statusItem.name = 'Pyne Typing';
    this.analyzer = analyzer;
  }

  register(): void {
    this.context.subscriptions.push(
      this.statusItem,
      {
        dispose: () => {
          // Deactivation hands the workspace back to whatever checker the user
          // has next; our per-access filter is gone, so the rule must be too.
          this.reconcileIndexRule(false);
          void this.stopClient();
        },
      },
      vscode.workspace.onDidCloseTextDocument((doc) => {
        this.analyzer.forget(doc.uri);
        this.rawDiagnostics.delete(doc.uri.toString());
      }),
      vscode.commands.registerCommand('pyneide.pyrightRestart', () => this.restart()),
      vscode.commands.registerCommand('pyneide.pyrightShowLog', () => this.output.show()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (
          e.affectsConfiguration('pyneide.pyright') ||
          e.affectsConfiguration('python.languageServer')
        ) {
          void this.sync();
        }
      }),
      vscode.extensions.onDidChange(() => void this.sync()),
      vscode.workspace.onDidChangeWorkspaceFolders(() => void this.sync()),
      // A Pyne file opened outside a workdir-based workspace still turns the
      // server on (gating below); cheap no-op once running.
      vscode.workspace.onDidOpenTextDocument((doc) => {
        if (doc.languageId === 'python' && !this.client) void this.sync();
      }),
      this.env.onDidChangeState((state) => {
        if (state.kind === 'ready' || state.kind === 'error') {
          this.analyzer.refreshInterpreter();
          void this.pushEnvironment();
        }
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
    return SUPERSEDING_EXTENSIONS.find((id) => {
      if (!vscode.extensions.getExtension(id)) return false;
      // With "None" or "Jedi" Pylance is installed but its server never runs;
      // the standalone pyright/basedpyright extensions ignore the setting.
      if (id === PYLANCE_EXTENSION) return pylanceServesHere();
      return true;
    });
  }

  private jediHostPresent(): boolean {
    if (!vscode.extensions.getExtension(JEDI_HOST_EXTENSION)) return false;
    const value = configuredLanguageServer();
    if (value === 'Jedi') return true;
    // "Default" falls back to Jedi only when Pylance is not installed
    // (VSCodium / Open VSX installs); "None" disables Jedi too.
    return value === 'Default' && !vscode.extensions.getExtension(PYLANCE_EXTENSION);
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
        // The index rule lives in the on-disk config, so it has to be set
        // before the server reads it (and handed back to the next checker
        // when we bow out).
        this.reconcileIndexRule(decision.start);
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

  /**
   * Restore or re-suppress `reportIndexIssue` in the generated config
   * depending on whether our filter is the one about to run. Pylance and CLI
   * runs read the same file, so leaving it open when we are not analyzing
   * would hand them ~175 series-history false positives per corpus.
   */
  private reconcileIndexRule(ours: boolean): void {
    const workdir = resolveWorkspaceWorkdir();
    if (!workdir?.exists) return;
    if (ensurePyrightConfig(workdir.path, { preciseIndexFilter: ours })) {
      this.output.appendLine(
        `reportIndexIssue ${ours ? 'restored for the per-access filter' : 'suppressed for other checkers'}`
      );
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
          this.publish = next;
          this.rawDiagnostics.set(uri.toString(), diagnostics);
          next(uri, this.filterDiagnostics(uri, diagnostics));
        },
        // pyright registers pull diagnostics (textDocument/diagnostic) when
        // the client is capable — those bypass handleDiagnostics entirely, so
        // the index filter has to run here too. Pull is a request/response, so
        // the analysis can simply be awaited; no drop-then-republish dance.
        provideDiagnostics: async (document, previousResultId, token, next) => {
          const report = await next(document, previousResultId, token);
          if (report?.kind !== vsdiag.DocumentDiagnosticReportKind.full) return report;
          const uri = document instanceof vscode.Uri ? document : document.uri;
          return { ...report, items: await this.filterPulled(uri, report.items) };
        },
        provideHover: async (document, position, token, next) => {
          const hover = await next(document, position, token);
          return hover ? this.decorateHover(document, position, hover) : hover;
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
      let amended = base;
      const pythonBin = this.readyPythonBin();
      if (pythonBin && !amended.pythonPath) amended = { ...amended, pythonPath: pythonBin };
      // The configless default instance (see `pyright` below) only requests
      // the `python` section and reads `analysis` nested inside it — this is
      // where its extraPaths must go so `pynecore` resolves from an editable
      // install, whose import-hook finder static analysis cannot follow.
      const root = this.editablePynecoreRoot();
      const analysis =
        amended.analysis && typeof amended.analysis === 'object'
          ? (amended.analysis as Record<string, unknown>)
          : {};
      if (root && !hasEntries(analysis.extraPaths)) {
        amended = { ...amended, analysis: { ...analysis, extraPaths: [root] } };
      }
      return amended;
    }
    if (section === 'python.analysis') {
      // Workspace instances request the flat section too; same default.
      const root = this.editablePynecoreRoot();
      if (root && !hasEntries(base.extraPaths)) return { ...base, extraPaths: [root] };
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

  /** The pynecore source root when it is an editable/dev install; else undefined. */
  private editablePynecoreRoot(): string | undefined {
    const state = this.env.state;
    if (state.kind !== 'ready') return undefined;
    const root = state.verify.pynecoreRoot;
    if (!root || path.basename(root) === 'site-packages') return undefined;
    return root;
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

  /**
   * Drop the series-history `reportIndexIssue` noise from `@pyne` documents.
   *
   * With an analysis in hand only the accesses pynecomp actually rewrites into
   * buffer reads are dropped; everything else stays as a genuine error with a
   * Pyne-specific hint appended. Without one — no interpreter, unparsable
   * source, analysis still running — the whole rule is dropped, so the fallback
   * can only ever be quieter than the truth, never noisier.
   */
  private filterDiagnostics(
    uri: vscode.Uri,
    diagnostics: vscode.Diagnostic[]
  ): vscode.Diagnostic[] {
    if (this.isForeignSource(uri)) return syntaxOnly(diagnostics);
    if (!diagnostics.some((d) => diagnosticRule(d) === 'reportIndexIssue')) return diagnostics;
    if (!this.isPyneUri(uri)) return diagnostics;
    const text = SeriesAnalyzer.readText(uri);
    if (text === undefined) return dropIndexIssues(diagnostics);
    const analysis = this.analyzer.cached(uri, text);
    if (analysis) return applySeriesAnalysis(diagnostics, analysis, text);
    void this.analyzeAndRepublish(uri, text);
    return dropIndexIssues(diagnostics);
  }

  /**
   * Pull-model twin of `filterDiagnostics`: the analysis is awaited (bounded
   * by the worker's own request timeout), so the returned report is already
   * precise. Every unavailable-analysis state still falls back to dropping the
   * whole rule — quieter than the truth, never noisier.
   */
  private async filterPulled(
    uri: vscode.Uri,
    items: vscode.Diagnostic[]
  ): Promise<vscode.Diagnostic[]> {
    if (this.isForeignSource(uri)) return syntaxOnly(items);
    if (!items.some((d) => diagnosticRule(d) === INDEX_RULE)) return items;
    if (!this.isPyneUri(uri)) return items;
    const text = SeriesAnalyzer.readText(uri);
    if (text === undefined) return dropIndexIssues(items);
    const analysis = await this.analyzer.analyze(uri, text);
    if (!analysis) return dropIndexIssues(items);
    return applySeriesAnalysis(items, analysis, text);
  }

  /**
   * Analyze in the background and re-publish once the answer is in. Skipped
   * when the document moved on in the meantime — that edit produces its own
   * diagnostics push, which runs this same path again.
   */
  private async analyzeAndRepublish(uri: vscode.Uri, text: string): Promise<void> {
    const analysis = await this.analyzer.analyze(uri, text);
    if (!analysis || !this.publish) return;
    const raw = this.rawDiagnostics.get(uri.toString());
    if (!raw) return;
    if (SeriesAnalyzer.readText(uri) !== text) return;
    this.publish(uri, applySeriesAnalysis(raw, analysis, text));
  }

  /** Hover cosmetics: show `Series[float]`, not the alias-collapsed `float`. */
  private decorateHover(
    document: vscode.TextDocument,
    position: vscode.Position,
    hover: vscode.Hover
  ): vscode.Hover {
    if (!this.isPyneDocument(document)) return hover;
    const analysis = this.analyzer.cached(document.uri, document.getText());
    if (!analysis) {
      void this.analyzer.analyze(document.uri, document.getText());
      return hover;
    }
    const ref = analysis.refs.find(
      (r) =>
        r.line === position.line && r.start <= position.character && position.character < r.end
    );
    if (!ref) return hover;
    const contents = hover.contents.map((part) => reannotateHoverPart(part, ref.annotation));
    return new vscode.Hover(contents, hover.range);
  }

  /**
   * A file outside every workspace folder that is not a Pyne script —
   * typically a pynecore source opened via go-to-definition. pyright hands
   * such files to the nearest workspace instance, so the workdir's generated
   * "basic" config judges code it was never written for (pynecore's own
   * `overload` decorator alone yields reportRedeclaration errors its repo
   * config silences). Pylance's configless default was "off"; these files get
   * the same treatment: syntax errors only.
   */
  private isForeignSource(uri: vscode.Uri): boolean {
    if (vscode.workspace.getWorkspaceFolder(uri) !== undefined) return false;
    return !this.isPyneUri(uri);
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

const INDEX_RULE = 'reportIndexIssue';

/**
 * Appended to index errors we keep, because pyright's own wording
 * ("__getitem__ method not defined on type float") describes the stub, not
 * what the user has to change.
 */
const INDEX_HINT =
  'Pyne: history indexing (`x[1]`) only works on series values — ' +
  'declare the variable as `Series[...]` or index a lib series directly.';

function dropIndexIssues(diagnostics: vscode.Diagnostic[]): vscode.Diagnostic[] {
  return diagnostics.filter((d) => diagnosticRule(d) !== INDEX_RULE);
}

/** Syntax errors carry no rule code; everything rule-based is dropped. */
function syntaxOnly(diagnostics: vscode.Diagnostic[]): vscode.Diagnostic[] {
  return diagnostics.filter((d) => diagnosticRule(d) === undefined);
}

/** Keep the index errors whose subscript base is not a series access. */
function applySeriesAnalysis(
  diagnostics: vscode.Diagnostic[],
  analysis: SeriesAnalysis,
  text: string
): vscode.Diagnostic[] {
  const lines = text.split(/\r?\n/);
  const index = seriesSpanIndex(analysis.spans);
  const kept: vscode.Diagnostic[] = [];
  for (const diagnostic of diagnostics) {
    if (diagnosticRule(diagnostic) !== INDEX_RULE) {
      kept.push(diagnostic);
      continue;
    }
    const { start, end } = diagnostic.range;
    const line = lines[start.line] ?? '';
    // A base expression spanning several lines cannot match a single-line
    // span, so it is kept as-is rather than guessed at.
    if (start.line === end.line && isSeriesAccess(index, line, start.line, start.character, end.character)) {
      continue;
    }
    kept.push(withHint(diagnostic));
  }
  return kept;
}

function withHint(diagnostic: vscode.Diagnostic): vscode.Diagnostic {
  const copy = new vscode.Diagnostic(
    diagnostic.range,
    `${diagnostic.message}\n${INDEX_HINT}`,
    diagnostic.severity
  );
  copy.code = diagnostic.code;
  copy.source = diagnostic.source;
  copy.tags = diagnostic.tags;
  copy.relatedInformation = diagnostic.relatedInformation;
  return copy;
}

/**
 * Rewrite the declared type in one hover part back to its Pyne form
 * (`Series[...]`, `Persistent[...]`). The whole displayed type is replaced,
 * not just the alias-collapsed element type: pyright's assignment narrowing
 * otherwise surfaces (`p: Persistent[float] = 0` then `p += 1` hovers as
 * `Literal[1]`), and for a per-bar mutable Pyne variable the declared type is
 * the truthful view, the literal a distraction.
 */
function reannotateHoverPart(
  part: vscode.MarkdownString | vscode.MarkedString,
  annotation: string
): vscode.MarkdownString | vscode.MarkedString {
  const rewrite = (value: string): string =>
    value.replace(/^(\(variable\)\s+\w+:\s*).*$/m, `$1${escapeReplacement(annotation)}`);
  if (part instanceof vscode.MarkdownString) {
    const next = new vscode.MarkdownString(rewrite(part.value), part.supportThemeIcons);
    next.isTrusted = part.isTrusted;
    return next;
  }
  if (typeof part === 'string') return rewrite(part);
  return { language: part.language, value: rewrite(part.value) };
}

/** `$` is special in String.replace replacement patterns — make it literal. */
function escapeReplacement(value: string): string {
  return value.replace(/\$/g, '$$$$');
}

/**
 * Whether the user actually configured a list. Pylance registers
 * `python.analysis.extraPaths` with a `[]` default, so mere presence cannot
 * distinguish "set" from "untouched default".
 */
function hasEntries(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0;
}

function configuredLanguageServer(): string {
  return vscode.workspace.getConfiguration('python').get<string>('languageServer', 'Default');
}

/** Whether `python.languageServer` routes Python analysis to Pylance. */
function pylanceServesHere(): boolean {
  const value = configuredLanguageServer();
  return value === 'Default' || value === 'Pylance';
}

/** The pyright rule name of a published diagnostic (code or code.value). */
function diagnosticRule(diagnostic: vscode.Diagnostic): string | undefined {
  const code = diagnostic.code;
  if (typeof code === 'string') return code;
  if (code && typeof code === 'object' && typeof code.value === 'string') return code.value;
  return undefined;
}
