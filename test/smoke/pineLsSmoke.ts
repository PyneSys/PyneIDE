/**
 * Pine language server install + LSP smoke test — runs WITHOUT VSCode,
 * against the LIVE release site with the released artifacts.
 * Usage: node dist/pinels-smoke.js [storageDir]
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { PINE_LS_BASE_URL } from '../../src/pinels/constants';
import {
  compareReleaseVersions,
  installPineLs,
  readInstalled,
  rollbackPineLs,
  rollbackTarget,
} from '../../src/pinels/installer';
import { fetchBytes } from '../../src/pinels/net';
import { verifyReleaseSignature } from '../../src/pinels/verify';
import { LspStdio } from './lspStdio';

const log = (msg: string): void => console.log(msg);

function versionCompareUnitTests(): void {
  const cases: [string, string, number][] = [
    ['6.0.44', '6.0.44', 0],
    ['6.0.44', '0.0.0-m5', 1],
    ['6.0.44', '6.0.45', -1],
    ['6.1.0', '6.0.99', 1],
    ['6.0.44', '6.0.44-rc1', 1],
    ['6.0.44-m5', '6.0.44-m6', -1],
  ];
  for (const [a, b, want] of cases) {
    const got = Math.sign(compareReleaseVersions(a, b));
    if (got !== want) throw new Error(`compare(${a}, ${b}): got ${got}, want ${want}`);
  }
  log('Version compare unit tests OK');
}

async function signatureTamperTest(): Promise<void> {
  const url = `${PINE_LS_BASE_URL}/releases/index.json`;
  const [data, sig] = await Promise.all([fetchBytes(url), fetchBytes(`${url}.sig`)]);
  if (!verifyReleaseSignature(data, sig.toString('utf8'))) {
    throw new Error('signature: genuine index.json did not verify');
  }
  const tampered = Buffer.concat([data, Buffer.from(' ')]);
  if (verifyReleaseSignature(tampered, sig.toString('utf8'))) {
    throw new Error('signature: tampered index.json verified');
  }
  const flipped = Buffer.from(data);
  flipped[0] ^= 0x01;
  if (verifyReleaseSignature(flipped, sig.toString('utf8'))) {
    throw new Error('signature: bit-flipped index.json verified');
  }
  log('Signature verification + tamper rejection OK');
}

/** Full editor-shaped round-trip against the released native binary. */
async function lspRoundTrip(executable: string): Promise<void> {
  const lsp = new LspStdio(executable);
  const init = (await lsp.request('initialize', {
    processId: process.pid,
    rootUri: null,
    capabilities: {},
  })) as { capabilities?: { textDocumentSync?: unknown; completionProvider?: unknown } };
  if (!init.capabilities?.textDocumentSync || !init.capabilities.completionProvider) {
    throw new Error(`lsp: missing capabilities: ${JSON.stringify(init)}`);
  }
  lsp.notify('initialized', {});

  const uri = 'file:///smoke.pine';
  const invalid = '//@version=6\nindicator("Smoke")\nplot(\n';
  const diagnosticsArrived = lsp.waitForNotification('textDocument/publishDiagnostics');
  lsp.notify('textDocument/didOpen', {
    textDocument: { uri, languageId: 'pine', version: 1, text: invalid },
  });
  const diag = (await diagnosticsArrived) as { uri: string; diagnostics: { message: string }[] };
  if (diag.uri !== uri || diag.diagnostics.length === 0) {
    throw new Error(`lsp: expected diagnostics for broken source: ${JSON.stringify(diag)}`);
  }

  const fixedArrived = lsp.waitForNotification('textDocument/publishDiagnostics');
  lsp.notify('textDocument/didChange', {
    textDocument: { uri, version: 2 },
    contentChanges: [{ text: '//@version=6\nindicator("Smoke")\nplot(close)\n' }],
  });
  const fixed = (await fixedArrived) as { diagnostics: unknown[] };
  if (fixed.diagnostics.length !== 0) {
    throw new Error(`lsp: valid source still has diagnostics: ${JSON.stringify(fixed)}`);
  }

  const completion = (await lsp.request('textDocument/completion', {
    textDocument: { uri },
    position: { line: 2, character: 5 },
  })) as { items?: unknown[] } | unknown[] | null;
  const items = Array.isArray(completion) ? completion : (completion?.items ?? []);
  if (items.length === 0) throw new Error('lsp: completion returned no items');

  await lsp.request('shutdown');
  lsp.notify('exit');
  const code = await lsp.exited();
  if (code !== 0) throw new Error(`lsp: exit code ${code}`);
  if (lsp.stderr.trim()) throw new Error(`lsp: stderr not empty: ${lsp.stderr.slice(0, 500)}`);
  log(`LSP round-trip OK (diagnostics, didChange, ${items.length} completions, clean shutdown)`);
}

async function main(): Promise<void> {
  versionCompareUnitTests();
  await signatureTamperTest();

  const storageDir = process.argv[2] ?? fs.mkdtempSync(path.join(os.tmpdir(), 'pyneide-pinels-'));
  log(`Storage dir: ${storageDir}`);

  if (readInstalled(storageDir)) throw new Error('install: fresh storage reports an install');
  const first = await installPineLs(storageDir, PINE_LS_BASE_URL, log);
  if (first.status !== 'installed') throw new Error(`install: expected 'installed', got ${first.status}`);
  const installed = readInstalled(storageDir);
  if (!installed || installed.version !== first.installed.version) {
    throw new Error('install: marker/readInstalled mismatch');
  }

  // Second run resolves the same release and must not reinstall.
  const second = await installPineLs(storageDir, PINE_LS_BASE_URL, log);
  if (second.status !== 'up-to-date') {
    throw new Error(`install: expected 'up-to-date', got ${second.status}`);
  }

  // Offline contract: install-state resolution and server startup are purely
  // local. readInstalled touched only the disk above; now the released binary
  // itself must serve a full editing session from stdio.
  await lspRoundTrip(installed.executablePath);

  // Rollback drill: pretend the live version was an update over an older one
  // by cloning it as the "previous" install, then roll back to it.
  const versionsRoot = path.dirname(path.dirname(installed.executablePath));
  const fakePrev = path.join(versionsRoot, '0.0.0-prev');
  fs.cpSync(path.dirname(installed.executablePath), fakePrev, { recursive: true });
  const markerFile = path.join(storageDir, 'pine-ls', 'installed.json');
  const marker = JSON.parse(fs.readFileSync(markerFile, 'utf8'));
  marker.previousVersion = '0.0.0-prev';
  marker.previousExecutable = marker.executable;
  fs.writeFileSync(markerFile, JSON.stringify(marker));
  if (!rollbackTarget(storageDir)) throw new Error('rollback: target not detected');
  const reverted = await rollbackPineLs(storageDir, log);
  if (reverted.version !== '0.0.0-prev') throw new Error('rollback: wrong version live');
  if (!fs.existsSync(reverted.executablePath)) throw new Error('rollback: executable missing');
  await lspRoundTrip(reverted.executablePath);
  if (fs.existsSync(path.dirname(installed.executablePath))) {
    throw new Error('rollback: replaced version was not pruned');
  }

  log('PINE LS SMOKE OK');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
