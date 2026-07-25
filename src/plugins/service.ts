/**
 * The plugin manager's model layer: merges the remote index with what is
 * actually installed in the environment, and owns install/uninstall.
 *
 * Two independent sources, each degradable on its own:
 *  - the catalogue (`/plugins/index.json`), ETag-cached in globalState so a
 *    failed request falls back to the last snapshot instead of an empty list;
 *  - `pyne plugin list --json`, which needs a working environment — without one
 *    the catalogue still renders, just without installed state.
 *
 * A package installed into the managed venv is recorded in globalState as well:
 * a `Repair (clean reinstall)` or a pin bump rebuilds the venv from scratch, and
 * that record is the only way to notice the plugins went with it.
 */
import * as vscode from 'vscode';

import type { AuthService } from '../api/auth';
import type { EnvManager } from '../env/manager';
import { pyneBinPath } from '../env/uv';
import { resolveWorkspaceWorkdir } from '../env/workdirConfig';
import {
  fetchPluginDetail,
  fetchPluginIndex,
  normalizePackageName,
  satisfiesMinPynecore,
  type PluginDetail,
  type PluginIndexSnapshot,
  type PluginListItem,
  type PluginStatus,
  type PluginTier,
} from './catalog';
import {
  cliWorkdir,
  isBuiltinPlugin,
  listInstalledPlugins,
  type InstalledPlugin,
} from './installed';

const INDEX_CACHE_KEY = 'pyneide.plugins.index';
const MANAGED_KEY = 'pyneide.plugins.managed';
/** Matches the index endpoint's own `Cache-Control: public, max-age=300`. */
const INDEX_TTL_MS = 5 * 60 * 1000;

interface IndexCache {
  etag?: string;
  fetchedAt: number;
  snapshot: PluginIndexSnapshot;
}

/** A package PyneIDE installed itself, so it can be restored after a rebuild. */
export interface ManagedPlugin {
  package: string;
  version: string;
}

export interface PluginRow {
  /**
   * Stable row key. Usually the normalized package name, but one package can
   * declare several plugin ids (PyneCore itself ships `ccxt` and `replay`), so
   * locally-discovered rows are keyed per id.
   */
  id: string;
  /** Exact PyPI package name — what gets installed/uninstalled. */
  package: string;
  displayName: string;
  summary: string;
  pluginIds: string[];
  capabilities: string[];
  tier?: PluginTier;
  status?: PluginStatus;
  latestVersion?: string;
  installedVersion?: string;
  installed: boolean;
  /** Ships inside PyneCore (ccxt, replay): always present, never removable. */
  builtin: boolean;
  updateAvailable: boolean;
  minPynecore?: string;
  requiresPynecore?: string;
  downloads30d?: number | null;
  updatedAt?: string | null;
  /** False for something installed locally that the index does not know. */
  inCatalogue: boolean;
  /** The plugin id is declared by more than one installed package. */
  conflict?: boolean;
  /** Set when the plugin cannot be installed against the current PyneCore. */
  blockedReason?: string;
}

export interface PluginsModel {
  rows: PluginRow[];
  catalogue: {
    state: 'ok' | 'cached' | 'error';
    fetchedAt?: number;
    message?: string;
  };
  env: {
    /** PyneIDE owns the environment and may install into it. */
    managed: boolean;
    ready: boolean;
    pynecoreVersion?: string;
    /** False when the installed list could not be read (no/broken env). */
    installedKnown: boolean;
    installedMessage?: string;
  };
}

export type PluginActionErrorKind = 'unmanaged' | 'pynecore' | 'no-environment' | 'failed';

export class PluginActionError extends Error {
  constructor(
    message: string,
    readonly kind: PluginActionErrorKind
  ) {
    super(message);
  }
}

export class PluginService {
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  /** Fires after an install/uninstall, so views can re-read the model. */
  readonly onDidChange = this.changeEmitter.event;

