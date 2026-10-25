/**
 * Bridge profile smoke test — a Profile run end-to-end against a real
 * pynecore, WITHOUT VSCode: the bridge's `--profile` writes the profile file,
 * names it in `start.outputs`, and the IDE's profile store reads the script's
 * lines out of it. A cancelled Profile run leaves no profile behind.
 *
 * Usage: node dist/bridge-profile-smoke.js [pythonBin]
 * `pythonBin` must be a venv python with pynecore importable (defaults to the
 * dev extension's managed venv). When that pynecore predates profiling, the
 * fallback is asserted instead: a warning and a run without a profile; when it
 * can profile but not here (no compiled profiler, Python < 3.13), the run must
 * fail with the profiler's own message.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import assert from 'node:assert/strict';

import { execProcess } from '../../src/env/exec';
import { managedVenvDir, pyneBinPath, venvPythonPath } from '../../src/env/uv';
import { scaffoldWorkdirWithCli } from '../../src/env/workdir';
import { loadProfile, sourceProfile } from '../../src/profile/profileStore';
import { BridgeRun, type BridgeEvent, type StartEvent } from '../../src/run/bridgeClient';

const log = (msg: string): void => console.log(msg);

const SCRIPT = `"""
@pyne
Profile demo
"""
from pynecore.lib import script, plot, close, ta


def scaled(value: float) -> float:
    return value * 2.0


@script.indicator("Profile Demo")
def main():
    total = 0.0
    for i in range(3):
        total += close * i
    plot(scaled(ta.sma(close, 5)) + total, "out")
`;

/** 0: can profile; 3: predates profiling; 4: knows profiling, cannot run it here. */
const CAPABILITY_PROBE = `
import inspect, sys
from pynecore.core.script_runner import ScriptRunner
if "profile_path" not in inspect.signature(ScriptRunner).parameters:
    sys.exit(3)
from pynecore.core import profiler
try:
    profiler._check_available()
except profiler.ProfilerUnavailable:
    sys.exit(4)
`;

interface Collected {
  events: BridgeEvent[];
  exitCode: number | null;
}

async function runBridge(
  pythonBin: string,
  workdir: string,
  cancelOnProgress = false
): Promise<Collected> {
  const events: BridgeEvent[] = [];
  let cancelled = false;
  const run: BridgeRun = BridgeRun.start({
    pythonBin,
    bridgeRoot: path.join(__dirname, '..', 'python'),
    script: 'profile_demo',
    data: 'demo',
    workdir,
    batchSize: cancelOnProgress ? 1 : 500,
    profile: true,
    onEvent: (ev) => {
      events.push(ev);
      if (cancelOnProgress && !cancelled && ev.e === 'progress') {
        cancelled = true;
        run.cancel();
      }
    },
    onLog: (line) => log(`[bridge] ${line}`),
  });
  return { events, exitCode: await run.exited };
}

function startOf(events: BridgeEvent[]): StartEvent {
  const start = events.find((ev): ev is StartEvent => ev.e === 'start');
  assert.ok(start, 'no start event');
  return start;
}

function endOf(events: BridgeEvent[]): { bars: number; cancelled: boolean } {
  const end = events.find((ev) => ev.e === 'end');
  assert.ok(end && end.e === 'end', 'no end event');
  return end;
}

function lineOf(text: string): number {
  const index = SCRIPT.split('\n').findIndex((line) => line.includes(text));
  assert.ok(index >= 0, `no line with ${text}`);
  return index + 1;
}

function assertProfiled(workdir: string, events: BridgeEvent[]): string {
  const errors = events.filter((ev) => ev.e === 'error');
  assert.deepEqual(errors, [], 'profiled run failed');
  const file = startOf(events).outputs.profile;
  // The bridge reports the workdir resolved (macOS: /var -> /private/var)
  assert.equal(file, path.join(fs.realpathSync(workdir), 'output', 'profile_demo_profile.json'));
  const end = endOf(events);
  assert.ok(!end.cancelled && end.bars > 0, 'profiled run did not complete');

  const profile = loadProfile(file);
  assert.ok(profile, 'profile file missing or unreadable');
  assert.equal(profile.bars, end.bars);
  assert.ok(profile.script_ns > 0 && profile.categories.script > 0, 'no script time');

  const scriptPath = path.join(workdir, 'scripts', 'profile_demo.py');
  const source = sourceProfile(profile, fs.realpathSync(scriptPath), fs.readFileSync(scriptPath, 'utf8'));
  assert.ok(source, 'the profile does not fit the script');
  const hits = (text: string): number | undefined => source.lines.get(lineOf(text))?.hits;
  assert.equal(hits('plot(scaled('), end.bars);
  assert.equal(hits('total += close * i'), 3 * end.bars);
  assert.equal(hits('return value * 2.0'), end.bars);
  assert.equal(source.blocks.get(lineOf('for i in range(3)'))?.kind, 'loop');
  assert.equal(source.blocks.get(lineOf('def main():'))?.kind, 'def');
  log(`Profile OK: ${end.bars} bars, ${source.lines.size} measured lines`);
  return file;
}

async function main(): Promise<void> {
  const defaultStorage = path.join(
    os.homedir(),
    'Library',
    'Application Support',
    'Code',
    'User',
    'globalStorage',
    'pynesys.pyneide'
  );
  const pythonBin = process.argv[2] ?? venvPythonPath(managedVenvDir(defaultStorage));
  if (!fs.existsSync(pythonBin)) {
    throw new Error(`python not found: ${pythonBin} — pass a venv python as the first argument`);
  }
  log(`Python: ${pythonBin}`);

  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pyneide-profile-'));
  try {
    const ws = await scaffoldWorkdirWithCli(pyneBinPath(pythonBin), path.join(base, 'workdir'), log);
    fs.writeFileSync(path.join(ws.workdir, 'scripts', 'profile_demo.py'), SCRIPT);

    const probe = await execProcess(pythonBin, ['-c', CAPABILITY_PROBE], log, { timeoutMs: 60000 });
    log(`pynecore profiling: exit ${probe.code}`);
    const { events, exitCode } = await runBridge(pythonBin, ws.workdir);

    if (probe.code === 3) {
      assert.equal(exitCode, 0, 'a run without profiling support must still succeed');
      assert.equal(startOf(events).outputs.profile, null);
      assert.ok(
        events.some((ev) => ev.e === 'log' && ev.level === 'warning' && /cannot profile/.test(ev.message)),
        'no warning about the missing profiling support'
      );
      log('Fallback OK: the run went on without a profile');
    } else if (probe.code === 4) {
      const error = events.find((ev) => ev.e === 'error');
      assert.ok(error && error.e === 'error' && error.kind === 'ProfilerUnavailable', 'no profiler error');
      log(`Unavailable OK: ${error.message}`);
    } else {
      assert.equal(probe.code, 0, `capability probe failed: ${probe.stderr}`);
      assert.equal(exitCode, 0, `bridge exit code ${exitCode}`);
      const file = assertProfiled(ws.workdir, events);

      // The earlier profile goes as the next Profile run starts; one that does
      // not complete writes none, so nothing stale is left to show
      const cancelled = await runBridge(pythonBin, ws.workdir, true);
      assert.equal(cancelled.exitCode, 0, 'cancelled run exit code');
      assert.ok(endOf(cancelled.events).cancelled, 'the run was not cancelled');
      assert.ok(!fs.existsSync(file), 'a cancelled Profile run left a profile');
      log('Cancel OK: no profile after a cancelled run');
    }
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }

  log('BRIDGE PROFILE SMOKE OK');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
