import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as https from 'node:https';

import type { Logger } from './constants';

const MAX_REDIRECTS = 5;

/**
 * Download a URL to a file using node:https. In the VSCode extension host the
 * http/https modules are proxy-patched (http.proxy / http.proxySupport), so
 * this honours the user's proxy settings without extra work.
 */
export function downloadFile(url: string, dest: string, log: Logger): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = (target: string, redirectsLeft: number): void => {
      https
        .get(target, { headers: { 'User-Agent': 'PyneIDE' } }, (res) => {
          const status = res.statusCode ?? 0;
          if (status >= 300 && status < 400 && res.headers.location) {
            res.resume();
            if (redirectsLeft <= 0) {
              reject(new Error(`Too many redirects while downloading ${url}`));
              return;
            }
            request(new URL(res.headers.location, target).toString(), redirectsLeft - 1);
            return;
          }
          if (status !== 200) {
            res.resume();
            reject(new Error(`Download failed with HTTP ${status}: ${target}`));
            return;
          }
          const file = fs.createWriteStream(dest);
          res.pipe(file);
          file.on('finish', () => file.close(() => resolve()));
          file.on('error', (err) => {
            fs.rmSync(dest, { force: true });
            reject(err);
          });
          res.on('error', (err) => {
            file.destroy();
            fs.rmSync(dest, { force: true });
            reject(err);
          });
        })
        .on('error', reject);
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
