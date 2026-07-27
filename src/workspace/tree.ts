/**
 * The "Pyne" activity-bar view: a tree of the workdir's Scripts, Data and
 * Output, resolved from `resolveWorkspaceWorkdir()`. Scripts are @pyne-detected
 * `.py`/`.pine` files; Data are `.ohlcv` files annotated from their sibling
 * `.toml` syminfo plus the first/last record of the binary; Output are the
 * files the CLI writes. A debounced FileSystemWatcher keeps the tree in sync,
 * and a per-mtime cache avoids re-reading unchanged `.ohlcv` metadata.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import * as vscode from 'vscode';

import { canonicalChartKey } from '../chart/chartKey';
import type { ChartManager } from '../chart/chartPanel';
import { OhlcvEditorProvider } from '../data/ohlcvEditor';
import { buildOutputPreview, resolveOutputPair } from '../data/outputPreview';
import { parseSymInfo, readOhlcvStats } from '../data/syminfo';
import { resolveWorkspaceWorkdir } from '../env/workdirConfig';
import type { PluginService } from '../plugins/service';
import { detectPyne, DETECT_HEAD_BYTES, type PyneKind } from '../pyneDetect';
import { createNewScript } from './createScript';

export const PYNE_WORKSPACE_VIEW_ID = 'pyneide.workspace';

type SectionKind = 'scripts' | 'data' | 'output';

interface SectionNode {
  type: 'section';
  kind: SectionKind;
}

interface ScriptNode {
  type: 'script';
  uri: vscode.Uri;
  rel: string;
  pyneKind?: PyneKind;
}

interface LibraryFolderNode {
  type: 'libraryFolder';
  uri: vscode.Uri;
  depth: number;
}

interface DataNode {
  type: 'data';
  uri: vscode.Uri;
}

/** The single "Symbol Map" entry point at the top of the Data section; a click
 * opens the whole-map webview editor (the map itself is not a tree child). */
interface SymbolMapRootNode {
  type: 'symbolMapRoot';
}

interface OutputNode {
  type: 'output';
  uri: vscode.Uri;
  /** Sidecars are nested below their `<stem>.csv` run output. */
  sidecar?: boolean;
}

/** The compiled `.py` nested under its `.pine` parent. */
interface CompanionNode {
  type: 'companion';
  uri: vscode.Uri;
  pyneKind?: PyneKind;
}

/** Entry point to the plugin manager; environment-wide, not workdir content. */
interface PluginsRootNode {
  type: 'pluginsRoot';
}

/** Call-to-action shown in place of an empty section's children — the inline
 * section-header actions only appear on hover, so an empty tree would otherwise
 * offer no visible next step. */
interface HintNode {
  type: 'hint';
  kind: 'newScript' | 'downloadData';
}

export type PyneNode =
  | SectionNode
  | ScriptNode
  | LibraryFolderNode
  | DataNode
  | SymbolMapRootNode
  | OutputNode
  | CompanionNode
  | PluginsRootNode
  | HintNode;

const HINTS: Record<HintNode['kind'], { label: string; icon: string; tooltip: string; command: string }> = {
  newScript: {
    label: 'New Script…',
    icon: 'add',
    tooltip: 'Create a Pine or Pyne indicator, strategy or library',
    command: 'pyneide.workspace.createScript',
  },
  downloadData: {
    label: 'Download market data…',
    icon: 'cloud-download',
    tooltip: 'Download OHLCV data for a symbol and timeframe',
    command: 'pyneide.dataDownloadWizard',
  },
};

interface DataMeta {
  label: string;
  description?: string;
  tooltip?: string;
}

/** Format a unix-seconds timestamp as `YYYY-MM-DD`. */
function fmtDate(ts: number): string {
  return new Date(ts * 1000).toISOString().slice(0, 10);
}

/** Human-readable byte size (KB/MB), matching a data-file feel. */
function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Provider names that carry the `<provider>_…` stem convention, used only as a
 * fallback when the `.toml` has no persisted `[download]` provider string. */
const KNOWN_PROVIDERS = new Set(['ccxt', 'bybit', 'tradingview', 'capitalcom', 'ctrader', 'coinbase']);

/** First `:`-delimited token of a pynecore provider string
 * (`ccxt:BYBIT:ETH/USDT:USDT@1D` -> `ccxt`, `bybit:ETHUSDT.P@1` -> `bybit`). */
