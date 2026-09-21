/**
 * Bridge security smoke test — verifies the `request.security` symbol-resolution
 * stack (global `config/symbol_map.toml`) end-to-end against a real pynecore,
 * WITHOUT VSCode.
 *
 * Usage: node dist/bridge-security-smoke.js [pythonBin]
 * `pythonBin` must be a venv python with pynecore importable (defaults to the
 * dev extension's managed venv).
 *
 * Scenarios:
 *   (a) `--inspect-security` classifies the buckets and populates the
 *       global-map fields for a cross-symbol requirement.
 *   (b) a full run resolves the cross-symbol feed from a `symbol_map.toml`
 *       entry with NO `--security` arg and reaches the `end` event.
 *   (c) an explicit `--security` mapping overrides the (deliberately broken)
 *       global map and the run still reaches `end`.
 *   (d) a global-map entry pointing at a missing file, with no `--security`,
 *       produces the pynecore mapped-but-missing error as an `error` event.
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { execProcess } from '../../src/env/exec';
import { managedVenvDir, pyneBinPath, venvPythonPath } from '../../src/env/uv';
import { scaffoldWorkdirWithCli } from '../../src/env/workdir';
import { BridgeRun, type BridgeEvent } from '../../src/run/bridgeClient';

const log = (msg: string): void => console.log(msg);

const RECORD_SIZE = 24;
const HOUR = 3600;
/** A Monday 00:00:00 UTC — keeps hourly bars inside 24/7 sessions cleanly. */
const START_TS = 1704067200; // 2024-01-01 00:00:00 UTC
const BAR_COUNT = 240;

/**
 * The demo script exercises three requirement buckets:
 *   - `close` on the chart (NASDAQ:AAPL @ 60) -> chart_main
 *   - same symbol at a COARSER timeframe (240) -> same_symbol_other_tf,
 *     served from the chart feed by resampling (no external file)
 *   - a cross-symbol literal (NASDAQ:MSFT @ 60) -> cross_symbol, resolved
 *     through the global symbol map.
 */
const SECURITY_SCRIPT = `"""
@pyne
Security resolution demo
"""
from pynecore.lib import close, plot, request, script, syminfo


@script.indicator("Security Resolution Demo", overlay=False)
def main():
    htf = request.security(syminfo.ticker, "240", close)
    other = request.security("NASDAQ:MSFT", "60", close)
    plot(close, "close")
    plot(htf, "htf")
    plot(other, "other")
`;

function fail(msg: string): never {
  throw new Error(msg);
}

/** Write `count` synthetic 24-byte OHLCV records (uint32 ts + 5x float32 LE). */
function writeOhlcv(file: string, startTs: number, count: number, base: number): void {
  const buf = Buffer.alloc(count * RECORD_SIZE);
  for (let i = 0; i < count; i++) {
    const o = i * RECORD_SIZE;
    const price = base + i;
    buf.writeUInt32LE(startTs + i * HOUR, o);
    buf.writeFloatLE(price, o + 4); // open
    buf.writeFloatLE(price + 0.5, o + 8); // high
    buf.writeFloatLE(price - 0.5, o + 12); // low
    buf.writeFloatLE(price + 0.25, o + 16); // close
    buf.writeFloatLE(1000 + i, o + 20); // volume
  }
  fs.writeFileSync(file, buf);
}

/** Write a minimal-but-complete syminfo TOML with 24/7 sessions. */
function writeSyminfo(
  file: string,
  prefix: string,
  ticker: string,
  period: string,
  type: string
): void {
  const lines: string[] = [
    '[symbol]',
    `prefix = "${prefix}"`,
    `description = "${prefix} ${ticker}"`,
    `ticker = "${ticker}"`,
    'currency = "USD"',
    'basecurrency = "USD"',
    `period = "${period}"`,
    `type = "${type}"`,
    'mintick = 0.01000000',
    'pricescale = 100',
    'minmove = 1.00000000',
    'pointvalue = 1.00000000',
    'timezone = "UTC"',
    'volumetype = "base"',
    '',
  ];
  for (let day = 0; day < 7; day++) {
    lines.push('[[opening_hours]]', `day = ${day}`, 'start = "00:00:00"', 'end = "23:59:59"', '');
  }
  for (let day = 0; day < 7; day++) {
    lines.push('[[session_starts]]', `day = ${day}`, 'time = "00:00:00"', '');
  }
  for (let day = 0; day < 7; day++) {
    lines.push('[[session_ends]]', `day = ${day}`, 'time = "23:59:59"', '');
  }
  fs.writeFileSync(file, lines.join('\n') + '\n');
}

function writeSymbolMap(configDir: string, body: string): void {
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'symbol_map.toml'), body);
}

