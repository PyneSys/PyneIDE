/** Startup broker selection and reversible drawing visibility regressions. */
import assert from 'node:assert/strict';
import esbuild from 'esbuild';

const built = await esbuild.build({ stdin: { resolveDir: process.cwd(), loader: 'ts', contents: `
  export { defaultBroker } from './src/data/brokerDefaults';
  export { DrawingStore, drawDrawings } from './src/chart/webview/drawings';
` }, bundle: true, platform: 'node', format: 'cjs', write: false });
const module = { exports: {} };
new Function('module', 'exports', built.outputFiles[0].text)(module, module.exports);
const { defaultBroker, DrawingStore, drawDrawings } = module.exports;
const brokers = [{ id: 'alpaca' }, { id: 'kraken' }, { id: 'bybit' }];
assert.equal(defaultBroker('ccxt', brokers), 'kraken');
assert.equal(defaultBroker('ccxt', brokers, 'bybit'), 'bybit');
assert.equal(defaultBroker('ccxt', brokers, 'missing'), 'kraken');
assert.equal(defaultBroker('other', brokers), 'alpaca');
assert.equal(defaultBroker('ccxt', []), undefined);
assert.equal(defaultBroker('ccxt', [{ id: 'other' }]), 'other');

const hidden = new Set();
const store = new DrawingStore(hidden);
store.apply([{ i: 0, op: 'create', obj: 'label', id: 1,
  s: { id: 1, x: 0, y: 10, text: 'entry', style: 'none', force_overlay: true } }]);
const painted = [];
const ctx = { save() {}, restore() {}, beginPath() {}, rect() {}, clip() {},
  fillText(text) { painted.push(text); } };
const env = { ctx, overlay: true, bars: [], bounding: { width: 300, height: 200 },
  xAxis: { convertToPixel: value => value }, yAxis: { convertToPixel: value => value } };
const xres = { toIndex: value => value };
drawDrawings(env, store, xres, false);
assert.deepEqual(painted, ['entry']);
hidden.add('label');
assert.equal(store.hasCanvasFor(true, false), false);
store.apply([{ i: 1, op: 'update', obj: 'label', id: 1,
  s: { id: 1, x: 1, y: 11, text: 'updated entry', style: 'none', force_overlay: true } }]);
painted.length = 0;
drawDrawings(env, store, xres, false);
assert.deepEqual(painted, [], 'hidden labels must not paint');
assert.equal(store.labels.size, 1, 'hiding must retain the drawing data');
hidden.delete('label');
drawDrawings(env, store, xres, false);
assert.deepEqual(painted, ['updated entry'], 'showing must use updates received while hidden');
assert.equal(store.hasCanvasFor(true, false), true);
assert.equal(store.hasCanvasFor(false, false), false, 'force_overlay routing must stay intact');
console.log('CHART POLISH SMOKE OK: initial/saved brokers, reversible labels, hidden updates, pane routing');
