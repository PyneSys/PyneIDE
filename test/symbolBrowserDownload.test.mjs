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

function fixture({ open = true } = {}) {
  const requests = [], messages = [], notifications = [], cancellations = [];
  const state = new Map();
  let receive;
  let disposed = 0;
  let onDispose = () => {};
  class ProviderServiceError extends Error {}
  class ProviderService {
    requestWithHandle(method, params) {
      const pending = deferred();
      const id = requests.length + 1;
      requests.push({ method, params, ...pending });
      return { id, result: pending.promise };
    }
    cancel(id) { cancellations.push(id); }
    dispose() {}
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
        reveal() {},
        dispose() {
          disposed++;
          onDispose();
        },
        onDidDispose(callback) { onDispose = callback; },
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
  const context = {
    extensionUri: '/extension',
    globalState: { get: (key) => state.get(key), update: async (key, value) => { state.set(key, value); } },
  };
  const deps = {
    pythonBin: 'python', bridgeRoot: '/bridge', workdir: '/work', output: { appendLine() {} },
  };
  const panel = module.exports.SymbolBrowserPanel;
  if (open) panel.show(context, deps);
  return {
    requests, messages, notifications, cancellations, state, send: (msg) => receive(msg),
    show: () => panel.show(context, deps),
    pickLive: (request) => panel.pickLive(context, deps, request),
    disposed: () => disposed,
  };
}

const liveRequest = { scriptName: 'trend.py', strategy: true, from: '-500', historyTrades: true };
const startLive = {
  type: 'startLive', provider: 'ccxt', broker: 'BYBIT', symbol: 'BTC/USDT:USDT', timeframe: '1',
  from: '-1000', historyTrades: false,
};

const download = {
  type: 'download', provider: 'capitalcom', symbol: 'EURUSD', timeframe: '240',
  from: 100, to: 200, truncate: false, extraData: false,
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

test('the opt-in data choice reaches the bridge as extra_data', async () => {
  const f = fixture();
  f.send({ ...download, provider: 'ctrader', broker: 'pepperstone', extraData: true });
  assert.equal(f.requests[0].params.extra_data, true);
  f.requests[0].resolve(completed);
  await flush();
  f.notifications[0].resolve(undefined);
  await flush();

  f.send(download);
  assert.equal(f.requests[1].params.extra_data, false);
  f.requests[1].resolve(completed);
  await flush();
  f.notifications[1].resolve(undefined);
  await flush();
});

test('Start Live resolves the pick with the provider string and closes a panel opened for it', async () => {
  const f = fixture({ open: false });
  const pick = f.pickLive(liveRequest);
  f.send(startLive);
  assert.deepEqual({ ...(await pick) }, {
    provider: 'ccxt:BYBIT:BTC/USDT:USDT@1', from: '-1000', historyTrades: false,
  });
  assert.equal(f.disposed(), 1);
  assert.equal(f.state.get('pyneide.symbolBrowser.timeframe'), '1');
});

test('an open panel enters the live pick, and opening it for a download gives the pick up', async () => {
  const f = fixture();
  const pick = f.pickLive({ ...liveRequest, strategy: false });
  assert.deepEqual({ ...f.messages.at(-1).live }, {
    script: 'trend.py', strategy: false, from: '-500', historyTrades: true,
  });
  f.show();
  assert.equal(await pick, undefined);
  assert.equal(f.messages.at(-1).live, null);
  // A Start Live without a pick waiting does nothing
  f.send(startLive);
  await flush();
  assert.equal(f.disposed(), 0);
});

test('an indicator never trades on the history, whatever the switch says', async () => {
  const f = fixture();
  const pick = f.pickLive({ ...liveRequest, strategy: false });
  f.send({ ...startLive, broker: undefined, provider: 'replay', symbol: 'TEST', historyTrades: true });
  assert.deepEqual({ ...(await pick) }, { provider: 'replay:TEST@1', from: '-1000', historyTrades: false });
  // The panel was open before the pick: it stays, back in download mode
  assert.equal(f.disposed(), 0);
  assert.equal(f.messages.at(-1).live, null);
});
