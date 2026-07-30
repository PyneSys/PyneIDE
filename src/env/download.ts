import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import type * as http from 'node:http';
import * as https from 'node:https';

import { CancelledError, type CancelToken } from './cancel';
import type { Logger } from './constants';

const MAX_REDIRECTS = 5;

/**
 * Socket inactivity timeout. A connection that never completes, or a server
 * that accepts the socket and then goes silent, produces no 'error' and no
 * 'end' event at all, so without this the promise would never settle and a
 * stuck setup would hang forever instead of failing.
 */
export const DOWNLOAD_IDLE_TIMEOUT_MS = 60_000;

/** Minimum gap between byte-progress callbacks — a fast link fires per packet. */
const PROGRESS_INTERVAL_MS = 150;

export interface DownloadOptions {
  /** Destroys the request and removes the partial file. */
  cancel?: CancelToken;
  /** Byte progress; `total` is undefined when the response has no content-length. */
  onProgress?: (received: number, total?: number) => void;
}

/**
 * Download a URL to a file using node:https. In the VSCode extension host the
 * http/https modules are proxy-patched (http.proxy / http.proxySupport), so
 * this honours the user's proxy settings without extra work.
 */
export function downloadFile(
  url: string,
  dest: string,
  log: Logger,
  options: DownloadOptions = {}
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let file: fs.WriteStream | undefined;
    let activeRequest: http.ClientRequest | undefined;
    let cancelSub: { dispose(): void } | undefined;

    const succeed = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      cancelSub?.dispose();
      resolve();
    };
    const fail = (err: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      cancelSub?.dispose();
      activeRequest?.destroy();
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
          const declared = parseInt(res.headers['content-length'] ?? '', 10);
          const total = Number.isFinite(declared) ? declared : undefined;
          let received = 0;
          let lastReport = 0;
          if (options.onProgress) {
            res.on('data', (chunk: Buffer) => {
              received += chunk.length;
              const now = Date.now();
              if (now - lastReport >= PROGRESS_INTERVAL_MS) {
                lastReport = now;
                options.onProgress?.(received, total);
              }
            });
          }
          file = fs.createWriteStream(dest);
          res.pipe(file);
          file.on('finish', () =>
            file?.close(() => {
              options.onProgress?.(received, total);
              succeed();
            })
          );
          file.on('error', fail);
          res.on('error', fail);
        }
      );
      activeRequest = req;
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

    if (options.cancel?.isCancellationRequested) {
      fail(new CancelledError(`Cancelled before downloading ${url}`));
      return;
    }
    cancelSub = options.cancel?.onCancellationRequested(() => {
      fail(new CancelledError(`Cancelled while downloading ${url}`));
    });
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
