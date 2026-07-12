/**
 * Environment bootstrap smoke test — runs WITHOUT VSCode.
 * Downloads uv, creates the pinned venv, installs packages, verifies imports.
 * Usage: node dist/env-smoke.js [storageDir]
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { bootstrapManagedEnv } from '../../src/env/bootstrap';
import { execChecked } from '../../src/env/exec';
import { venvPythonPath, managedVenvDir } from '../../src/env/uv';
import { createPyneWorkspace, findWorkdir } from '../../src/env/workdir';

const log = (msg: string): void => console.log(msg);

async function main(): Promise<void> {
  const storageDir =
    process.argv[2] ?? fs.mkdtempSync(path.join(os.tmpdir(), 'pyneide-smoke-'));
  log(`Storage dir: ${storageDir}`);

  const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy || undefined;
  const { pythonBin, verify } = await bootstrapManagedEnv({ storageDir, log, proxyUrl });
  if (!verify.ok) {
    throw new Error(`Verification failed: ${verify.error}`);
  }
  if (pythonBin !== venvPythonPath(managedVenvDir(storageDir))) {
    throw new Error('Unexpected python path for managed venv');
  }

  // The pyne CLI must start from the venv.
  const pyneBin = path.join(
    path.dirname(pythonBin),
    process.platform === 'win32' ? 'pyne.exe' : 'pyne'
  );
  await execChecked(pyneBin, ['--help'], log, { timeoutMs: 60000 });

  // Workdir discovery + workspace scaffolding.
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pyneide-ws-'));
  const before = findWorkdir(base);
  if (before.exists) throw new Error('findWorkdir: false positive');
  const ws = createPyneWorkspace(base);
  const after = findWorkdir(path.join(base, 'workdir', 'scripts'));
  if (!after.exists || after.path !== ws.workdir) {
    throw new Error(`findWorkdir mismatch: ${after.path} != ${ws.workdir}`);
  }
  if (!fs.existsSync(ws.demoScript)) throw new Error('demo script missing');

  log('SMOKE OK');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
