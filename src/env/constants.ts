/**
 * Pinned toolchain versions. Changing any of them already marks existing
 * installs outdated (the env.json marker carries all four), which reinstalls
 * into the venv in place. ENV_SCHEMA_VERSION is for LAYOUT changes only — it
 * wipes the venv, taking installed plugins (and a dev editable pynecore) with it.
 */

export const UV_VERSION = '0.11.28';
export const PYTHON_VERSION = '3.14';
export const PYNECORE_VERSION = '6.10.2';
export const DEBUGPY_VERSION = '1.8.21';

/**
 * Minimum pynecore accepted when the user brings their own install. Kept equal
 * to PYNECORE_VERSION: the bridge contract is unversioned and only the pinned
 * release is ever tested against it, so an own install older than the pin would
 * be an untested pairing. Everything below 6.8.14 is additionally unusable —
 * `pynecore.core.ohlcv` (the self-describing v2 format the runner bridge imports
 * unconditionally) wrote through POSIX-only `os.pread`/`os.pwrite` before it, so
 * any OHLCV write died on Windows.
 */
export const PYNECORE_MIN_VERSION = '6.10.2';

/** Bump when the managed environment LAYOUT changes (forces a venv rebuild). */
export const ENV_SCHEMA_VERSION = 2;

/**
 * Rough total download of a first-time managed setup, shown in the setup
 * prompt. Measured for the pins above (uv release assets + the CPython
 * standalone build uv fetches for 3.14 + the resolved wheel set): macOS arm64
 * ~75 MB, Windows x64 ~72 MB, Linux x64 ~93 MB. Rounded to one number instead
 * of per-platform figures — no API exposes the Python/wheel bytes at prompt
 * time, so this is an estimate that needs re-measuring on pin bumps.
 */
export const SETUP_DOWNLOAD_MB = 80;

export interface UvArtifact {
  name: string;
  sha256: string;
}

/**
 * Release artifacts of astral-sh/uv with pinned SHA-256 checksums
 * (from the .sha256 files next to each release asset).
 */
export const UV_ARTIFACTS: Record<string, UvArtifact> = {
  'darwin-arm64': {
    name: 'uv-aarch64-apple-darwin.tar.gz',
    sha256: '33540eb7c883ab857eff79bd5ac2aa31fe27b595abecb4a9c003a2c998447232',
  },
  'darwin-x64': {
    name: 'uv-x86_64-apple-darwin.tar.gz',
    sha256: '2ad79983127ffca7d77b77ce6a24278d7e4f7b817a1acf72fea5f8124b4aac5e',
  },
  'linux-x64': {
    name: 'uv-x86_64-unknown-linux-gnu.tar.gz',
    sha256: 'e490a6464492183c5d4534a5527fb4440f7f2bb2f228162ad7e4afe076dc0224',
  },
  'linux-arm64': {
    name: 'uv-aarch64-unknown-linux-gnu.tar.gz',
    sha256: '03e9fe0a81b0718d0bc84625de3885df6cc3f89a8b6af6121d6b9f6113fb6533',
  },
  'win32-x64': {
    name: 'uv-x86_64-pc-windows-msvc.zip',
    sha256: '0a23463216d09c6a72ff80ef5dc5a795f07dc1575cb84d24596c2f124a441b7b',
  },
  'win32-arm64': {
    name: 'uv-aarch64-pc-windows-msvc.zip',
    sha256: '3248109afad3ec59baad299d324ff53de17e2d9a3b3e21580ffd26744b11e036',
  },
};

export function uvDownloadUrl(artifact: UvArtifact): string {
  return `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/${artifact.name}`;
}

export type Logger = (message: string) => void;