function providerName(providerStr: string | undefined): string | undefined {
  if (!providerStr) return undefined;
  const head = providerStr.split(':', 1)[0].trim();
  return head || undefined;
}

/** Best-effort provider from the `<provider>_…` filename stem, but only for the
 * known set — arbitrary user-named files (`pf68`, `demo`) must NOT guess one. */
function providerFromStem(stem: string): string | undefined {
  const head = stem.split('_', 1)[0].toLowerCase();
  return KNOWN_PROVIDERS.has(head) ? head : undefined;
}

export class PyneWorkspaceProvider implements vscode.TreeDataProvider<PyneNode> {
  private readonly emitter = new vscode.EventEmitter<PyneNode | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;

  /** Metadata cache keyed by .ohlcv fsPath; invalidated by mtime. */
  private readonly dataCache = new Map<string, { mtimeMs: number; meta: DataMeta }>();

  private workdir: string | undefined;
  private pluginSummary: string | undefined;

  constructor(private readonly extensionUri: vscode.Uri) {
    this.workdir = this.currentWorkdir();
  }

  private currentWorkdir(): string | undefined {
    const resolved = resolveWorkspaceWorkdir();
    return resolved?.exists ? resolved.path : undefined;
  }

  /** True when a usable workdir is resolved (drives the welcome view). */
  hasWorkdir(): boolean {
    return this.workdir !== undefined;
  }

  refresh(): void {
    this.workdir = this.currentWorkdir();
    this.emitter.fire(undefined);
  }

  getTreeItem(node: PyneNode): vscode.TreeItem {
    switch (node.type) {
      case 'section':
        return this.sectionItem(node);
      case 'script':
        return this.scriptItem(node);
      case 'libraryFolder':
        return this.libraryFolderItem(node);
      case 'data':
        return this.dataItem(node);
      case 'symbolMapRoot':
        return this.symbolMapRootItem();
      case 'pluginsRoot':
        return this.pluginsRootItem();
      case 'output':
        return this.outputItem(node);
      case 'companion':
        return this.companionItem(node);
      case 'hint':
        return this.hintItem(node);
    }
  }

  getChildren(node?: PyneNode): PyneNode[] {
    if (!this.workdir) return [];
    if (!node) {
      return [
        { type: 'section', kind: 'scripts' },
        { type: 'section', kind: 'data' },
        { type: 'section', kind: 'output' },
        { type: 'pluginsRoot' },
      ];
    }
    if (node.type === 'script') return this.companionChildren(node);
    if (node.type === 'libraryFolder') return this.libraryFolderChildren(node);
    if (node.type === 'output' && !node.sidecar) return this.outputSidecarChildren(node);
    if (node.type !== 'section') return [];
    switch (node.kind) {
      case 'scripts':
        return this.scriptChildren();
      case 'data':
        return this.dataChildren();
      case 'output':
        return this.outputChildren();
    }
  }

  private sectionItem(node: SectionNode): vscode.TreeItem {
    const labels: Record<SectionKind, string> = {
      scripts: 'Scripts',
      data: 'Data',
      output: 'Output',
    };
    const icons: Record<SectionKind, string> = {
      scripts: 'file-code',
      data: 'database',
      output: 'output',
    };
    const item = new vscode.TreeItem(labels[node.kind], vscode.TreeItemCollapsibleState.Expanded);
    item.iconPath = new vscode.ThemeIcon(icons[node.kind]);
    item.contextValue = `pyneSection.${node.kind}`;
    return item;
  }

  private scriptChildren(): PyneNode[] {
    const dir = path.join(this.workdir!, 'scripts');
    const libraryDir = path.join(dir, 'lib');
    const libraryPrefix = `${libraryDir}${path.sep}`;
    const allFiles = walkScripts(dir);
    const files = allFiles.filter(
      (file) => file !== libraryDir && !file.startsWith(libraryPrefix)
    );
    const present = new Set(files);
    const nodes: ScriptNode[] = [];
    for (const file of files) {
      // A compiled `.py` with a sibling `.pine` is nested under it, not listed
      // at the top level.
      if (/\.py$/i.test(file) && present.has(file.replace(/\.py$/i, '.pine'))) continue;
      nodes.push({
        type: 'script',
        uri: vscode.Uri.file(file),
        rel: path.relative(dir, file),
        pyneKind: detectScriptKind(file),
      });
    }
    nodes.sort((a, b) => a.rel.localeCompare(b.rel));
    const hasLibraries = allFiles.some(
      (file) =>
        file.startsWith(libraryPrefix) && path.basename(file) !== '__init__.py'
    );
    const libraries: LibraryFolderNode[] = hasLibraries
      ? [{ type: 'libraryFolder', uri: vscode.Uri.file(libraryDir), depth: 0 }]
      : [];
    if (libraries.length === 0 && nodes.length === 0) {
      return [{ type: 'hint', kind: 'newScript' }];
    }
    return [...libraries, ...nodes];
  }

