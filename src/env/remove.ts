import * as fs from 'node:fs';
import * as path from 'node:path';

import { markerPath } from './bootstrap';
import type { Logger } from './constants';
import { managedPythonDir, managedVenvDir, uvDir } from './uv';

/**
 * Everything PyneIDE downloads lives in globalStorage, which VS Code does NOT
 * delete when the extension is uninstalled — without this module the ~250 MB
 * managed environment is only removable by hand. Kept vscode-free like the
 * rest of src/env; the command UI lives in `removeCommand.ts`.
 */

export type RemovableId = 'python' | 'pine-ls';

export interface RemovableComponent {
  id: RemovableId;
  label: string;
  /** What removing it costs later, shown as the picker row's detail. */
  note: string;
  /** Existing paths only — the picker never offers what is not on disk. */
  paths: string[];
  bytes: number;
}

/**
 * Directories owned by other modules. Passed in rather than imported so this
 * module does not reach into src/pinels and src/plugins (and so src/env keeps
 * its one-way dependencies).
 */
export interface ComponentLocations {
  /** `src/pinels/installer.ts` `pineLsRoot()`. */
  pineLsRoot: string;
  /** `src/plugins/installed.ts` `cliWorkdir()`. */
  cliWorkdir: string;
}

/**
 * The removable components that currently exist on disk, with their sizes.
 * The Python environment is one component on purpose: uv, the standalone
 * CPython and the venv are useless without each other.
 */
export async function removableComponents(
  storageDir: string,
  locations: ComponentLocations
): Promise<RemovableComponent[]> {
  const python = [
    uvDir(storageDir),
    managedPythonDir(storageDir),
    managedVenvDir(storageDir),
    markerPath(storageDir),
    locations.cliWorkdir,
  ].filter((target) => fs.existsSync(target));
  const pineLs = [locations.pineLsRoot].filter((target) => fs.existsSync(target));

  const components: RemovableComponent[] = [];
  if (python.length > 0) {
    components.push({
      id: 'python',
      label: 'Python environment',
      note: 'uv, the standalone Python, the virtual environment and any installed plugins',
      paths: python,
      bytes: await totalBytes(python),
    });
  }
  if (pineLs.length > 0) {
    components.push({
      id: 'pine-ls',
      label: 'Pine language server',
      note: 'Installing it again needs an internet connection',
      paths: pineLs,
      bytes: await totalBytes(pineLs),
    });
  }
  return components;
}

async function totalBytes(paths: string[]): Promise<number> {
  let total = 0;
  for (const target of paths) total += await pathBytes(target);
  return total;
}

/**
 * Size of a file or directory tree. Symlinks are measured, never followed:
 * a standalone CPython links the same libraries several times over, so
 * following them would report several times the size actually freed.
 */
async function pathBytes(target: string): Promise<number> {
  let stat: fs.Stats;
  try {
    stat = await fs.promises.lstat(target);
  } catch {
    return 0;
  }
  if (!stat.isDirectory()) return stat.size;
  let total = 0;
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(target, { withFileTypes: true });
  } catch {
    return total;
  }
  for (const entry of entries) {
    total += await pathBytes(path.join(target, entry.name));
  }
  return total;
}

/**
 * Delete the given paths. `maxRetries` is what makes this work on Windows,
 * where a file a just-stopped process still holds fails with EBUSY/EPERM for
 * a moment; a path that stays locked throws and the caller reports it.
 */
export async function removePaths(paths: string[], log: Logger): Promise<void> {
  for (const target of paths) {
    log(`Removing ${target}`);
    await fs.promises.rm(target, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 200,
    });
  }
}

/** Size for a menu row: whole MB, since these are tens to hundreds of MB. */
export function formatBytes(bytes: number): string {
  if (bytes < 1_000_000) return '<1 MB';
  return `${Math.round(bytes / 1_000_000)} MB`;
}
