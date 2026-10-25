import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(import.meta.url);
const bundled = await build({
  entryPoints: [path.join(root, 'src/profile/profileStore.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  write: false,
});
// Evaluated in this realm: deepStrictEqual compares prototypes too
const module = { exports: {} };
vm.runInThisContext(`(function (module, exports, require) {${bundled.outputFiles[0].text}\n})`)(
  module, module.exports, require
);
const store = module.exports;

const sha256 = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');

const PY_TEXT = 'def main():\n    x = 1\n    for i in range(3):\n        x += i\n    return x\n';

function profile(overrides = {}) {
  return {
    schema: 1,
    pynecore: '6.6.0',
    python: '3.14.0',
    bars: 100,
    wall_ns: 4_000_000,
    script_ns: 2_000_000,
    categories: { script: 1_500_000, libraries: 500_000, engine: 0, output: 1_000_000,
                  data: 1_000_000, security: 0, runner: 0 },
    files: [{
      path: '/work/scripts/demo.py',
      sha256: sha256(PY_TEXT),
      role: 'script',
      lines: { 1: [100_000, 100], 2: [200_000, 100], 3: [400_000, 400], 4: [900_000, 300],
               5: [50_000, 100] },
      blocks: [
        { kind: 'def', start: 1, end: 5, ns: 1_650_000, header_ns: 100_000, hits: 100 },
        { kind: 'loop', start: 3, end: 4, ns: 1_300_000, header_ns: 400_000, hits: 400 },
      ],
    }],
    contexts: [],
    ...overrides,
  };
}

function writeProfile(t, content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pyneide-profile-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'demo_profile.json');
  fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
  return file;
}

test('reads a profile of the known schema only', (t) => {
  const loaded = store.loadProfile(writeProfile(t, profile({ contexts: undefined })));
  assert.equal(loaded.bars, 100);
  assert.deepEqual(loaded.contexts, [], 'a profile without contexts reads as having none');
  assert.equal(store.loadProfile(writeProfile(t, profile({ schema: 2 }))), undefined);
  assert.equal(store.loadProfile(writeProfile(t, '{"schema": 1')), undefined);
  assert.equal(store.loadProfile(path.join(os.tmpdir(), 'pyneide-no-such-profile.json')), undefined);
});

test('annotates a Python file only while its content is the measured one', () => {
  const source = store.sourceProfile(profile(), '/work/scripts/demo.py', PY_TEXT);
  assert.deepEqual(source.lines.get(4), { ns: 900_000, hits: 300 });
  assert.equal(source.scriptNs, 2_000_000);
  assert.equal(source.pine, false);
  assert.deepEqual(source.blocks.get(3), { kind: 'loop', start: 3, end: 4, ns: 1_300_000, hits: 400 });

  // The run read the file with universal newlines; an editor may hold CRLF
  assert.ok(store.sourceProfile(profile(), '/work/scripts/demo.py', PY_TEXT.replace(/\n/g, '\r\n')));
  assert.equal(store.sourceProfile(profile(), '/work/scripts/demo.py', `${PY_TEXT}# edited\n`), undefined);
  assert.equal(store.sourceProfile(profile(), '/work/scripts/other.py', PY_TEXT), undefined);
});

test('adds the time of a Pine line up and counts its first mapped statement', () => {
  const measured = profile();
  measured.files[0].lines = {
    3: [10_000, 1],                     // generated header, before the first mapping
    5: [100_000, 100],
    6: [300_000, 100], 7: [50_000, 100], 8: [25_000, 100],  // one statement over three lines
    10: [70_000, 7], 12: [40_000, 9],   // two statements emitted for one Pine line
    14: [5_000, 2],                     // its first statement did not run
  };
  measured.files[0].blocks = [
    { kind: 'if', start: 6, end: 12, ns: 485_000, header_ns: 300_000, hits: 100 },
  ];
  const map = { version: 1, mappings: [[5, 1], [6, 2], [10, 4], [12, 4], [13, 5], [14, 5]] };
  const source = store.sourceProfile(measured, '/work/scripts/demo.py', PY_TEXT, map);

  assert.equal(source.pine, true);
  assert.deepEqual([...source.lines.keys()].sort(), [1, 2, 4, 5]);
  assert.deepEqual(source.lines.get(2), { ns: 375_000, hits: 100 });
  assert.deepEqual(source.lines.get(4), { ns: 110_000, hits: 7 });
  assert.deepEqual(source.lines.get(5), { ns: 5_000, hits: 2 });
  assert.deepEqual(source.blocks.get(2), { kind: 'if', start: 2, end: 4, ns: 485_000, hits: 100 });
});

test('lists each request.security context on the lines it ran', () => {
  const measured = profile({
    contexts: [
      { sec_ids: ['sec·0'], timeframe: '1D', data: 'EURUSD_1D.ohlcv', bars: 20, script_ns: 30_000,
        files: [{ path: '/work/scripts/demo.py', lines: { 2: [30_000, 20] }, blocks: [] }] },
      { sec_ids: ['sec·1'], timeframe: '240', data: 'EURUSD_240.ohlcv', bars: 50, script_ns: 70_000,
        files: [{ path: '/work/scripts/lib.py', lines: { 2: [70_000, 50] }, blocks: [] }] },
    ],
  });
  const source = store.sourceProfile(measured, '/work/scripts/demo.py', PY_TEXT);
  assert.deepEqual(source.contexts.get(2),
    [{ timeframe: '1D', data: 'EURUSD_1D.ohlcv', ns: 30_000, hits: 20 }]);
  assert.equal(source.contexts.size, 1);
});

test('formats durations and shares the way the CLI does', () => {
  assert.equal(store.formatDuration(1_040_000_000), '1.04 s');
  assert.equal(store.formatDuration(51_400_000), '51.4 ms');
  assert.equal(store.formatDuration(1_500), '1.50 µs');
  assert.equal(store.formatDuration(690), '690 ns');
  assert.equal(store.formatShare(1, 8), '12.5%');
  assert.equal(store.formatShare(1, 0), '0.0%');
  assert.equal(store.profilePathFor('/w', '/w/scripts/demo.pine'),
    path.join('/w', 'output', 'demo_profile.json'));
});