  private libraryFolderChildren(node: LibraryFolderNode): PyneNode[] {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(node.uri.fsPath, { withFileTypes: true });
    } catch {
      return [];
    }

    const folders = entries
      .filter(
        (entry) =>
          entry.isDirectory() &&
          !entry.name.startsWith('.') &&
          entry.name !== '__pycache__'
      )
      .map(
        (entry): LibraryFolderNode => ({
          type: 'libraryFolder',
          uri: vscode.Uri.file(path.join(node.uri.fsPath, entry.name)),
          depth: node.depth + 1,
        })
      )
      .sort((a, b) =>
        path.basename(a.uri.fsPath).localeCompare(path.basename(b.uri.fsPath))
      );

    const files = entries
      .filter(
        (entry) =>
          entry.isFile() &&
          entry.name !== '__init__.py' &&
          /\.(?:pine|py)$/i.test(entry.name)
      )
      .map((entry) => path.join(node.uri.fsPath, entry.name));
    const present = new Set(files);
    const scripts = files
      .filter(
        (file) =>
          !/\.py$/i.test(file) || !present.has(file.replace(/\.py$/i, '.pine'))
      )
      .map(
        (file): ScriptNode => ({
          type: 'script',
          uri: vscode.Uri.file(file),
          rel: path.basename(file),
          pyneKind: detectScriptKind(file),
        })
      )
      .sort((a, b) => a.rel.localeCompare(b.rel));

