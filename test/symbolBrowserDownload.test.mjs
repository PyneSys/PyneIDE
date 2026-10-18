import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import vm from 'node:vm';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const bundled = await build({
  entryPoints: [new URL('../src/data/symbolBrowserPanel.ts', import.meta.url).pathname],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  external: ['vscode', './providerService'],
  write: false,
});

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function fixture() {
  const requests = [], messages = [], notifications = [], cancellations = [];
  let receive;
  class ProviderServiceError extends Error {}
  class ProviderService {
    requestWithHandle(method, params) {
      const pending = deferred();
      const id = requests.length + 1;
      requests.push({ method, params, ...pending });
      return { id, result: pending.promise };
    }
    cancel(id) { cancellations.push(id); }
  }
  const vscode = {
    ViewColumn: { Active: 1 },
    Uri: { joinPath: (...parts) => parts.join('/'), file: (file) => file },
    commands: { executeCommand: async () => {} },
    window: {
      createWebviewPanel: () => ({
        webview: {
          asWebviewUri: (uri) => uri,
          postMessage: (msg) => { messages.push(msg); },
          onDidReceiveMessage: (callback) => { receive = callback; },
        },
        onDidDispose() {},
      }),
      showInformationMessage: () => {
        const pending = deferred();
        notifications.push(pending);
        return pending.promise;
      },
    },
  };
  const module = { exports: {} };
  vm.runInNewContext(bundled.outputFiles[0].text, {
    module, exports: module.exports, process, Buffer, console,
    require: (name) => name === 'vscode' ? vscode
      : name === './providerService' ? { ProviderService, ProviderServiceError } : require(name),
  });
  module.exports.SymbolBrowserPanel.show({ extensionUri: '/extension' }, {
    pythonBin: 'python', bridgeRoot: '/bridge', workdir: '/work', output: { appendLine() {} },
  });
  return { requests, messages, notifications, cancellations, send: (msg) => receive(msg) };
}

const download = {
  type: 'download', provider: 'capitalcom', symbol: 'EURUSD', timeframe: '240',
  from: 100, to: 200, truncate: false,
};
const completed = { ohlcv_path: '/data/eurusd.ohlcv', bars_written: 42 };
const flush = () => new Promise((resolve) => setImmediate(resolve));

test('repeat download accepts changed dates and truncate while success notification is open', async () => {
  const f = fixture();
  f.send(download);
  f.requests[0].resolve(completed);
  await flush();
  assert.equal(f.notifications.length, 1);
  assert.equal(f.messages.at(-1).type, 'downloadDone');

  f.send({ ...download, from: 365, truncate: true });
  assert.equal(f.requests.length, 2);
  assert.equal(f.requests[1].params.from, 365);
  assert.equal(f.requests[1].params.truncate, true);

  // Closing an earlier notification must not unlock the current download.
  f.notifications[0].resolve(undefined);
  await flush();
  f.send(download);
  assert.equal(f.requests.length, 2);
  assert.equal(f.messages.at(-1).kind, 'Busy');
  f.send({ type: 'cancelDownload' });
  assert.deepEqual(f.cancellations, [2]);
  f.requests[1].resolve(completed);
  await flush();
  f.notifications[1].resolve(undefined);
  await flush();
});

test('a failed download releases its lock for retry', async () => {
  const f = fixture();
  f.send(download);
  f.requests[0].reject(new Error('Download failed'));
  await flush();
  assert.equal(f.messages.at(-1).type, 'downloadError');
  f.send(download);
  assert.equal(f.requests.length, 2);
  f.requests[1].resolve(completed);
  await flush();
  f.notifications[0].resolve(undefined);
  await flush();
});
