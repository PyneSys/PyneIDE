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

import { OhlcvEditorProvider } from '../data/ohlcvEditor';
import { parseSymbolSection, readOhlcvStats } from '../data/syminfo';
import { resolveWorkspaceWorkdir } from '../env/workdirConfig';
import { detectPyne, DETECT_HEAD_BYTES, type PyneKind } from '../pyneDetect';

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

interface DataNode {
  type: 'data';
  uri: vscode.Uri;
}

interface OutputNode {
  type: 'output';
  uri: vscode.Uri;
}

export type PyneNode = SectionNode | ScriptNode | DataNode | OutputNode;

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

export class PyneWorkspaceProvider implements vscode.TreeDataProvider<PyneNode> {
  private readonly emitter = new vscode.EventEmitter<PyneNode | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;

  /** Metadata cache keyed by .ohlcv fsPath; invalidated by mtime. */
  private readonly dataCache = new Map<string, { mtimeMs: number; meta: DataMeta }>();

  private workdir: string | undefined;

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
      case 'data':
        return this.dataItem(node);
      case 'output':
        return this.outputItem(node);
    }
  }

  getChildren(node?: PyneNode): PyneNode[] {
    if (!this.workdir) return [];
    if (!node) {
      return [
        { type: 'section', kind: 'scripts' },
        { type: 'section', kind: 'data' },
        { type: 'section', kind: 'output' },
      ];
    }
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

  private scriptChildren(): ScriptNode[] {
    const dir = path.join(this.workdir!, 'scripts');
    const nodes: ScriptNode[] = [];
    for (const file of walkScripts(dir)) {
      nodes.push({
        type: 'script',
        uri: vscode.Uri.file(file),
        rel: path.relative(dir, file),
        pyneKind: detectScriptKind(file),
      });
    }
    nodes.sort((a, b) => a.rel.localeCompare(b.rel));
    return nodes;
  }

  private scriptItem(node: ScriptNode): vscode.TreeItem {
    const item = new vscode.TreeItem(node.rel, vscode.TreeItemCollapsibleState.None);
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
    item.contextValue = node.pyneKind ? 'pyneScript' : 'pyneFile';
    item.command = { command: 'vscode.open', title: 'Open', arguments: [node.uri] };
    return item;
  }

  private dataChildren(): DataNode[] {
    const dir = path.join(this.workdir!, 'data');
    let names: string[];
    try {
      names = fs.readdirSync(dir).filter((n) => n.toLowerCase().endsWith('.ohlcv'));
    } catch {
      return [];
    }
    names.sort((a, b) => a.localeCompare(b));
    return names.map((n) => ({ type: 'data', uri: vscode.Uri.file(path.join(dir, n)) }));
  }

  private dataItem(node: DataNode): vscode.TreeItem {
    const meta = this.dataMeta(node.uri.fsPath);
    const item = new vscode.TreeItem(meta.label, vscode.TreeItemCollapsibleState.None);
    item.resourceUri = node.uri;
    item.description = meta.description;
    item.tooltip = meta.tooltip;
    item.iconPath = new vscode.ThemeIcon('graph-line');
    item.contextValue = 'pyneData';
    item.command = {
      command: 'vscode.openWith',
      title: 'Open as Table',
      arguments: [node.uri, OhlcvEditorProvider.viewType],
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
    try {
      const tomlPath = fsPath.replace(/\.ohlcv$/i, '.toml');
      const sym = parseSymbolSection(fs.readFileSync(tomlPath, 'utf8'));
      ticker = sym.ticker;
      period = sym.period;
    } catch {
      // No sibling toml — fall back to the file stem.
    }
    const label = [ticker, period].filter(Boolean).join(' ') || stem;

    const parts: string[] = [];
    const tooltipLines: string[] = [ticker && period ? `${ticker} ${period}` : stem];
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
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    return entries
      .filter((e) => e.isFile() && !e.name.startsWith('.'))
      .map((e): OutputNode => ({ type: 'output', uri: vscode.Uri.file(path.join(dir, e.name)) }))
      .sort((a, b) => a.uri.fsPath.localeCompare(b.uri.fsPath));
  }

  private outputItem(node: OutputNode): vscode.TreeItem {
    const item = new vscode.TreeItem(
      path.basename(node.uri.fsPath),
      vscode.TreeItemCollapsibleState.None
    );
    item.resourceUri = node.uri;
    item.iconPath = vscode.ThemeIcon.File;
    item.contextValue = 'pyneOutput';
    item.command = { command: 'vscode.open', title: 'Open', arguments: [node.uri] };
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
export function registerWorkspaceView(context: vscode.ExtensionContext): PyneWorkspaceProvider {
  const provider = new PyneWorkspaceProvider(context.extensionUri);
  const view = vscode.window.createTreeView(PYNE_WORKSPACE_VIEW_ID, {
    treeDataProvider: provider,
    showCollapseAll: false,
  });
  context.subscriptions.push(view);

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

  context.subscriptions.push(
    vscode.commands.registerCommand('pyneide.workspace.refresh', () => {
      provider.refresh();
      syncContext();
      rebuildWatcher();
    }),
    vscode.commands.registerCommand('pyneide.workspace.runScript', (node?: PyneNode) => {
      const uri = nodeUri(node);
      if (uri) void vscode.commands.executeCommand('pyneide.runScript', uri);
    }),
    vscode.commands.registerCommand('pyneide.workspace.debugScript', (node?: PyneNode) => {
      const uri = nodeUri(node);
      if (uri) void vscode.commands.executeCommand('pyneide.debugScript', uri);
    }),
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
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('pyneide.workdir')) refresh();
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => refresh())
  );

  return provider;
}

function nodeUri(node?: PyneNode): vscode.Uri | undefined {
  if (node && node.type !== 'section') return node.uri;
  return undefined;
}