    return [...folders, ...scripts];
  }

  private libraryFolderItem(node: LibraryFolderNode): vscode.TreeItem {
    const label = node.depth === 0 ? 'Libraries' : path.basename(node.uri.fsPath);
    const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.Collapsed);
    item.iconPath = new vscode.ThemeIcon(
      node.depth === 0 ? 'library' : node.depth === 1 ? 'organization' : 'folder'
    );
    item.contextValue =
      node.depth === 0
        ? 'pyneLibraryRoot'
        : node.depth === 1
          ? 'pyneLibraryPublisher'
          : 'pyneLibraryFolder';
    item.tooltip = node.uri.fsPath;
    return item;
  }

  /** The compiled `.py` nested under a `.pine`, if it exists on disk. The
   * generated `.py.map`/`.toml` are intentionally hidden here. Empty for `.py`. */
  private companionChildren(node: ScriptNode): CompanionNode[] {
    if (!/\.pine$/i.test(node.uri.fsPath)) return [];
    const py = node.uri.fsPath.replace(/\.pine$/i, '.py');
    if (!fs.existsSync(py)) return [];
    return [{ type: 'companion', uri: vscode.Uri.file(py), pyneKind: detectScriptKind(py) }];
  }

  private scriptItem(node: ScriptNode): vscode.TreeItem {
    const collapsible =
      this.companionChildren(node).length > 0
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None;
    const item = new vscode.TreeItem(node.rel, collapsible);
    if (/\.pine$/i.test(node.rel)) {
      const pineIcon = vscode.Uri.joinPath(this.extensionUri, 'icons', 'pine-file.svg');
      item.iconPath = { light: pineIcon, dark: pineIcon };
    } else if (node.pyneKind) {
      const pyneIcon = vscode.Uri.joinPath(this.extensionUri, 'icons', 'pyne-core.svg');
      item.iconPath = { light: pyneIcon, dark: pyneIcon };
      item.description = node.pyneKind === 'edge' ? '@pyne edge' : node.pyneKind === 'lib' ? '@pyne lib' : '@pyne';
    } else {
      item.resourceUri = node.uri;
      item.iconPath = new vscode.ThemeIcon('file');
    }
    item.contextValue = this.isLibraryScript(node.uri.fsPath, node.pyneKind)
      ? 'pyneLibrary'
      : scriptContextValue(node.uri.fsPath, node.pyneKind);
    item.command = { command: 'vscode.open', title: 'Open', arguments: [node.uri] };
    return item;
  }

  private companionItem(node: CompanionNode): vscode.TreeItem {
    const item = new vscode.TreeItem(
      path.basename(node.uri.fsPath),
      vscode.TreeItemCollapsibleState.None
    );
    if (node.pyneKind) {
      const pyneIcon = vscode.Uri.joinPath(this.extensionUri, 'icons', 'pyne-core.svg');
      item.iconPath = { light: pyneIcon, dark: pyneIcon };
      item.description = node.pyneKind === 'edge' ? '@pyne edge' : node.pyneKind === 'lib' ? '@pyne lib' : '@pyne';
    } else {
      item.resourceUri = node.uri;
      item.iconPath = new vscode.ThemeIcon('file');
    }
    item.contextValue = this.isLibraryScript(node.uri.fsPath, node.pyneKind)
      ? 'pyneLibrary'
      : scriptContextValue(node.uri.fsPath, node.pyneKind);
    item.command = { command: 'vscode.open', title: 'Open', arguments: [node.uri] };
    return item;
  }

  private isLibraryScript(file: string, kind: PyneKind | undefined): boolean {
    if (kind === 'lib') return true;
    const relative = path.relative(path.join(this.workdir!, 'scripts'), file);
    return relative === 'lib' || relative.startsWith(`lib${path.sep}`);
  }

  private dataChildren(): PyneNode[] {
    const symbolMapRoot: SymbolMapRootNode = { type: 'symbolMapRoot' };
    const dir = path.join(this.workdir!, 'data');
    const downloadHint: HintNode = { type: 'hint', kind: 'downloadData' };
    let names: string[];
    try {
      names = fs.readdirSync(dir).filter((n) => n.toLowerCase().endsWith('.ohlcv'));
    } catch {
      return [symbolMapRoot, downloadHint];
    }
    if (names.length === 0) return [symbolMapRoot, downloadHint];
    names.sort((a, b) => a.localeCompare(b));
    const dataNodes: DataNode[] = names.map((n) => ({
      type: 'data',
      uri: vscode.Uri.file(path.join(dir, n)),
    }));
    return [symbolMapRoot, ...dataNodes];
  }

  /** The "Plugins" leaf that opens the plugin manager panel. */
  private pluginsRootItem(): vscode.TreeItem {
    const item = new vscode.TreeItem('Plugins', vscode.TreeItemCollapsibleState.None);
    item.iconPath = new vscode.ThemeIcon('extensions');
    item.contextValue = 'pynePluginsRoot';
    item.description = this.pluginSummary;
    item.tooltip = 'Browse and install PyneCore plugins (providers, brokers, CLI tools)';
    item.command = { command: 'pyneide.openPlugins', title: 'Manage Plugins' };
    return item;
  }

  /** Installed-count suffix of the Plugins leaf; empty until it is known. */
  setPluginSummary(summary: string | undefined): void {
    if (this.pluginSummary === summary) return;
    this.pluginSummary = summary;
    this.emitter.fire(undefined);
  }

  /** Empty-section call-to-action leaf (see {@link HintNode}). */
  private hintItem(node: HintNode): vscode.TreeItem {
    const hint = HINTS[node.kind];
    const item = new vscode.TreeItem(hint.label, vscode.TreeItemCollapsibleState.None);
    item.iconPath = new vscode.ThemeIcon(hint.icon);
    item.tooltip = hint.tooltip;
    item.contextValue = 'pyneHint';
    item.command = { command: hint.command, title: hint.label };
    return item;
  }

  /** The "Symbol Map" leaf that opens the whole-map webview editor. */
  private symbolMapRootItem(): vscode.TreeItem {
    const item = new vscode.TreeItem('Symbol Map', vscode.TreeItemCollapsibleState.None);
    item.iconPath = new vscode.ThemeIcon('references');
    item.contextValue = 'pyneSymbolMapRoot';
    item.tooltip = 'TradingView symbols -> provider-qualified native symbols';
    item.command = { command: 'pyneide.openSymbolMap', title: 'Open Symbol Map' };
    return item;
  }

  private dataItem(node: DataNode): vscode.TreeItem {
    const meta = this.dataMeta(node.uri.fsPath);
    const item = new vscode.TreeItem(meta.label, vscode.TreeItemCollapsibleState.None);
    item.resourceUri = node.uri;
    item.description = meta.description;
    item.tooltip = meta.tooltip;
    item.iconPath = new vscode.ThemeIcon('graph-line');
    item.contextValue = 'pyneData';
    // preserveFocus keeps the tree focused (like the built-in Explorer), so
    // arrow-key browsing and the Delete keybinding keep working after a click.
    item.command = {
      command: 'vscode.openWith',
      title: 'Open as Table',
      arguments: [node.uri, OhlcvEditorProvider.viewType, { preserveFocus: true }],
    };
    return item;
  }

  /** Cached per-mtime metadata for an .ohlcv file. */
  private dataMeta(fsPath: string): DataMeta {
    let mtimeMs: number;
    try {
      mtimeMs = fs.statSync(fsPath).mtimeMs;
    } catch {
      return { label: path.basename(fsPath) };
    }
    const cached = this.dataCache.get(fsPath);
    if (cached && cached.mtimeMs === mtimeMs) return cached.meta;
    const meta = this.buildDataMeta(fsPath);
    this.dataCache.set(fsPath, { mtimeMs, meta });
    return meta;
  }

  private buildDataMeta(fsPath: string): DataMeta {
    const stem = path.basename(fsPath).replace(/\.ohlcv$/i, '');
    let ticker: string | undefined;
    let period: string | undefined;
    let broker: string | undefined;
    let provider: string | undefined;
    try {
      const tomlPath = fsPath.replace(/\.ohlcv$/i, '.toml');
      const sym = parseSymInfo(fs.readFileSync(tomlPath, 'utf8'));
      ticker = sym.symbol.ticker;
      period = sym.symbol.period;
      broker = sym.symbol.prefix || undefined;
      provider = providerName(sym.provider);
    } catch {
      // No sibling toml — fall back to the file stem.
    }
    provider ??= providerFromStem(stem);

    // Prefix the label with the exchange (TradingView-style `BYBIT:BTCUSDT`);
    // requires a real ticker so a stem-only fallback stays a plain name.
    const symbolLabel = [ticker, period].filter(Boolean).join(' ') || stem;
    const label = broker && ticker ? `${broker}:${symbolLabel}` : symbolLabel;

    const parts: string[] = [];
    const tooltipLines: string[] = [label];
    const origin = [provider && `Provider: ${provider}`, broker && `Broker: ${broker}`]
      .filter(Boolean)
      .join(' · ');
    if (origin) tooltipLines.push(origin);
    try {
      const stats = readOhlcvStats(fsPath);
      if (stats.firstTs !== undefined && stats.lastTs !== undefined) {
        const range = `${fmtDate(stats.firstTs)} -> ${fmtDate(stats.lastTs)}`;
        parts.push(range);
        tooltipLines.push(range);
      }
      parts.push(`${stats.bars} bars`);
      parts.push(fmtSize(stats.size));
      tooltipLines.push(`${stats.bars} bars`, fmtSize(stats.size));
    } catch {
      // Unreadable binary — label alone.
    }
    return {
      label,
      description: parts.join(' · ') || undefined,
      tooltip: tooltipLines.join('\n'),
    };
  }

  private outputChildren(): OutputNode[] {
    const dir = path.join(this.workdir!, 'output');
    let names: string[];
    try {
      names = fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && !entry.name.startsWith('.'))
        .map((entry) => entry.name);
    } catch {
      return [];
    }
    const present = new Set(names);
    const nested = new Set<string>();
    for (const name of names) {
      if (!/\.csv$/i.test(name)) continue;
      const stem = name.slice(0, -4);
      for (const suffix of ['_viz.ndjson', '_strat.csv', '_trade.csv']) {
        const sidecar = `${stem}${suffix}`;
        if (present.has(sidecar)) nested.add(sidecar);
      }
    }
    return names
      .filter((name) => !nested.has(name))
      .map((name): OutputNode => ({
        type: 'output',
        uri: vscode.Uri.file(path.join(dir, name)),
      }))
      .sort((a, b) => a.uri.fsPath.localeCompare(b.uri.fsPath));
  }

  private outputSidecarChildren(node: OutputNode): OutputNode[] {
    if (!/\.csv$/i.test(node.uri.fsPath)) return [];
    const stem = node.uri.fsPath.slice(0, -4);
    return ['_viz.ndjson', '_strat.csv', '_trade.csv']
      .map((suffix) => `${stem}${suffix}`)
      .filter((file) => fs.existsSync(file))
      .map((file): OutputNode => ({ type: 'output', uri: vscode.Uri.file(file), sidecar: true }));
  }

  private outputItem(node: OutputNode): vscode.TreeItem {
    const collapsible =
      !node.sidecar && this.outputSidecarChildren(node).length
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None;
    const item = new vscode.TreeItem(
      path.basename(node.uri.fsPath),
      collapsible
    );
    item.resourceUri = node.uri;
    item.iconPath = vscode.ThemeIcon.File;
    const chartable = !node.sidecar && resolveOutputPair(node.uri.fsPath) !== undefined;
    item.contextValue = chartable ? 'pyneChartOutput' : 'pyneOutput';
    item.command = {
      command: 'vscode.open',
      title: 'Open',
      arguments: [node.uri, { preserveFocus: true }],
    };
    return item;
  }
}

