/**
 * Environment bootstrap smoke test — runs WITHOUT VSCode.
 * Downloads uv, creates the pinned venv, installs packages, verifies imports.
 * Usage: node dist/env-smoke.js [storageDir]
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { bootstrapManagedEnv } from '../../src/env/bootstrap';
import { execChecked } from '../../src/env/exec';
import { venvPythonPath, managedVenvDir, pyneBinPath } from '../../src/env/uv';
import { findWorkdir, resolveWorkdir, scaffoldWorkdirWithCli } from '../../src/env/workdir';
import { BridgeRun, type BridgeEvent } from '../../src/run/bridgeClient';

const log = (msg: string): void => console.log(msg);

async function main(): Promise<void> {
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
