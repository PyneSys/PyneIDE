/** Startup broker selection and reversible drawing visibility regressions. */
import assert from 'node:assert/strict';
import esbuild from 'esbuild';

const built = await esbuild.build({ stdin: { resolveDir: process.cwd(), loader: 'ts', contents: `
  export { defaultBroker } from './src/data/brokerDefaults';
  export { DrawingStore, drawDrawings } from './src/chart/webview/drawings';
  export { labelLinkSpans, parseLabelLink } from './src/chart/labelLinks';
` }, bundle: true, platform: 'node', format: 'cjs', write: false });
const module = { exports: {} };
new Function('module', 'exports', built.outputFiles[0].text)(module, module.exports);
const { defaultBroker, DrawingStore, drawDrawings, labelLinkSpans, parseLabelLink } = module.exports;
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

const fonts = [];
ctx.fillText = (text) => { fonts.push([text, ctx.font]); };
store.apply([
  { i: 2, op: 'update', obj: 'label', id: 1, s: { id: 1, x: 1, y: 11, text: 'both', style: 'none',
    force_overlay: true, text_formatting: ['bold', 'italic'] } },
  { i: 2, op: 'create', obj: 'label', id: 2, s: { id: 2, x: 1, y: 11, text: 'plain', style: 'none',
    force_overlay: true, text_formatting: [] } },
]);
drawDrawings(env, store, xres, false);
assert.deepEqual(fonts, [['both', 'italic bold 14px sans-serif'], ['plain', '14px sans-serif']],
  'text_formatting must style the label font');

const tooltip = 'Docs (https://example.com/guide#L12)\nfile:///tmp/a%20b.py#L7, scripts/demo.pine#L12\n<script>command:quit</script>';
const links = [...labelLinkSpans(tooltip)];
assert.deepEqual(links.map(({ start, target }) => tooltip.slice(start, start + target.length)),
  ['https://example.com/guide#L12', 'file:///tmp/a%20b.py#L7', 'scripts/demo.pine#L12']);
assert.deepEqual(parseLabelLink('./notes%20here.md#L12'),
  { kind: 'relative', path: './notes here.md', line: 12 });
for (const target of ['command:quit', 'javascript:alert(1)', '%2Ftmp/private.txt', 'demo.pine#L0']) {
  assert.equal(parseLabelLink(target), undefined, target);
}

store.apply([{ i: 3, op: 'update', obj: 'label', id: 1, s: {
  id: 1, x: 50, y: 40, style: 'none', text: 'wide', textalign: 'right', tooltip, force_overlay: true,
} }]);
ctx.measureText = () => ({ width: 30 });
const hits = [];
drawDrawings(env, store, xres, false, hits);
assert.deepEqual(hits.map(({ label, x, y, width, height }) => [label.id, x, y, width, height]),
  [[1, 20, 33, 30, 14]], 'only the tooltip-enabled label is hit-testable, using its text alignment');
hidden.add('label');
hits.length = 0;
drawDrawings(env, store, xres, false, hits);
assert.deepEqual(hits, [], 'hidden labels have no tooltip hit regions');
console.log('CHART POLISH SMOKE OK: brokers, reversible drawings, pane routing, text styles and label tooltips');
