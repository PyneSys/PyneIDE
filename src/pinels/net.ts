import * as https from 'node:https';

const MAX_REDIRECTS = 5;

/** Release metadata documents are tiny; anything bigger is not ours. */
const MAX_DOCUMENT_BYTES = 4 * 1024 * 1024;

/**
 * Fetch a small release document (index/manifest/signature) into memory.
 * HTTPS only; honours VSCode's proxy patching like env/download.ts does.
 */
export function fetchBytes(url: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const request = (target: string, redirectsLeft: number): void => {
      if (!target.startsWith('https://')) {
        reject(new Error(`Refusing non-HTTPS release URL: ${target}`));
        return;
      }
      https
        .get(target, { headers: { 'User-Agent': 'PyneIDE' } }, (res) => {
          const status = res.statusCode ?? 0;
          if (status >= 300 && status < 400 && res.headers.location) {
            res.resume();
            if (redirectsLeft <= 0) {
              reject(new Error(`Too many redirects while fetching ${url}`));
              return;
            }
            request(new URL(res.headers.location, target).toString(), redirectsLeft - 1);
            return;
          }
          if (status !== 200) {
            res.resume();
            reject(new Error(`Fetch failed with HTTP ${status}: ${target}`));
            return;
          }
          const chunks: Buffer[] = [];
          let total = 0;
          res.on('data', (chunk: Buffer) => {
            total += chunk.length;
            if (total > MAX_DOCUMENT_BYTES) {
              res.destroy(new Error(`Release document too large: ${target}`));
              return;
            }
            chunks.push(chunk);
          });
          res.on('end', () => resolve(Buffer.concat(chunks)));
          res.on('error', reject);
        })
        .on('error', reject);
    };
    request(url, MAX_REDIRECTS);
  });
}
