/**
 * Environment bootstrap smoke test — runs WITHOUT VSCode.
 * Downloads uv, creates the pinned venv, installs packages, verifies imports.
 * Usage: node dist/env-smoke.js [storageDir]
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { sha256 } from '../../src/compile/sourcemap';
import { demangleName, demangleVariables } from '../../src/debug/demangle';
import { PineSourceMapper } from '../../src/debug/sourceMapper';
import { bootstrapManagedEnv } from '../../src/env/bootstrap';
import { execChecked } from '../../src/env/exec';
import { venvPythonPath, managedVenvDir, pyneBinPath } from '../../src/env/uv';
import { findWorkdir, resolveWorkdir, scaffoldWorkdirWithCli } from '../../src/env/workdir';
import { BridgeRun, type BridgeEvent } from '../../src/run/bridgeClient';
import { DapClient } from './dapClient';

const log = (msg: string): void => console.log(msg);

function waitFor(check: () => boolean, what: string, timeoutMs = 60000): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = (): void => {
      if (check()) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error(`timeout: ${what}`));
      setTimeout(tick, 50);
    };
    tick();
  });
}

/** Pyne script with persistent + series state for the debug smoke test. */
const DBGVARS_SCRIPT = `"""
@pyne
Debug variables smoke script
"""
from pynecore import Persistent, Series
from pynecore.lib import script, close, plot


@script.indicator(title="Debug Vars", overlay=True)
def main():
    counter: Persistent[int] = 0
    counter += 1
    smooth: Series[float] = close
    avg = (smooth[0] + smooth[1]) / 2 if counter > 1 else close
    plot(avg, title="avg")
`;

/**
 * Evaluate a pyneide_bridge.debug_inspect helper (base64 JSON array of scalar
 * entries) exactly as the IDE-side DAP proxy does, and decode it.
 */
async function evalPineHelper(
  dap: DapClient,
  frameId: number,
  fn: string,
  call: string
): Promise<Record<string, string>[]> {
  const res = (await dap.request('evaluate', {
    expression: `__import__("pyneide_bridge.debug_inspect", fromlist=["${fn}"]).${call}`,
    frameId,
    context: 'watch',
  })) as { result: string };
  const b64 = /^'([A-Za-z0-9+/=]*)'$/.exec(res.result)?.[1];
  if (b64 === undefined) {
    throw new Error(`debug: ${fn} returned no base64 payload: ${res.result}`);
  }
  const decoded = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
  return Array.isArray(decoded) ? decoded : [];
}

/**
 * Debug round-trip: bridge with a debugpy listener + a raw DAP client.
 * Covers the import-hook line-preservation contract (the breakpoint is set on
 * a source line of the heavily AST-transformed script and must bind and stop
 * exactly there, with locals visible) and the Pine introspection the IDE-side
 * DAP proxy composes its three scopes from: pine_slots (named Locals state),
 * pine_bar (the Pyne current-bar scope) and pine_globals (imported sources +
 * constants), plus a slot evaluate rendering through the SeriesImpl plugin.
 */
