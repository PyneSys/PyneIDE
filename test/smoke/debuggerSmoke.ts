/** Real debugpy round-trip through the production adapter, using an existing env. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PyneDapProxy } from '../../src/debug/dapProxy';
import { BridgeRun } from '../../src/run/bridgeClient';

async function main(): Promise<void> {
  const [pythonBin, bridgeRoot, dataPath] = process.argv.slice(2);
  if (!pythonBin || !bridgeRoot || !dataPath) throw new Error('Expected python, bridge root, OHLCV path');
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'pyne-debugger-smoke-'));
  fs.mkdirSync(path.join(workdir, 'scripts'));
  fs.mkdirSync(path.join(workdir, 'data'));
  fs.copyFileSync(dataPath, path.join(workdir, 'data', 'fixture.ohlcv'));
  fs.copyFileSync(dataPath.replace(/\.ohlcv$/, '.toml'), path.join(workdir, 'data', 'fixture.toml'));
  const scriptPath = path.join(workdir, 'scripts', 'debugger.py');
  const source = `"""\n@pyne\n"""
from pynecore import Series
from pynecore.lib import script, close, ta, plot
@script.indicator(title="Debugger smoke")
def main(length=26.0):
    smooth: Series[float] = close
    unused: Series[float] = close
    previous = smooth[1]
    average = ta.sma(close, 3)
    noisy = 83468.45000000001
    missing = float('nan')
    plot(average)
`;
  fs.writeFileSync(scriptPath, source);
  const line = source.split('\n').findIndex((s) => s.includes('plot(average)')) + 1;
  let endpoint: { host: string; port: number } | undefined;
  const run = BridgeRun.start({ pythonBin, bridgeRoot, script: 'debugger', data: 'fixture', workdir,
    batchSize: 1, debugpyPort: 0, onEvent(ev) { if (ev.e === 'debugpy') endpoint = ev; }, onLog: console.error });
  let proxy: PyneDapProxy | undefined;
  const wait = async (check: () => boolean) => {
    const until = Date.now() + 30000;
    while (!check()) { if (Date.now() > until) throw new Error('Debugger timeout'); await new Promise(r => setTimeout(r, 20)); }
  };
  try {
    await wait(() => !!endpoint);
    let position: unknown;
    proxy = new PyneDapProxy(endpoint!.host, endpoint!.port, {
      onExecState(stopped, _thread, _reason, current) { position = stopped ? current : undefined; },
      onFastChartBreakpointsChanged() {},
    });
    let seq = 1;
    const pending = new Map<number, { resolve: (m: any) => void; reject: (e: Error) => void }>();
    const events: any[] = [];
    proxy.onDidSendMessage((m: any) => {
      if (m.type === 'response') { pending.get(m.request_seq)?.resolve(m); pending.delete(m.request_seq); }
      else if (m.type === 'event') events.push(m);
    });
    const request = (command: string, args: any = {}): Promise<any> => new Promise((resolve, reject) => {
      const id = seq++;
      const timer = setTimeout(() => reject(new Error(`Timeout: ${command}`)), 15000);
      pending.set(id, { resolve: m => { clearTimeout(timer); resolve(m); }, reject });
      proxy!.handleMessage({ seq: id, type: 'request', command, arguments: args } as any);
    });
    const event = async (name: string) => { await wait(() => events.some(e => e.event === name)); return events.splice(events.findIndex(e => e.event === name), 1)[0].body; };
    await request('initialize', { adapterID: 'pyne', pathFormat: 'path', linesStartAt1: true, columnsStartAt1: true });
    const attach = request('attach', { justMyCode: false,
      variablePresentation: { special: 'inline', protected: 'inline', function: 'hide', class: 'hide' },
    });
    await event('initialized');
    await request('setBreakpoints', { source: { path: scriptPath }, breakpoints: [{ line, condition: 'bar_index == 2' }] });
    await request('configurationDone');
    await attach;
    const stopped = await event('stopped');
    assert.equal((position as any).barIndex, 2);
    assert.equal(typeof (position as any).timestamp, 'number');
    const threads = (await request('threads')).body.threads;
    assert(!threads.some((t: any) => /pyneide-control|_worker_thread/.test(t.name)), JSON.stringify(threads));
    const frame = (await request('stackTrace', { threadId: stopped.threadId })).body.stackFrames[0];
    const scopes = (await request('scopes', { frameId: frame.id })).body.scopes;
    assert.equal(scopes[0].name, 'Locals');
    const locals = (await request('variables', { variablesReference: scopes[0].variablesReference })).body.variables;
    assert(!locals.some((v: any) => v.name.includes('·')), JSON.stringify(locals));
    assert(locals.some((v: any) => v.name === 'average'));
    assert.equal(locals.find((v: any) => v.name === 'length').value, '26');
    assert.equal(locals.find((v: any) => v.name === 'noisy').value, '83468.45');
    assert.equal(locals.find((v: any) => v.name === 'missing').value, 'na');
    const evaluate = (expression: string, context = 'watch') => request('evaluate', { expression, frameId: frame.id, context });
    assert.equal((await evaluate("'__st·__' in locals()")).body.result, 'True', 'fixture must exercise the hidden runtime temp');
    const missing = await evaluate('close[1]');
    assert.equal(missing.success, false);
    assert.match(missing.message, /History for 'close' is unavailable/);
    assert(!missing.message.includes('not subscriptable'));
    assert(!missing.message.includes('HistoryUnavailableError'));
    assert.equal((await evaluate('smooth[1]')).success, true);
    assert.match((await evaluate('unused[1]')).message, /History for 'unused' is unavailable/);
    assert.match((await evaluate('1 / 0')).message, /ZeroDivisionError/);
    assert.match((await evaluate('unknown_name')).message, /NameError/);
    assert.equal((await evaluate('noisy')).body.result, '83468.45');
    assert.equal((await evaluate('noisy', 'clipboard')).body.result, '83468.45000000001');
    assert.equal((await evaluate('missing')).body.result, 'na');
    assert.equal((await evaluate('[10, 20][1]')).body.result, '20');
    assert.equal((await evaluate('False and close[1]')).body.result, 'False');
    await request('disconnect', { terminateDebuggee: true });
    console.log('DEBUGGER SMOKE OK: real stops, clean locals/threads, scope order, missing/present history, compact scalars, exact clipboard');
  } finally { proxy?.dispose(); run.cancel(); await run.exited; fs.rmSync(workdir, { recursive: true, force: true }); }

}
void main().catch((error) => { console.error(error); process.exitCode = 1; });
