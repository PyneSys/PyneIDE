/**
 * Pine language server install + LSP smoke test — runs WITHOUT VSCode,
 * against the LIVE release site with the released artifacts.
 * Usage: node dist/pinels-smoke.js [storageDir]
 */
import { spawn, type ChildProcess } from 'node:child_process';
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

/** Minimal Content-Length framed LSP client over the server's stdio. */
class LspStdio {
  private readonly child: ChildProcess;
  private buffer = Buffer.alloc(0);
  private nextId = 1;
  private readonly pending = new Map<
    number,
    (result: unknown, error?: { code: number; message: string }) => void
  >();
  private readonly notificationWaiters: {
    method: string;
    resolve: (params: unknown) => void;
  }[] = [];
  stderr = '';

  constructor(executable: string) {
    this.child = spawn(executable, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stdout!.on('data', (chunk: Buffer) => this.onData(chunk));
    this.child.stderr!.on('data', (chunk: Buffer) => {
      this.stderr += chunk.toString();
    });
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd < 0) return;
      const header = this.buffer.subarray(0, headerEnd).toString('ascii');
      const length = parseInt(/Content-Length: (\d+)/i.exec(header)?.[1] ?? '', 10);
      if (!Number.isFinite(length)) throw new Error(`lsp: bad header: ${header}`);
      const bodyStart = headerEnd + 4;
      if (this.buffer.length < bodyStart + length) return;
      const body = this.buffer.subarray(bodyStart, bodyStart + length).toString('utf8');
      this.buffer = this.buffer.subarray(bodyStart + length);
      const message = JSON.parse(body) as {
        id?: number;
        method?: string;
        result?: unknown;
        error?: { code: number; message: string };
        params?: unknown;
      };
      if (message.id !== undefined && message.method === undefined) {
        this.pending.get(message.id)?.(message.result, message.error);
        this.pending.delete(message.id);
      } else if (message.method) {
        for (let i = this.notificationWaiters.length - 1; i >= 0; i--) {
          if (this.notificationWaiters[i].method === message.method) {
            this.notificationWaiters[i].resolve(message.params);
            this.notificationWaiters.splice(i, 1);
          }
        }
      }
    }
  }

  private send(message: object): void {
    const body = Buffer.from(JSON.stringify(message), 'utf8');
    this.child.stdin!.write(`Content-Length: ${body.length}\r\n\r\n`);
    this.child.stdin!.write(body);
  }

  request(method: string, params?: unknown, timeoutMs = 15000): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`lsp: ${method} timed out`)), timeoutMs);
      this.pending.set(id, (result, error) => {
        clearTimeout(timer);
        if (error) reject(new Error(`lsp: ${method} error ${error.code}: ${error.message}`));
        else resolve(result);
      });
      // Parameterless messages omit `params` entirely (JSON-RPC structured
      // params rule; vscode-languageclient does the same for shutdown/exit).
      this.send(params === undefined ? { jsonrpc: '2.0', id, method } : { jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method: string, params?: unknown): void {
    this.send(params === undefined ? { jsonrpc: '2.0', method } : { jsonrpc: '2.0', method, params });
  }

  waitForNotification(method: string, timeoutMs = 15000): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`lsp: no ${method} received`)), timeoutMs);
      this.notificationWaiters.push({
        method,
        resolve: (params) => {
          clearTimeout(timer);
          resolve(params);
        },
      });
    });
  }

  exited(): Promise<number> {
    return new Promise((resolve) => this.child.on('close', (code) => resolve(code ?? -1)));
  }
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