interface SecurityEvent {
  e: 'security';
  supported: boolean;
  chartSymbol?: string;
  chartTf?: string;
  chartMain?: SecReq[];
  sameSymbolOtherTf?: SecReq[];
  crossSymbol?: SecReq[];
  dynamic?: SecReq[];
}
interface SecReq {
  symbol: string;
  timeframe: string;
  hasGlobalMap?: boolean;
  mappedProvider?: string | null;
  mappedNativeSymbol?: string | null;
  mappedFile?: string | null;
  mappedFileExists?: boolean;
}

/** Spawn `--inspect-security` directly and collect the emitted proto events. */
function inspectSecurity(
  pythonBin: string,
  bridgeRoot: string,
  workdir: string,
  script: string,
  data: string
): Promise<Array<Record<string, unknown>>> {
  return new Promise((resolve, reject) => {
    const args = [
      '-X',
      'utf8',
      '-m',
      'pyneide_bridge',
      '--workdir',
      workdir,
      '--data',
      data,
      '--inspect-security',
      script,
    ];
    const pythonPath = process.env.PYTHONPATH
      ? `${bridgeRoot}${path.delimiter}${process.env.PYTHONPATH}`
      : bridgeRoot;
    const child = spawn(pythonBin, args, {
      cwd: workdir,
      env: { ...process.env, PYTHONPATH: pythonPath, PYNE_WORK_DIR: workdir },
    });
    const events: Array<Record<string, unknown>> = [];
    let out = '';
    let err = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (c: string) => (out += c));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (c: string) => (err += c));
    child.on('error', reject);
    child.on('close', (code) => {
      for (const line of out.split('\n')) {
        const t = line.trim();
        if (!t) continue;
        try {
          events.push(JSON.parse(t) as Record<string, unknown>);
        } catch {
          /* non-proto noise */
        }
      }
      if (code !== 0) {
        reject(new Error(`inspect-security exit ${code}: ${err.slice(-500)}`));
        return;
      }
      resolve(events);
    });
  });
}

interface Collected {
  events: BridgeEvent[];
  exitCode: number | null;
}

