import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as https from 'node:https';

import type { Logger } from './constants';

const MAX_REDIRECTS = 5;

/**
 * Socket inactivity timeout. A connection that never completes, or a server
 * that accepts the socket and then goes silent, produces no 'error' and no
 * 'end' event at all, so without this the promise would never settle and a
 * stuck setup would hang forever instead of failing.
 */
export const DOWNLOAD_IDLE_TIMEOUT_MS = 60_000;

/**
 * Download a URL to a file using node:https. In the VSCode extension host the
 * http/https modules are proxy-patched (http.proxy / http.proxySupport), so
 * this honours the user's proxy settings without extra work.
 */
export function downloadFile(url: string, dest: string, log: Logger): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let file: fs.WriteStream | undefined;

    const succeed = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      resolve();
    };
    const fail = (err: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      file?.destroy();
      fs.rmSync(dest, { force: true });
      reject(err);
    };

    const request = (target: string, redirectsLeft: number): void => {
      const req = https.get(
        target,
        { headers: { 'User-Agent': 'PyneIDE' }, timeout: DOWNLOAD_IDLE_TIMEOUT_MS },
        (res) => {
          const status = res.statusCode ?? 0;
          if (status >= 300 && status < 400 && res.headers.location) {
            res.resume();
            if (redirectsLeft <= 0) {
              fail(new Error(`Too many redirects while downloading ${url}`));
              return;
            }
            request(new URL(res.headers.location, target).toString(), redirectsLeft - 1);
            return;
          }
          if (status !== 200) {
            res.resume();
            fail(new Error(`Download failed with HTTP ${status}: ${target}`));
            return;
          }
          file = fs.createWriteStream(dest);
          res.pipe(file);
          file.on('finish', () => file?.close(() => succeed()));
          file.on('error', fail);
          res.on('error', fail);
        }
      );
      req.on('timeout', () => {
        req.destroy();
        fail(
          new Error(
            `Download timed out: no data for ${Math.round(DOWNLOAD_IDLE_TIMEOUT_MS / 1000)}s ` +
              `from ${target}`
          )
        );
      });
      req.on('error', fail);
    };
    log(`Downloading ${url}`);
    request(url, MAX_REDIRECTS);
  });
}

export async function sha256File(path: string): Promise<string> {
  const hash = crypto.createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    const stream = fs.createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve());
    stream.on('error', reject);
  });
  return hash.digest('hex');
}

export async function verifySha256(path: string, expected: string): Promise<void> {
  const actual = await sha256File(path);
  if (actual !== expected.toLowerCase()) {
    fs.rmSync(path, { force: true });
    throw new Error(
      `Checksum mismatch for ${path}: expected ${expected}, got ${actual}. ` +
        'The download was discarded.'
    );
  }
}