async function debugSmoke(pythonBin: string, bridgeRoot: string, workdir: string): Promise<void> {
  const scriptPath = path.join(workdir, 'scripts', 'dbgvars.py');
  fs.writeFileSync(scriptPath, DBGVARS_SCRIPT);
  const scriptLines = DBGVARS_SCRIPT.split('\n');
  // The breakpoint sits on the `avg = ...` line: by then the persistent
  // increment and the series add of THIS bar ran, so `smooth` must be a
  // visible local. (Known pynecore transform issue: the rewritten series-add
  // statement itself carries fix_missing_locations fallback positions, so a
  // breakpoint on the LAST source line fires early, mid-assignment — the
  // plain statement lines used here are mapped correctly.)
  const bpLine = scriptLines.findIndex((l) => l.includes('avg =')) + 1;
  if (bpLine <= 0) throw new Error('debug: breakpoint anchor not found in dbgvars.py');

  let endpoint: { host: string; port: number } | undefined;
  const events: BridgeEvent[] = [];
  const run = BridgeRun.start({
    pythonBin,
    bridgeRoot,
    script: 'dbgvars',
    data: 'demo',
    workdir,
    batchSize: 1,
    debugpyPort: 0,
    onEvent: (ev) => {
      events.push(ev);
      if (ev.e === 'debugpy') endpoint = ev;
    },
    onLog: (line) => log(`[debug-bridge] ${line}`),
  });
  await waitFor(() => endpoint !== undefined, 'debugpy endpoint from the bridge');

  const dap = await DapClient.connect(endpoint!.host, endpoint!.port);
  try {
    await dap.request('initialize', {
      adapterID: 'pyne',
      pathFormat: 'path',
      linesStartAt1: true,
      columnsStartAt1: true,
    });
    // pydevd rejects an EMPTY arguments object on attach; VSCode always sends
    // the resolved launch config here, so mirror that shape.
    const attachDone = dap.request('attach', { justMyCode: false });
    await dap.waitForEvent('initialized');
    const setBp = (await dap.request('setBreakpoints', {
      source: { path: scriptPath },
      breakpoints: [{ line: bpLine }],
    })) as { breakpoints: { verified: boolean; line?: number }[] };
    if (!setBp.breakpoints[0]?.verified) {
      throw new Error(`debug: breakpoint did not verify: ${JSON.stringify(setBp)}`);
    }
    await dap.request('configurationDone', {});
    await attachDone;

    const stopped = (await dap.waitForEvent('stopped')) as {
      reason: string;
      threadId: number;
    };
    if (stopped.reason !== 'breakpoint') {
      throw new Error(`debug: unexpected stop reason: ${stopped.reason}`);
    }
    const stack = (await dap.request('stackTrace', { threadId: stopped.threadId })) as {
      stackFrames: { id: number; line: number; name: string; source?: { path?: string } }[];
    };
    const frame = stack.stackFrames[0];
    if (!frame || frame.line !== bpLine || !frame.source?.path?.endsWith('dbgvars.py')) {
      throw new Error(
        `debug: import hook broke line numbers — stopped at ` +
          `${frame?.source?.path}:${frame?.line}, expected dbgvars.py:${bpLine}`
      );
    }
    const scopes = (await dap.request('scopes', { frameId: frame.id })) as {
      scopes: { name: string; variablesReference: number }[];
    };
    const locals = (await dap.request('variables', {
      variablesReference: scopes.scopes[0].variablesReference,
    })) as { variables: { name: string; value: string }[] };
    const names = locals.variables.map((v) => v.name);
    if (!names.includes('smooth')) {
      throw new Error(`debug: 'smooth' local missing from the stopped frame: ${names.join(', ')}`);
    }

    // Pine state introspection, exactly as the IDE-side DAP proxy does it:
    // the helper lists the named persistent/series slots of the frame...
    const slotsEval = (await dap.request('evaluate', {
      expression:
        '__import__("pyneide_bridge.debug_inspect", fromlist=["pine_slots"])' +
        '.pine_slots(locals(), globals(), "main")',
      frameId: frame.id,
      context: 'watch',
    })) as { result: string };
    const b64 = /^'([A-Za-z0-9+/=]*)'$/.exec(slotsEval.result)?.[1];
    if (b64 === undefined) {
      throw new Error(`debug: pine_slots returned no base64 payload: ${slotsEval.result}`);
    }
    const slots = JSON.parse(Buffer.from(b64, 'base64').toString('utf8')) as {
      name: string;
      param: string;
      slot: number;
      kind: string;
    }[];
    const counter = slots.find((s) => s.name === 'counter');
    const smooth = slots.find((s) => s.name === 'smooth');
    if (counter?.kind !== 'var' || smooth?.kind !== 'series') {
      throw new Error(`debug: pine_slots missed the state names: ${JSON.stringify(slots)}`);
    }
    // The synthetic Pyne scope: the current bar's runtime values, read live off
    // pynecore.lib. bar_index leads (the first thing a Pine dev looks for).
    const bar = await evalPineHelper(dap, frame.id, 'pine_bar', 'pine_bar()');
    const barIndex = bar.find((c) => c.name === 'bar_index');
    const closeBar = bar.find((c) => c.name === 'close');
    if (barIndex === undefined || !/^\d+$/.test(barIndex.value) || closeBar === undefined) {
      throw new Error(`debug: Pyne scope missing bar_index/close: ${JSON.stringify(bar)}`);
    }
    // The curated Globals scope: the script's imported value sources. dbgvars
    // imports `close`, which the transform rewrote to lib.close — pine_globals
    // must reconstruct it from the source and resolve its current value.
    const globals = await evalPineHelper(dap, frame.id, 'pine_globals', 'pine_globals(globals())');
    const closeGlobal = globals.find((c) => c.name === 'close');
    if (closeGlobal === undefined || !/\d/.test(closeGlobal.value)) {
      throw new Error(
        `debug: Globals scope missing imported source 'close': ${JSON.stringify(globals)}`
      );
    }

    // Watch resolution: the transform rewrote `close` to lib.close and dropped
    // the import, so a bare `close` watch is a NameError until bind_sources
    // binds it into the module globals (the proxy does this at every stop; the
    // raw DAP client here calls it directly). Then `close` must evaluate.
    const bound = (await dap.request('evaluate', {
      expression:
        '__import__("pyneide_bridge.debug_inspect", fromlist=["bind_sources"]).bind_sources(globals())',
      frameId: frame.id,
      context: 'watch',
    })) as { result: string };
    if (!/^[1-9]/.test(bound.result)) {
      throw new Error(`debug: bind_sources bound no imported sources: ${bound.result}`);
    }
    const closeWatch = (await dap.request('evaluate', {
      expression: 'close',
      frameId: frame.id,
      context: 'watch',
    })) as { result: string };
    if (!/^\d/.test(closeWatch.result.replace('-', ''))) {
      throw new Error(`debug: bare 'close' watch did not resolve after bind: ${closeWatch.result}`);
    }
    // ...and the slots evaluate to live values: the persistent already
    // incremented on this first bar, the series buffer renders through the
    // SeriesImpl presentation plugin (pydevd_plugins/).
    const counterEval = (await dap.request('evaluate', {
      expression: `${counter.param}[${counter.slot}]`,
      frameId: frame.id,
      context: 'watch',
    })) as { result: string };
    if (counterEval.result !== '1') {
      throw new Error(`debug: persistent slot value mismatch: ${counterEval.result}`);
    }
    const seriesEval = (await dap.request('evaluate', {
      expression: `${smooth.param}[${smooth.slot}]`,
      frameId: frame.id,
      context: 'watch',
    })) as { result: string };
    if (!seriesEval.result.includes('Series(')) {
      throw new Error(`debug: SeriesImpl presentation plugin inactive: ${seriesEval.result}`);
    }

    // Clear the (per-bar) breakpoint and let the run finish.
    await dap.request('setBreakpoints', { source: { path: scriptPath }, breakpoints: [] });
    await dap.request('continue', { threadId: stopped.threadId });
  } finally {
    dap.close();
  }

  const exitCode = await run.exited;
  const end = events.find((ev) => ev.e === 'end');
  if (exitCode !== 0 || !end || end.e !== 'end' || end.bars === 0 || end.cancelled) {
    throw new Error(`debug: bad run end (exit=${exitCode}, end=${JSON.stringify(end)})`);
  }
  log(
    `Debug smoke OK: breakpoint hit at dbgvars.py:${bpLine}, ` +
      `Pyne/Locals/Globals scopes resolved, ${end.bars} bars completed`
  );
}

