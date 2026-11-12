/** Install project plugins while preserving the selected Core release. */
import { typerRequirementForCore } from './bootstrap';
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
  pynecoreVersion?: string;
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
  const args = ['pip', action, '--python', op.pythonBin, ...op.packages];
  if (action === 'install' && op.pynecoreVersion) {
    args.push(`pynesys-pynecore[cli]==${op.pynecoreVersion}`);
    const typerRequirement = typerRequirementForCore(op.pynecoreVersion);
    if (typerRequirement) args.push(typerRequirement);
  }
  await execChecked(
    uvBin,
    args,
    op.log,
    { env, timeoutMs: 600000 }
  );
}
