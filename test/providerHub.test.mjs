import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { build } from 'esbuild';

const bundled = await build({
  stdin: {
    contents: "export * from './src/run/providerHub';",
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  bundle: true, platform: 'node', format: 'esm', write: false,
});
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pyneide-hub-'));
const modulePath = path.join(dir, 'providerHub.mjs');
fs.writeFileSync(modulePath, bundled.outputFiles[0].text);
const { ProviderHubs } = await import(modulePath);

// A stand-in for `python -m pynecore.core.plugin.hub`: listens, prints its
// address, ends when its standard input closes. Every start is logged.
const starts = path.join(dir, 'starts.log');
const fakeHub = path.join(dir, 'python');
fs.writeFileSync(fakeHub, `#!${process.execPath}
const fs = require('node:fs');
const net = require('node:net');
const args = process.argv.slice(2);
const at = args.indexOf('--port');
const server = net.createServer((socket) => socket.on('error', () => {}));
server.listen(at < 0 ? 0 : Number(args[at + 1]), '127.0.0.1', () => {
  fs.appendFileSync(${JSON.stringify(starts)}, JSON.stringify({
    pid: process.pid, args, token: process.env.PYNE_PROVIDER_HUB_TOKEN,
  }) + '\\n');
  console.log(JSON.stringify({ host: '127.0.0.1', port: server.address().port }));
});
process.stdin.on('end', () => process.exit(0));
process.stdin.resume();
`, { mode: 0o755 });

const oldCore = path.join(dir, 'python-old');
fs.writeFileSync(oldCore, `#!${process.execPath}
console.error("python: Error while finding module specification for 'pynecore.core.plugin.hub' " +
  "(ModuleNotFoundError: No module named 'pynecore.core.plugin.hub')");
process.exit(1);
`, { mode: 0o755 });

const started = () => (fs.existsSync(starts) ? fs.readFileSync(starts, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const until = async (condition, what) => {
  for (let i = 0; i < 400; i++) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`timed out waiting for ${what}`);
};
const connects = (env) => new Promise((resolve) => {
  const [host, port] = env.PYNE_PROVIDER_HUB.split(':');
  const socket = net.connect(Number(port), host, () => {
    socket.destroy();
    resolve(true);
  });
  socket.on('error', () => resolve(false));
});

const skip = process.platform === 'win32';

test('live runs of one workdir share one hub, which ends after the last one', { skip }, async () => {
  fs.rmSync(starts, { force: true });
  const hubs = new ProviderHubs(() => undefined, 50);
  const [first, second] = await Promise.all([hubs.acquire(fakeHub, dir), hubs.acquire(fakeHub, dir)]);
  assert.deepEqual(first.env, second.env);
  assert.equal(started().length, 1);
  const { pid, args, token } = started()[0];
  assert.deepEqual(args.slice(0, 5), ['-X', 'utf8', '-m', 'pynecore.core.plugin.hub', '--config-dir']);
  assert.equal(args[5], path.join(dir, 'config'));
  assert.equal(first.env.PYNE_PROVIDER_HUB_TOKEN, token);
  assert.ok(await connects(first.env));

  first.release();
  first.release();
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.ok(alive(pid), 'a run still uses the hub');

  second.release();
  await until(() => !alive(pid), 'the hub to end');
  hubs.dispose();
});

test('a run that comes within the linger finds the hub running', { skip }, async () => {
  fs.rmSync(starts, { force: true });
  const hubs = new ProviderHubs(() => undefined, 2000);
  const first = await hubs.acquire(fakeHub, dir);
  first.release();
  const second = await hubs.acquire(fakeHub, dir);
  assert.deepEqual(second.env, first.env);
  assert.equal(started().length, 1);
  const { pid } = started()[0];
  hubs.dispose();
  await until(() => !alive(pid), 'the hub to end');
});

test('a hub that dies under its runs is started again on the same port', { skip }, async () => {
  fs.rmSync(starts, { force: true });
  const lines = [];
  const hubs = new ProviderHubs((line) => lines.push(line), 50);
  const lease = await hubs.acquire(fakeHub, dir);
  const port = lease.env.PYNE_PROVIDER_HUB.split(':')[1];
  process.kill(started()[0].pid, 'SIGKILL');
  await until(() => started().length === 2, 'the restart');
  const again = started()[1];
  assert.deepEqual(again.args.slice(-2), ['--port', port]);
  assert.equal(again.token, lease.env.PYNE_PROVIDER_HUB_TOKEN);
  await until(() => connects(lease.env), 'the restarted hub to listen');
  assert.ok(lines.some((line) => line.includes('starting it again')));
  lease.release();
  await until(() => !alive(again.pid), 'the hub to end');
  hubs.dispose();
});

test('a PyneCore without the hub runs without one, and is asked once', { skip }, async () => {
  const lines = [];
  const hubs = new ProviderHubs((line) => lines.push(line), 50);
  const lease = await hubs.acquire(oldCore, dir);
  assert.deepEqual(lease.env, {});
  lease.release();
  assert.deepEqual(lines, []);
  // Remembered: no second start
  fs.rmSync(oldCore);
  assert.deepEqual((await hubs.acquire(oldCore, dir)).env, {});
  hubs.forgetUnsupported();
  hubs.dispose();
});

test('a hub that never reports its address is killed and its run goes without one', { skip }, async () => {
  const pidFile = path.join(dir, 'hanging.pid');
  const hanging = path.join(dir, 'python-hanging');
  fs.writeFileSync(hanging, `#!${process.execPath}
require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
process.stdin.resume();
`, { mode: 0o755 });
  const lines = [];
  const hubs = new ProviderHubs((line) => lines.push(line), 50, 2000);
  const lease = await hubs.acquire(hanging, dir);
  assert.deepEqual(lease.env, {});
  lease.release();
  assert.ok(lines.some((line) => line.includes('did not report its address')));
  await until(() => !alive(Number(fs.readFileSync(pidFile, 'utf8'))), 'the hanging hub to be killed');
  hubs.dispose();
});

test('an output line before the address does not hide the address', { skip }, async () => {
  fs.rmSync(starts, { force: true });
  const noisy = path.join(dir, 'python-noisy');
  fs.writeFileSync(noisy, `#!${process.execPath}
console.log('a banner');
require(${JSON.stringify(fakeHub)});
`, { mode: 0o755 });
  const lines = [];
  const hubs = new ProviderHubs((line) => lines.push(line), 50);
  const lease = await hubs.acquire(noisy, dir);
  assert.ok(await connects(lease.env));
  assert.ok(lines.some((line) => line.includes('unexpected output: a banner')));
  const { pid } = started()[0];
  lease.release();
  await until(() => !alive(pid), 'the hub to end');
  hubs.dispose();
});

test('a hub whose restart fails is tried again for its runs', { skip }, async () => {
  fs.rmSync(starts, { force: true });
  const failedOnce = path.join(dir, 'failed-once');
  const flaky = path.join(dir, 'python-flaky');
  fs.writeFileSync(flaky, `#!${process.execPath}
const fs = require('node:fs');
if (process.argv.includes('--port') && !fs.existsSync(${JSON.stringify(failedOnce)})) {
  fs.writeFileSync(${JSON.stringify(failedOnce)}, '');
  process.exit(1);
}
require(${JSON.stringify(fakeHub)});
`, { mode: 0o755 });
  const lines = [];
  const hubs = new ProviderHubs((line) => lines.push(line), 50);
  const lease = await hubs.acquire(flaky, dir);
  process.kill(started()[0].pid, 'SIGKILL');
  await until(() => started().length === 2, 'the second restart');
  assert.ok(fs.existsSync(failedOnce));
  await until(() => connects(lease.env), 'the restarted hub to listen');
  assert.ok(lines.some((line) => line.includes('trying again')));
  const again = started()[1];
  lease.release();
  await until(() => !alive(again.pid), 'the hub to end');
  hubs.dispose();
});

test('a hub that failed too often is started again once its restart window frees', { skip }, async () => {
  fs.rmSync(starts, { force: true });
  const failures = path.join(dir, 'failures');
  fs.rmSync(failures, { force: true });
  const failing = path.join(dir, 'python-failing');
  fs.writeFileSync(failing, `#!${process.execPath}
const fs = require('node:fs');
const failed = fs.existsSync(${JSON.stringify(failures)}) ? fs.readFileSync(${JSON.stringify(failures)}, 'utf8').length : 0;
if (process.argv.includes('--port') && failed < 4) {
  fs.appendFileSync(${JSON.stringify(failures)}, 'x');
  process.exit(1);
}
require(${JSON.stringify(fakeHub)});
`, { mode: 0o755 });
  const lines = [];
  const hubs = new ProviderHubs((line) => lines.push(line), 50, 30_000, 2500);
  const lease = await hubs.acquire(failing, dir);
  process.kill(started()[0].pid, 'SIGKILL');
  await until(() => started().length === 2, 'the hub to come back after the limit');
  assert.equal(fs.readFileSync(failures, 'utf8').length, 4);
  await until(() => connects(lease.env), 'the restarted hub to listen');
  assert.ok(lines.some((line) => line.includes('started again 3 times')));
  const again = started()[1];
  lease.release();
  await until(() => !alive(again.pid), 'the hub to end');
  hubs.dispose();
});

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
