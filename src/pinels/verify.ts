import * as crypto from 'node:crypto';

import { PINE_LS_PUBLIC_KEY_B64 } from './constants';

/** DER SPKI header for a raw 32-byte Ed25519 public key. */
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/**
 * Verify an Ed25519 signature (base64, as served in the release `.sig`
 * files) over the exact downloaded bytes with the pinned release key.
 */
export function verifyReleaseSignature(data: Buffer, signatureB64: string): boolean {
  const raw = Buffer.from(PINE_LS_PUBLIC_KEY_B64, 'base64');
  if (raw.length !== 32) return false;
  const signature = Buffer.from(signatureB64.trim(), 'base64');
  if (signature.length !== 64) return false;
  const publicKey = crypto.createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, raw]),
    format: 'der',
    type: 'spki',
  });
  return crypto.verify(null, data, publicKey, signature);
}

export function sha256Hex(data: Buffer): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}
