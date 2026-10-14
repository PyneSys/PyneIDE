/** Draw-callback regressions for future fills and offset/show_last plots. */
import assert from 'node:assert/strict';
import esbuild from 'esbuild';

const built = await esbuild.build({ entryPoints: ['src/chart/webview/plotStyles.ts'],
  bundle: true, platform: 'node', format: 'cjs', write: false });
const module = { exports: {} };
new Function('module', 'exports', built.outputFiles[0].text)(module, module.exports);
const { drawFills, drawAreas, drawSteplines } = module.exports;
const paths = [];
let current = [];
const ctx = {
  setLineDash() {}, beginPath() { current = []; },
  moveTo(x, y) { current.push([x, y]); }, lineTo(x, y) { current.push([x, y]); },
  closePath() {}, fill() { paths.push(current); }, stroke() { paths.push(current); },
};
const env = {
  ctx, bars: Array.from({ length: 4 }, (_, i) => ({ plots: [10 + i, 20 + i] })),
  visibleFrom: 0, visibleTo: 10, xAxis: { convertToPixel: i => i },
  yAxis: { convertToPixel: v => v }, bounding: { width: 10, height: 40 },
  colorAt: () => '#00FF0040',
};
function fill(offset, extra = {}) {
  paths.length = 0;
  const a = { id: 'a', kind: 'plot', offset, ...extra };
  const b = { id: 'b', kind: 'plot', offset, ...extra };
  drawFills(env, [{ meta: { id: 'fill', kind: 'fill', dynamic: true },
    a: { plotIndex: 0, plotMeta: a }, b: { plotIndex: 1, plotMeta: b } }]);
  return paths.flat();
}
assert.deepEqual(fill(2).map(p => p[0]), [2, 3, 4, 5, 5, 4, 3, 2]);
assert.equal(Math.max(...fill(-2).map(p => p[0])), 1, 'negative offsets must not project');
assert.equal(Math.max(...fill(0).map(p => p[0])), 3, 'unshifted fills end at real data');
assert.equal(Math.min(...fill(2, { show_last: 2 }).map(p => p[0])), 4,
  'show_last selects source bars before shifting');
env.visibleFrom = 4;
assert.equal(Math.max(...fill(2).map(p => p[0])), 5, 'future-only viewport must retain fill');
paths.length = 0;
drawAreas(env, [{ plotIndex: 0, meta: { id: 'a', kind: 'plot', offset: 2 }, fallbackColor: '#00FF00' }]);
assert.equal(Math.max(...paths.flat().map(p => p[0])), 5, 'area tail missing');
paths.length = 0;
drawSteplines(env, [{ plotIndex: 0, meta: { id: 'a', kind: 'plot', offset: 2, style: 'stepline' },
  fallbackColor: '#00FF00' }]);
assert.ok(paths.flat().some(p => p[0] === 5), 'stepline tail missing');
console.log('PLOT OFFSET SMOKE OK: positive/negative/zero offsets, show_last, future viewport, area, steps');
