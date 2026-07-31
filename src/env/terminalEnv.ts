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
    manager.onDidChangeState(() => updateTerminalEnv(context, manager)),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('pyneide.workdir')) updateTerminalEnv(context, manager);
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => updateTerminalEnv(context, manager))
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
  const collection = context.environmentVariableCollection;
  const workdir = resolveWorkspaceWorkdir();

  // The bare `pyne` CLI would otherwise miss a workdir that is the project
  // folder itself — its upward search matches the directory NAME `workdir`.
  if (workdir?.exists) {
    collection.replace('PYNE_WORK_DIR', workdir.path, MUTATOR_OPTIONS);
  } else {
    collection.delete('PYNE_WORK_DIR');
  }

  // Until the first check completes the interpreter is simply not known yet.
  // VS Code persists this collection across restarts, so leaving it alone keeps
  // the previous session's values for terminals restored at startup, instead of
  // stripping the environment for a moment and putting it straight back.
  const state = manager.state;
  if (state.kind === 'unknown' || state.kind === 'working') return;

  const pythonBin = state.kind === 'ready' ? state.pythonBin : undefined;
  if (!pythonBin || !resolvePyneIdeWorkdir()) {
    collection.delete('PATH');
    collection.delete('VIRTUAL_ENV');
    collection.description = WORKDIR_ONLY_DESCRIPTION;
    return;
  }

  collection.prepend('PATH', path.dirname(pythonBin) + path.delimiter, MUTATOR_OPTIONS);
  collection.description = ACTIVATED_DESCRIPTION;

  // Only a real virtual environment has a VIRTUAL_ENV to announce; with
  // `pyneide.pythonPath` pointing at a bare interpreter, claiming one would
  // send every venv-aware tool in that terminal to a directory that is not one.
  const venv = venvLocation(pythonBin);
  if (venv) {
    collection.replace('VIRTUAL_ENV', path.join(venv.venvPath, venv.venv), MUTATOR_OPTIONS);
  } else {
    collection.delete('VIRTUAL_ENV');
  }
}
