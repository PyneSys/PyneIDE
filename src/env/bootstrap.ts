import * as fs from 'node:fs';
import * as path from 'node:path';

import { throwIfCancelled, type CancelToken } from './cancel';
import {
  DEBUGPY_VERSION,
  ENV_SCHEMA_VERSION,
  PYNECORE_MIN_VERSION,
  PYNECORE_VERSION,
  PYTHON_VERSION,
  type Logger,
} from './constants';
import { execChecked, execProcess } from './exec';
import {
  SetupProgressTracker,
  UvInstallProgress,
  UvVenvProgress,
  type ProgressReporter,
} from './progress';
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
  /** Aborts the current download or child process and throws a CancelledError. */
  cancel?: CancelToken;
  /** Overall progress for the UI; the log stream is not a progress source. */
  progress?: ProgressReporter;
}

const VERIFY_SCRIPT = [
  'import json, os, platform, sys',
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
  'def pyvenv_cfg():',
  '    p = os.path.join(os.path.dirname(os.path.dirname(sys.executable)), "pyvenv.cfg")',
  '    try:',
  '        with open(p, encoding="utf-8") as f:',
  '            return f.read()',
  '    except OSError:',
  '        return None',
  'print(json.dumps({',
  '    "python": platform.python_version(),',
  '    "pynecore": ver("pynesys-pynecore"),',
  '    "debugpy": ver("debugpy"),',
  '    "pynecoreRoot": pynecore_root(),',
  '    "prefix": sys.prefix,',
  '    "basePrefix": sys.base_prefix,',
  '    "executable": sys.executable,',
  '    "path": sys.path,',
  '    "pyvenvCfg": pyvenv_cfg(),',
  '}))',
].join('\n');

interface VerifyInfo {
  python: string;
  pynecore: string | null;
  debugpy: string | null;
  pynecoreRoot: string | null;
  prefix: string;
  basePrefix: string;
  executable: string;
  path: string[];
  pyvenvCfg: string | null;
}

/** Dump interpreter state so a missing-package failure is diagnosable from logs. */
function logInterpreterDiag(info: VerifyInfo, log: Logger): void {
  log(`  sys.executable = ${info.executable}`);
  log(`  sys.prefix = ${info.prefix}`);
  log(`  sys.base_prefix = ${info.basePrefix}`);
  log(`  sys.path = ${JSON.stringify(info.path)}`);
  if (info.pyvenvCfg) {
    for (const line of info.pyvenvCfg.split('\n')) {
      if (line.trim()) log(`  pyvenv.cfg: ${line}`);
    }
  } else {
    log('  pyvenv.cfg: not found next to the interpreter');
  }
}

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
export async function verifyPython(
  pythonBin: string,
  log: Logger,
  cancel?: CancelToken
): Promise<VerifyResult> {
  try {
    const result = await execProcess(pythonBin, ['-X', 'utf8', '-c', VERIFY_SCRIPT], log, {
      timeoutMs: 30000,
      cancel,
    });
    if (result.code !== 0) {
      return { ok: false, error: result.stderr.trim() || `exit code ${result.code}` };
    }
    const info = JSON.parse(result.stdout.trim()) as VerifyInfo;
    const pynecoreRoot = info.pynecoreRoot ?? undefined;
    if (!info.pynecore) {
      logInterpreterDiag(info, log);
      return { ok: false, pythonVersion: info.python, error: 'pynesys-pynecore is not installed' };
    }
    if (!info.debugpy) {
      logInterpreterDiag(info, log);
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
  return runBootstrap(options, new SetupProgressTracker(options.progress));
}

/**
 * The bootstrap body. The tracker is threaded through the recreate-and-retry
 * recursion instead of being created per call, so a second pass continues the
 * bar the user is already watching rather than restarting it.
 */
async function runBootstrap(
  options: BootstrapOptions & { recreate?: boolean },
  tracker: SetupProgressTracker
): Promise<{ pythonBin: string; verify: VerifyResult }> {
  const { storageDir, log, proxyUrl, useOwnPynecore, recreate, cancel } = options;
  fs.mkdirSync(storageDir, { recursive: true });
  const env = uvEnv(storageDir, proxyUrl);
  tracker.begin('uv', 'Preparing the package manager…');
  const { uvBin } = await ensureUv(storageDir, log, env, {
    cancel,
    onProgress: (fraction, message) => tracker.within(fraction, message),
  });
  throwIfCancelled(cancel);

  const venvDir = managedVenvDir(storageDir);
  const pythonBin = venvPythonPath(venvDir);

  // A schema bump means the env layout changed (not just package pins), so the
  // venv itself must be rebuilt, not merely reinstalled into.
  const marker = readMarker(storageDir);
  const staleLayout = marker !== undefined && marker.schema !== ENV_SCHEMA_VERSION;
  if (recreate || staleLayout) {
    log(
      recreate
        ? `Removing existing venv at ${venvDir}`
        : `Env schema changed (${marker?.schema} -> ${ENV_SCHEMA_VERSION}), rebuilding venv at ${venvDir}`
    );
    fs.rmSync(venvDir, { recursive: true, force: true });
    fs.rmSync(markerPath(storageDir), { force: true });
  }

  if (!fs.existsSync(pythonBin)) {
    log(`Creating venv with Python ${PYTHON_VERSION}`);
    tracker.begin('python', `Creating the Python ${PYTHON_VERSION} environment…`);
    const venvProgress = new UvVenvProgress();
    await execChecked(uvBin, ['venv', '--python', PYTHON_VERSION, venvDir], log, {
      env,
      timeoutMs: 300000,
      cancel,
      onLine: (line) => {
        const update = venvProgress.accept(line);
        if (update) tracker.within(update.fraction, update.message);
      },
    });
  }
  throwIfCancelled(cancel);

  const packages: string[] = [`debugpy==${DEBUGPY_VERSION}`];
  let installPynecore = true;
  if (useOwnPynecore) {
    const check = await verifyPython(pythonBin, log, cancel);
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
  tracker.begin('packages', 'Resolving packages…');
  const installProgress = new UvInstallProgress();
  await execChecked(uvBin, ['pip', 'install', '--python', pythonBin, ...packages], log, {
    env,
    timeoutMs: 600000,
    cancel,
    onLine: (line) => {
      const update = installProgress.accept(line);
      if (update) tracker.within(update.fraction, update.message);
    },
  });
  throwIfCancelled(cancel);

  tracker.begin('verify', 'Verifying the environment…');
  const verify = await verifyPython(pythonBin, log, cancel);
  // A cancel surfaces here as a failed verification (verifyPython never
  // throws), and must not be mistaken for a broken install worth rebuilding.
  throwIfCancelled(cancel);
  if (!verify.ok && !recreate) {
    log(`Verification failed (${verify.error}); recreating the environment once`);
    tracker.note('Verification failed — rebuilding the environment…');
    return runBootstrap({ ...options, recreate: true }, tracker);
  }
  if (verify.ok) {
    fs.writeFileSync(markerPath(storageDir), JSON.stringify(currentMarker(), null, 2));
    log(
      `Environment ready: Python ${verify.pythonVersion}, ` +
        `pynecore ${verify.pynecoreVersion}, debugpy ${verify.debugpyVersion}`
    );
    tracker.done(`Environment ready (Python ${verify.pythonVersion})`);
  }
  return { pythonBin, verify };
}
