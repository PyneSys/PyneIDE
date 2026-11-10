/**
 * Bridge robustness smoke test: a strategy run with `--robustness` end-to-end
 * against a real pynecore, without VSCode. The bridge names the report file
 * in `start.outputs`, reports the test phases, emits the report before `end`,
 * writes the JSON and CSV files, and the output preview reloads the report
 * from disk (with the executed bars of the visualization sidecar, as the script
 * plots nothing). A cancelled run and an indicator leave no report behind.
 *
 * Usage: node dist/bridge-robustness-smoke.js [pythonBin]
 * `pythonBin` must be a venv python with pynecore importable (defaults to the
 * dev extension's managed venv). When that pynecore has no robustness tests,
 * the fallback is asserted instead: a `robustness` event with
 * `supported: false` and a run that completes without a report.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import assert from 'node:assert/strict';

import { renderRobustness } from '../../src/chart/webview/robustnessView';
import { execProcess } from '../../src/env/exec';
import { managedVenvDir, pyneBinPath, venvPythonPath } from '../../src/env/uv';
import { scaffoldWorkdirWithCli } from '../../src/env/workdir';
import { buildOutputPreview, resolveScriptOutputPair } from '../../src/data/outputPreview';
import {
  BridgeRun,
  type BridgeEvent,
  type RobustnessEvent,
  type StartEvent,
} from '../../src/run/bridgeClient';

const log = (msg: string): void => console.log(msg);

const STRATEGY = `"""
@pyne
"""
from pynecore.lib import bar_index, close, script, strategy


@script.strategy("Robustness Demo", initial_capital=10000,
                 default_qty_type=strategy.fixed, default_qty_value=1)
def main():
    if bar_index % 7 == 3 and strategy.position_size == 0:
        strategy.entry("L", strategy.long)
        strategy.exit("LX", "L", stop=close * 0.97, limit=close * 1.05)
`;

const INDICATOR = `"""
@pyne
"""
from pynecore.lib import close, plot, script


@script.indicator("Robustness Indicator")
def main():
    plot(close, "close")
`;

const SETTINGS = {
  draws: 500, seed: 7, coinflip: 'both', coinflipRuns: 10, targetMultiple: 2, maxLeverage: 1,
};

/** 0: the robustness tests are installed; 3: this pynecore has none. */
const CAPABILITY_PROBE = `
import sys
try:
    from pynecore.analysis import coinflip, analyze, TradeRecorder
except ImportError:
    sys.exit(3)
`;

interface Collected {
  events: BridgeEvent[];
  exitCode: number | null;
}

