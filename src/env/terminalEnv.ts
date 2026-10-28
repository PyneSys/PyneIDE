import * as path from 'node:path';

import * as vscode from 'vscode';

import type { EnvManager } from './manager';
import { venvLocation } from './workdir';
import { resolvePyneIdeWorkdir, resolveWorkspaceWorkdir } from './workdirConfig';

/**
 * Makes the integrated terminal behave like the Pyne environment is activated:
 * the `pyne` CLI (plus the environment's `python`/`pip`) is on PATH and finds
 * the same workdir PyneIDE runs scripts against.
 *
 * The two halves are gated differently on purpose, because the extension
 * activates on startup in EVERY window:
 *
 * - PATH/VIRTUAL_ENV take the STRICT gate (`resolvePyneIdeWorkdir`, i.e. our
 *   own marker in the workdir's generated pyrightconfig). Prepending PATH swaps
 *   `python` for everything typed in that terminal — as intrusive as the
 *   Pylance takeover, and gated the same way. A merely resolvable workdir is
 *   not enough: the name-based search walks ten parent directories, so one
 *   `workdir` folder high up would activate our interpreter inside every plain
 *   Python project below it.
 * - PYNE_WORK_DIR keeps the loose resolution. Only the `pyne` CLI reads it, and
 *   in a PyneCore checkout that was never initialized by PyneIDE it still names
 *   the right workdir.
 *
 * `applyAtShellIntegration` matters on macOS: `/etc/zprofile` runs
 * `path_helper`, which rebuilds PATH with the system directories in front, so a
 * process-creation-only prepend would be demoted by the login shell.
 */
const MUTATOR_OPTIONS: vscode.EnvironmentVariableMutatorOptions = {
  applyAtProcessCreation: true,
  applyAtShellIntegration: true,
};

/** Shown on the terminal tab, so it must state what was actually applied. */
const WORKDIR_ONLY_DESCRIPTION = 'Points the pyne CLI at the workdir resolved by PyneIDE';
const ACTIVATED_DESCRIPTION =
  'Activates PyneIDE’s Python environment (pyne CLI on PATH) and points it at the workdir';

export function registerTerminalEnv(
  context: vscode.ExtensionContext,
  manager: EnvManager
): void {
  updateTerminalEnv(context, manager);
  context.subscriptions.push(
    manager.onDidChangeProjectState(() => updateTerminalEnv(context, manager)),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('pyneide.workdir')) updateTerminalEnv(context, manager);
    }),
    vscode.workspace.onDidChangeWorkspaceFolders((e) => {
      for (const folder of e.removed) {
        context.environmentVariableCollection.getScoped({ workspaceFolder: folder }).clear();
      }
      updateTerminalEnv(context, manager);
    })
  );
}

/**
 * Recompute the whole collection. Also called after "Initialize Pyne Project",
 * whose new workdir directory produces no event of its own.
 */
export function updateTerminalEnv(
  context: vscode.ExtensionContext,
  manager: EnvManager
): void {
  const root = context.environmentVariableCollection;
  root.clear();
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    const collection = root.getScoped({ workspaceFolder: folder });
    collection.clear();
    const workdir = resolveWorkspaceWorkdir(folder);
    if (workdir?.exists) collection.replace('PYNE_WORK_DIR', workdir.path, MUTATOR_OPTIONS);
    const state = manager.forProject(folder.uri).state;
    if (state.kind !== 'ready' || !resolvePyneIdeWorkdir(folder)) {
      collection.description = WORKDIR_ONLY_DESCRIPTION;
      continue;
    }
    collection.prepend('PATH', path.dirname(state.pythonBin) + path.delimiter, MUTATOR_OPTIONS);
    collection.description = ACTIVATED_DESCRIPTION;
    const venv = venvLocation(state.pythonBin);
    if (venv) {
      collection.replace('VIRTUAL_ENV', path.join(venv.venvPath, venv.venv), MUTATOR_OPTIONS);
    }
  }
}