function runBridge(
  pythonBin: string,
  bridgeRoot: string,
  workdir: string,
  script: string,
  data: string,
  security?: string[]
): Promise<Collected> {
  const events: BridgeEvent[] = [];
  const run = BridgeRun.start({
    pythonBin,
    bridgeRoot,
    script,
    data,
    workdir,
    security,
    batchSize: 50,
    onEvent: (ev) => events.push(ev),
    onLog: (line) => log(`[bridge] ${line}`),
  });
  return run.exited.then((exitCode) => ({ events, exitCode }));
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
    fail(`python not found: ${pythonBin} — pass a venv python as the first argument`);
  }
  log(`Python: ${pythonBin}`);

  const bridgeRoot = path.join(__dirname, '..', 'python');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pyneide-security-'));
  const ws = await scaffoldWorkdirWithCli(pyneBinPath(pythonBin), path.join(base, 'workdir'), log);

  // Two synthetic .ohlcv + .toml pairs: the chart feed (NASDAQ:AAPL @ 60) and
  // the cross-symbol feed the global map derives. The mapped provider is `ccxt`
  // because pynecore derives the expected file name through the provider class
  // (`load_plugin(...).get_ohlcv_path()`), and ccxt is the one provider the
  // managed environment always installs — an uninstalled provider would simply
  // report `mapped_file: None`. ccxt is multi-broker, so the broker is part of
  // both the mapped symbol and the file name (`ccxt:BYBIT:MSFT/USDT` ->
  // `ccxt_BYBIT_MSFT_USDT_60`); nothing here goes near the network.
  const dataDir = path.join(ws.workdir, 'data');
  const chartStem = 'aapl_60';
  writeOhlcv(path.join(dataDir, `${chartStem}.ohlcv`), START_TS, BAR_COUNT, 100);
  writeSyminfo(path.join(dataDir, `${chartStem}.toml`), 'NASDAQ', 'AAPL', '60', 'stock');

  const crossStem = 'ccxt_BYBIT_MSFT_USDT_60';
  writeOhlcv(path.join(dataDir, `${crossStem}.ohlcv`), START_TS, BAR_COUNT, 300);
  writeSyminfo(path.join(dataDir, `${crossStem}.toml`), 'BYBIT', 'MSFT/USDT', '60', 'crypto');

  fs.writeFileSync(path.join(ws.workdir, 'scripts', 'security_demo.py'), SECURITY_SCRIPT);

  const configDir = path.join(ws.workdir, 'config');

  // ---- (a) inspect-security: buckets + global-map fields ----
  writeSymbolMap(configDir, '[symbol_map]\n"NASDAQ:MSFT" = "ccxt:BYBIT:MSFT/USDT"\n');
  const inspectEvents = await inspectSecurity(
    pythonBin,
    bridgeRoot,
    ws.workdir,
    'security_demo',
    chartStem
  );
  const sec = inspectEvents.find((e) => e.e === 'security') as SecurityEvent | undefined;
  if (!sec) fail('no security event from --inspect-security');
  if (sec.supported !== true) fail('security event not supported:true');
  if (sec.chartSymbol !== 'NASDAQ:AAPL') fail(`chartSymbol: ${sec.chartSymbol}`);
  if (sec.chartTf !== '60') fail(`chartTf: ${sec.chartTf}`);
  const sameTf = sec.sameSymbolOtherTf ?? [];
  if (!sameTf.some((r) => r.timeframe === '240')) fail('missing same-symbol 240 requirement');
  const cross = sec.crossSymbol ?? [];
  const msft = cross.find((r) => r.symbol === 'NASDAQ:MSFT');
  if (!msft) fail('missing NASDAQ:MSFT cross-symbol requirement');
  if (msft.timeframe !== '60') fail(`MSFT tf: ${msft.timeframe}`);
  if (msft.hasGlobalMap !== true) fail('MSFT hasGlobalMap not true');
  if (msft.mappedProvider !== 'ccxt') fail(`MSFT mappedProvider: ${msft.mappedProvider}`);
  if (msft.mappedNativeSymbol !== 'BYBIT:MSFT/USDT') {
    fail(`MSFT mappedNativeSymbol: ${msft.mappedNativeSymbol}`);
  }
  if (!msft.mappedFile || !msft.mappedFile.endsWith(`${crossStem}.ohlcv`)) {
    fail(`MSFT mappedFile: ${msft.mappedFile}`);
  }
  if (msft.mappedFileExists !== true) fail('MSFT mappedFileExists not true');
  log('(a) inspect-security buckets + global-map fields OK');

  // ---- (b) full run resolves via the map with NO --security arg ----
  const bRun = await runBridge(pythonBin, bridgeRoot, ws.workdir, 'security_demo', chartStem);
  if (bRun.exitCode !== 0) fail(`(b) bridge exit ${bRun.exitCode}`);
  const bErr = bRun.events.find((e) => e.e === 'error');
  if (bErr && bErr.e === 'error') fail(`(b) unexpected error: ${bErr.message}`);
  const bEnd = bRun.events.find((e) => e.e === 'end');
  if (!bEnd || bEnd.e !== 'end' || bEnd.cancelled || bEnd.bars === 0) fail('(b) bad end');
  log(`(b) map-resolved run OK (no --security): ${bEnd.bars} bars`);

  // ---- (c) explicit --security overrides a broken map ----
  // Point the map at a provider file that does NOT exist, then override with an
  // explicit --security mapping to the real file. Reaching `end` proves the
  // explicit mapping wins over the global map.
  writeSymbolMap(configDir, '[symbol_map]\n"NASDAQ:MSFT" = "ccxt:BYBIT:NOPE/USDT"\n');
  const cRun = await runBridge(
    pythonBin,
    bridgeRoot,
    ws.workdir,
    'security_demo',
    chartStem,
    [`NASDAQ:MSFT=${crossStem}`]
  );
  if (cRun.exitCode !== 0) fail(`(c) bridge exit ${cRun.exitCode}`);
  const cErr = cRun.events.find((e) => e.e === 'error');
  if (cErr && cErr.e === 'error') fail(`(c) unexpected error: ${cErr.message}`);
  const cEnd = cRun.events.find((e) => e.e === 'end');
  if (!cEnd || cEnd.e !== 'end' || cEnd.cancelled || cEnd.bars === 0) fail('(c) bad end');
  log(`(c) explicit --security override OK: ${cEnd.bars} bars`);

  // ---- (d) map to a missing file, no --security -> pynecore error ----
  const dRun = await runBridge(pythonBin, bridgeRoot, ws.workdir, 'security_demo', chartStem);
  const dErr = dRun.events.find((e) => e.e === 'error');
  if (!dErr || dErr.e !== 'error') fail('(d) expected an error event for the missing mapped file');
  if (!/symbol_map\.toml/.test(dErr.message) || !/NOPE/.test(dErr.message)) {
    fail(`(d) unexpected error message: ${dErr.message}`);
  }
  const dEnd = dRun.events.find((e) => e.e === 'end');
  if (dEnd && dEnd.e === 'end' && dEnd.bars > 0) fail('(d) run should not have completed bars');
  log('(d) missing-mapping error OK');

  log('BRIDGE SECURITY SMOKE OK');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