/** Recursively collect `.py`/`.pine` files under `dir`, skipping caches. */
function walkScripts(dir: string): string[] {
  const out: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name === '__pycache__') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkScripts(full));
    } else if (entry.isFile() && /\.(py|pine)$/i.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

/** Resolve an output CSV stem back to the script identity used by RunService.
 * Output names are stem-based too, so this is the same one-to-one convention
 * the writer already relies on. Prefer Pine when both source and compiled Pyne
 * exist; canonicalChartKey performs the same fold for a `.py` fallback. */
function outputChartKey(plotPath: string): string {
  const workdir = path.dirname(path.dirname(plotPath));
  const stem = path.basename(plotPath).replace(/\.csv$/i, '');
  const matches = walkScripts(path.join(workdir, 'scripts')).filter(
    (file) => path.parse(file).name === stem
  );
  const script = matches.find((file) => /\.pine$/i.test(file)) ?? matches[0];
  return script ? canonicalChartKey(script) : plotPath;
}

/**
 * Context value of a runnable script row. Pine sources get their own value so
 * the tree menus can offer Pine-named Run/Debug entries — a menu contribution
 * cannot override a command's title, only pick a different command.
 */
function scriptContextValue(file: string, kind: PyneKind | undefined): string {
  if (kind === undefined) return 'pyneFile';
  return /\.pine$/i.test(file) ? 'pyneScriptPine' : 'pyneScript';
}

/** Detect the @pyne kind of a `.py` file from its head; .pine is always Pyne. */
function detectScriptKind(file: string): PyneKind | undefined {
  if (/\.pine$/i.test(file)) return 'pyne';
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(DETECT_HEAD_BYTES);
      const read = fs.readSync(fd, buf, 0, DETECT_HEAD_BYTES, 0);
      return detectPyne(buf.toString('utf8', 0, read));
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return undefined;
  }
}

