/**
 * Installing extra packages (plugins) into the managed venv with the same
 * pinned uv the bootstrap uses. Kept vscode-free so it stays headless-testable
 * next to bootstrap.ts.
 *
 * The pinned pynecore is deliberately NOT resolvable away here: callers must
 * check a plugin's `min_pynecore` against the installed version BEFORE calling
 * in, so uv never has a reason to upgrade pynecore under the extension (the
 * IDE <-> PyneCore bridge is an unversioned private contract).
 */
import type { Logger } from './constants';
import { execChecked } from './exec';
import { ensureUv, uvEnv } from './uv';

export interface PackageOperation {
  storageDir: string;
  /** Interpreter of the target environment (the managed venv's python). */
  pythonBin: string;
  packages: string[];
  log: Logger;
  proxyUrl?: string;
}

/** `uv pip install` the given requirement strings into the managed venv. */
export async function installPackages(op: PackageOperation): Promise<void> {
  await runUvPip(op, 'install');
}

/** `uv pip uninstall` the given package names from the managed venv. */
export async function uninstallPackages(op: PackageOperation): Promise<void> {
  await runUvPip(op, 'uninstall');
}

async function runUvPip(op: PackageOperation, action: 'install' | 'uninstall'): Promise<void> {
  if (op.packages.length === 0) return;
  const env = uvEnv(op.storageDir, op.proxyUrl);
  const { uvBin } = await ensureUv(op.storageDir, op.log, env);
  await execChecked(
    uvBin,
    ['pip', action, '--python', op.pythonBin, ...op.packages],
    op.log,
    { env, timeoutMs: 600000 }
  );
}