/**
 * The IDE-side proxy (PyneDapProxy) forwards this exact wrapped condition so a
 * bare Pine builtin resolves live. Kept in lockstep with `wrapCondition` in
 * src/debug/dapProxy.ts; the smoke uses a raw DAP client, so it mirrors the
 * wrapping the proxy would otherwise apply.
 */
function wrapConditionForSmoke(expr: string): string {
  return `__import__("pyneide_bridge.debug_inspect",fromlist=["cond"]).cond(${JSON.stringify(
    expr
  )},globals(),locals())`;
}

/**
 * Conditional breakpoints: a bare Pine name in a condition (`bar_index == 3`)
 * is a NameError at runtime — the transform rewrote it to `lib.bar_index` and
 * dropped the import — which pydevd surfaces by suspending on EVERY bar. The
 * proxy wraps each condition in `debug_inspect.cond(...)` so the builtins
 * resolve live. This asserts the breakpoint suspends ONLY at the target bar:
 * had the wrapping failed (or the condition errored), the first stop would land
 * on bar 0, not the target.
 */
async function conditionalBreakpointSmoke(
  pythonBin: string,
  bridgeRoot: string,
  workdir: string
): Promise<void> {
  const scriptPath = path.join(workdir, 'scripts', 'dbgvars.py');
  fs.writeFileSync(scriptPath, DBGVARS_SCRIPT);
  const scriptLines = DBGVARS_SCRIPT.split('\n');
  const bpLine = scriptLines.findIndex((l) => l.includes('avg =')) + 1;
  if (bpLine <= 0) throw new Error('cond-debug: breakpoint anchor not found in dbgvars.py');
  const target = 3;

  let endpoint: { host: string; port: number } | undefined;
  const events: BridgeEvent[] = [];
  const run = BridgeRun.start({
    pythonBin,
    bridgeRoot,
    script: 'dbgvars',
    data: 'demo',
    workdir,
    batchSize: 1,
    debugpyPort: 0,
    onEvent: (ev) => {
      events.push(ev);
      if (ev.e === 'debugpy') endpoint = ev;
    },
    onLog: (line) => log(`[cond-debug-bridge] ${line}`),
  });
  await waitFor(() => endpoint !== undefined, 'debugpy endpoint from the bridge');

  const dap = await DapClient.connect(endpoint!.host, endpoint!.port);
  try {
    await dap.request('initialize', {
      adapterID: 'pyne',
      pathFormat: 'path',
      linesStartAt1: true,
      columnsStartAt1: true,
    });
    const attachDone = dap.request('attach', { justMyCode: false });
    await dap.waitForEvent('initialized');
    const setBp = (await dap.request('setBreakpoints', {
      source: { path: scriptPath },
      breakpoints: [{ line: bpLine, condition: wrapConditionForSmoke(`bar_index == ${target}`) }],
    })) as { breakpoints: { verified: boolean }[] };
    if (!setBp.breakpoints[0]?.verified) {
      throw new Error(`cond-debug: conditional breakpoint did not verify: ${JSON.stringify(setBp)}`);
    }
    await dap.request('configurationDone', {});
    await attachDone;

    const stopped = (await dap.waitForEvent('stopped')) as { reason: string; threadId: number };
    if (stopped.reason !== 'breakpoint') {
      throw new Error(`cond-debug: unexpected stop reason: ${stopped.reason}`);
    }
    const stack = (await dap.request('stackTrace', { threadId: stopped.threadId })) as {
      stackFrames: { id: number }[];
    };
    const frame = stack.stackFrames[0];
    const bar = await evalPineHelper(dap, frame.id, 'pine_bar', 'pine_bar()');
    const barIndex = bar.find((c) => c.name === 'bar_index');
    if (barIndex?.value !== String(target)) {
      throw new Error(
        `cond-debug: conditional breakpoint stopped at the wrong bar — ` +
          `bar_index=${barIndex?.value}, expected ${target} (a bare-name NameError would ` +
          `stop on every bar, landing on bar 0)`
      );
    }

    await dap.request('setBreakpoints', { source: { path: scriptPath }, breakpoints: [] });
    await dap.request('continue', { threadId: stopped.threadId });
  } finally {
    dap.close();
  }

  const exitCode = await run.exited;
  const end = events.find((ev) => ev.e === 'end');
  if (exitCode !== 0 || !end || end.e !== 'end' || end.bars === 0 || end.cancelled) {
    throw new Error(`cond-debug: bad run end (exit=${exitCode}, end=${JSON.stringify(end)})`);
  }
  log(`Conditional breakpoint smoke OK: suspended only at bar_index==${target}`);
}

