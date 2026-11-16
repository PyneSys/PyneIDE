import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { build } from 'esbuild';

const bundled = await build({
  stdin: {
    contents: [
      "export * from './src/chart/barRows';",
      "export * from './src/chart/liveWindow';",
      "export * from './src/chart/webview/liveSeries';",
      "export { ColorTrack } from './src/chart/webview/colorTrack';",
      "export { DrawingStore, makeXResolver } from './src/chart/webview/drawings';",
      "export { buildTradeMarkerIndex } from './src/chart/webview/tradeMarkers';",
    ].join('\n'),
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  bundle: true, platform: 'node', format: 'cjs', write: false,
});
// The bundle runs in its own realm: compare its arrays and objects as copies
const module = { exports: {} };
vm.runInNewContext(bundled.outputFiles[0].text, { module, exports: module.exports });
const {
  ColorTrack, DrawingStore, LIVE_MAX_BARS, LIVE_TRIM_BARS, TailCalc, buildTradeMarkerIndex,
  datumReach, foldColorRows, formatCountdown, liveTrimCount, makeXResolver, msToPeriodEnd, periodMs, upsertLastBar,
} = module.exports;

test('a bar with the last bar timestamp replaces it, a later one is appended', () => {
  const bars = [{ t: 1, v: 'a' }, { t: 2, v: 'b' }];
  assert.equal(upsertLastBar(bars, { t: 2, v: 'c' }, (b) => b.t), true);
  assert.equal(upsertLastBar(bars, { t: 3, v: 'd' }, (b) => b.t), false);
  assert.deepEqual(bars.map((b) => b.v), ['a', 'c', 'd']);
});

test('the reach of a series covers offsets and show_last', () => {
  assert.deepEqual({ ...datumReach([]) }, { future: 0, back: 1 });
  assert.deepEqual({ ...datumReach([{ offset: 3 }, { offset: -2 }]) }, { future: 3, back: 3 });
  assert.deepEqual({ ...datumReach([{ show_last: 5 }]) }, { future: 0, back: 5 });
});

/** The series a full calc gives: datum i reads bar i - offset, blanked before
 * the last showLast bars. */
function reference(list, { offset = 0, showLast }) {
  return Array.from({ length: list.length + Math.max(0, offset) }, (_d, i) => {
    const src = i - offset;
    if (src < 0 || src >= list.length) return null;
    if (showLast !== undefined && src < list.length - showLast) return null;
    return list[src].v;
  });
}

for (const plot of [{}, { offset: 2 }, { offset: -2 }, { showLast: 3 }, { offset: -1, showLast: 2 }]) {
  test(`a live update recomputes the tail only and matches a full calc (${JSON.stringify(plot)})`, () => {
    const reach = datumReach([{ offset: plot.offset, show_last: plot.showLast }]);
    const tail = new TailCalc(reach);
    const list = Array.from({ length: 10 }, (_d, i) => ({ v: i }));
    let computed = [];
    const calc = () => tail.calc(list, (i) => {
      computed.push(i);
      return reference(list, plot)[i];
    });
    assert.deepEqual([...calc()], reference(list, plot));

    // The forming bar changes, then closes and the next one appears
    list[9] = { v: 90 };
    computed = [];
    assert.deepEqual([...calc()], reference(list, plot));
    assert.ok(Math.min(...computed) >= 10 - reach.back, `recomputed ${computed}`);
    list.push({ v: 10 });
    assert.deepEqual([...calc()], reference(list, plot));
    // Coalesced in one frame: the last bar replaced, then the next one appended
    list[10] = { v: 100 };
    list.push({ v: 11 });
    assert.deepEqual([...calc()], reference(list, plot));

    // A reload is a new list: recomputed in full
    const reloaded = list.slice(0, 5);
    computed = [];
    assert.deepEqual([...tail.calc(reloaded, (i) => {
      computed.push(i);
      return reference(reloaded, plot)[i];
    })], reference(reloaded, plot));
    assert.equal(computed[0], 0);
  });
}

test('a tick color overrides the forming bar only, until cleared', () => {
  const track = new ColorTrack();
  track.addRows([[100, { c: 'red' }]], new Map([[100, 0], [200, 1]]));
  track.setProvisional(1, { c: 'blue' });
  assert.equal(track.colorAt('c', 0), 'red');
  assert.equal(track.colorAt('c', 1), 'blue');
  assert.equal(track.colorAt('constructor', 1), undefined);
  track.clearProvisional();
  assert.equal(track.colorAt('c', 1), 'red');
});

test('tick drawings are reverted before the next tick and before the close', () => {
  const store = new DrawingStore();
  store.apply([{ obj: 'line', op: 'create', id: 1, s: { id: 1, x1: 0 } }]);
  store.applyProvisional([
    { obj: 'line', op: 'update', id: 1, s: { id: 1, x1: 5 } },
    { obj: 'line', op: 'update', id: 1, s: { id: 1, x1: 6 } },
    { obj: 'label', op: 'create', id: 7, s: { id: 7 } },
  ]);
  assert.equal(store.lines.get(1).x1, 6);
  assert.equal(store.labels.size, 1);
  store.applyProvisional([{ obj: 'line', op: 'delete', id: 1 }]);
  assert.equal(store.lines.size, 0);
  assert.equal(store.labels.size, 0);
  store.revertProvisional();
  assert.equal(store.lines.get(1).x1, 0);
  const tables = store.tableVersion;
  store.applyProvisional([{ obj: 'table', op: 'create', id: 2, s: { id: 2, cells: [] } }]);
  store.revertProvisional();
  assert.equal(store.tables.size, 0);
  assert.equal(store.tableVersion, tables + 2);
});

test('bar lengths and the countdown', () => {
  assert.equal(periodMs('5S'), 5_000);
  assert.equal(periodMs('15'), 900_000);
  assert.equal(periodMs('1D'), 86_400_000);
  assert.equal(periodMs('W'), 604_800_000);
  assert.equal(periodMs('1M'), undefined);
  assert.equal(periodMs('x'), undefined);
  assert.equal(msToPeriodEnd(0, 60_000, 15_000), 45_000);
  // The bar ended without a newer one: the next periods follow it
  assert.equal(msToPeriodEnd(0, 60_000, 60_000), 60_000);
  assert.equal(msToPeriodEnd(0, 60_000, 150_000), 30_000);
  assert.equal(formatCountdown(45_000), '0:45');
  assert.equal(formatCountdown(3_725_000), '1:02:05');
  assert.equal(formatCountdown(90_061_000), '1d 01:01:01');
  assert.equal(formatCountdown(-5), '0:00');
});

test('a live chart drops its oldest bars past the limit, a batch at a time', () => {
  assert.equal(liveTrimCount(LIVE_MAX_BARS), 0);
  assert.equal(liveTrimCount(LIVE_MAX_BARS + 1), LIVE_TRIM_BARS + 1);
  assert.equal(LIVE_MAX_BARS + 1 - liveTrimCount(LIVE_MAX_BARS + 1), LIVE_MAX_BARS - LIVE_TRIM_BARS);
});

test('the colors of dropped bars fold into the first bar kept', () => {
  const rows = [[1, { a: 'red', b: 'blue' }], [2, { a: 'green' }], [4, { b: 'black' }], [5, { a: 'white' }]];
  assert.deepEqual([...foldColorRows(rows, 3)].map((r) => [r[0], { ...r[1] }]),
    [[3, { a: 'green', b: 'blue' }], [4, { b: 'black' }], [5, { a: 'white' }]]);
  // The first bar's own delta wins over the folded ones
  assert.deepEqual([...foldColorRows(rows, 4)].map((r) => [r[0], { ...r[1] }]),
    [[4, { a: 'green', b: 'black' }], [5, { a: 'white' }]]);
  assert.equal(foldColorRows(rows, 1).length, 4);
});

test('a shifted color track answers like the original past the dropped bars', () => {
  const tsToIndex = new Map(Array.from({ length: 10 }, (_d, i) => [i * 10, i]));
  const rows = [[0, { c: 'a' }], [20, { c: 'b' }], [30, { d: 'x' }], [70, { c: 'e' }]];
  for (const drop of [1, 2, 3, 5, 8]) {
    const before = new ColorTrack();
    before.addRows(rows, tsToIndex);
    const after = new ColorTrack();
    after.addRows(rows, tsToIndex);
    after.shift(drop);
    for (let i = drop; i < 10; i++) {
      for (const channel of ['c', 'd']) {
        assert.equal(after.colorAt(channel, i - drop), before.colorAt(channel, i), `drop ${drop} bar ${i} ${channel}`);
      }
    }
  }
});

test('a bar_index drawing x maps onto the bars of a trimmed chart', () => {
  const bars = [{ timestamp: 1000 }, { timestamp: 2000 }];
  const xres = makeXResolver(bars, new Map([[1000, 0], [2000, 1]]), () => 500);
  assert.equal(xres.toIndex(501, 'bar_index'), 1);
  assert.equal(xres.toIndex(2000, 'bar_time'), 1);
});

test('the trades of dropped bars leave no marker on a trimmed chart', () => {
  // Bar indices 500 and 501 are kept; the timestamps of resampled trades miss
  const bars = [{ timestamp: 1000, high: 2, low: 1 }, { timestamp: 2000, high: 2, low: 1 }];
  const tsToIndex = new Map([[1000, 0], [2000, 1]]);
  const trade = (entryBar, exitBar) => ({
    size: 1, entryTime: 1, entryBar, entryPrice: 1.5, entryId: 'L',
    exitTime: 2, exitBar, exitPrice: 1.6,
  });
  const before = buildTradeMarkerIndex([trade(0, 3)], bars, tsToIndex, 500);
  assert.equal(before.size, 0);
  const spanning = buildTradeMarkerIndex([trade(10, 501)], bars, tsToIndex, 500);
  assert.deepEqual([...spanning.keys()], [1]);
  assert.deepEqual([...spanning.get(1)].map((item) => item.kind), ['price']);
});
