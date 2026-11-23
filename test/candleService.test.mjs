import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { build } from 'esbuild';

const bundled = await build({
  stdin: {
    contents: "export * from './src/run/candleService'; export * from './src/run/providerHub';",
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  bundle: true, platform: 'node', format: 'esm', write: false,
});
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pyneide-candles-'));
const modulePath = path.join(dir, 'candleService.mjs');
fs.writeFileSync(modulePath, bundled.outputFiles[0].text);
const { CandleServices, ProviderHubs } = await import(modulePath);

// A stand-in for the Python of an environment. As the hub it listens and prints
// its address; as the candle service it answers `open` with a start and two bars
// (from the `from` date when it is one), goes live for a `live:` provider, and
// answers `close` with an end, each followed by the chart's exit; as a bridge of
// one chart it sends a start and ends on `cancel`. Every start is logged.
const starts = path.join(dir, 'starts.log');
const fake = (name, { hub = true, candles = 'ok' } = {}) => {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `#!${process.execPath}
const fs = require('node:fs');
const net = require('node:net');
const readline = require('node:readline');
const args = process.argv.slice(2);
const say = (event) => console.log(JSON.stringify(event));
fs.appendFileSync(${JSON.stringify(starts)}, JSON.stringify({
  pid: process.pid, args, hub: process.env.PYNE_PROVIDER_HUB ?? null,
}) + '\\n');
const input = readline.createInterface({ input: process.stdin });
input.on('close', () => process.exit(0));
if (args.includes('pynecore.core.plugin.hub')) {
  if (!${hub}) {
    console.error("ModuleNotFoundError: No module named 'pynecore.core.plugin.hub'");
    process.exit(1);
  }
  const server = net.createServer((socket) => socket.on('error', () => {}));
  server.listen(0, '127.0.0.1', () => say({ host: '127.0.0.1', port: server.address().port }));
} else if (args.includes('--candle-service')) {
  say({ e: 'hello', protocol: 1, pid: process.pid });
  if (${JSON.stringify(candles)} === 'broken') {
    say({ e: 'error', message: 'cannot import', kind: 'ImportError', traceback: '' });
    process.exit(1);
  }
  say({ e: 'candles' });
  input.on('line', (line) => {
    const msg = JSON.parse(line);
    if (msg.cmd === 'open') {
      if (msg.provider === 'die') process.exit(3);
      say({ e: 'start', chart: msg.chart, data: msg.provider, from: msg.from ?? null });
      const first = /^\\d{4}-/.test(msg.from ?? '') ? Date.parse(msg.from) : msg.chart * 60000;
      say({ e: 'bars', chart: msg.chart, d: [[first, 1, 2, 0, 1, 5, null], [first + 60000, 1, 2, 0, 1, 5, null]] });
      if (msg.provider.startsWith('live:')) say({ e: 'live', chart: msg.chart });
      if (msg.provider === 'fail') {
        say({ e: 'error', chart: msg.chart, message: 'no such symbol', kind: 'ProviderError', traceback: '' });
        say({ e: 'exit', chart: msg.chart, code: 1 });
      }
    } else if (msg.cmd === 'close') {
      say({ e: 'end', chart: msg.chart, bars: 1, cancelled: true });
      say({ e: 'exit', chart: msg.chart, code: 0 });
    }
  });
} else {
  say({ e: 'hello', protocol: 1, pid: process.pid });
  say({ e: 'start', data: args[args.indexOf('--live') + 1] });
  input.on('line', (line) => {
    if (JSON.parse(line).cmd === 'cancel') {
      say({ e: 'end', bars: 0, cancelled: true });
      process.exit(0);
    }
  });
}
`, { mode: 0o755 });
  return file;
};
const python = fake('python');
const pythonOld = fake('python-old', { hub: false });
const pythonBroken = fake('python-broken', { candles: 'broken' });

