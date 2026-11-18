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
  stdin: { contents: "export * from './src/run/runService'; export * from './src/run/dataSelect'; export * from './src/run/liveChartService'; export { ChartManager } from './src/chart/chartPanel';", resolveDir: process.cwd() },
  bundle: true, platform: 'node', format: 'cjs', external: ['vscode'], write: false,
  plugins: [{ name: 'bridge-fixture', setup(build) {
    build.onLoad({ filter: /\/run\/bridgeClient\.ts$/ }, () => ({ contents:
      'export const BridgeRun = {start: (options) => fixture.start(options)};' }));
    build.onLoad({ filter: /\/data\/symbolBrowserPanel\.ts$/ }, () => ({ contents:
      'export const SymbolBrowserPanel = {show: (...args) => fixture.showSymbolBrowser(...args)};' }));
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
  const state = new Map();
  const picks = [];
  const browsers = [];
  let receiveChartMessage;
  let bridgeStart;
  let pickDownload = false;
  const context = {
    extensionUri: { fsPath: process.cwd() },
    subscriptions: [],
    workspaceState: {
      get: (key, fallback) => state.get(key) ?? fallback,
      async update(key, value) { state.set(key, value); },
    },
    globalState: { async update() {} },
  };
  let event;
  let choice;
  let exitCode = 1;
  let missingSource = false;
  let logShows = 0;
  const channel = {
    name: 'PyneIDE Run',
    appendLine: (line) => logs.push(line),
    clear: () => { logs.length = 0; },
    show: () => logShows++,
    dispose() {},
  };
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
    ViewColumn: { Beside: 2 },
    languages: { createDiagnosticCollection: () => ({ clear: () => markers.clear(), set: (uri, values) => markers.set(uri.fsPath, values) }) },
    workspace: {
      getConfiguration: () => ({ get: (_key, fallback) => fallback }),
      onDidChangeConfiguration() {},
      async openTextDocument(uri) {
        if (missingSource) throw new Error('source deleted');
        const source = fs.readFileSync(uri.fsPath, 'utf8');
        const lines = source.split('\n');
        return {
          uri, languageId: 'python', getText: () => source, lineCount: lines.length,
          lineAt: (line) => ({ range: new Range(line, 0, line, lines[line].length) }),
        };
      },
    },
    commands: { executeCommand: async (...args) => commands.push(args) },
    window: {
      createOutputChannel: () => channel,
      createStatusBarItem: () => ({ show() {}, hide() {} }),
      tabGroups: { all: [] },
      createWebviewPanel: () => ({
        webview: {
          asWebviewUri: (uri) => uri.fsPath,
          onDidReceiveMessage: (callback) => { receiveChartMessage = callback; },
        },
        reveal() {},
        onDidChangeViewState() {},
        onDidDispose() {},
      }),
      async showTextDocument(doc, options) {
        assert.ok(closedCharts.length > 0, 'close the failed chart before focusing the source');
        const entry = { file: doc.uri.fsPath, options };
        opened.push(entry);
        return { revealRange: (range, type) => { entry.reveal = { range, type }; } };
      },
      showErrorMessage: async (message, ...actions) => { notices.push({ severity: 'error', message, actions }); return choice; },
      showWarningMessage: async (message, ...actions) => { notices.push({ severity: 'warning', message, actions }); return choice; },
      async showQuickPick(items) {
        picks.push(items);
        if (pickDownload) return items.find((item) => item.action === 'download');
        return items.find((item) => item.name === 'replacement');
      },
      setStatusBarMessage() {},
    },
  };
  const module = { exports: {} };
  vm.runInNewContext(bundled.outputFiles[0].text, {
    module, exports: module.exports, require: (name) => name === 'vscode' ? vscode : require(name),
    fixture: {
      showSymbolBrowser(context, deps) { browsers.push({ context, deps }); },
      start(options) {
        if (bridgeStart) return bridgeStart(options);
        return { exited: Promise.resolve().then(() => {
          if (event) options.onEvent(event);
          return exitCode;
        }) };
      },
    },
    process, Buffer, console, setTimeout, clearTimeout,
  });
  const service = new module.exports.RunService(context, { ensureReady: async () => 'python' }, {});
  service.attachChart({
    onEvent() {}, onFinished() {}, setDebugPosition() {}, reconcile() {},
    closeChart: (key) => closedCharts.push(key),
  });
  const liveCharts = new module.exports.LiveChartService(context, {
    openLiveChart() {}, onEvent() {}, closeChart: (key) => closedCharts.push(key),
  }, channel);
  return {
    root, script, markers, notices, opened, logs, commands, closedCharts, state, picks, browsers,
    attachChartPicker(pickLiveTarget, start) {
      const chart = new module.exports.ChartManager(context);
      service.attachChart(chart);
      service.resolveOrInitWorkdir = async () => root;
      service.setPickLiveTarget(pickLiveTarget);
      bridgeStart = start;
      let selection;
      chart.onSelectData = (chartKey, live) => { selection = service.reselectChartData(chartKey, live); };
      return {
        show: (event) => chart.onEvent(event, script),
        run: () => service.runLive(vscode.Uri.file(script)),
        selectSymbol: () => {
          receiveChartMessage({ type: 'selectData' });
          return selection;
        },
      };
    },
    remembered: (key = script) => module.exports.getRememberedData(context, root, key),
    selectData: (key = script) => module.exports.pickRunData(context, root, key, 'python', channel),
    selectDownloadData: () => {
      pickDownload = true;
      return module.exports.pickRunData(context, root, script, 'python', channel);
    },
    get logShows() { return logShows; },
    async run(frames, options = {}) {
      event = frames === null ? undefined : {
        e: 'error', kind: options.kind ?? 'ValueError', message: options.message ?? 'bad input',
        traceback: 'Traceback (most recent call last):\n' + frames.map(([file, line, name = 'main']) =>
          `  File "${file}", line ${line}, in ${name}\n    failing_call()\n`).join('') + 'ValueError: bad input\n',
        ...(options.coded ?? {}),
      };
      choice = options.choice;
      exitCode = options.exitCode ?? 1;
      missingSource = options.missingSource ?? false;
      const live = { provider: 'test:SYMBOL@1', from: '-5', historyTrades: false };
      if (options.standalone) {
        await liveCharts.openTarget(live, { pythonBin: 'python', workdir: root, resource: vscode.Uri.file(root) });
        return;
      }
      if (options.prepareLive) {
        const doc = { uri: vscode.Uri.file(script), languageId: 'python', getText: () => fs.readFileSync(script, 'utf8') };
        service.resolveDocument = async () => doc;
        service.resolveOrInitWorkdir = async () => root;
        service.setPickLiveTarget(async () => live);
        await service.runLive(doc.uri);
        return;
      }
      await service.executeRun({
        pythonBin: 'python', scriptPath: script, chartKey: options.chartKey ?? script,
        workdir: root, data: 'demo', ...(options.profile ? { profile: true } : {}),
        ...(options.live ? { live } : {}),
      });
    },
  };
}

const core = '/env/lib/python3.14/site-packages/pynecore';

test('downloading from the data picker opens the Symbol Browser and aborts selection', async (t) => {
  const f = fixture(t);
  const bindings = { [f.script]: 'previous', 'other.py': 'other' };
  f.state.set('pyneide.lastRunData', bindings);
  assert.equal(await f.selectDownloadData(), undefined);
  assert.equal(f.picks.length, 1, 'do not continue into the wizard or reopen the picker');
  assert.equal(f.browsers.length, 1);
  assert.equal(f.browsers[0].deps.workdir, f.root);
  assert.equal(f.browsers[0].deps.pythonBin, 'python');
  assert.equal(f.browsers[0].deps.bridgeRoot, path.join(process.cwd(), 'python'));
  assert.equal(f.state.get('pyneide.lastRunData'), bindings, 'keep existing bindings unchanged');
  assert.equal(f.commands.length, 0, 'do not restart the script');
});

test('failed runs forget only their own data binding and allow a fresh choice', async (t) => {
  const f = fixture(t);
  const otherScript = path.join(f.root, 'scripts', 'other.py');
  fs.mkdirSync(path.join(f.root, 'data'));
  for (const stem of ['demo', 'other', 'replacement']) {
    fs.writeFileSync(path.join(f.root, 'data', `${stem}.ohlcv`), 'fixture');
  }
  f.state.set('pyneide.lastRunData', { [f.script]: 'demo', [otherScript]: 'other' });
  assert.equal(f.remembered(), 'demo');
  await f.run([[f.script, 3], [`${core}/lib/runtime.py`, 17, 'error']]);
  assert.equal(f.remembered(), undefined);
  assert.equal(f.remembered(otherScript), 'other');
  assert.equal(await f.selectData(), 'replacement');
  assert.equal(f.picks.length, 1);
  assert.equal(f.remembered(), 'replacement');
  await f.run(null, { exitCode: 0 });
  assert.equal(f.remembered(), 'replacement', 'successful runs keep their data binding');
});

test('Pine errors clear the shared Pine/Python data binding', async (t) => {
  const f = fixture(t);
  const pine = f.script.replace(/\.py$/, '.pine');
  f.state.set('pyneide.lastRunData', { [pine]: 'demo' });
  await f.run([[f.script, 3]], { chartKey: pine });
  assert.equal(Object.hasOwn(f.state.get('pyneide.lastRunData'), pine), false);
});

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

test('a run of the compiled .py selects its own line even with a valid Pine map beside it', async (t) => {
  const f = fixture(t);
  const pine = f.script.replace(/\.py$/, '.pine');
  fs.writeFileSync(pine, '//@version=6\nindicator("Demo")\nruntime.error("bad input")\n');
  fs.writeFileSync(`${f.script}.map`, JSON.stringify({ version: 1, mappings: [[2, 2], [3, 3]] }));
  await f.run([[f.script, 3], [`${core}/lib/runtime.py`, 17, 'error']]);
  assert.equal(f.opened[0].file, f.script);
  assert.equal(f.opened[0].options.selection.start.line, 2);
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

test('a coded runtime.error is a script stop at the line PyneCore located', async (t) => {
  const f = fixture(t);
  // The traceback names another line: a coded error is not mined from it
  await f.run([[f.script, 2]], {
    kind: 'ScriptRuntimeError', message: 'stopped', coded: {
      code: 'R0005', params: { message: 'stopped' }, bar: 5, time: 0, inSecurity: false,
      at: { module: 'main', path: f.script, line: 3, col: 9, pineLine: null },
    },
  });
  assert.equal(f.notices[0].severity, 'warning');
  assert.match(f.notices[0].message, /script stopped: R0005: stopped \(demo.py:3\)/);
  assert.equal(f.opened[0].file, f.script);
  assert.equal(f.opened[0].options.selection.start.line, 2);
  assert.equal(f.markers.get(f.script)[0].code, 'R0005');
});

test('a coded error without a location falls back to its traceback', async (t) => {
  const f = fixture(t);
  // Raised while importing the script: PyneCore never located it (at: null)
  await f.run([[f.script, 3]], {
    kind: 'ScriptRuntimeError', message: 'stopped', coded: {
      code: 'R0005', params: { message: 'stopped' }, bar: null, time: null, inSecurity: false, at: null,
    },
  });
  assert.equal(f.notices[0].severity, 'warning');
  assert.match(f.notices[0].message, /script stopped: R0005: stopped \(demo.py:3\)/);
  assert.equal(f.opened[0].file, f.script);
  assert.equal(f.opened[0].options.selection.start.line, 2);
  assert.ok(!f.notices[0].actions.includes('Report a Problem'));
});

test('a coded error of a compiled Pine script opens the Pine line PyneCore found', async (t) => {
  const f = fixture(t);
  const pine = f.script.replace(/\.py$/, '.pine');
  fs.writeFileSync(pine, '//@version=6\nindicator("Demo")\nx = 1\ny = 2\n');
  await f.run([[f.script, 3]], {
    kind: 'DivisionByZeroError', message: 'Division by zero.', chartKey: pine, coded: {
      code: 'R0001', params: {}, bar: 7, time: 0, inSecurity: false,
      at: { module: 'main', path: f.script, line: 3, col: 5, pineLine: 4 },
    },
  });
  assert.equal(f.notices[0].severity, 'error');
  assert.match(f.notices[0].message, /script runtime error: R0001: Division by zero\./);
  assert.equal(f.opened[0].file, pine);
  assert.equal(f.opened[0].options.selection.start.line, 3);
});

test('a coded error of a run of the compiled .py opens the .py line, not the Pine line', async (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.script.replace(/\.py$/, '.pine'), '//@version=6\nindicator("Demo")\nx = 1\ny = 2\n');
  await f.run([[f.script, 3]], {
    kind: 'DivisionByZeroError', message: 'Division by zero.', coded: {
      code: 'R0001', params: {}, bar: 7, time: 0, inSecurity: false,
      at: { module: 'main', path: f.script, line: 3, col: 5, pineLine: 4 },
    },
  });
  assert.equal(f.opened[0].file, f.script);
  assert.equal(f.opened[0].options.selection.start.line, 2);
});

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

test('both Live entry points offer a PyneCore update scoped to the failed chart', async (t) => {
  for (const standalone of [false, true]) {
    const f = fixture(t);
    await f.run([], {
      live: true, standalone, kind: 'LiveUnsupported', choice: 'Update PyneCore',
      coded: { traceback: '' },
    });
    assert.equal(f.closedCharts.length, 1);
    assert.deepEqual(f.notices[0].actions, ['Update PyneCore']);
    assert.equal(f.opened.length, 0);
    const update = f.commands.find(([command]) => command === 'pyneide.updatePyneCore');
    assert.equal(update?.[1].fsPath, standalone ? f.root : f.script);
  }
});

test('Run Live clears prior output before logging the new script preparation', async (t) => {
  const f = fixture(t);
  f.logs.push('log from a previous run');
  await f.run([], {
    prepareLive: true, kind: 'LiveUnsupported', message: 'PyneCore cannot run live charts',
    coded: { traceback: '' },
  });
  assert.match(f.logs[0], /^Run requested:/);
  assert.ok(f.logs.some((line) => line.startsWith('--- Live:')));
  assert.ok(f.logs.includes('PyneCore cannot run live charts'));
  assert.ok(!f.logs.includes('log from a previous run'));
});

test('the chart symbol button keeps a script live when changing symbols', async (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.script, '"""@pyne"""\nscript.strategy("Demo")\n');
  const previous = { provider: 'ccxt:BYBIT:BTC/USDT:USDT@15', from: '-1000', historyTrades: true };
  const next = { ...previous, provider: 'ccxt:BYBIT:ETH/USDT:USDT@15' };
  const savedData = { [f.script]: 'downloaded' };
  f.state.set('pyneide.lastRunData', savedData);
  f.state.set('pyneide.liveTarget', { [f.script]: previous });
  const requests = [];
  const launches = [];
  let resolveFirstRun;
  let stops = 0;
  let target;
  const chart = f.attachChartPicker(async (request) => {
    requests.push(request);
    return target;
  }, (options) => {
    launches.push(options);
    if (launches.length > 1) return { exited: Promise.resolve(0) };
    return {
      exited: new Promise((resolve) => { resolveFirstRun = resolve; }),
      cancel: () => { stops++; resolveFirstRun(0); },
    };
  });
  const running = chart.run();
  await new Promise(setImmediate);
  assert.equal(launches[0].live.provider, previous.provider);
  chart.show({ e: 'start', live: previous });

  await chart.selectSymbol();
  assert.equal(requests[0].strategy, true);
  assert.equal(requests[0].timeframe, '15');
  assert.equal(requests[0].from, '-1000');
  assert.equal(requests[0].historyTrades, true);
  assert.equal(stops, 0, 'cancelling the picker leaves the current feed running');
  assert.equal(f.state.get('pyneide.liveTarget')[f.script], previous);

  target = next;
  await chart.selectSymbol();
  await running;
  assert.equal(stops, 1);
  assert.equal(launches.length, 2);
  assert.equal(launches[1].live.provider, next.provider);
  assert.equal(launches[1].script, f.script);
  assert.equal(launches[1].data, undefined);
  assert.equal(f.state.get('pyneide.liveTarget')[f.script], next);
  assert.equal(f.state.get('pyneide.lastRunData'), savedData);
  assert.equal(f.picks.length, 0);
});

test('the same symbol button selects downloaded data after a historical run', async (t) => {
  const f = fixture(t);
  f.state.set('pyneide.liveTarget', { [f.script]: { provider: 'test:SYMBOL@1', from: '-5', historyTrades: false } });
  const chart = f.attachChartPicker(() => assert.fail('the live picker must not open'));
  fs.mkdirSync(path.join(f.root, 'data'));
  fs.writeFileSync(path.join(f.root, 'data', 'demo.ohlcv'), 'fixture');
  f.state.set('pyneide.lastRunData', { [f.script]: 'demo' });
  chart.show({ e: 'start' });
  await chart.selectSymbol();
  assert.equal(f.picks.length, 1);
});
