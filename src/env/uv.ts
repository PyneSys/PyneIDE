import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { UV_ARTIFACTS, UV_VERSION, uvDownloadUrl, type Logger } from './constants';
import { downloadFile, verifySha256 } from './download';
import { execChecked } from './exec';

export interface UvPaths {
  /** Absolute path of the uv executable. */
  uvBin: string;
}

function platformKey(): string {
  return `${process.platform}-${process.arch}`;
}

function uvBinName(): string {
  return process.platform === 'win32' ? 'uv.exe' : 'uv';
}

function findFile(root: string, name: string): string | undefined {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isFile() && entry.name === name) return full;
    if (entry.isDirectory()) {
      const nested = findFile(full, name);
      if (nested) return nested;
    }
  }
  return undefined;
}

/**
 * Ensure a pinned-version uv binary exists under `storageDir/uv` and return
 * its path. Downloads and checksum-verifies the release artifact when the
 * binary is missing or has the wrong version.
 */
export async function ensureUv(
  storageDir: string,
  log: Logger,
  env?: NodeJS.ProcessEnv
): Promise<UvPaths> {
  const uvDir = path.join(storageDir, 'uv');
  const uvBin = path.join(uvDir, uvBinName());

  if (fs.existsSync(uvBin)) {
    try {
      const result = await execChecked(uvBin, ['--version'], log, { env, timeoutMs: 15000 });
      if (result.stdout.includes(` ${UV_VERSION}`) || result.stdout.trim().endsWith(UV_VERSION)) {
        return { uvBin };
      }
      log(`uv version mismatch (${result.stdout.trim()}), reinstalling ${UV_VERSION}`);
    } catch (err) {
      log(`Existing uv binary is broken (${String(err)}), reinstalling`);
    }
  }

  const artifact = UV_ARTIFACTS[platformKey()];
  if (!artifact) {
    throw new Error(
      `Unsupported platform: ${platformKey()}. ` +
        'Set "pyneide.pythonPath" or "pyneide.venvPath" to use your own Python environment.'
    );
  }

  fs.rmSync(uvDir, { recursive: true, force: true });
  fs.mkdirSync(uvDir, { recursive: true });

  const archivePath = path.join(uvDir, artifact.name);
  await downloadFile(uvDownloadUrl(artifact), archivePath, log);
  await verifySha256(archivePath, artifact.sha256);
  log(`Checksum OK: ${artifact.sha256}`);

  // tar.gz on macOS/Linux; on Windows 10+ the bundled bsdtar extracts zip too.
  const extractDir = path.join(uvDir, 'extract');
  fs.mkdirSync(extractDir, { recursive: true });
  await execChecked('tar', ['-xf', archivePath, '-C', extractDir], log, { timeoutMs: 60000 });

  const extractedBin = findFile(extractDir, uvBinName());
  if (!extractedBin) {
    throw new Error(`uv binary not found in extracted archive ${artifact.name}`);
  }
  fs.renameSync(extractedBin, uvBin);
  if (process.platform !== 'win32') {
    fs.chmodSync(uvBin, 0o755);
  }
  fs.rmSync(extractDir, { recursive: true, force: true });
  fs.rmSync(archivePath, { force: true });

  await execChecked(uvBin, ['--version'], log, { env, timeoutMs: 15000 });
  log(`uv ${UV_VERSION} installed at ${uvBin}`);
  return { uvBin };
}

/** Environment for uv child processes: self-contained python + optional proxy. */
export function uvEnv(storageDir: string, proxyUrl?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    UV_PYTHON_INSTALL_DIR: path.join(storageDir, 'python'),
    // Without this uv prefers a system interpreter (e.g. Homebrew framework
    // Python) over its own standalone build, so the env depends on whatever
    // Python the machine happens to have.
    UV_MANAGED_PYTHON: '1',
    // uv's default clone (APFS reflink) link mode has produced venvs with
    // missing site-packages on macOS (astral-sh/uv#15084).
    UV_LINK_MODE: 'copy',
    UV_NO_MODIFY_PATH: '1',
  };
  if (proxyUrl) {
    env.HTTP_PROXY = proxyUrl;
    env.HTTPS_PROXY = proxyUrl;
  }
  return env;
}

export function venvPythonPath(venvDir: string): string {
  return process.platform === 'win32'
    ? path.join(venvDir, 'Scripts', 'python.exe')
    : path.join(venvDir, 'bin', 'python');
}

/** The pyne console script installed next to a Python interpreter. */
export function pyneBinPath(pythonBin: string): string {
  return path.join(
    path.dirname(pythonBin),
    process.platform === 'win32' ? 'pyne.exe' : 'pyne'
  );
}

/** Default location of the managed venv. */
export function managedVenvDir(storageDir: string): string {
  return path.join(storageDir, 'venv');
}

export function defaultStorageTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pyneide-env-'));
}
