import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { build } from 'esbuild';

const bundled = await build({
  stdin: {
    contents: [
      "export * from './src/dashboard/model';",
      "export { ChartComposer, SLOT_WAIT_MS, TICK_COALESCE_MS } from './src/dashboard/composer';",
      "export { chartHtml } from './src/chart/chartHtml';",
    ].join('\n'),
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  bundle: true, platform: 'node', format: 'cjs', write: false,
});
// The bundle runs in its own realm: compare its arrays and objects as copies
const module = { exports: {} };
vm.runInNewContext(bundled.outputFiles[0].text, { module, exports: module.exports, structuredClone });
const m = module.exports;
const plain = (v) => JSON.parse(JSON.stringify(v));

const FILE = `name = "BTC"

[layout]
split = "horizontal"
sizes = [0.6, 0.4]
children = ["btc_1", { split = "vertical", sizes = [1, 1], children = ["eth_5", "btc_60"] }]

[charts.btc_1]
provider = "ccxt:BINANCE:BTC/USDT@1"

[[charts.btc_1.scripts]]
id = "ema_fast"
path = "scripts/ema.py"
inputs = { length = 9 }

[[charts.btc_1.scripts]]
id = "ema_slow"
path = "scripts/ema.py"
inputs = { length = 21 }

[charts.eth_5]
provider = "ccxt:BINANCE:ETH/USDT@5"
history = -300

[charts.btc_60]
provider = "ccxt:BINANCE:BTC/USDT@60"
history = "2026-11-01"
`;

test('a dashboard file parses into charts, scripts and a layout', () => {
  const d = m.parseDashboard(FILE);
  assert.equal(d.name, 'BTC');
  assert.deepEqual(plain(d.layout), {
    split: 'horizontal', sizes: [0.6, 0.4],
    children: ['btc_1', { split: 'vertical', sizes: [0.5, 0.5], children: ['eth_5', 'btc_60'] }],
  });
  assert.equal(d.charts.btc_1.history, '-500');
  assert.equal(d.charts.eth_5.history, '-300');
  assert.equal(d.charts.btc_60.history, '2026-11-01');
  assert.deepEqual(plain(d.charts.btc_1.scripts), [
    { id: 'ema_fast', path: 'scripts/ema.py', inputs: { length: 9 } },
    { id: 'ema_slow', path: 'scripts/ema.py', inputs: { length: 21 } },
  ]);
});

test('serializing and parsing again keeps the dashboard', () => {
  const d = m.parseDashboard(FILE);
  const again = m.parseDashboard(m.serializeDashboard(d));
  assert.deepEqual(plain(again), plain(d));
});

test('malformed dashboards are refused with the place of the error', () => {
  assert.throws(() => m.parseDashboard('charts = 1'), /charts must be a table/);
  assert.throws(() => m.parseDashboard('[charts.a]\nhistory = "-5"'), /charts\.a\.provider/);
  assert.throws(() => m.parseDashboard('[charts."a b"]\nprovider = "p"'), /chart key/);
  assert.throws(
    () => m.parseDashboard('[charts.a]\nprovider = "p"\n[[charts.a.scripts]]\nid = "x"\npath = "s"\n' +
      '[[charts.a.scripts]]\nid = "x"\npath = "t"'),
    /used twice/);
  assert.throws(() => m.parseDashboard('name = ['), m.DashboardFormatError);
});

test('the layout is repaired to hold every chart exactly once', () => {
  const d = m.parseDashboard(`
[layout]
split = "vertical"
children = ["a", "gone", "a"]
[charts.a]
provider = "p"
[charts.b]
provider = "q"
`);
  assert.deepEqual(plain(d.layout), { split: 'horizontal', sizes: [0.5, 0.5], children: ['a', 'b'] });
  assert.equal(m.parseDashboard('[charts.a]\nprovider = "p"').layout, 'a');
});

test('a chart goes beside another, splitting its cell', () => {
  let layout = m.insertBeside(undefined, undefined, 'a', 'horizontal');
  assert.equal(layout, 'a');
  layout = m.insertBeside(layout, 'a', 'b', 'horizontal');
  assert.deepEqual(plain(layout), { split: 'horizontal', sizes: [0.5, 0.5], children: ['a', 'b'] });
  // Same direction: a sibling in the same split, the target's share halved
  layout = m.insertBeside(layout, 'a', 'c', 'horizontal');
  assert.deepEqual(plain(layout), { split: 'horizontal', sizes: [0.25, 0.25, 0.5], children: ['a', 'c', 'b'] });
  // Other direction: the cell becomes a split
  layout = m.insertBeside(layout, 'b', 'd', 'vertical');
  assert.deepEqual(plain(layout), {
    split: 'horizontal', sizes: [0.25, 0.25, 0.5],
    children: ['a', 'c', { split: 'vertical', sizes: [0.5, 0.5], children: ['b', 'd'] }],
  });
});

test('removing a chart gives its space to the neighbours and collapses splits', () => {
  const layout = {
    split: 'horizontal', sizes: [0.5, 0.5],
    children: ['a', { split: 'vertical', sizes: [0.5, 0.5], children: ['b', 'c'] }],
  };
  assert.deepEqual(plain(m.removeFromLayout(layout, 'b')),
    { split: 'horizontal', sizes: [0.5, 0.5], children: ['a', 'c'] });
  assert.deepEqual(plain(m.removeFromLayout(m.removeFromLayout(layout, 'b'), 'a')), 'c');
  assert.equal(m.removeFromLayout('a', 'a'), undefined);
  // A nested split of the same direction merges into its parent
  const nested = {
    split: 'horizontal', sizes: [0.5, 0.5],
    children: ['a', { split: 'vertical', sizes: [0.5, 0.5],
      children: ['b', { split: 'horizontal', sizes: [0.5, 0.5], children: ['c', 'd'] }] }],
  };
  assert.deepEqual(plain(m.removeFromLayout(nested, 'b')),
    { split: 'horizontal', sizes: [0.5, 0.25, 0.25], children: ['a', 'c', 'd'] });
});

test('a split is resized by its path, keeping every cell visible', () => {
  const layout = {
    split: 'horizontal', sizes: [0.5, 0.5],
    children: ['a', { split: 'vertical', sizes: [0.5, 0.5], children: ['b', 'c'] }],
  };
  const resized = m.resizeSplit(layout, [1], [0.99, 0.01]);
  assert.deepEqual(plain(resized.children[1].sizes.map((s) => Math.round(s * 1000) / 1000)), [0.908, 0.092]);
  assert.deepEqual(plain(m.resizeSplit(layout, [], [3, 1]).sizes), [0.75, 0.25]);
  assert.deepEqual(plain(m.resizeSplit(layout, [], [1])), plain(layout));
});

test('chart keys and script ids are derived and kept unique', () => {
  assert.equal(m.chartKeyFor('ccxt:BINANCE:BTC/USDT@1', []), 'btc_usdt_1');
  assert.equal(m.chartKeyFor('ccxt:BYBIT:BTC/USDT:USDT@60', []), 'btc_usdt_usdt_60');
  assert.equal(m.chartKeyFor('capitalcom:EURUSD@1D', ['eurusd_1d']), 'eurusd_1d-2');
  assert.equal(m.scriptIdFor('scripts/ema.py', ['ema', 'ema-2']), 'ema-3');
  assert.equal(m.scriptIdFor('scripts/My Script.pine', []), 'my_script');
});

test('a chart runs at most four indicators and one strategy', () => {
  assert.equal(m.scriptLimitReason(['indicator', 'indicator', 'indicator'], 'indicator'), undefined);
  assert.match(m.scriptLimitReason(['indicator', 'indicator', 'indicator', 'indicator'], 'indicator'), /4 indicators/);
  assert.equal(m.scriptLimitReason(['indicator'], 'strategy'), undefined);
  assert.match(m.scriptLimitReason(['strategy'], 'strategy'), /1 strategy/);
});

const MIN = 60_000;
const SLOT_WAIT = m.SLOT_WAIT_MS;
const TICK = m.TICK_COALESCE_MS;
const START = (over = {}) => ({
  e: 'start', script: '', scriptType: 'indicator', overlay: false, syminfo: {}, data: 'p@1',
  range: { from: 0, to: 0, bars: 0 }, live: { provider: 'p@1', historyTrades: false },
  outputs: { plot: '', strat: null, trades: null }, ...over,
});
const row = (t, close, plots = null, ...rest) => [t, close, close, close, close, 1, plots, ...rest];

function composer(ids) {
  const out = [];
  const timers = [];
  const c = new m.ChartComposer(ids.map((id) => ({ id })), {
    emit: (ev) => out.push(plain(ev)),
    schedule: (callback, ms) => timers.push({ callback, ms }),
  });
  // Runs the timers of at most `ms`, in order, and the ones they schedule
  const fire = (ms) => {
    for (let i = 0; i < timers.length;) {
      if (timers[i].ms <= ms) timers.splice(i, 1)[0].callback();
      else i++;
    }
  };
  return { c, out, fire };
}

test('the composer holds the history until every process is live, then merges it', () => {
  const { c, out } = composer(['fast', 'slow']);
  c.base(START({ dataOnly: true }));
  c.base({ e: 'bars', d: [row(0, 1), row(MIN, 2)] });
  c.base({ e: 'feedStatus', state: 'live', attempt: 0, offlineSeconds: null, error: null });
  c.base({ e: 'live' });
  c.slot('fast', START({ script: '/w/scripts/ema.py', overlay: true }));
  c.slot('fast', { e: 'plotKeys', keys: ['EMA'] });
  c.slot('fast', { e: 'plotMeta', metas: [{ id: 'EMA', kind: 'plot', title: 'EMA' }] });
  c.slot('fast', { e: 'bars', d: [row(0, 1, [10]), row(MIN, 2, [11])] });
  c.slot('fast', { e: 'live' });
  assert.equal(out.length, 0, 'nothing before the last process is live');
  c.slot('slow', START({ scriptType: 'strategy', initialCapital: 1000 }));
  c.slot('slow', { e: 'plotKeys', keys: ['EMA'] });
  c.slot('slow', { e: 'bars', d: [row(0, 1, [20], 1000, null), row(MIN, 2, [21], 1001, null)] });
  c.slot('slow', { e: 'live' });

  assert.deepEqual(out.map((ev) => ev.e),
    ['start', 'plotKeys', 'plotMeta', 'plotKeys', 'bars', 'live', 'feedStatus']);
  const start = out[0];
  assert.equal(start.scriptType, 'strategy');
  assert.equal(start.initialCapital, 1000);
  assert.equal(start.dataOnly, undefined);
  assert.equal(start.overlay, false);
  assert.equal(start.scriptTitle, 'fast, slow');
  assert.deepEqual(out[3].keys, ['fast: EMA', 'slow: EMA']);
  assert.deepEqual(out[2].metas, [{ id: 'fast: EMA', kind: 'plot', title: 'fast: EMA', force_overlay: true }]);
  assert.deepEqual(out[4].d, [row(0, 1, [10, 20], 1000, null), row(MIN, 2, [11, 21], 1001, null)]);
});

test('a chart without scripts is the base stream, marked data only', () => {
  const { c, out } = composer([]);
  c.base(START({ dataOnly: true }));
  c.base({ e: 'bars', d: [row(0, 1)] });
  c.base({ e: 'live' });
  assert.equal(out[0].dataOnly, true);
  assert.deepEqual(out[1], { e: 'bars', d: [row(0, 1, [])] });
});

function liveComposer(ids = ['a']) {
  const { c, out, fire } = composer(ids);
  c.base(START());
  c.base({ e: 'bars', d: [row(0, 1)] });
  c.base({ e: 'live' });
  for (const id of ids) {
    c.slot(id, START());
    c.slot(id, { e: 'plotKeys', keys: ['x'] });
    c.slot(id, { e: 'bars', d: [row(0, 1, [5])] });
    c.slot(id, { e: 'live' });
  }
  out.length = 0;
  return { c, out, fire };
}

test('live, a slot value waits for its bar and replaces it when it comes late', () => {
  const { c, out, fire } = liveComposer();
  // The slot closed the bar first: it goes out with the base's close
  c.slot('a', { e: 'bars', d: [row(MIN, 2, [6])] });
  assert.equal(out.length, 0);
  c.base({ e: 'bars', d: [row(MIN, 2)] });
  assert.deepEqual(out.pop(), { e: 'bars', d: [row(MIN, 2, [6])] });
  // The base closed the bar first: it waits for the slot's value
  c.base({ e: 'bars', d: [row(2 * MIN, 3)] });
  assert.equal(out.length, 0);
  c.slot('a', { e: 'bars', d: [row(2 * MIN, 3, [7])] });
  assert.deepEqual(out.pop(), { e: 'bars', d: [row(2 * MIN, 3, [7])] });
  // A value later than the wait replaces the last merged bar
  c.base({ e: 'bars', d: [row(3 * MIN, 4)] });
  fire(SLOT_WAIT);
  assert.deepEqual(out.pop(), { e: 'bars', d: [row(3 * MIN, 4, [null])] });
  c.slot('a', { e: 'bars', d: [row(3 * MIN, 4, [8])] });
  assert.deepEqual(out.pop(), { e: 'bars', d: [row(3 * MIN, 4, [8])] });
  // A value of an older bar is dropped
  c.slot('a', { e: 'bars', d: [row(MIN, 2, [99])] });
  assert.equal(out.length, 0);
});

test('live, a closed bar is held until every running slot sent it', () => {
  const { c, out } = liveComposer(['a', 'b']);
  c.base({ e: 'bars', d: [row(MIN, 2)] });
  c.slot('a', { e: 'bars', d: [row(MIN, 2, [6])] });
  assert.equal(out.length, 0, 'b has not sent the bar yet');
  c.slot('b', { e: 'bars', d: [row(MIN, 2, [7])] });
  assert.deepEqual(out, [{ e: 'bars', d: [row(MIN, 2, [6, 7])] }]);
});

test('held bars go out in order when their wait is over; a value after that is dropped', () => {
  const { c, out, fire } = liveComposer(['a', 'b']);
  c.base({ e: 'bars', d: [row(MIN, 2)] });
  c.base({ e: 'bars', d: [row(2 * MIN, 3)] });
  c.slot('a', { e: 'bars', d: [row(MIN, 2, [6]), row(2 * MIN, 3, [7])] });
  fire(TICK);
  assert.equal(out.length, 0, 'b has not sent the bars yet');
  fire(SLOT_WAIT);
  assert.deepEqual(out, [
    { e: 'bars', d: [row(MIN, 2, [6, null])] },
    { e: 'bars', d: [row(2 * MIN, 3, [7, null])] },
  ]);
  out.length = 0;
  // A value of a bar a later one followed is lost; one of the last bar replaces it
  c.slot('b', { e: 'bars', d: [row(MIN, 2, [8])] });
  assert.equal(out.length, 0);
  c.slot('b', { e: 'bars', d: [row(2 * MIN, 3, [9])] });
  assert.deepEqual(out, [{ e: 'bars', d: [row(2 * MIN, 3, [7, 9])] }]);
});

test('a slot that ends releases the bars held for it', () => {
  const { c, out } = liveComposer(['a', 'b']);
  c.base({ e: 'bars', d: [row(MIN, 2)] });
  c.slot('a', { e: 'bars', d: [row(MIN, 2, [6])] });
  assert.equal(out.length, 0);
  c.slot('b', { e: 'end', bars: 0, cancelled: false });
  assert.deepEqual(out, [{ e: 'bars', d: [row(MIN, 2, [6, null])] }]);
  out.length = 0;
  // Later bars wait only for the running slots
  c.base({ e: 'bars', d: [row(2 * MIN, 3)] });
  assert.equal(out.length, 0);
  c.slot('a', { e: 'bars', d: [row(2 * MIN, 3, [7])] });
  assert.deepEqual(out, [{ e: 'bars', d: [row(2 * MIN, 3, [7, null])] }]);
});

test('ticks of later bars wait while a closed bar is held', () => {
  const { c, out, fire } = liveComposer();
  c.base({ e: 'bars', d: [row(MIN, 2)] });
  c.base({ e: 'tick', ran: true, d: row(2 * MIN, 3, []) });
  fire(TICK);
  assert.equal(out.length, 0, 'no tick while the closed bar is held');
  c.slot('a', { e: 'bars', d: [row(MIN, 2, [6])] });
  assert.deepEqual(out.map((ev) => ev.e), ['bars']);
  fire(TICK);
  assert.deepEqual(out.map((ev) => ev.e), ['bars', 'tick']);
  assert.deepEqual(out[1], { e: 'tick', ran: false, d: row(2 * MIN, 3, [null]) });
});

test('colors and drawings wait for their bar; drawing ids are unique per slot', () => {
  const { c, out } = liveComposer();
  c.slot('a', { e: 'colors', d: [[MIN, { x: '#ff0000ff' }]] });
  c.slot('a', { e: 'drawings', d: [{ i: 1, op: 'create', obj: 'label', id: 3, s: { id: 3, x: 1, y: 2 } }] });
  assert.equal(out.length, 0);
  c.base({ e: 'bars', d: [row(MIN, 2)] });
  assert.equal(out.length, 0, 'the closed bar waits for the slot');
  c.slot('a', { e: 'bars', d: [row(MIN, 2, [6])] });
  assert.deepEqual(out.map((ev) => ev.e), ['bars', 'colors', 'drawings']);
  assert.deepEqual(out[1].d, [[MIN, { 'a: x': '#ff0000ff' }]]);
  assert.deepEqual(out[2].d, [{ i: 1, op: 'create', obj: 'label', id: 24, s: { id: 24, x: 1, y: 2 } }]);
});

test('a slot whose history started a bar later is moved onto the base bar indexes', () => {
  const { c, out } = composer(['a']);
  c.base(START());
  c.base({ e: 'bars', d: [row(0, 1), row(MIN, 2), row(2 * MIN, 3)] });
  c.base({ e: 'live' });
  c.slot('a', START({ scriptType: 'strategy' }));
  c.slot('a', { e: 'plotKeys', keys: ['x'] });
  c.slot('a', { e: 'bars', d: [row(MIN, 2, [6]), row(2 * MIN, 3, [7])] });
  c.slot('a', { e: 'drawings', d: [{ i: 1, op: 'create', obj: 'line', id: 0,
    s: { x1: 0, x2: 1, xloc: 'bar_index' } }] });
  c.slot('a', { e: 'trades', d: [{ entryBar: 0, exitBar: 1 }] });
  c.slot('a', { e: 'openTrades', d: [{ entryBar: 1, exitBar: -1 }] });
  c.slot('a', { e: 'live' });
  const bars = out.find((ev) => ev.e === 'bars');
  assert.deepEqual(bars.d.map((r) => r[6]), [[null], [6], [7]]);
  const drawing = out.find((ev) => ev.e === 'drawings').d[0];
  assert.deepEqual([drawing.i, drawing.s.x1, drawing.s.x2], [2, 1, 2]);
  assert.deepEqual(out.find((ev) => ev.e === 'trades').d, [{ entryBar: 1, exitBar: 2 }]);
  assert.deepEqual(out.find((ev) => ev.e === 'openTrades').d, [{ entryBar: 2, exitBar: -1 }]);
});

test('a tick merges the base candle with the slots ticks of the same bar', () => {
  const { c, out, fire } = liveComposer();
  c.slot('a', { e: 'tick', ran: true, d: row(MIN, 2, [8]), colors: { x: '#00ff00ff' }, drawings: [] });
  fire(TICK);
  assert.equal(out.length, 0, 'no tick before the base has one');
  c.base({ e: 'tick', ran: true, d: row(MIN, 2.5, []) });
  fire(TICK);
  assert.deepEqual(out.pop(), {
    e: 'tick', ran: true, d: row(MIN, 2.5, [8]), colors: { 'a: x': '#00ff00ff' }, drawings: [],
  });
  // The bar's close ends its ticks
  c.base({ e: 'bars', d: [row(MIN, 2.6)] });
  c.slot('a', { e: 'bars', d: [row(MIN, 2, [9])] });
  c.slot('a', { e: 'tick', ran: true, d: row(MIN, 2, [9]) });
  fire(TICK);
  assert.equal(out.filter((ev) => ev.e === 'tick').length, 0);
});

test('the ticks of a still forming last history bar go out until its live close', () => {
  const { c, out, fire } = liveComposer();
  // The history's last bar (time 0) is the downloaded partial bar: the feed goes on forming it
  c.slot('a', { e: 'tick', ran: true, d: row(0, 1.5, [7]), colors: {},
    drawings: [{ i: 0, op: 'update', obj: 'table', id: 1, s: { id: 1, cells: [] } }] });
  c.base({ e: 'tick', ran: true, d: row(0, 1.5, []) });
  fire(TICK);
  assert.deepEqual(out.pop(), {
    e: 'tick', ran: true, d: row(0, 1.5, [7]), colors: {},
    drawings: [{ i: 0, op: 'update', obj: 'table', id: 8, s: { id: 8, cells: [] } }],
  });
  // Its live close ends them: a slot's late tick of the same bar is dropped
  c.base({ e: 'bars', d: [row(0, 1.6)] });
  c.slot('a', { e: 'bars', d: [row(0, 1.6, [8])] });
  c.slot('a', { e: 'tick', ran: true, d: row(0, 1.6, [8]) });
  c.base({ e: 'tick', ran: true, d: row(0, 1.6, []) });
  fire(TICK);
  assert.equal(out.filter((ev) => ev.e === 'tick').length, 0);
});

test('a live close while a slot is loading ends the ticks of its bar', () => {
  const { c, out, fire } = composer(['a']);
  c.base(START());
  c.base({ e: 'bars', d: [row(0, 1)] });
  c.base({ e: 'live' });
  // The base forms and closes the history's partial bar before the slot is live
  c.base({ e: 'tick', ran: true, d: row(0, 1.5, []) });
  c.base({ e: 'bars', d: [row(0, 1.6)] });
  c.slot('a', START());
  c.slot('a', { e: 'plotKeys', keys: ['x'] });
  c.slot('a', { e: 'bars', d: [row(0, 1.6, [5])] });
  c.slot('a', { e: 'live' });
  fire(TICK);
  assert.deepEqual(out.filter((ev) => ev.e === 'bars').at(-1).d, [row(0, 1.6, [5])]);
  assert.equal(out.filter((ev) => ev.e === 'tick').length, 0);
});

test('a slot that fails while loading is left out, the chart still goes live', () => {
  const { c, out } = composer(['a', 'b']);
  c.base(START());
  c.base({ e: 'bars', d: [row(0, 1)] });
  c.base({ e: 'live' });
  c.slot('a', { e: 'error', message: 'boom', kind: 'X', traceback: '' });
  c.slot('b', START());
  c.slot('b', { e: 'plotKeys', keys: ['y'] });
  c.slot('b', { e: 'bars', d: [row(0, 1, [3])] });
  c.slot('b', { e: 'live' });
  assert.equal(out[0].scriptTitle, 'b');
  assert.deepEqual(out.find((ev) => ev.e === 'bars').d, [row(0, 1, [3])]);
  assert.equal(c.isLive(), true);
});

test('a dashboard chart carries the cell controls on its toolbar, a chart tab its output files', () => {
  const ids = (html) => new Set([...html.matchAll(/id="([^"]+)"/g)].map((match) => match[1]));
  const cell = ids(m.chartHtml({ cspSource: 'x', scripts: [], embedded: true }));
  const tab = ids(m.chartHtml({ cspSource: 'x', scripts: [] }));
  for (const id of ['tb-add-script', 'tb-split', 'tb-full-chart', 'tb-remove-chart']) {
    assert.ok(cell.has(id), `${id} in a dashboard cell`);
    assert.ok(!tab.has(id), `${id} not in a chart tab`);
  }
  for (const id of ['tb-csv-plot', 'tb-csv-trades']) {
    assert.ok(tab.has(id), `${id} in a chart tab`);
    assert.ok(!cell.has(id), `${id} not in a dashboard cell`);
  }
});
