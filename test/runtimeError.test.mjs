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
  stdin: { contents: "export * from './src/run/runService';", resolveDir: process.cwd() },
  bundle: true, platform: 'node', format: 'cjs', external: ['vscode'], write: false,
  plugins: [{ name: 'bridge-fixture', setup(build) {
    build.onLoad({ filter: /\/run\/bridgeClient\.ts$/ }, () => ({ contents:
      'export const BridgeRun = {start: (options) => fixture.start(options)};' }));
  } }],
});

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pyneide-runtime-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const script = path.join(root, 'scripts', 'demo.py');
  fs.mkdirSync(path.dirname(script));
  fs.writeFileSync(script, '"""@pyne"""\ndef main():\n    raise ValueError("bad input")\n');
  const markers = new Map();
  const notices = [];
  const opened = [];
  const logs = [];
  const commands = [];
  const closedCharts = [];
  let event;
  let choice;
  let exitCode = 1;
  let missingSource = false;
  let logShows = 0;
  const channel = { name: 'PyneIDE Run', appendLine: (line) => logs.push(line), show: () => logShows++, dispose() {} };
  class Range {
    constructor(startLine, startCharacter, endLine, endCharacter) {
      this.start = { line: startLine, character: startCharacter };
      this.end = { line: endLine, character: endCharacter };
    }
  }
  const vscode = {
    Uri: { file: (fsPath) => ({ fsPath }), joinPath: (uri, part) => ({ fsPath: path.join(uri.fsPath, part) }) },
    Range,
    Diagnostic: class {
      constructor(range, message, severity) { Object.assign(this, { range, message, severity }); }
    },
    DiagnosticSeverity: { Error: 0 }, StatusBarAlignment: { Left: 1 },
    TextEditorRevealType: { InCenterIfOutsideViewport: 2 },
    languages: { createDiagnosticCollection: () => ({ clear: () => markers.clear(), set: (uri, values) => markers.set(uri.fsPath, values) }) },
    workspace: {
      getConfiguration: () => ({ get: (_key, fallback) => fallback }),
      async openTextDocument(uri) {
        if (missingSource) throw new Error('source deleted');
        const lines = fs.readFileSync(uri.fsPath, 'utf8').split('\n');
        return { uri, lineCount: lines.length, lineAt: (line) => ({ range: new Range(line, 0, line, lines[line].length) }) };
      },
    },
    commands: { executeCommand: async (...args) => commands.push(args) },
    window: {
      createOutputChannel: () => channel,
      createStatusBarItem: () => ({ show() {}, hide() {} }),
      async showTextDocument(doc, options) {
        assert.ok(closedCharts.length > 0, 'close the failed chart before focusing the source');
        const entry = { file: doc.uri.fsPath, options };
        opened.push(entry);
        return { revealRange: (range, type) => { entry.reveal = { range, type }; } };
      },
      showErrorMessage: async (message, ...actions) => { notices.push({ severity: 'error', message, actions }); return choice; },
      showWarningMessage: async (message, ...actions) => { notices.push({ severity: 'warning', message, actions }); return choice; },
      setStatusBarMessage() {},
    },
  };
  const module = { exports: {} };
  vm.runInNewContext(bundled.outputFiles[0].text, {
    module, exports: module.exports, require: (name) => name === 'vscode' ? vscode : require(name),
    fixture: {
      start(options) {
        return { exited: Promise.resolve().then(() => {
          if (event) options.onEvent(event);
          return exitCode;
        }) };
      },
    },
    process, Buffer, console, setTimeout, clearTimeout,
  });
  const service = new module.exports.RunService({ extensionUri: { fsPath: process.cwd() } }, {}, {});
  service.attachChart({
    onEvent() {}, onFinished() {}, setDebugPosition() {}, reconcile() {},
    closeChart: (key) => closedCharts.push(key),
  });
  return {
    root, script, markers, notices, opened, logs, commands, closedCharts,
    get logShows() { return logShows; },
    async run(frames, options = {}) {
      event = frames === null ? undefined : {
        e: 'error', kind: options.kind ?? 'ValueError', message: options.message ?? 'bad input',
        traceback: 'Traceback (most recent call last):\n' + frames.map(([file, line, name = 'main']) =>
          `  File "${file}", line ${line}, in ${name}\n    failing_call()\n`).join('') + 'ValueError: bad input\n',
      };
      choice = options.choice;
      exitCode = options.exitCode ?? 1;
      missingSource = options.missingSource ?? false;
      await service.executeRun({
        pythonBin: 'python', scriptPath: script, chartKey: options.chartKey ?? script,
        workdir: root, data: 'demo', ...(options.profile ? { profile: true } : {}),
      });
    },
  };
}

const core = '/env/lib/python3.14/site-packages/pynecore';

