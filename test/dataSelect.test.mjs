import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';
import vm from 'node:vm';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const bundled = await build({
  entryPoints: ['src/run/dataSelect.ts'],
  bundle: true, platform: 'node', format: 'cjs', external: ['vscode'], write: false,
  plugins: [{ name: 'symbol-browser-fixture', setup(build) {
    build.onLoad({ filter: /\/data\/symbolBrowserPanel\.ts$/ }, () => ({
      contents: 'export const SymbolBrowserPanel = {show() {}};',
    }));
  } }],
});

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pyneide-data-picker-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'data'));
  for (const stem of ['first', 'second']) {
    fs.writeFileSync(path.join(root, 'data', `${stem}.ohlcv`), 'fixture');
  }
  const state = new Map();
  const requests = [];
  let updateGate;
  const context = { workspaceState: {
    get: (key, fallback) => structuredClone(state.get(key) ?? fallback),
    async update(key, value) {
      if (updateGate) await updateGate;
      state.set(key, structuredClone(value));
    },
  } };
  const vscode = { window: { showQuickPick(items) {
    const result = deferred();
    requests.push({ ...result, choose: (name) => result.resolve(items.find((item) => item.name === name)) });
    return result.promise;
  } } };
  const module = { exports: {} };
  vm.runInNewContext(bundled.outputFiles[0].text, {
    module, exports: module.exports,
    require: (name) => name === 'vscode' ? vscode : require(name),
    process, Buffer, console, setTimeout, clearTimeout,
  });
  return {
    state, requests,
    pick: (script = 'demo.py') => module.exports.pickRunData(context, root, script, 'python', { appendLine() {} }),
    delayUpdate: (promise) => { updateGate = promise; },
  };
}

test('overlapping run/chart data requests share one picker through persistence', async (t) => {
  const f = fixture(t);
  const saved = deferred();
  f.delayUpdate(saved.promise);
  const run = f.pick();
  const chart = f.pick();
  assert.equal(f.requests.length, 1);
  f.requests[0].choose('first');
  await Promise.resolve();
  const duringSave = f.pick();
  assert.equal(f.requests.length, 1, 'accepting the item must not release the picker before saving');
  saved.resolve();
  assert.deepEqual(await Promise.all([run, chart, duringSave]), ['first', 'first', 'first']);
  assert.equal(f.state.get('pyneide.lastRunData')['demo.py'], 'first');
  const next = f.pick();
  assert.equal(f.requests.length, 2, 'an explicit later selection still opens a picker');
  f.requests[1].choose('second');
  assert.equal(await next, 'second');
});

test('cancelled and failed selections release all waiters and allow a retry', async (t) => {
  const f = fixture(t);
  const first = f.pick();
  const second = f.pick();
  assert.equal(f.requests.length, 1);
  f.requests[0].resolve(undefined);
  assert.deepEqual(await Promise.all([first, second]), [undefined, undefined]);
  const failed = f.pick();
  const alsoFailed = f.pick();
  assert.equal(f.requests.length, 2);
  const checks = [failed, alsoFailed].map((result) => assert.rejects(result, /picker failed/));
  f.requests[1].reject(new Error('picker failed'));
  await Promise.all(checks);
  const retry = f.pick();
  assert.equal(f.requests.length, 3);
  f.requests[2].choose('second');
  assert.equal(await retry, 'second');
});

test('different scripts keep their own selections without overwriting newer bindings', async (t) => {
  const f = fixture(t);
  const first = f.pick('first.py');
  const second = f.pick('second.py');
  assert.equal(f.requests.length, 2);
  f.requests[0].choose('first');
  await first;
  f.requests[1].choose('second');
  await second;
  assert.deepEqual(f.state.get('pyneide.lastRunData'), { 'first.py': 'first', 'second.py': 'second' });
});