const started = () => (fs.existsSync(starts) ? fs.readFileSync(starts, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
const of = (flag) => started().filter((start) => start.args.includes(flag));
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
const setup = (lingerMs = 50) => {
  fs.rmSync(starts, { force: true });
  const lines = [];
  const hubs = new ProviderHubs(() => undefined, 50);
  const candles = new CandleServices(hubs, path.join(dir, 'bridge'), (line) => lines.push(line), lingerMs);
  const open = async (pythonBin, provider, from) => {
    const events = [];
    const run = await candles.start({ pythonBin, workdir: dir, provider, from, onEvent: (event) => events.push(event) });
    return { run, events };
  };
  return { hubs, candles, lines, open, done: () => {
    candles.dispose();
    hubs.dispose();
  } };
};

const skip = process.platform === 'win32';

test('the charts of a workdir share one candle process, a client of the hub', { skip }, async () => {
  const { open, done } = setup();
  const [first, second] = await Promise.all([open(python, 'ccxt:A@1', '-300'), open(python, 'ccxt:B@5')]);
  const processes = of('--candle-service');
  assert.equal(processes.length, 1);
  assert.equal(of('--data-only').length, 0);
  assert.match(processes[0].hub, /^127\.0\.0\.1:\d+$/);
  assert.deepEqual(processes[0].args, ['-X', 'utf8', '-m', 'pyneide_bridge', '--candle-service', '--workdir', dir]);

  await until(() => first.events.length === 2 && second.events.length === 2, 'the first events');
  // Each chart gets its own events, as a bridge of its own would send them
  assert.deepEqual(first.events[0], { e: 'start', data: 'ccxt:A@1', from: '-300', workdir: dir });
  assert.deepEqual(second.events[0], { e: 'start', data: 'ccxt:B@5', from: null, workdir: dir });
  assert.equal(first.events[1].e, 'bars');
  assert.notDeepEqual(first.events[1].d, second.events[1].d);

  first.run.cancel();
  assert.equal(await first.run.exited, 0);
  assert.deepEqual(first.events.at(-1), { e: 'end', bars: 1, cancelled: true });
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.ok(alive(processes[0].pid), 'a chart still uses the process');
  assert.equal(second.events.length, 2);

  second.run.cancel();
  assert.equal(await second.run.exited, 0);
  await until(() => !alive(processes[0].pid), 'the candle process to end');
  const hub = of('pynecore.core.plugin.hub')[0];
  await until(() => !alive(hub.pid), 'the hub to end');
  done();
});

test('a chart opened within the linger finds the candle process running', { skip }, async () => {
  const { open, done } = setup(2000);
  const first = await open(python, 'ccxt:A@1');
  first.run.cancel();
  await first.run.exited;
  const second = await open(python, 'ccxt:A@5');
  await until(() => second.events.length === 2, 'the second chart');
  assert.equal(of('--candle-service').length, 1);
  const { pid } = of('--candle-service')[0];
  done();
  await until(() => !alive(pid), 'the candle process to end');
});

test('a killed chart ends at once and gets no further event', { skip }, async () => {
  const { open, done } = setup();
  const chart = await open(python, 'ccxt:A@1');
  await until(() => chart.events.length === 2, 'the first events');
  chart.run.kill();
  assert.equal(await chart.run.exited, null);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(chart.events.length, 2);
  done();
});

test("a chart's failure ends that chart only", { skip }, async () => {
  const { open, done } = setup();
  const good = await open(python, 'ccxt:A@1');
  const bad = await open(python, 'fail');
  assert.equal(await bad.run.exited, 1);
  assert.equal(bad.events.at(-1).message, 'no such symbol');
  const { pid } = of('--candle-service')[0];
  assert.ok(alive(pid));
  good.run.cancel();
  assert.equal(await good.run.exited, 0);
  done();
});

test('a candle process that dies is started again, its charts go on from their last bar', { skip }, async () => {
  const { lines, open, done } = setup();
  const live = await open(python, 'live:A@1');
  const loading = await open(python, 'ccxt:B@1');
  await until(() => live.events.length === 3 && loading.events.length === 2, 'the first events');
  const lastBar = live.events[1].d[1][0];
  process.kill(of('--candle-service')[0].pid, 'SIGKILL');

  await until(() => live.events.length === 6 && loading.events.length === 3, 'the events of the new process');
  assert.equal(of('--candle-service').length, 2);
  assert.equal(of('--data-only').length, 0);
  // No second start or live: the chart learns of the outage and gets the bars from its last one on
  assert.deepEqual(live.events.map((event) => event.e), ['start', 'bars', 'live', 'feedStatus', 'bars', 'feedStatus']);
  assert.deepEqual(live.events.filter((event) => event.e === 'feedStatus').map((event) => event.state), ['reconnecting', 'live']);
  // The new process streams from the bar before the last one; the chart gets its last bar again
  assert.deepEqual(live.events[4].d.map((row) => row[0]), [lastBar]);
  // A chart that was not live yet only gets its bars
  assert.deepEqual(loading.events.map((event) => event.e), ['start', 'bars', 'bars']);
  assert.deepEqual(loading.events[2].d.map((row) => row[0]), [loading.events[1].d[1][0]]);
  assert.ok(lines.some((line) => line.includes('starting it again for 2 chart(s)')));

  for (const chart of [live, loading]) {
    chart.run.cancel();
    assert.equal(await chart.run.exited, 0);
    assert.deepEqual(chart.events.at(-1), { e: 'end', bars: 1, cancelled: true });
  }
  done();
});

test('a candle process that keeps dying leaves its charts to bridges of their own', { skip }, async () => {
  const { lines, open, done } = setup();
  const chart = await open(python, 'ccxt:A@1');
  await until(() => chart.events.length === 2, 'the first events');
  // Every candle process dies of this chart
  const dying = await open(python, 'die');
  await until(() => of('--data-only').length === 2, 'the two bridges');
  assert.equal(of('--candle-service').length, 4);
  assert.ok(lines.some((line) => line.includes('ended 4 times within 60 s')));
  // Each of the three later processes sent the chart its last bar again
  assert.deepEqual(chart.events.map((event) => event.e), ['start', 'bars', 'bars', 'bars', 'bars']);
  const lastBar = chart.events[1].d[1][0];
  assert.ok(chart.events.slice(2).every((event) => event.d.length === 1 && event.d[0][0] === lastBar));
  const mine = of('--data-only').find((bridge) => bridge.args.includes('ccxt:A@1'));
  assert.deepEqual(mine.args.slice(-5), ['--live', 'ccxt:A@1', '--live-from', new Date(lastBar - 60000).toISOString(), '--data-only']);
  assert.ok(of('--data-only').every((bridge) => /^127\.0\.0\.1:\d+$/.test(bridge.hub)));

  // The next chart does not try the shared process either
  const next = await open(python, 'ccxt:C@1');
  await until(() => of('--data-only').length === 3, 'the third bridge');
  assert.equal(of('--candle-service').length, 4);
  for (const each of [chart, dying, next]) {
    each.run.cancel();
    assert.equal(await each.run.exited, 0);
  }
  assert.equal(chart.events.filter((event) => event.e === 'start').length, 1);
  done();
});

test('a chart cancelled while its candle process is started again ends', { skip }, async () => {
  const { open, done } = setup();
  const chart = await open(python, 'live:A@1');
  await until(() => chart.events.length === 3, 'the first events');
  process.kill(of('--candle-service')[0].pid, 'SIGKILL');
  await until(() => chart.events.some((event) => event.e === 'feedStatus'), 'the outage');
  chart.run.cancel();
  assert.equal(await chart.run.exited, 0);
  assert.equal(chart.events.at(-1).e, 'end');
  assert.equal(chart.events.at(-1).cancelled, true);
  // The new process starts all the same; it has no chart
  await until(() => of('--candle-service').length === 2, 'the new candle process');
  done();
});

test('without a hub every chart runs a bridge of its own', { skip }, async () => {
  const { open, done } = setup();
  const [first, second] = await Promise.all([open(pythonOld, 'ccxt:A@1', '-300'), open(pythonOld, 'ccxt:B@5')]);
  // A bridge logs its start a moment after it was spawned
  await until(() => of('--data-only').length === 2, 'the two bridges');
  assert.equal(of('--candle-service').length, 0);
  const bridges = of('--data-only');
  assert.ok(bridges.every((bridge) => bridge.hub === null));
  const mine = bridges.find((bridge) => bridge.args.includes('ccxt:A@1'));
  assert.deepEqual(mine.args.slice(-7), ['--workdir', dir, '--live', 'ccxt:A@1', '--live-from', '-300', '--data-only']);
  await until(() => first.events.some((event) => event.e === 'start'), 'the start');
  first.run.cancel();
  second.run.cancel();
  assert.equal(await first.run.exited, 0);
  assert.equal(await second.run.exited, 0);
  done();
});

test('a candle process that cannot start is tried once, the charts run bridges of their own behind the hub', { skip }, async () => {
  const { candles, lines, open, done } = setup();
  const first = await open(pythonBroken, 'ccxt:A@1');
  const second = await open(pythonBroken, 'ccxt:B@1');
  await until(() => of('--data-only').length === 2, 'the two bridges');
  assert.equal(of('--candle-service').length, 1);
  const bridges = of('--data-only');
  assert.ok(bridges.every((bridge) => /^127\.0\.0\.1:\d+$/.test(bridge.hub)));
  assert.ok(lines.some((line) => line.includes('cannot import')));
  candles.forgetFailed();
  const third = await open(pythonBroken, 'ccxt:C@1');
  await until(() => of('--data-only').length === 3, 'the third bridge');
  assert.equal(of('--candle-service').length, 2);
  for (const chart of [first, second, third]) {
    chart.run.cancel();
    assert.equal(await chart.run.exited, 0);
  }
  done();
});

test('an idle candle process ends at once for a package update', { skip }, async () => {
  const { candles, hubs, open, done } = setup(60_000);
  const chart = await open(python, 'ccxt:A@1');
  const { pid } = of('--candle-service')[0];
  await candles.endIdle(python);
  assert.ok(alive(pid), 'a chart uses the process');
  chart.run.cancel();
  await chart.run.exited;
  await candles.endIdle(python);
  assert.ok(!alive(pid));
  await hubs.endIdle(python);
  assert.ok(!alive(of('pynecore.core.plugin.hub')[0].pid));
  done();
});