/**
 * Register the Pyne workspace tree view, its title actions, and a debounced
 * FileSystemWatcher over the workdir's scripts/data/output. The download-wizard
 * command is supplied by the caller (it owns the environment/output plumbing);
 * C2 replaces it with the full wizard.
 */
export function registerWorkspaceView(
  context: vscode.ExtensionContext,
  chartManager?: ChartManager,
  plugins?: PluginService
): PyneWorkspaceProvider {
  const provider = new PyneWorkspaceProvider(context.extensionUri);
  const view = vscode.window.createTreeView(PYNE_WORKSPACE_VIEW_ID, {
    treeDataProvider: provider,
    showCollapseAll: false,
  });
  context.subscriptions.push(view);

  if (plugins) {
    const syncPlugins = async (): Promise<void> => {
      try {
        const model = await plugins.model();
        const installed = model.rows.filter((r) => r.installed && !r.builtin).length;
        provider.setPluginSummary(model.env.installedKnown ? `${installed} installed` : undefined);
      } catch {
        provider.setPluginSummary(undefined);
      }
    };
    context.subscriptions.push(plugins.onDidChange(() => void syncPlugins()));
    void syncPlugins();
  }

  const syncContext = (): void => {
    void vscode.commands.executeCommand('setContext', 'pyneide.hasWorkdir', provider.hasWorkdir());
  };
  syncContext();

  let debounce: ReturnType<typeof setTimeout> | undefined;
  const refresh = (): void => {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => {
      provider.refresh();
      syncContext();
      rebuildWatcher();
    }, 250);
  };

  let watcher: vscode.FileSystemWatcher | undefined;
  const rebuildWatcher = (): void => {
    watcher?.dispose();
    watcher = undefined;
    const resolved = resolveWorkspaceWorkdir();
    if (!resolved?.exists) return;
    watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(resolved.path, '{scripts,data,output}/**')
    );
    const onChange = (): void => refresh();
    watcher.onDidCreate(onChange);
    watcher.onDidChange(onChange);
    watcher.onDidDelete(onChange);
    context.subscriptions.push(watcher);
  };
  rebuildWatcher();

  // The `*PineScript` ids are pure aliases — they exist only so `.pine` rows can
  // show Pine-named menu entries; both ids drive the same script command.
  const runNode = (node?: PyneNode): void => {
    const uri = nodeUri(node);
    if (uri) void vscode.commands.executeCommand('pyneide.runScript', uri);
  };
  const debugNode = (node?: PyneNode): void => {
    const uri = nodeUri(node);
    if (uri) void vscode.commands.executeCommand('pyneide.debugScript', uri);
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('pyneide.workspace.refresh', () => {
      provider.refresh();
      syncContext();
      rebuildWatcher();
    }),
    vscode.commands.registerCommand('pyneide.workspace.createScript', () =>
      createNewScript(context)
    ),
    vscode.commands.registerCommand('pyneide.workspace.runScript', runNode),
    vscode.commands.registerCommand('pyneide.workspace.runPineScript', runNode),
    vscode.commands.registerCommand('pyneide.workspace.debugScript', debugNode),
    vscode.commands.registerCommand('pyneide.workspace.debugPineScript', debugNode),
    vscode.commands.registerCommand('pyneide.workspace.selectData', (node?: PyneNode) => {
      const uri = nodeUri(node);
      if (uri) void vscode.commands.executeCommand('pyneide.changeRunData', uri);
    }),
    vscode.commands.registerCommand('pyneide.workspace.openTable', (node?: PyneNode) => {
      const uri = nodeUri(node);
      if (uri) {
        void vscode.commands.executeCommand(
          'vscode.openWith',
          uri,
          OhlcvEditorProvider.viewType
        );
      }
    }),
    vscode.commands.registerCommand('pyneide.workspace.openOutputChart', (node?: PyneNode) => {
      const uri = nodeUri(node ?? view.selection[0]);
      const pair = uri && resolveOutputPair(uri.fsPath);
      if (!pair || !chartManager) return;
      try {
        const preview = buildOutputPreview(pair);
        chartManager.openOutputPreview(outputChartKey(pair.plot), preview.events);
        if (preview.warnings.length) {
          void vscode.window.showWarningMessage(
            `PyneIDE: chart opened with ${preview.warnings.length} ignored output record(s).`
          );
        }
      } catch (err) {
        void vscode.window.showErrorMessage(
          `PyneIDE: could not open output chart — ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      }
    }),
    vscode.commands.registerCommand('pyneide.workspace.revealInExplorer', (node?: PyneNode) => {
      const uri = nodeUri(node ?? view.selection[0]);
      if (uri) void vscode.commands.executeCommand('revealInExplorer', uri);
    }),
    vscode.commands.registerCommand('pyneide.scriptDelete', (node?: PyneNode) => {
      const target = node ?? view.selection[0];
      if (isDeletableScriptNode(target)) void deleteScriptNode(target);
    }),
    vscode.commands.registerCommand('pyneide.dataDelete', (node?: PyneNode) => {
      const target = node ?? view.selection[0];
      if (target?.type === 'data') void deleteDataFile(target.uri);
    }),
    vscode.commands.registerCommand('pyneide.outputDelete', (node?: PyneNode) => {
      const target = node ?? view.selection[0];
      if (target?.type === 'output') void deleteOutputFile(target.uri);
    }),
    // The Delete/Backspace keybinding routes here: its `when` only checks the
    // focused view (viewItem is unreliable at keybinding-eval time), so the
    // target type is resolved from the current selection.
    vscode.commands.registerCommand('pyneide.workspace.deleteSelected', (node?: PyneNode) => {
      const target = node ?? view.selection[0];
      if (isDeletableScriptNode(target)) void deleteScriptNode(target);
      else if (target?.type === 'data') void deleteDataFile(target.uri);
      else if (target?.type === 'output') void deleteOutputFile(target.uri);
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('pyneide.workdir')) refresh();
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => refresh())
  );

  return provider;
}

function nodeUri(node?: PyneNode): vscode.Uri | undefined {
  return node && 'uri' in node ? node.uri : undefined;
}

type DeletableScriptNode = ScriptNode | CompanionNode | LibraryFolderNode;

function isDeletableScriptNode(node: PyneNode | undefined): node is DeletableScriptNode {
  return (
    node?.type === 'script' ||
    node?.type === 'companion' ||
    node?.type === 'libraryFolder'
  );
}

/**
 * Delete a script family or an entire library group after a modal confirm.
 * Selecting a Pine parent removes its compiled Pyne companion and shared
 * metadata too; selecting the companion itself keeps the Pine source and its
 * input metadata. Library folders are removed recursively.
 */
async function deleteScriptNode(node: DeletableScriptNode): Promise<void> {
  if (node.type === 'libraryFolder') {
    const name = node.depth === 0 ? 'Libraries' : path.basename(node.uri.fsPath);
    const choice = await vscode.window.showWarningMessage(
      `Delete ${name} and everything in it?`,
      { modal: true, detail: 'The folder and all its contents are moved to the trash.' },
      'Delete'
    );
    if (choice !== 'Delete') return;
    await deleteToTrash(node.uri, true);
    return;
  }

  const targets = scriptDeletionTargets(node);
  const associatedCount = targets.length - 1;
  const name = path.basename(node.uri.fsPath);
  const choice = await vscode.window.showWarningMessage(
    associatedCount > 0
      ? `Delete ${name} and its ${associatedCount} associated file${associatedCount === 1 ? '' : 's'}?`
      : `Delete ${name}?`,
    {
      modal: true,
      detail:
        targets.length === 1
          ? 'The file is moved to the trash.'
          : 'The script files are moved to the trash.',
    },
    'Delete'
  );
  if (choice !== 'Delete') return;
  for (const target of targets) {
    await deleteToTrash(vscode.Uri.file(target));
  }
}

function scriptDeletionTargets(node: ScriptNode | CompanionNode): string[] {
  const file = node.uri.fsPath;
  const targets = [file];
  if (/\.pine$/i.test(file)) {
    const stem = file.replace(/\.pine$/i, '');
    targets.push(`${stem}.py`, `${stem}.py.map`, `${stem}.toml`);
  } else if (/\.py$/i.test(file)) {
    targets.push(`${file}.map`);
    if (node.type === 'script') {
      targets.push(file.replace(/\.py$/i, '.toml'));
    }
  }
  return targets.filter((target, index) => index === 0 || fs.existsSync(target));
}

/**
 * Delete an `.ohlcv` data file and its sibling `.toml` syminfo (to the OS
 * trash), after a modal confirm. The FileSystemWatcher refreshes the tree.
 */
async function deleteDataFile(uri: vscode.Uri): Promise<void> {
  const name = path.basename(uri.fsPath);
  const choice = await vscode.window.showWarningMessage(
    `Delete ${name} and its symbol info?`,
    { modal: true, detail: 'The files are moved to the trash.' },
    'Delete'
  );
  if (choice !== 'Delete') return;
  await deleteToTrash(uri);
  const tomlPath = uri.fsPath.replace(/\.ohlcv$/i, '.toml');
  if (tomlPath !== uri.fsPath && fs.existsSync(tomlPath)) {
    await deleteToTrash(vscode.Uri.file(tomlPath));
  }
}

/** Delete an output file (to the OS trash) after a modal confirm. */
async function deleteOutputFile(uri: vscode.Uri): Promise<void> {
  const name = path.basename(uri.fsPath);
  const choice = await vscode.window.showWarningMessage(
    `Delete ${name}?`,
    { modal: true, detail: 'The file is moved to the trash.' },
    'Delete'
  );
  if (choice !== 'Delete') return;
  await deleteToTrash(uri);
}

async function deleteToTrash(uri: vscode.Uri, recursive = false): Promise<void> {
  try {
    await vscode.workspace.fs.delete(uri, { recursive, useTrash: true });
  } catch (err) {
    void vscode.window.showErrorMessage(
      `PyneIDE: could not delete ${path.basename(uri.fsPath)} — ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }
}
