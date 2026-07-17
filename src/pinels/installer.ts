import * as fs from 'node:fs';
import * as path from 'node:path';

import type { Logger } from '../env/constants';
import { downloadFile, sha256File } from '../env/download';
import { execChecked } from '../env/exec';
import {
  INSTALL_SCHEMA_VERSION,
  PINE_LANGUAGE_MAJOR,
  PINE_LS_KEY_ID,
  PINE_LS_PROTOCOL_VERSION,
  RELEASE_SCHEMA_VERSION,
  SUPPORTED_TARGETS,
  type ManifestArtifact,
  type PineLsVersionInfo,
  type ReleaseIndex,
  type ReleaseManifest,
} from './constants';
import { fetchBytes } from './net';
import { sha256Hex, verifyReleaseSignature } from './verify';

/** Local install marker: which verified release is live, and the rollback target. */
export interface InstallMarker {
  schema: number;
  version: string;
  executable: string;
  sha256: string;
  previousVersion?: string;
  previousExecutable?: string;
}

export interface InstalledPineLs {
  version: string;
  executablePath: string;
  marker: InstallMarker;
}

export type InstallOutcome =
  | { status: 'installed'; installed: InstalledPineLs }
  | { status: 'updated'; installed: InstalledPineLs; fromVersion: string }
  | { status: 'up-to-date'; installed: InstalledPineLs };

export function pineLsRoot(storageDir: string): string {
  return path.join(storageDir, 'pine-ls');
}

function versionsDir(storageDir: string): string {
  return path.join(pineLsRoot(storageDir), 'versions');
}

function versionDir(storageDir: string, version: string): string {
  return path.join(versionsDir(storageDir), version);
}

function markerPath(storageDir: string): string {
  return path.join(pineLsRoot(storageDir), 'installed.json');
}

export function targetKey(): string {
  return `${process.platform}-${process.arch}`;
}

export function isSupportedTarget(): boolean {
  return (SUPPORTED_TARGETS as readonly string[]).includes(targetKey());
}

/**
 * Read the local install state. Purely local — this is what makes offline
 * startup work: no network is touched to resolve an already installed LS.
 */
export function readInstalled(storageDir: string): InstalledPineLs | undefined {
  let marker: InstallMarker;
  try {
    marker = JSON.parse(fs.readFileSync(markerPath(storageDir), 'utf8')) as InstallMarker;
  } catch {
    return undefined;
  }
  if (marker.schema !== INSTALL_SCHEMA_VERSION || !marker.version || !marker.executable) {
    return undefined;
  }
  const executablePath = path.join(versionDir(storageDir, marker.version), marker.executable);
  if (!fs.existsSync(executablePath)) return undefined;
  return { version: marker.version, executablePath, marker };
}

/** A rollback target exists when the previous version directory survived. */
export function rollbackTarget(storageDir: string): InstalledPineLs | undefined {
  const installed = readInstalled(storageDir);
  const prev = installed?.marker.previousVersion;
  const prevExe = installed?.marker.previousExecutable;
  if (!installed || !prev || !prevExe) return undefined;
  const executablePath = path.join(versionDir(storageDir, prev), prevExe);
  if (!fs.existsSync(executablePath)) return undefined;
  return { version: prev, executablePath, marker: installed.marker };
}

/**
 * Compare release versions: dotted numerics, an optional `-suffix` sorts
 * below the plain release with the same numbers (6.0.44 > 0.0.0-m5).
 */