async function runBridge(
  pythonBin: string,
  workdir: string,
  script: string,
  cancelOnPhase = false
): Promise<Collected> {
  const events: BridgeEvent[] = [];
  let cancelled = false;
  const run: BridgeRun = BridgeRun.start({
    pythonBin,
    bridgeRoot: path.join(__dirname, '..', 'python'),
    script,
    data: 'demo',
    workdir,
    batchSize: 500,
    robustness: SETTINGS,
    onEvent: (ev) => {
      events.push(ev);
      if (cancelOnPhase && !cancelled && ev.e === 'robustnessProgress' && ev.phase.includes('timing')) {
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

function robustnessOf(events: BridgeEvent[]): RobustnessEvent {
  const event = events.find((ev): ev is RobustnessEvent => ev.e === 'robustness');
  assert.ok(event, 'no robustness event');
  return event;
}

function endOf(events: BridgeEvent[]): { bars: number; cancelled: boolean } {
  const end = events.find((ev) => ev.e === 'end');
  assert.ok(end && end.e === 'end', 'no end event');
  return end;
}

function assertReport(workdir: string, events: BridgeEvent[]): string {
  assert.deepEqual(events.filter((ev) => ev.e === 'error'), [], 'robustness run failed');
  const file = startOf(events).outputs.robustness;
  // The bridge reports the workdir resolved (macOS: /var -> /private/var)
  const output = path.join(fs.realpathSync(workdir), 'output');
  assert.equal(file, path.join(output, 'robustness_demo_robustness.json'));
  const end = endOf(events);
  assert.ok(!end.cancelled && end.bars > 0, 'robustness run did not complete');

  const phases = new Set(
    events.flatMap((ev) => (ev.e === 'robustnessProgress' ? [ev.phase] : []))
  );
  assert.deepEqual([...phases], ['tests', 'coin flip (direction)', 'coin flip (timing)']);
  const order = events.map((ev) => ev.e);
  assert.ok(order.indexOf('robustness') < order.indexOf('end'), 'the report must precede end');

  const event = robustnessOf(events);
  assert.equal(event.supported, true);
  assert.equal(event.file, file);
  const report = event.report;
  assert.ok(report, `no report: ${event.message}`);
  assert.equal(report.unit, 'r', 'stop exits must give results in R');
  assert.ok(renderRobustness(report).includes('<th>Total (R)</th>'));
  const html = renderRobustness({
    ...report,
    unit: 'R & < USD' as typeof report.unit,
    rows: [{ Test: 'Backtest', Metric: 'Total', Value: 1, Unit: 'USD > EUR & "fees"' }],
  });
  assert.ok(html.includes('<th>Total (R &#38; &#60; USD)</th>'), 'report unit must be HTML-escaped');
  assert.ok(html.includes('<td>1 USD &#62; EUR &#38; &#34;fees&#34;</td>'), 'row unit must be HTML-escaped');

  assert.ok(report.trades > 5, 'too few trades to test');
  assert.ok(report.rows.some((row) => row['Test'] === 'Backtest' && row['Metric'] === 'Total'));
  assert.deepEqual(report.coinflips.map((flip) => flip.mode), ['direction', 'timing']);
  for (const flip of report.coinflips) {
    const counts = flip.histogram.counts.reduce((sum, n) => sum + n, 0);
    assert.equal(counts, flip.draws, `${flip.mode}: the histogram must hold every draw`);
    assert.equal(flip.histogram.edges.length, flip.histogram.counts.length + 1);
  }
  assert.equal(report.coinflips[1].draws, SETTINGS.coinflipRuns);
  assert.ok(report.monte_carlo.bands.length > 1, 'no Monte Carlo fan');
  assert.ok(report.account?.target_level, 'the target multiple must reach the account Monte Carlo');
  assert.equal(typeof report.account_capped, 'number', 'the leverage limit must reach the account Monte Carlo');

  assert.ok(fs.existsSync(file), 'no report file');
  for (const suffix of ['robustness', 'montecarlo', 'costs', 'periods', 'coinflip_direction', 'coinflip_timing']) {
    assert.ok(fs.existsSync(path.join(output, `robustness_demo_${suffix}.csv`)), `no ${suffix} CSV`);
  }

  const pair = resolveScriptOutputPair(workdir, path.join(workdir, 'scripts', 'robustness_demo.py'));
  assert.ok(pair?.robustness, 'the output pair does not find the report');
  const preview = buildOutputPreview(pair);
  assert.deepEqual(preview.warnings, []);
  // The script plots nothing: the reloaded bars come from the visualization sidecar
  const bars = preview.events.find((ev) => ev.e === 'bars');
  assert.ok(bars && bars.e === 'bars' && bars.d.length === end.bars, 'the reloaded chart lost bars');
  const reloaded = robustnessOf(preview.events);
  assert.deepEqual(reloaded.report, report, 'the reloaded report differs from the streamed one');
  log(`Report OK: ${report.trades} trades, ${report.rows.length} rows, ${report.coinflips.length} coin flips`);
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

  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pyneide-robustness-'));
  try {
    const ws = await scaffoldWorkdirWithCli(pyneBinPath(pythonBin), path.join(base, 'workdir'), log);
    fs.writeFileSync(path.join(ws.workdir, 'scripts', 'robustness_demo.py'), STRATEGY);
    fs.writeFileSync(path.join(ws.workdir, 'scripts', 'robustness_indicator.py'), INDICATOR);

    const probe = await execProcess(pythonBin, ['-c', CAPABILITY_PROBE], log, { timeoutMs: 60000 });
    log(`pynecore robustness tests: exit ${probe.code}`);
    const { events, exitCode } = await runBridge(pythonBin, ws.workdir, 'robustness_demo');
    assert.equal(exitCode, 0, `bridge exit code ${exitCode}`);

    if (probe.code === 3) {
      assert.equal(startOf(events).outputs.robustness, null);
      const event = robustnessOf(events);
      assert.equal(event.supported, false);
      assert.equal(event.report, null);
      assert.ok(!endOf(events).cancelled, 'the run must go on without the tests');
      log('Fallback OK: the run went on without robustness tests');
    } else {
      assert.equal(probe.code, 0, `capability probe failed: ${probe.stderr}`);
      const file = assertReport(ws.workdir, events);

      // The earlier report goes as the next run starts; a run cancelled during
      // the tests writes none, so nothing stale is left to show
      const cancelled = await runBridge(pythonBin, ws.workdir, 'robustness_demo', true);
      assert.equal(cancelled.exitCode, 0, 'cancelled run exit code');
      assert.ok(endOf(cancelled.events).cancelled, 'the run was not cancelled');
      assert.ok(!cancelled.events.some((ev) => ev.e === 'robustness'), 'a cancelled run sent a report');
      assert.ok(!fs.existsSync(file), 'a cancelled run left a report');
      log('Cancel OK: no report after a cancelled run');

      const indicator = await runBridge(pythonBin, ws.workdir, 'robustness_indicator');
      assert.equal(indicator.exitCode, 0, 'indicator run exit code');
      assert.equal(startOf(indicator.events).outputs.robustness, null);
      const event = robustnessOf(indicator.events);
      assert.equal(event.report, null);
      assert.match(event.message ?? '', /strategy/);
      log(`Indicator OK: ${event.message}`);
    }
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }

  log('BRIDGE ROBUSTNESS SMOKE OK');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
