/**
 * What is installed in the environment, from `pyne plugin list --json` — the
 * CLI's own entry-point discovery, so a plugin counts as installed exactly when
 * PyneCore can load it (not merely when the wheel is present).
 *
 * The CLI scaffolds a workdir on any subcommand and prompts for confirmation
 * when the directory does not exist, so callers must pass an EXISTING one; use
 * {@link cliWorkdir} when no Pyne workspace is open. `PYNE_NO_LOGO=1` keeps the
 * banner out of stdout, but plugin load failures are printed before the JSON,
 * so the payload is located from the first `{`.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import type { Logger } from '../env/constants';
import { execChecked } from '../env/exec';
import { normalizePackageName } from './catalog';

/** The package every built-in plugin (`ccxt`, `replay`) is reported under. */
export const PYNECORE_PACKAGE = 'pynesys-pynecore';

export interface InstalledPlugin {
  /** Entry point name — what `-p <name>` and the provider strings use. */
  name: string;
  displayName: string;
  version: string;
  capabilities: string[];
  summary: string;
  /** Distribution that declared the entry point. */
  package: string;
  /** The same plugin id is declared by more than one installed package. */
  conflict: boolean;
}

export interface PluginListError {
  name: string;
  error: string;
}

export interface InstalledPlugins {
  plugins: InstalledPlugin[];
  errors: PluginListError[];
}

/** The CLI's snake_case wire shape. */
interface RawPlugin {
  name?: string;
  display_name?: string;
  version?: string;
  capabilities?: string[];
  summary?: string;
  package?: string;
  conflict?: boolean;
}

/**
 * Parse the `pyne plugin list --json` payload out of a CLI stdout that may
 * carry leading noise. Exported for the smoke test.
 */
export function parsePluginListJson(stdout: string): InstalledPlugins {
  const start = stdout.indexOf('{');
  if (start < 0) throw new Error('pyne plugin list produced no JSON output');
  const parsed = JSON.parse(stdout.slice(start)) as {
    plugins?: RawPlugin[];
    errors?: PluginListError[];
  };
  return {
    plugins: (parsed.plugins ?? [])
      .filter((p): p is RawPlugin & { name: string } => Boolean(p.name))
      .map((p) => ({
        name: p.name,
        displayName: p.display_name || p.name,
        version: p.version ?? '',
        // The CLI writes "library" when a plugin has no capability at all.
        capabilities: (p.capabilities ?? []).filter((c) => c && c !== 'library'),
        summary: p.summary ?? '',
        package: p.package ?? '',
        conflict: p.conflict ?? false,
      })),
    errors: parsed.errors ?? [],
  };
}

/** Run `pyne plugin list --json` against an environment. */
export async function listInstalledPlugins(
  pyneBin: string,
  workdir: string,
  log: Logger
): Promise<InstalledPlugins> {
  const result = await execChecked(pyneBin, ['--workdir', workdir, 'plugin', 'list', '--json'], log, {
    timeoutMs: 60 * 1000,
    env: { ...process.env, PYNE_WORK_DIR: workdir, PYNE_NO_LOGO: '1' },
  });
  return parsePluginListJson(result.stdout);
}

/**
 * A workdir for CLI calls that have nothing to do with the user's project (the
 * plugin listing). Kept in globalStorage and pre-created, so pynecore scaffolds
 * its layout there instead of prompting — and never in a folder the user sees.
 */
export function cliWorkdir(storageDir: string): string {
  const dir = cliWorkdirPath(storageDir);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** The same location without creating it — for callers that only remove it. */
export function cliWorkdirPath(storageDir: string): string {
  return path.join(storageDir, 'cli-workdir');
}

/** Built-ins ship inside PyneCore itself, so they cannot be uninstalled. */
export function isBuiltinPlugin(plugin: InstalledPlugin): boolean {
  return normalizePackageName(plugin.package) === PYNECORE_PACKAGE;
}
