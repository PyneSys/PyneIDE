/**
 * Plugins smoke test — verifies the pure, VSCode-free logic behind the plugin
 * manager: the `pyne plugin list --json` parser, PEP 503 package normalization,
 * the PyneCore-floor gate and the conditional index fetch.
 *
 * Usage: node dist/plugins-smoke.js
 * Needs no VSCode runtime and no Python: the CLI output is a fixture and the
 * catalogue requests run against a throwaway local HTTP server.
 *
 * Assertions:
 *   (a) parsePluginListJson finds the payload after CLI noise, maps
 *       display_name -> displayName and drops the "library" pseudo-capability;
 *   (b) malformed output raises instead of silently reporting "nothing installed";
 *   (c) normalizePackageName collapses PEP 503 spellings to one key;
 *   (d) satisfiesMinPynecore blocks an older PyneCore and passes unknown values;
 *   (e) fetchPluginIndex parses the snapshot and returns the ETag;
 *   (f) a known ETag is sent as If-None-Match and a 304 comes back as
 *       `not-modified` (so the caller keeps its cached copy);
 *   (g) fetchPluginDetail maps 404 to a readable error.
 */
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  fetchPluginDetail,
  fetchPluginIndex,
  normalizePackageName,
  satisfiesMinPynecore,
} from '../../src/plugins/catalog';
import { parsePluginListJson } from '../../src/plugins/installed';

let failed = false;

function check(label: string, ok: boolean, detail?: string): void {
  if (ok) {
    console.log(`  ✓ ${label}`);
  } else {
    failed = true;
    console.log(`  ✗ ${label}${detail ? ` -> ${detail}` : ''}`);
  }
}

const ETAG = '"abc123"';
const SNAPSHOT = {
  schema_version: 1,
  generated_at: '2026-07-25T15:00:00Z',
  count: 1,
  plugins: [
    {
      package: 'pynesys-pynecore-bybit',
      version: '0.9.1',
      summary: 'Bybit v5 integration for PyneCore',
      tier: 'official',
      status: 'active',
      plugin_ids: ['bybit'],
      requires_pynecore: '>=6.6.0',
      min_pynecore: '6.6.0',
      capabilities: ['broker', 'live_provider', 'provider'],
      downloads_30d: 157,
      updated_at: '2026-07-24T21:47:36Z',
    },
  ],
};

/** A stand-in for the index endpoints, including conditional-request handling. */
function startServer(): Promise<{ baseUrl: string; close: () => void; conditional: string[] }> {
  const conditional: string[] = [];
  const server = http.createServer((req, res) => {
    if (req.url === '/plugins/index.json') {
      const ifNoneMatch = req.headers['if-none-match'];
      if (typeof ifNoneMatch === 'string') conditional.push(ifNoneMatch);
      if (ifNoneMatch === ETAG) {
        res.writeHead(304, { etag: ETAG });
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json', etag: ETAG });
      res.end(JSON.stringify(SNAPSHOT));
      return;
    }
    if (req.url === '/plugins/pynesys-pynecore-bybit') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ...SNAPSHOT.plugins[0], entry_points: [], project_urls: [] }));
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        close: () => server.close(),
        conditional,
      });
    });
  });
}

const CLI_OUTPUT = `Failed to load CLI plugin 'tradingview':
{"plugins": [{"name": "bybit", "display_name": "Bybit", "version": "0.9.1", "capabilities": ["provider", "broker"], "summary": "Bybit v5 plugin.", "package": "pynesys-pynecore-bybit", "conflict": false}, {"name": "replay", "display_name": "replay", "version": "6.6.0", "capabilities": ["library"], "summary": "", "package": "pynesys-pynecore", "conflict": false}], "errors": [{"name": "tradingview", "error": "boom"}]}`;

async function main(): Promise<void> {
  console.log('Plugins smoke test');

  const parsed = parsePluginListJson(CLI_OUTPUT);
  const bybit = parsed.plugins.find((p) => p.name === 'bybit');
  const replay = parsed.plugins.find((p) => p.name === 'replay');
  check(
    '(a) payload parsed past the CLI noise, display_name mapped',
    bybit?.displayName === 'Bybit' && bybit?.package === 'pynesys-pynecore-bybit',
    JSON.stringify(bybit)
  );
  check(
    '(a) the "library" pseudo-capability is dropped',
    replay?.capabilities.length === 0,
    JSON.stringify(replay?.capabilities)
  );
  check('(a) load failures are surfaced', parsed.errors.length === 1, JSON.stringify(parsed.errors));

  let threw = false;
  try {
    parsePluginListJson('no json here');
  } catch {
    threw = true;
  }
  check('(b) output without JSON raises', threw);

  check(
    '(c) PEP 503 spellings normalize to one key',
    normalizePackageName('PyneSys_PyneCore-Bybit') === 'pynesys-pynecore-bybit' &&
      normalizePackageName('pynesys.pynecore.bybit') === 'pynesys-pynecore-bybit'
  );

  check('(d) older PyneCore is blocked', !satisfiesMinPynecore('6.6.0', '6.5.7'));
  check('(d) equal version passes', satisfiesMinPynecore('6.6.0', '6.6.0'));
  check('(d) newer version passes', satisfiesMinPynecore('6.6.0', '6.7.1'));
  check(
    '(d) unknown values pass (never invent a block)',
    satisfiesMinPynecore(undefined, '6.5.7') && satisfiesMinPynecore('6.6.0', undefined)
  );

  const server = await startServer();
  try {
    const first = await fetchPluginIndex(server.baseUrl);
    check(
      '(e) snapshot parsed with its ETag',
      first.kind === 'ok' &&
        first.etag === ETAG &&
        first.snapshot.plugins[0]?.package === 'pynesys-pynecore-bybit',
      JSON.stringify(first)
    );

    const second = await fetchPluginIndex(server.baseUrl, ETAG);
    check('(f) a known ETag comes back as not-modified', second.kind === 'not-modified');
    check(
      '(f) the ETag was sent as If-None-Match',
      server.conditional.includes(ETAG),
      JSON.stringify(server.conditional)
    );

    const detail = await fetchPluginDetail(server.baseUrl, 'pynesys-pynecore-bybit');
    check('(g) detail lookup returns the package', detail.package === 'pynesys-pynecore-bybit');

    let notFound = '';
    try {
      await fetchPluginDetail(server.baseUrl, 'pynesys-pynecore-nope');
    } catch (err) {
      notFound = err instanceof Error ? err.message : String(err);
    }
    check('(g) 404 becomes a readable error', notFound.includes('not in the plugin index'), notFound);
  } finally {
    server.close();
  }

  if (failed) {
    console.log('PLUGINS SMOKE FAILED');
    process.exit(1);
  }
  console.log('PLUGINS SMOKE OK');
}

void main();