/**
 * Pure-Node checks of the F6 Pine-debug building blocks (no Python env):
 * PineSourceMapper direction/snap/staleness semantics and the rename
 * demangler. Runs first so a regression fails fast, before the env bootstrap.
 */
function sourcemapUnitTests(): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pyneide-map-'));
  const pinePath = path.join(dir, 'foo.pine');
  const pyPath = path.join(dir, 'foo.py');
  fs.writeFileSync(pinePath, '//@version=6\n');
  const pyText = 'print("compiled stand-in")\n';
  fs.writeFileSync(pyPath, pyText);
  // Statements at pine lines 3, 5 (two py statements), 9 — header before py 10.
  const mappings = [
    [10, 3],
    [12, 5],
    [13, 5],
    [17, 9],
  ];
  fs.writeFileSync(
    `${pyPath}.map`,
    JSON.stringify({ version: 1, pine_version: 6, mappings, py_sha256: sha256(pyText) })
  );

  const mapper = new PineSourceMapper();
  if (!mapper.hasPineMapping(pinePath)) throw new Error('mapper: pair not resolved');
  const expect = (what: string, got: unknown, want: unknown): void => {
    if (JSON.stringify(got) !== JSON.stringify(want)) {
      throw new Error(`mapper: ${what}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
    }
  };
  expect('pine 3 exact', mapper.pineToPy(pinePath, 3), { path: pyPath, line: 10 });
  expect('pine 5 first py line', mapper.pineToPy(pinePath, 5), { path: pyPath, line: 12 });
  expect('pine 4 snaps forward', mapper.pineToPy(pinePath, 4), { path: pyPath, line: 12 });
  expect('pine 10 past end', mapper.pineToPy(pinePath, 10), undefined);
  expect('py 10 back', mapper.pyToPine(pyPath, 10), { path: pinePath, line: 3 });
  expect('py 11 forward-fill', mapper.pyToPine(pyPath, 11), { path: pinePath, line: 3 });
  expect('py 13 same pine stmt', mapper.pyToPine(pyPath, 13), { path: pinePath, line: 5 });
  expect('py 9 header unmapped', mapper.pyToPine(pyPath, 9), undefined);
  expect('breakpointable lines', mapper.mappedPineLines(pinePath, 4, 9), [5, 9]);

  // A stale map (the .py was edited after compile) must not translate.
  fs.writeFileSync(pyPath, 'print("edited")\n');
  if (new PineSourceMapper().hasPineMapping(pinePath)) {
    throw new Error('mapper: stale py_sha256 accepted');
  }
  // A map without its .pine source must not translate either.
  fs.writeFileSync(pyPath, pyText);
  fs.rmSync(pinePath);
  if (new PineSourceMapper().hasPineMapping(pinePath)) {
    throw new Error('mapper: missing .pine accepted');
  }

  const demangleCases: [string, string | undefined][] = [
    ['basis__global__', 'basis'],
    ['close__0000002a__', 'close'],
    ['x__global___', 'x'], // collision-dodging extra underscore
    ['field__ren__', 'field'],
    ['member__ren___', 'member'], // class-body variant
    ['plain', undefined],
    ['__state__', undefined],
    ['__block_result__', undefined],
    ['x__DEADBEEF__', undefined], // block ids are lowercase hex
  ];
  for (const [name, want] of demangleCases) {
    const got = demangleName(name);
    if (got !== want) throw new Error(`demangle ${name}: got ${got}, want ${want}`);
  }
  const vars: Record<string, unknown>[] = [
    { name: 'basis__global__', value: '1' },
    { name: 'taken__global__', value: '2' },
    { name: 'taken', value: '3' },
    { name: 'twin__11111111__', value: '4' },
    { name: 'twin__22222222__', value: '5' },
  ];
  demangleVariables(vars);
  const shown = vars.map((v) => v.name);
  const wantShown = ['basis', 'taken__global__', 'taken', 'twin__11111111__', 'twin__22222222__'];
  if (JSON.stringify(shown) !== JSON.stringify(wantShown)) {
    throw new Error(`demangleVariables: got ${JSON.stringify(shown)}`);
  }
  if (vars[0].evaluateName !== 'basis__global__') {
    throw new Error('demangleVariables: evaluateName must address the runtime name');
  }
  log('Sourcemap + demangle unit tests OK');
}

async function main(): Promise<void> {
  sourcemapUnitTests();
  const storageDir =
    process.argv[2] ?? fs.mkdtempSync(path.join(os.tmpdir(), 'pyneide-smoke-'));
  log(`Storage dir: ${storageDir}`);

  const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy || undefined;
  const { pythonBin, verify } = await bootstrapManagedEnv({ storageDir, log, proxyUrl });
  if (!verify.ok) {
    throw new Error(`Verification failed: ${verify.error}`);
  }
  if (pythonBin !== venvPythonPath(managedVenvDir(storageDir))) {
    throw new Error('Unexpected python path for managed venv');
  }

  // The pyne CLI must start from the venv.
  const pyneBin = pyneBinPath(pythonBin);
  await execChecked(pyneBin, ['--help'], log, { timeoutMs: 60000 });

  // Workdir discovery + CLI scaffolding, subfolder mode (pyne CLI layout).
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pyneide-ws-'));
  const before = findWorkdir(base);
  if (before.exists) throw new Error('findWorkdir: false positive');
  const ws = await scaffoldWorkdirWithCli(pyneBin, path.join(base, 'workdir'), log);
  const after = findWorkdir(path.join(base, 'workdir', 'scripts'));
  if (!after.exists || after.path !== ws.workdir) {
    throw new Error(`findWorkdir mismatch: ${after.path} != ${ws.workdir}`);
  }
  if (!fs.existsSync(ws.demoScript)) throw new Error('demo script missing');
  for (const rel of ['config/providers.toml', 'config/api.toml', 'data/demo.ohlcv', 'data/demo.toml']) {
    if (!fs.existsSync(path.join(ws.workdir, rel))) throw new Error(`${rel} missing`);
  }

  // Runner bridge end-to-end: demo script on demo data through the NDJSON
  // protocol, exercising pause/resume control on the way.
  const bridgeRoot = path.join(__dirname, '..', 'python');
  const events: BridgeEvent[] = [];
  let sawPaused = false;
  const run = BridgeRun.start({
    pythonBin,
    bridgeRoot,
    script: 'demo',
    data: 'demo',
    workdir: ws.workdir,
    batchSize: 50,
    onEvent: (ev) => {
      events.push(ev);
      // Pause lands during the (slow) pynecore import, well before bar #1;
      // resume as soon as the ack arrives so the run completes.
      if (ev.e === 'hello') run.pause();
      if (ev.e === 'state' && ev.state === 'paused') {
        sawPaused = true;
        run.resume();
      }
    },
    onLog: (line) => log(`[bridge] ${line}`),
  });
  const exitCode = await run.exited;
  if (exitCode !== 0) throw new Error(`bridge exit code ${exitCode}`);
  const byType = <K extends BridgeEvent['e']>(k: K): Extract<BridgeEvent, { e: K }>[] =>
    events.filter((ev): ev is Extract<BridgeEvent, { e: K }> => ev.e === k);
  const hello = byType('hello')[0];
  if (!hello || hello.protocol !== 1) throw new Error('bridge: bad hello');
  const start = byType('start')[0];
  if (!start || !start.syminfo.ticker) throw new Error('bridge: bad start event');
  if (typeof start.overlay !== 'boolean') throw new Error('bridge: start event missing overlay flag');
  if (!sawPaused) throw new Error('bridge: pause/resume control did not round-trip');
  const barCount = byType('bars').reduce((n, ev) => n + ev.d.length, 0);
  const end = byType('end')[0];
  if (!end || end.cancelled || end.bars !== barCount || barCount === 0) {
    throw new Error(`bridge: bad end state (bars=${barCount}, end=${JSON.stringify(end)})`);
  }
  const errEvent = byType('error')[0];
  if (errEvent) throw new Error(`bridge: error event: ${errEvent.message}`);
  log(`Bridge streamed ${barCount} bars`);

  // Data-only chart preview: raw candles from demo.ohlcv, no script.
  const doEvents: BridgeEvent[] = [];
  const doRun = BridgeRun.start({
    pythonBin,
    bridgeRoot,
    data: 'demo',
    workdir: ws.workdir,
    dataOnly: true,
    batchSize: 50,
    onEvent: (ev) => doEvents.push(ev),
    onLog: (line) => log(`[bridge] ${line}`),
  });
  const doExit = await doRun.exited;
  if (doExit !== 0) throw new Error(`data-only bridge exit code ${doExit}`);
  const doStart = doEvents.find((ev): ev is Extract<BridgeEvent, { e: 'start' }> => ev.e === 'start');
  if (!doStart || doStart.dataOnly !== true) throw new Error('data-only: start missing dataOnly flag');
  if (!doStart.syminfo.ticker) throw new Error('data-only: start missing syminfo');
  const doBars = doEvents
    .filter((ev): ev is Extract<BridgeEvent, { e: 'bars' }> => ev.e === 'bars')
    .reduce((n, ev) => n + ev.d.length, 0);
  const doEnd = doEvents.find((ev): ev is Extract<BridgeEvent, { e: 'end' }> => ev.e === 'end');
  if (!doEnd || doEnd.cancelled || doEnd.bars !== doBars || doBars === 0) {
    throw new Error(`data-only: bad end state (bars=${doBars}, end=${JSON.stringify(doEnd)})`);
  }
  if (doEvents.some((ev) => ev.e === 'error')) throw new Error('data-only: error event');
  log(`Data-only preview streamed ${doBars} raw candles`);

  await debugSmoke(pythonBin, bridgeRoot, ws.workdir);
  await conditionalBreakpointSmoke(pythonBin, bridgeRoot, ws.workdir);

  // Project-root mode: the folder itself is the workdir, marked by setting.
  const rootBase = fs.mkdtempSync(path.join(os.tmpdir(), 'pyneide-root-'));
  const rootWs = await scaffoldWorkdirWithCli(pyneBin, rootBase, log);
  if (rootWs.workdir !== rootBase || !rootWs.created) {
    throw new Error(`root-mode scaffold mismatch: ${rootWs.workdir}`);
  }
  const bySetting = resolveWorkdir({ setting: '.', wsFolder: rootBase });
  if (!bySetting?.exists || bySetting.path !== rootBase || bySetting.source !== 'setting') {
    throw new Error(`resolveWorkdir setting mode failed: ${bySetting?.path}`);
  }
  const byFallback = resolveWorkdir({ wsFolder: rootBase });
  if (byFallback?.exists !== false || byFallback.source !== 'fallback') {
    throw new Error('resolveWorkdir fallback mode failed');
  }

  log('SMOKE OK');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