  private inFlight: Promise<PluginsModel> | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly manager: EnvManager,
    private readonly auth: AuthService,
    private readonly output: vscode.OutputChannel
  ) {}

  dispose(): void {
    this.changeEmitter.dispose();
  }

  private log = (message: string): void => this.output.appendLine(message);

  /**
   * Build the merged model. `refresh` forces a catalogue request; otherwise the
   * cached snapshot is used when it is younger than the server's own 5-minute
   * cache window.
   */
  async model(refresh = false): Promise<PluginsModel> {
    // Concurrent callers (panel + status bar + tree) share one build.
    if (!refresh && this.inFlight) return this.inFlight;
    const build = this.buildModel(refresh).finally(() => {
      if (this.inFlight === build) this.inFlight = undefined;
    });
    this.inFlight = build;
    return build;
  }

  private async buildModel(refresh: boolean): Promise<PluginsModel> {
    const [catalogue, installed] = await Promise.all([
      this.loadCatalogue(refresh),
      this.loadInstalled(),
    ]);
    const state = this.manager.state;
    const pynecoreVersion = state.kind === 'ready' ? state.verify.pynecoreVersion : undefined;

    const rows = new Map<string, PluginRow>();
    for (const item of catalogue.snapshot?.plugins ?? []) {
      const id = normalizePackageName(item.package);
      rows.set(id, this.catalogueRow(id, item, pynecoreVersion));
    }
    for (const plugin of installed.plugins) {
      const existing = rows.get(normalizePackageName(plugin.package));
      if (existing) {
        this.applyInstalled(existing, plugin);
      } else {
        // Not in the index (a local/editable install, or PyneCore's own
        // built-ins): keyed per plugin id, since one package can declare
        // several — `ccxt` and `replay` both come from pynesys-pynecore.
        const id = `local:${normalizePackageName(plugin.package)}:${plugin.name}`;
        rows.set(id, this.localRow(id, plugin));
      }
    }

    return {
      rows: [...rows.values()].sort(comparePluginRows),
      catalogue: {
        state: catalogue.state,
        fetchedAt: catalogue.fetchedAt,
        message: catalogue.message,
      },
      env: {
        managed: this.manager.managesEnvironment,
        ready: state.kind === 'ready',
        pynecoreVersion,
        installedKnown: installed.known,
        installedMessage: installed.message,
      },
    };
  }

  private catalogueRow(id: string, item: PluginListItem, pynecoreVersion?: string): PluginRow {
    const blocked = !satisfiesMinPynecore(item.min_pynecore, pynecoreVersion);
    return {
      id,
      package: item.package,
      displayName: item.plugin_ids[0] ?? item.package,
      summary: item.summary,
      pluginIds: item.plugin_ids ?? [],
      capabilities: item.capabilities ?? [],
      tier: item.tier,
      status: item.status,
      latestVersion: item.version,
      installed: false,
      builtin: false,
      updateAvailable: false,
      minPynecore: item.min_pynecore,
      requiresPynecore: item.requires_pynecore,
      downloads30d: item.downloads_30d,
      updatedAt: item.updated_at,
      inCatalogue: true,
      blockedReason: blocked
        ? `Requires PyneCore ${item.requires_pynecore || `>=${item.min_pynecore}`}` +
          (pynecoreVersion ? ` (installed: ${pynecoreVersion})` : '')
        : undefined,
    };
  }

  private localRow(id: string, plugin: InstalledPlugin): PluginRow {
    return {
      id,
      package: plugin.package || plugin.name,
      displayName: plugin.displayName,
      summary: plugin.summary,
      pluginIds: [plugin.name],
      capabilities: plugin.capabilities,
      installedVersion: plugin.version,
      installed: true,
      builtin: isBuiltinPlugin(plugin),
      updateAvailable: false,
      inCatalogue: false,
      conflict: plugin.conflict,
    };
  }

  private applyInstalled(row: PluginRow, plugin: InstalledPlugin): void {
    row.installed = true;
    row.installedVersion = plugin.version;
    row.builtin = isBuiltinPlugin(plugin);
    row.conflict = plugin.conflict;
    if (plugin.displayName) row.displayName = plugin.displayName;
    if (!row.pluginIds.includes(plugin.name)) row.pluginIds = [...row.pluginIds, plugin.name];
    row.updateAvailable =
      !row.builtin &&
      Boolean(row.latestVersion) &&
      Boolean(plugin.version) &&
      row.latestVersion !== plugin.version;
  }

  // --- catalogue -----------------------------------------------------------

  private async loadCatalogue(refresh: boolean): Promise<{
    state: 'ok' | 'cached' | 'error';
    snapshot?: PluginIndexSnapshot;
    fetchedAt?: number;
    message?: string;
  }> {
    const cached = this.context.globalState.get<IndexCache>(INDEX_CACHE_KEY);
    // The server caches the index for 5 minutes anyway, so a fresh copy needs
    // no request at all unless the user explicitly refreshed.
    if (!refresh && cached && Date.now() - cached.fetchedAt < INDEX_TTL_MS) {
      return { state: 'ok', snapshot: cached.snapshot, fetchedAt: cached.fetchedAt };
    }
    try {
      const result = await fetchPluginIndex(this.auth.baseUrl(), cached?.etag);
      // A 304 without a cached body cannot happen (the ETag comes from it), but
      // guard anyway rather than serving an empty catalogue.
      const snapshot = result.kind === 'ok' ? result.snapshot : cached?.snapshot;
      if (!snapshot) throw new Error('The plugin index answered 304 without a cached copy');
      const fresh: IndexCache = {
        etag: result.kind === 'ok' ? result.etag : cached?.etag,
        fetchedAt: Date.now(),
        snapshot,
      };
      await this.context.globalState.update(INDEX_CACHE_KEY, fresh);
      return { state: 'ok', snapshot, fetchedAt: fresh.fetchedAt };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log(`PyneIDE: plugin index unavailable: ${message}`);
      if (cached) {
        return { state: 'cached', snapshot: cached.snapshot, fetchedAt: cached.fetchedAt, message };
      }
      return { state: 'error', message };
    }
  }

  /** Detail for the side pane; the index is the only source, so no fallback. */
  async detail(pkg: string): Promise<PluginDetail> {
    return fetchPluginDetail(this.auth.baseUrl(), pkg);
  }

  // --- installed -----------------------------------------------------------

  private async loadInstalled(): Promise<{
    plugins: InstalledPlugin[];
    known: boolean;
    message?: string;
  }> {
    const state =
      this.manager.state.kind === 'ready' ? this.manager.state : await this.manager.check();
    if (state.kind !== 'ready') {
      return {
        plugins: [],
        known: false,
        message:
          state.kind === 'needs-setup'
            ? state.reason
            : state.kind === 'error'
              ? state.message
              : 'The Python environment is not ready.',
      };
    }
    try {
      const result = await listInstalledPlugins(
        pyneBinPath(state.pythonBin),
        this.workdir(),
        this.log
      );
      for (const failure of result.errors) {
        this.log(`PyneIDE: plugin '${failure.name}' failed to load: ${failure.error}`);
      }
      return { plugins: result.plugins, known: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log(`PyneIDE: could not list installed plugins: ${message}`);
      return { plugins: [], known: false, message };
    }
  }

  /**
   * Workdir for the listing call. The user's project is preferred (so pynecore
   * also generates the freshly installed plugin's `config/plugins/*.toml`
   * there); without one a private scratch workdir keeps the CLI from prompting.
   */
  private workdir(): string {
    const resolved = resolveWorkdirSafely();
    return resolved ?? cliWorkdir(this.context.globalStorageUri.fsPath);
  }

  // --- mutations -----------------------------------------------------------

  /**
   * Install (or update to) a catalogue package. Returns false when the user
   * declined the trust prompt.
   */
  async install(row: PluginRow): Promise<boolean> {
    await this.requireInstallableEnvironment();
    if (row.blockedReason) {
      throw new PluginActionError(row.blockedReason, 'pynecore');
    }
    if (!(await confirmUntrustedTier(row))) return false;
    const requirement = row.latestVersion ? `${row.package}==${row.latestVersion}` : row.package;
    const verb = row.installed ? 'Updating' : 'Installing';
    try {
      await this.manager.installPackages([requirement], `PyneIDE: ${verb} ${row.package}…`);
    } catch (err) {
      throw new PluginActionError(err instanceof Error ? err.message : String(err), 'failed');
    }
    await this.rememberManaged(row.package, row.latestVersion ?? '');
    this.changeEmitter.fire();
    return true;
  }

  async uninstall(row: PluginRow): Promise<void> {
    await this.requireInstallableEnvironment();
    try {
      await this.manager.uninstallPackages([row.package], `PyneIDE: Removing ${row.package}…`);
    } catch (err) {
      throw new PluginActionError(err instanceof Error ? err.message : String(err), 'failed');
    }
    await this.forgetManaged(row.package);
    this.changeEmitter.fire();
  }

  /**
   * The command to run by hand against a user-provided environment. Plain `pip`
   * on purpose: it is what a hand-made venv has, and the command is meant to be
   * run from inside that venv.
   */
  installCommand(row: PluginRow): string {
    const requirement = row.latestVersion ? `${row.package}==${row.latestVersion}` : row.package;
    return `pip install ${requirement}`;
  }

  private async requireInstallableEnvironment(): Promise<void> {
    if (!this.manager.managesEnvironment) {
      throw new PluginActionError(
        'PyneIDE does not install into user-provided environments — copy the install ' +
          'command and run it against your own venv.',
        'unmanaged'
      );
    }
    const pythonBin = await this.manager.ensureReady(
      'Installing a plugin needs the PyneIDE Python environment.'
    );
    if (!pythonBin) {
      throw new PluginActionError('The Python environment is not available.', 'no-environment');
    }
  }

  // --- managed-package bookkeeping ----------------------------------------

  managedPlugins(): ManagedPlugin[] {
    return this.context.globalState.get<ManagedPlugin[]>(MANAGED_KEY) ?? [];
  }

  private async rememberManaged(pkg: string, version: string): Promise<void> {
    const key = normalizePackageName(pkg);
    const next = this.managedPlugins().filter((p) => normalizePackageName(p.package) !== key);
    next.push({ package: pkg, version });
    await this.context.globalState.update(MANAGED_KEY, next);
  }

  private async forgetManaged(pkg: string): Promise<void> {
    const key = normalizePackageName(pkg);
    await this.context.globalState.update(
      MANAGED_KEY,
      this.managedPlugins().filter((p) => normalizePackageName(p.package) !== key)
    );
  }

  /**
   * Packages PyneIDE installed that are no longer loadable — the fingerprint of
   * a venv rebuild (Repair, pin bump). Empty when the installed set is unknown,
   * so a broken environment never looks like "everything vanished".
   */
  async missingManagedPlugins(): Promise<ManagedPlugin[]> {
    const managed = this.managedPlugins();
    if (managed.length === 0) return [];
    const installed = await this.loadInstalled();
    if (!installed.known) return [];
    const present = new Set(installed.plugins.map((p) => normalizePackageName(p.package)));
    return managed.filter((p) => !present.has(normalizePackageName(p.package)));
  }

  /** Reinstall what a venv rebuild removed, in one uv call. */
  async restoreManagedPlugins(plugins: ManagedPlugin[]): Promise<void> {
    if (plugins.length === 0) return;
    await this.requireInstallableEnvironment();
    const requirements = plugins.map((p) => (p.version ? `${p.package}==${p.version}` : p.package));
    try {
      await this.manager.installPackages(
        requirements,
        `PyneIDE: Reinstalling ${plugins.length} plugin${plugins.length > 1 ? 's' : ''}…`
      );
    } catch (err) {
      throw new PluginActionError(err instanceof Error ? err.message : String(err), 'failed');
    }
    this.changeEmitter.fire();
  }
}

