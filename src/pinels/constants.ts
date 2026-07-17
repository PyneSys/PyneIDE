/**
 * Pine language server release channel. The base URL is only a transport
 * default: every downloaded index/manifest must verify against the pinned
 * Ed25519 public key, so pointing elsewhere cannot inject binaries.
 */

export const PINE_LS_BASE_URL = 'https://pine-ls.pynesys.io';

/** Pinned Ed25519 release key (raw 32-byte public key, base64). */
export const PINE_LS_KEY_ID = '2bc1c151cbd468aa';
export const PINE_LS_PUBLIC_KEY_B64 = '1TbND3TJpCAwkItU/bmhIuZmr3btx3D/rzhTPddB6Gs=';

/** LSP wire contract this client speaks; releases with another pin are skipped. */
export const PINE_LS_PROTOCOL_VERSION = 1;
export const PINE_LANGUAGE_MAJOR = 6;

/** schemaVersion of the release site index/manifest documents. */
export const RELEASE_SCHEMA_VERSION = 1;

/** Bump when the local install layout or gates change (forces reinstall). */
export const INSTALL_SCHEMA_VERSION = 1;

/** Targets the release pipeline builds; anything else has no Pine LS. */
export const SUPPORTED_TARGETS = [
  'darwin-arm64',
  'darwin-x64',
  'linux-arm64',
  'linux-x64',
  'win32-x64',
] as const;

export interface ReleaseIndexEntry {
  manifestPath: string;
  manifestSha256: string;
  signaturePath: string;
  sourceCommit: string;
  version: string;
}

export interface ReleaseIndex {
  keyId: string;
  releases: ReleaseIndexEntry[];
  schemaVersion: number;
}

export interface ManifestArtifact {
  archive: string;
  executable: string;
  minimumSystem: string;
  sha256: string;
  size: number;
  url: string;
  noticesUrl: string;
  noticesSha256: string;
  noticesSize: number;
}

export interface ReleaseManifest {
  artifacts: Record<string, ManifestArtifact>;
  frontend: string;
  keyId: string;
  pineLanguageMajor: number;
  protocol: number;
  python: string;
  schemaVersion: number;
  sourceCommit: string;
  version: string;
}

/** Output of `pynesys-pine-ls --version`. */
export interface PineLsVersionInfo {
  frontendVersion: string;
  pineLanguageMajor: number;
  pineLsVersion: string;
  protocolVersion: number;
  python: string;
}