export function compareReleaseVersions(a: string, b: string): number {
  const [na, sa = ''] = splitVersion(a);
  const [nb, sb = ''] = splitVersion(b);
  for (let i = 0; i < Math.max(na.length, nb.length); i++) {
    const diff = (na[i] ?? 0) - (nb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  if (sa === sb) return 0;
  if (sa === '') return 1;
  if (sb === '') return -1;
  return sa < sb ? -1 : 1;
}

function splitVersion(version: string): [number[], string | undefined] {
  const dash = version.indexOf('-');
  const numbers = (dash >= 0 ? version.slice(0, dash) : version)
    .split('.')
    .map((p) => parseInt(p, 10) || 0);
  return [numbers, dash >= 0 ? version.slice(dash + 1) : undefined];
}

async function fetchVerified(url: string, signatureUrl: string): Promise<Buffer> {
  const [data, signature] = await Promise.all([fetchBytes(url), fetchBytes(signatureUrl)]);
  if (!verifyReleaseSignature(data, signature.toString('utf8'))) {
    throw new Error(`Release signature verification failed for ${url}`);
  }
  return data;
}

export interface ResolvedRelease {
  manifest: ReleaseManifest;
  artifact: ManifestArtifact;
}

/**
 * Resolve the newest release compatible with this client: signed index,
 * signed + hash-pinned manifest, matching protocol/language pins, and an
 * artifact for the current target. Incompatible releases are skipped so a
 * future protocol bump does not brick older IDE versions.
 */
export async function resolveLatest(baseUrl: string, log: Logger): Promise<ResolvedRelease> {
  const base = baseUrl.replace(/\/+$/, '');
  const indexBytes = await fetchVerified(
    `${base}/releases/index.json`,
    `${base}/releases/index.json.sig`
  );
  const index = JSON.parse(indexBytes.toString('utf8')) as ReleaseIndex;
  if (index.schemaVersion !== RELEASE_SCHEMA_VERSION || index.keyId !== PINE_LS_KEY_ID) {
    throw new Error(
      `Unexpected release index (schema ${index.schemaVersion}, key ${index.keyId})`
    );
  }
  const target = targetKey();
  const candidates = [...index.releases].sort((a, b) =>
    compareReleaseVersions(b.version, a.version)
  );
  for (const entry of candidates) {
    const manifestBytes = await fetchVerified(
      `${base}/${entry.manifestPath}`,
      `${base}/${entry.signaturePath}`
    );
    if (sha256Hex(manifestBytes) !== entry.manifestSha256) {
      throw new Error(`Manifest hash mismatch for release ${entry.version}`);
    }
    const manifest = JSON.parse(manifestBytes.toString('utf8')) as ReleaseManifest;
    if (
      manifest.schemaVersion !== RELEASE_SCHEMA_VERSION ||
      manifest.keyId !== PINE_LS_KEY_ID ||
      manifest.version !== entry.version
    ) {
      throw new Error(`Inconsistent manifest for release ${entry.version}`);
    }
    if (
      manifest.protocol !== PINE_LS_PROTOCOL_VERSION ||
      manifest.pineLanguageMajor !== PINE_LANGUAGE_MAJOR
    ) {
      log(
        `Skipping Pine LS ${entry.version}: protocol ${manifest.protocol}/` +
          `v${manifest.pineLanguageMajor} does not match this client`
      );
      continue;
    }
    const artifact = manifest.artifacts[target];
    if (!artifact) {
      log(`Skipping Pine LS ${entry.version}: no artifact for ${target}`);
      continue;
    }
    return { manifest, artifact };
  }
  throw new Error(`No compatible Pine LS release found for ${target}`);
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

/** Gate a freshly extracted binary before it can become the live install. */
async function verifyBinary(
  executablePath: string,
  expectedVersion: string,
  log: Logger
): Promise<void> {
  const version = await execChecked(executablePath, ['--version'], log, { timeoutMs: 30000 });
  const info = JSON.parse(version.stdout.trim()) as PineLsVersionInfo;
  if (info.pineLsVersion !== expectedVersion || info.protocolVersion !== PINE_LS_PROTOCOL_VERSION) {
    throw new Error(
      `Downloaded Pine LS reports ${info.pineLsVersion} (protocol ${info.protocolVersion}), ` +
        `expected ${expectedVersion} (protocol ${PINE_LS_PROTOCOL_VERSION})`
    );
  }
  const selfCheck = await execChecked(executablePath, ['--self-check'], log, { timeoutMs: 60000 });
  const result = JSON.parse(selfCheck.stdout.trim()) as { ok?: boolean };
  if (result.ok !== true) {
    throw new Error(`Pine LS self-check failed: ${selfCheck.stdout.trim()}`);
  }
}

function writeMarker(storageDir: string, marker: InstallMarker): void {
  const tmp = `${markerPath(storageDir)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(marker, null, 2));
  fs.renameSync(tmp, markerPath(storageDir));
}

/** Remove version directories that are neither live nor the rollback target. */
function pruneVersions(storageDir: string, keep: (string | undefined)[]): void {
  const dir = versionsDir(storageDir);
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir)) {
    if (!keep.includes(entry)) {
      fs.rmSync(path.join(dir, entry), { recursive: true, force: true });
    }
  }
}

/**
 * Install (or update to) the newest compatible release. The live install is
 * replaced only after the new binary passed checksum, signature-chain,
 * `--version` and `--self-check` gates; the previous version directory is
 * kept as the rollback target. A failure at any point leaves the current
 * install untouched.
 */
export async function installPineLs(
  storageDir: string,
  baseUrl: string,
  log: Logger,
  options: { force?: boolean } = {}
): Promise<InstallOutcome> {
  if (!isSupportedTarget()) {
    throw new Error(`The Pine language server has no build for ${targetKey()}.`);
  }
  const { manifest, artifact } = await resolveLatest(baseUrl, log);
  const installed = readInstalled(storageDir);
  if (!options.force && installed && installed.version === manifest.version) {
    log(`Pine LS ${installed.version} is up to date`);
    return { status: 'up-to-date', installed };
  }

  const root = pineLsRoot(storageDir);
  const stagingDir = path.join(root, `staging-${process.pid}-${Date.now()}`);
  fs.rmSync(stagingDir, { recursive: true, force: true });
  fs.mkdirSync(stagingDir, { recursive: true });
  try {
    const archivePath = path.join(stagingDir, path.basename(new URL(artifact.url).pathname));
    await downloadFile(artifact.url, archivePath, log);
    const size = fs.statSync(archivePath).size;
    if (size !== artifact.size) {
      throw new Error(`Size mismatch for ${artifact.url}: expected ${artifact.size}, got ${size}`);
    }
    const digest = await sha256File(archivePath);
    if (digest !== artifact.sha256.toLowerCase()) {
      throw new Error(`Checksum mismatch for ${artifact.url}: got ${digest}`);
    }
    log(`Checksum OK: ${artifact.sha256}`);

    // tar.gz on macOS/Linux; the zip artifact only exists for win32 targets,
    // where Windows 10+ bsdtar extracts zip too (same approach as env/uv.ts).
    const extractDir = path.join(stagingDir, 'extract');
    fs.mkdirSync(extractDir);
    await execChecked('tar', ['-xf', archivePath, '-C', extractDir], log, { timeoutMs: 120000 });
    const executable = findFile(extractDir, artifact.executable);
    if (!executable) {
      throw new Error(`${artifact.executable} not found in the extracted archive`);
    }
    if (process.platform !== 'win32') {
      fs.chmodSync(executable, 0o755);
    }
    await verifyBinary(executable, manifest.version, log);

    // Atomic swap: move the verified payload in place, then repoint the
    // marker (tmp file + rename). Failures before the rename leave the old
    // marker — and with it the old, still intact version — live.
    const payloadRoot = path.dirname(executable);
    const target = versionDir(storageDir, manifest.version);
    fs.rmSync(target, { recursive: true, force: true });
    fs.mkdirSync(versionsDir(storageDir), { recursive: true });
    fs.renameSync(payloadRoot, target);
    const marker: InstallMarker = {
      schema: INSTALL_SCHEMA_VERSION,
      version: manifest.version,
      executable: artifact.executable,
      sha256: artifact.sha256,
      ...(installed && installed.version !== manifest.version
        ? {
            previousVersion: installed.version,
            previousExecutable: installed.marker.executable,
          }
        : {}),
    };
    writeMarker(storageDir, marker);
    pruneVersions(storageDir, [marker.version, marker.previousVersion]);

    const result = readInstalled(storageDir);
    if (!result) {
      throw new Error('Install marker verification failed after swap');
    }
    log(`Pine LS ${manifest.version} installed at ${result.executablePath}`);
    return installed
      ? { status: 'updated', installed: result, fromVersion: installed.version }
      : { status: 'installed', installed: result };
  } finally {
    fs.rmSync(stagingDir, { recursive: true, force: true });
  }
}

/**
 * Revert to the previous version after a bad update. The reverted binary is
 * self-checked before the marker is repointed.
 */
export async function rollbackPineLs(storageDir: string, log: Logger): Promise<InstalledPineLs> {
  const installed = readInstalled(storageDir);
  const target = rollbackTarget(storageDir);
  if (!installed || !target) {
    throw new Error('No previous Pine LS version is available to roll back to.');
  }
  const selfCheck = await execChecked(target.executablePath, ['--self-check'], log, {
    timeoutMs: 60000,
  });
  const result = JSON.parse(selfCheck.stdout.trim()) as { ok?: boolean };
  if (result.ok !== true) {
    throw new Error(`Rollback target failed its self-check: ${selfCheck.stdout.trim()}`);
  }
  const marker: InstallMarker = {
    schema: INSTALL_SCHEMA_VERSION,
    version: target.version,
    executable: installed.marker.previousExecutable ?? installed.marker.executable,
    sha256: '',
    previousVersion: undefined,
    previousExecutable: undefined,
  };
  writeMarker(storageDir, marker);
  pruneVersions(storageDir, [marker.version]);
  const reverted = readInstalled(storageDir);
  if (!reverted) {
    throw new Error('Rollback failed: reverted install is not readable');
  }
  log(`Rolled back to Pine LS ${reverted.version}`);
  return reverted;
}