/**
 * A `community` entry is an auto-discovered PyPI package nobody reviewed, and a
 * `yanked` release was pulled by its own author — installing either runs that
 * code locally, so both need an explicit yes. Official/verified go straight through.
 */
async function confirmUntrustedTier(row: PluginRow): Promise<boolean> {
  const warnings: string[] = [];
  if (row.tier === 'community') {
    warnings.push(
      'This is a community plugin: an automatically discovered third-party package that ' +
        'PyneSys has not reviewed. Installing it runs its code on your machine.'
    );
  }
  if (row.status === 'yanked') {
    warnings.push('The indexed release is yanked — its author withdrew it.');
  }
  if (warnings.length === 0) return true;
  const choice = await vscode.window.showWarningMessage(
    `Install ${row.package}?`,
    { modal: true, detail: warnings.join('\n\n') },
    'Install'
  );
  return choice === 'Install';
}

/** Tier first (official -> verified -> community -> local), then package name. */
function comparePluginRows(a: PluginRow, b: PluginRow): number {
  const rank = (row: PluginRow): number => {
    if (row.builtin) return 4;
    switch (row.tier) {
      case 'official':
        return 0;
      case 'verified':
        return 1;
      case 'community':
        return 2;
      default:
        return 3;
    }
  };
  return rank(a) - rank(b) || a.package.localeCompare(b.package);
}

/** The workspace workdir when one exists — never throws into the model build. */
function resolveWorkdirSafely(): string | undefined {
  try {
    const resolved = resolveWorkspaceWorkdir();
    return resolved?.exists ? resolved.path : undefined;
  } catch {
    return undefined;
  }
}
