import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  DEBUGPY_VERSION,
  ENV_SCHEMA_VERSION,
  PYNECORE_MIN_VERSION,
  PYNECORE_VERSION,
  PYTHON_VERSION,
  type Logger,
} from './constants';
import { execChecked, execProcess } from './exec';
import { ensureUv, managedVenvDir, uvEnv, venvPythonPath } from './uv';

export interface EnvMarker {
  schema: number;
  python: string;
  pynecore: string;
  debugpy: string;
}

export interface VerifyResult {
  ok: boolean;
  pythonVersion?: string;
  pynecoreVersion?: string;
  debugpyVersion?: string;
  /**
   * Directory that must be on the import path for `pynecore` to resolve, as the
   * interpreter itself reports it (site-packages for a wheel install, the src
   * root for an editable/dev install). Type checkers cannot follow setuptools'
   * import-hook editable finder, so this is fed to pyrightconfig.json extraPaths.
   */
  pynecoreRoot?: string;
  error?: string;
}

export interface BootstrapOptions {
  storageDir: string;
  log: Logger;
  proxyUrl?: string;
  /** Keep an already importable pynecore instead of installing the pin. */
  useOwnPynecore?: boolean;
}

const VERIFY_SCRIPT = [
  'import json, os, platform',
  'from importlib import metadata',
  'def ver(name):',
  '    try:',
  '        return metadata.version(name)',
  '    except metadata.PackageNotFoundError:',
  '        return None',
  'def pynecore_root():',
  '    try:',
  '        import pynecore',
  '    except Exception:',
  '        return None',
  '    f = getattr(pynecore, "__file__", None)',
  '    return os.path.dirname(os.path.dirname(f)) if f else None',
  'print(json.dumps({',
  '    "python": platform.python_version(),',
  '    "pynecore": ver("pynesys-pynecore"),',
  '    "debugpy": ver("debugpy"),',
  '    "pynecoreRoot": pynecore_root(),',
  '}))',
].join('\n');

function markerPath(storageDir: string): string {
  return path.join(storageDir, 'env.json');
}

export function readMarker(storageDir: string): EnvMarker | undefined {
  try {
    return JSON.parse(fs.readFileSync(markerPath(storageDir), 'utf8')) as EnvMarker;
  } catch {
    return undefined;
  }
}

export function currentMarker(): EnvMarker {
  return {
    schema: ENV_SCHEMA_VERSION,
    python: PYTHON_VERSION,
    pynecore: PYNECORE_VERSION,
    debugpy: DEBUGPY_VERSION,
  };
}

export function markerUpToDate(storageDir: string): boolean {
  const marker = readMarker(storageDir);
  if (!marker) return false;
  const want = currentMarker();
  return (
    marker.schema === want.schema &&
    marker.python === want.python &&
    marker.pynecore === want.pynecore &&
    marker.debugpy === want.debugpy
  );
}

/** Compare dotted version strings; returns negative/zero/positive. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((p) => parseInt(p, 10) || 0);
  const pb = b.split('.').map((p) => parseInt(p, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * Run an import/version check against a Python interpreter.
 * Never throws: problems come back in the `error` field.
 */
export async function verifyPython(pythonBin: string, log: Logger): Promise<VerifyResult> {
  try {
    const result = await execProcess(pythonBin, ['-X', 'utf8', '-c', VERIFY_SCRIPT], log, {
      timeoutMs: 30000,
    });
    if (result.code !== 0) {
      return { ok: false, error: result.stderr.trim() || `exit code ${result.code}` };
    }
    const info = JSON.parse(result.stdout.trim()) as {
      python: string;
      pynecore: string | null;
      debugpy: string | null;
      pynecoreRoot: string | null;
    };
    const pynecoreRoot = info.pynecoreRoot ?? undefined;
    if (!info.pynecore) {
      return { ok: false, pythonVersion: info.python, error: 'pynesys-pynecore is not installed' };
    }
    if (!info.debugpy) {
      return {
        ok: false,
        pythonVersion: info.python,
        pynecoreVersion: info.pynecore,
        error: 'debugpy is not installed',
      };
    }
    if (compareVersions(info.pynecore, PYNECORE_MIN_VERSION) < 0) {
      return {
        ok: false,
        pythonVersion: info.python,
        pynecoreVersion: info.pynecore,
        debugpyVersion: info.debugpy,
        error: `pynesys-pynecore ${info.pynecore} is older than the required ${PYNECORE_MIN_VERSION}`,
      };
    }
    return {
      ok: true,
      pythonVersion: info.python,
      pynecoreVersion: info.pynecore,
      debugpyVersion: info.debugpy,
      pynecoreRoot,
    };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

/**
 * Create (or recreate) the managed venv under globalStorage and install the
 * pinned packages. Idempotent; `recreate` wipes the venv first for repair.
 */
export async function bootstrapManagedEnv(
  options: BootstrapOptions & { recreate?: boolean }
): Promise<{ pythonBin: string; verify: VerifyResult }> {
  const { storageDir, log, proxyUrl, useOwnPynecore, recreate } = options;
  fs.mkdirSync(storageDir, { recursive: true });
  const env = uvEnv(storageDir, proxyUrl);
  const { uvBin } = await ensureUv(storageDir, log, env);

  const venvDir = managedVenvDir(storageDir);
  const pythonBin = venvPythonPath(venvDir);

  if (recreate) {
    log(`Removing existing venv at ${venvDir}`);
    fs.rmSync(venvDir, { recursive: true, force: true });
    fs.rmSync(markerPath(storageDir), { force: true });
  }

  if (!fs.existsSync(pythonBin)) {
    log(`Creating venv with Python ${PYTHON_VERSION}`);
    await execChecked(uvBin, ['venv', '--python', PYTHON_VERSION, venvDir], log, {
      env,
      timeoutMs: 300000,
    });
  }

  const packages: string[] = [`debugpy==${DEBUGPY_VERSION}`];
  let installPynecore = true;
  if (useOwnPynecore) {
    const check = await verifyPython(pythonBin, log);
    if (check.pynecoreVersion) {
      log(`Keeping user-provided pynecore ${check.pynecoreVersion} (pyneide.useOwnPynecore)`);
      installPynecore = false;
    } else {
      log('pyneide.useOwnPynecore is set but pynecore is not importable; installing the pin');
    }
  }
  if (installPynecore) {
    packages.unshift(`pynesys-pynecore[all]==${PYNECORE_VERSION}`);
  }

  log(`Installing: ${packages.join(', ')}`);
  await execChecked(uvBin, ['pip', 'install', '--python', pythonBin, ...packages], log, {
    env,
    timeoutMs: 600000,
  });

  const verify = await verifyPython(pythonBin, log);
  if (verify.ok) {
    fs.writeFileSync(markerPath(storageDir), JSON.stringify(currentMarker(), null, 2));
    log(
      `Environment ready: Python ${verify.pythonVersion}, ` +
        `pynecore ${verify.pynecoreVersion}, debugpy ${verify.debugpyVersion}`
    );
  }
  return { pythonBin, verify };
}