test('runtime.error is a script stop; selects the calling Pyne line without offering a report', async (t) => {
  const f = fixture(t);
  await f.run([[`${core}/core/script_runner.py`, 3595], [f.script, 3], [`${core}/lib/runtime.py`, 17, 'error']], {
    kind: 'RuntimeError', message: 'Use standard 1-minute candles.', choice: 'Show Log',
  });
  assert.equal(f.notices[0].severity, 'warning');
  assert.match(f.notices[0].message, /script stopped: Use standard 1-minute candles\. \(demo.py:3\)/);
  assert.deepEqual([...f.notices[0].actions], ['Show Log']);
  assert.equal(f.opened[0].file, f.script);
  assert.equal(f.opened[0].options.selection.start.line, 2);
  assert.equal(f.opened[0].options.preview, false);
  assert.equal(f.opened[0].reveal.range.start.line, 2);
  assert.equal(f.markers.get(f.script)[0].message, 'Use standard 1-minute candles.');
  assert.equal(f.logShows, 1);
  assert.deepEqual(f.closedCharts, [f.script]);
  assert.match(f.logs.join('\n'), /pynecore\/lib\/runtime.py/);
});

test('ordinary script exceptions navigate and mark Python; next successful run clears the error', async (t) => {
  const f = fixture(t);
  await f.run([[f.script, 3]], { kind: 'ZeroDivisionError', message: 'division by zero' });
  assert.equal(f.notices[0].severity, 'error');
  assert.match(f.notices[0].message, /script runtime error: division by zero/);
  assert.deepEqual([...f.notices[0].actions], ['Show Log']);
  assert.equal(f.opened[0].options.selection.start.line, 2);
  assert.equal(f.markers.size, 1);
  await f.run(null, { exitCode: 0 });
  assert.deepEqual(f.closedCharts, [f.script], 'successful runs keep their chart');
  assert.equal(f.markers.size, 0);
  assert.equal(f.notices.length, 1);
});

test('a runtime API failure selects the deepest local library caller, skipping dependency frames', async (t) => {
  const f = fixture(t);
  const lib = path.join(f.root, 'scripts', 'lib', 'signals.py');
  fs.mkdirSync(path.dirname(lib));
  fs.writeFileSync(lib, 'def signal():\n    return 1 / 0\n');
  await f.run([[f.script, 3], [lib, 2], [`${core}/lib/array.py`, 123, 'get']]);
  assert.equal(f.opened[0].file, lib);
  assert.equal(f.opened[0].options.selection.start.line, 1);
  assert.equal(f.markers.get(lib)[0].range.start.line, 1);
  assert.deepEqual([...f.notices[0].actions], ['Show Log']);
});

test('compiled Pine failures select the mapped original line in Profile runs too', async (t) => {
  const f = fixture(t);
  const pine = f.script.replace(/\.py$/, '.pine');
  fs.writeFileSync(pine, '//@version=6\nindicator("Demo")\nruntime.error("bad input")\n');
  fs.writeFileSync(`${f.script}.map`, JSON.stringify({ version: 1, mappings: [[2, 2], [3, 3]] }));
  await f.run([[f.script, 3], [`${core}/lib/runtime.py`, 17, 'error']], { chartKey: pine, profile: true });
  assert.equal(f.opened[0].file, pine);
  assert.equal(f.opened[0].options.selection.start.line, 2);
  assert.equal(f.markers.has(pine), true);
  assert.deepEqual(f.closedCharts, [pine]);
});

for (const invalid of ['stale', 'converted', 'malformed']) {
  test(`${invalid} Pine maps fall back to the executed Python line`, async (t) => {
    const f = fixture(t);
    const pine = f.script.replace(/\.py$/, '.pine');
    fs.writeFileSync(pine, 'different source');
    fs.writeFileSync(`${f.script}.map`, JSON.stringify({
      version: 1, mappings: invalid === 'malformed' ? [null] : [[3, 99]],
      ...(invalid === 'stale' ? { py_sha256: 'different-hash' } : {}),
      ...(invalid === 'converted' ? { converted_source: true } : {}),
    }));
    await f.run([[f.script, 3]], { chartKey: pine });
    assert.equal(f.opened[0].file, f.script);
    assert.equal(f.opened[0].options.selection.start.line, 2);
  });
}

test('a missing source does not turn a script exception into a report prompt', async (t) => {
  const f = fixture(t);
  await f.run([[f.script, 3]], { missingSource: true });
  assert.equal(f.opened.length, 0);
  assert.deepEqual([...f.notices[0].actions], ['Show Log']);
});

test('engine failures without a user frame still offer a report and never open engine files', async (t) => {
  const f = fixture(t);
  // A project-local venv must not be mistaken for user code.
  const engine = path.join(f.root, '.pyneide', 'venv', 'lib', 'site-packages', 'pynecore', 'runner.py');
  await f.run([[engine, 10]], { choice: 'Report a Problem' });
  assert.match(f.notices[0].message, /run failed/);
  assert.ok(f.notices[0].actions.includes('Report a Problem'));
  assert.equal(f.opened.length, 0);
  assert.ok(f.commands.some(([command]) => command === 'pyneide.reportProblem'));
});

test('unexpected process exits retain the internal failure report action', async (t) => {
  const f = fixture(t);
  await f.run(null, { exitCode: 2 });
  assert.match(f.notices[0].message, /runner exited with code 2/);
  assert.ok(f.notices[0].actions.includes('Report a Problem'));
});
