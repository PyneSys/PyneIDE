/**
 * Bridge viz smoke test — verifies the plotMeta/colors protocol additions
 * (F9A A1) end-to-end against a real pynecore, WITHOUT VSCode.
 *
 * Usage: node dist/bridge-viz-smoke.js [pythonBin]
 * `pythonBin` must be a venv python with pynecore importable (defaults to the
 * dev extension's managed venv). When that pynecore predates the viz layer
 * (< 6.6), the degradation contract is asserted instead: no plotMeta/colors
 * events and a clean run.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { execProcess } from '../../src/env/exec';
import {
  buildOutputPreview,
  resolveOutputPair,
  resolveScriptOutputPair,
} from '../../src/data/outputPreview';
import { managedVenvDir, pyneBinPath, venvPythonPath } from '../../src/env/uv';
import { scaffoldWorkdirWithCli } from '../../src/env/workdir';
import {
  BridgeRun,
  type BridgeEvent,
  type ColorEnc,
  type DrawingEventRecord,
  type PlotMetaRecord,
} from '../../src/run/bridgeClient';

const log = (msg: string): void => console.log(msg);

/** Exercises the A1 surface (static/dynamic colors, histogram/circles styles,
 * force_overlay, display=none, an always-dynamic bgcolor channel), the A2 one
 * (hline, stepline, plotshape/plotchar markers, offset/show_last), the A3 one
 * (area style, trackprice, plotarrow) and the A4 one (plotcandle/plotbar,
 * barcolor, fill between plots and between hlines). */
const VIZ_SCRIPT = `"""
@pyne
Viz styles demo
"""
from pynecore.lib import (
    script, plot, plotarrow, plotbar, plotcandle, plotshape, plotchar,
    barcolor, bgcolor, fill, hline, color, display, shape, location, size,
    close, na, ta, bar_index,
)


@script.indicator("Viz Styles Demo", overlay=False)
def main():
    m = ta.sma(close, 5)
    plot(m, "sma", color=color.orange, linewidth=2)
    plot(close - m, "hist", style=plot.style_histogram, color=color.teal)
    plot(close, "dyn", color=color.red if bar_index % 2 == 0 else color.lime)
    plot(m, "circ", style=plot.style_circles, color=color.purple)
    plot(close, "onprice", color=color.blue, force_overlay=True)
    plot(m, "hidden", display=display.none)
    plot(m, "step", style=plot.style_stepline, color=color.aqua, offset=2, show_last=40)
    hline(0.0, "zero", color=color.gray, linestyle=hline.style_dotted, linewidth=2)
    plotshape(bar_index % 7 == 0, "marks", style=shape.triangleup,
              location=location.top, color=color.green, size=size.small, text="up")
    plotchar(bar_index % 5 == 0, "stars", char="*", location=location.bottom,
             color=color.yellow)
    bgcolor(color.new(color.blue, 85) if bar_index % 3 == 0 else na, title="bg")
    plot(m, "areap", style=plot.style_area, color=color.new(color.teal, 70))
    plot(m, "track", color=color.silver, trackprice=True)
    plotarrow(close - m, "arr", colorup=color.green, colordown=color.red)
    pf1 = plot(m + 2, "fa", color=color.olive)
    pf2 = plot(m - 2, "fb", color=color.olive)
    fill(pf1, pf2, color=color.new(color.olive, 80), title="pfill")
    h1 = hline(1.0, "hup", color=color.gray)
    h2 = hline(-1.0, "hdn", color=color.gray)
    fill(h1, h2, color=color.new(color.gray, 90), title="hfill")
    plotcandle(m, m + 1, m - 1, m + 0.5, "pc",
               color=color.green if bar_index % 2 == 0 else color.red,
               wickcolor=color.gray)
    plotbar(m, m + 1, m - 1, m + 0.5, "pb", color=color.maroon)
    barcolor(color.orange if bar_index % 4 == 0 else na, title="bc")
`;

/** Exercises the F9B drawing journal: every family created on the first
 * bar, a trend line mutated per bar (update events), a line deleted mid-run
 * (delete event), future-pointing x2 and a filled table cell. */
const DRAW_SCRIPT = `"""
@pyne
Viz drawings demo
"""
from pynecore.lib import (
    script, color, close, high, low, bar_index,
    line, label, box, table, polyline, linefill, chart, extend, position,
)
from pynecore.types import Persistent, Line


@script.indicator("Viz Drawings Demo", overlay=True)
def main():
    trend: Persistent[Line] = line.new(0, close, 1, close, color=color.blue,
                                       width=2, style=line.style_dashed)
    doomed: Persistent[Line] = line.new(0, low, 5, low, color=color.red)
    if bar_index == 0:
        label.new(bar_index, high, "start", color=color.green,
                  textcolor=color.white, style=label.style_label_down)
        box.new(bar_index, high, bar_index + 10, low,
                border_color=color.gray, bgcolor=color.new(color.blue, 90))
        polyline.new([chart.point.from_index(0, low),
                      chart.point.from_index(3, high),
                      chart.point.from_index(6, low)],
                     line_color=color.purple)
        l1 = line.new(bar_index, high, bar_index + 20, high, extend=extend.right)
        l2 = line.new(bar_index, low, bar_index + 20, low, extend=extend.right)
        linefill.new(l1, l2, color.new(color.teal, 85))
        tbl = table.new(position.top_right, 2, 1, bgcolor=color.new(color.gray, 80))
        table.cell(tbl, 0, 0, "sym")
        table.cell(tbl, 1, 0, "42")
    line.set_xy2(trend, bar_index, close)
    if bar_index == 20:
        line.delete(doomed)
`;

const STRATEGY_SCRIPT = `"""
@pyne
Equity persistence demo
"""
from pynecore.lib import script, strategy, close, open, plot


@script.strategy("Equity Persistence Demo", overlay=True)
def main():
    plot(close, "Price")
    if close > open:
        strategy.entry("Long", strategy.long)
    elif close < open:
        strategy.entry("Short", strategy.short)
`;

function fail(msg: string): never {
  throw new Error(msg);
}

async function vizCapable(pythonBin: string): Promise<boolean> {
  const probe =
    'from pynecore.core import viz; import sys; sys.exit(0 if hasattr(viz, "serialize_meta") else 3)';
  const res = await execProcess(pythonBin, ['-c', probe], log, { timeoutMs: 60000 });
  return res.code === 0;
}

interface Collected {
  events: BridgeEvent[];
  exitCode: number | null;
}

async function runBridge(pythonBin: string, workdir: string, script: string): Promise<Collected> {
  const events: BridgeEvent[] = [];
  const run = BridgeRun.start({
    pythonBin,
    bridgeRoot: path.join(__dirname, '..', 'python'),
    script,
    data: 'demo',
    workdir,
    batchSize: 50,
    onEvent: (ev) => events.push(ev),
    onLog: (line) => log(`[bridge] ${line}`),
  });
  const exitCode = await run.exited;
  return { events, exitCode };
}

function assertVizStream(events: BridgeEvent[]): void {
  const hello = events.find((ev) => ev.e === 'hello');
  if (!hello || hello.e !== 'hello' || hello.protocol !== 3) fail('bad hello/protocol');

  // Meta-before-bars: every plot registers on bar 0 in the demo script, so
  // the very first plotMeta event must precede the first bars event.
  const firstMetaIdx = events.findIndex((ev) => ev.e === 'plotMeta');
  const firstBarsIdx = events.findIndex((ev) => ev.e === 'bars');
  if (firstMetaIdx < 0) fail('no plotMeta events');
  if (firstBarsIdx >= 0 && firstMetaIdx > firstBarsIdx) fail('plotMeta after first bars');

  // Meta contents (last version wins — upsert by id).
  const metas = new Map<string, PlotMetaRecord>();
  let dynEmissions = 0;
  for (const ev of events) {
    if (ev.e !== 'plotMeta') continue;
    for (const m of ev.metas) {
      metas.set(m.id, m);
      if (m.id === 'dyn') dynEmissions++;
    }
  }
  const ids = [
    'sma', 'hist', 'dyn', 'circ', 'onprice', 'hidden', 'step',
    'hline#0', 'marks', 'stars', 'bgcolor#0', 'areap', 'track', 'arr',
    'fa', 'fb', 'fill#0', 'hline#1', 'hline#2', 'fill#1',
    'pc', 'pb', 'barcolor#0',
  ];
  for (const id of ids) {
    if (!metas.has(id)) fail(`missing meta: ${id}`);
  }
  if (metas.get('sma')?.linewidth !== 2) fail('sma linewidth');
  if (metas.get('hist')?.style !== 'histogram') fail('hist style');
  if (metas.get('circ')?.style !== 'circles') fail('circ style');
  if (metas.get('onprice')?.force_overlay !== true) fail('onprice force_overlay');
  if (metas.get('hidden')?.display !== 'none') fail('hidden display');
  if (metas.get('bgcolor#0')?.kind !== 'bgcolor') fail('bgcolor kind');

  // A2 metas: stepline + offset/show_last, hline price/linestyle, shape/char.
  const step = metas.get('step');
  if (step?.style !== 'stepline') fail('step style');
  if (step.offset !== 2) fail('step offset');
  if (step.show_last !== 40) fail('step show_last');
  const hl = metas.get('hline#0');
  if (hl?.kind !== 'hline') fail('hline kind');
  if (hl.price !== 0) fail('hline price');
  if (hl.linestyle !== 'dotted') fail('hline linestyle');
  if (hl.linewidth !== 2) fail('hline linewidth');
  const marks = metas.get('marks');
  if (marks?.kind !== 'shape') fail('marks kind');
  if (marks.style !== 'triangleup') fail('marks style');
  if (marks.location !== 'top') fail('marks location');
  if (marks.size !== 'small') fail('marks size');
  if (marks.text !== 'up') fail('marks text');
  const stars = metas.get('stars');
  if (stars?.kind !== 'char') fail('stars kind');
  if (stars.char !== '*') fail('stars char');
  if (stars.location !== 'bottom') fail('stars location');

  // A3 metas: area style, trackprice flag, plotarrow colors/height bounds.
  if (metas.get('areap')?.style !== 'area') fail('areap style');
  if (metas.get('track')?.trackprice !== true) fail('track trackprice');
  const arr = metas.get('arr');
  if (arr?.kind !== 'arrow') fail('arr kind');
  if (arr.colorup !== '#4CAF50FF') fail(`arr colorup: ${arr.colorup}`);
  if (arr.colordown !== '#F23645FF') fail(`arr colordown: ${arr.colordown}`);
  if (arr.minheight !== 5 || arr.maxheight !== 100) fail('arr height bounds');

  // A4 metas: plot-pair and hline-pair fills, candle/bar OHLC plots (four
  // value columns each), an always-dynamic barcolor channel.
  const pfill = metas.get('fill#0');
  if (pfill?.kind !== 'fill') fail('fill#0 kind');
  if (pfill.plot1 !== 'fa' || pfill.plot2 !== 'fb') fail('fill#0 plot refs');
  if (typeof pfill.color !== 'string') fail('fill#0 color');
  const hfill = metas.get('fill#1');
  if (hfill?.kind !== 'fill') fail('fill#1 kind');
  if (hfill.hline1 !== 'hline#1' || hfill.hline2 !== 'hline#2') fail('fill#1 hline refs');
  const pc = metas.get('pc');
  if (pc?.kind !== 'candle') fail('pc kind');
  if (pc.dynamic !== true) fail('pc not dynamic');
  if (typeof pc.wickcolor !== 'string') fail('pc wickcolor');
  const pb = metas.get('pb');
  if (pb?.kind !== 'bar') fail('pb kind');
  if (typeof pb.color !== 'string') fail('pb color');
  if (metas.get('barcolor#0')?.kind !== 'barcolor') fail('barcolor kind');

  // plotcandle/plotbar store four value columns keyed off the title.
  const keysEv = events.find((ev) => ev.e === 'plotKeys');
  if (!keysEv || keysEv.e !== 'plotKeys') fail('no plotKeys event');
  for (const col of ['pc (open)', 'pc (high)', 'pc (low)', 'pc (close)', 'pb (open)']) {
    if (!keysEv.keys.includes(col)) fail(`missing plot column: ${col}`);
  }

  // Static -> dynamic upsert: "dyn" registers static on bar 0 and re-emits
  // with dynamic:true once its color first diverges (bar 1) — the two
  // versions land in different flushes, so the id must appear twice.
  if (dynEmissions < 2) fail(`dyn meta emitted ${dynEmissions}x, expected upsert re-emission`);
  if (metas.get('dyn')?.dynamic !== true) fail('dyn meta not dynamic');

  // Color deltas: every timestamp must refer to an already-delivered bar,
  // and both the alternating plot channel and the always-dynamic bgcolor
  // channel (nulls included) must flow.
  const seenTs = new Set<number>();
  const channelValues = new Map<string, ColorEnc[]>();
  for (const ev of events) {
    if (ev.e === 'bars') {
      for (const row of ev.d) seenTs.add(row[0]);
    } else if (ev.e === 'colors') {
      for (const [tMs, delta] of ev.d) {
        if (!seenTs.has(tMs)) fail(`colors row for undelivered bar ${tMs}`);
        for (const key of Object.keys(delta)) {
          let list = channelValues.get(key);
          if (!list) channelValues.set(key, (list = []));
          list.push(delta[key]);
        }
      }
    }
  }
  const dynChanges = channelValues.get('dyn') ?? [];
  if (dynChanges.length < 2) fail(`dyn channel changes: ${dynChanges.length}`);
  const bg = channelValues.get('bgcolor#0') ?? [];
  if (!bg.some((v) => v === null) || !bg.some((v) => typeof v === 'string')) {
    fail('bgcolor channel must carry both null (off) and color values');
  }
  const bc = channelValues.get('barcolor#0') ?? [];
  if (!bc.some((v) => v === null) || !bc.some((v) => typeof v === 'string')) {
    fail('barcolor channel must carry both null (off) and color values');
  }
  const pcCh = channelValues.get('pc') ?? [];
  if (!pcCh.some((v) => Array.isArray(v) && v.length === 3)) {
    fail('pc channel must carry (color, wick, border) 3-tuples');
  }

  const end = events.find((ev) => ev.e === 'end');
  if (!end || end.e !== 'end' || end.cancelled || end.bars === 0) fail('bad end');
  const err = events.find((ev) => ev.e === 'error');
  if (err && err.e === 'error') fail(`error event: ${err.message}`);
  log(`Viz stream OK: ${metas.size} metas, ${channelValues.size} color channels`);
}

function assertNativeVizFile(workdir: string, stem: string): void {
  const file = path.join(workdir, 'output', `${stem}_viz.ndjson`);
  if (!fs.existsSync(file)) fail(`native viz output missing: ${file}`);
  const records = fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as { t?: string; id?: string; bars?: number; data?: string });
  if (records[0]?.t !== 'hdr') fail('native viz header missing');
  const dataPath = fs.realpathSync(path.join(workdir, 'data', 'demo.ohlcv'));
  if (records[0]?.data !== dataPath) fail('native viz source data path missing');
  if (records.at(-1)?.t !== 'end') fail('native viz end missing');
  if (!records.some((record) => record.t === 'meta' && record.id === 'sma')) {
    fail('native viz plot metadata missing');
  }
  if (!records.some((record) => record.t === 'bar')) fail('native viz bars missing');

  const pair = resolveOutputPair(file);
  if (!pair) fail('native viz/CSV pair was not resolved');
  const scriptPair = resolveScriptOutputPair(workdir, path.join(workdir, 'scripts', `${stem}.py`));
  if (!scriptPair || scriptPair.plot !== pair.plot || scriptPair.viz !== pair.viz) {
    fail('script did not resolve to its native viz/CSV output pair');
  }
  const preview = buildOutputPreview(pair);
  if (preview.warnings.length) fail(`output preview warnings: ${preview.warnings.join('; ')}`);
  const start = preview.events[0];
  if (start.e !== 'start' || start.data !== dataPath) fail('preview source data path missing');
  if (!preview.events.some((event) => event.e === 'plotMeta')) fail('preview plot metadata missing');
  if (!preview.events.some((event) => event.e === 'colors')) fail('preview colors missing');
  const bars = preview.events.find((event) => event.e === 'bars');
  if (!bars || bars.e !== 'bars' || !bars.d.length) fail('preview bars missing');
  const end = preview.events.at(-1);
  if (!end || end.e !== 'end' || end.cancelled) fail('preview end missing');
  log(`Native viz file OK: ${records.length} NDJSON records`);
}

function assertNativeEquityFile(workdir: string, stem: string): void {
  const file = path.join(workdir, 'output', `${stem}_viz.ndjson`);
  const records = fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as { t?: string; equity?: number | null });
  const persisted = records.filter(
    (record): record is { t: string; equity: number } =>
      record.t === 'bar' && typeof record.equity === 'number'
  );
  if (!persisted.length) fail('native viz strategy equity missing');

  const pair = resolveOutputPair(file);
  if (!pair) fail('native strategy viz/CSV pair was not resolved');
  const preview = buildOutputPreview(pair);
  const start = preview.events[0];
  if (start.e !== 'start' || typeof start.initialCapital !== 'number') {
    fail('persisted strategy initial capital missing');
  }
  const bars = preview.events.find((event) => event.e === 'bars');
  if (!bars || bars.e !== 'bars') fail('strategy preview bars missing');
  const replayed = bars.d.filter((bar) => typeof bar[7] === 'number');
  if (replayed.length !== persisted.length) {
    fail(`strategy equity replay mismatch: ${replayed.length}/${persisted.length}`);
  }
  log(`Native strategy equity OK: ${persisted.length} bars`);
}

/**
 * F9B drawing journal assertions: every family present, the persistent
 * trend line accumulates per-bar updates, the doomed line's delete is
 * journaled, and every event's bar index refers to an already-delivered bar.
 */
function assertDrawStream(events: BridgeEvent[]): void {
  let barsSeen = 0;
  const records: DrawingEventRecord[] = [];
  for (const ev of events) {
    if (ev.e === 'bars') {
      barsSeen += ev.d.length;
    } else if (ev.e === 'drawings') {
      for (const rec of ev.d) {
        if (rec.i >= barsSeen) fail(`drawing event for undelivered bar ${rec.i}`);
        records.push(rec);
      }
    }
  }
  if (!records.length) fail('no drawings events');

  const families = new Set(records.map((r) => r.obj));
  for (const fam of ['line', 'label', 'box', 'table', 'polyline', 'linefill'] as const) {
    if (!families.has(fam)) fail(`missing drawing family: ${fam}`);
  }

  const creates = records.filter((r) => r.op === 'create');
  if (creates.some((r) => r.s === undefined)) fail('create without state');
  if (!creates.every((r) => r.i === 0)) fail('all creates expected on bar 0');

  // The trend line moves every bar -> one update per bar after its create.
  const lineUpdates = records.filter((r) => r.obj === 'line' && r.op === 'update');
  if (lineUpdates.length < 10) fail(`too few line updates: ${lineUpdates.length}`);

  const deletes = records.filter((r) => r.op === 'delete');
  if (deletes.length !== 1 || deletes[0].obj !== 'line' || deletes[0].i !== 20) {
    fail('expected exactly one line delete on bar 20');
  }
  if (deletes[0].s !== undefined) fail('delete must not carry state');

  // Spot-check serialized shapes: line style/extend enum names, label text,
  // table cells, polyline points, linefill embedded line states.
  const trendCreate = creates.find(
    (r) => r.obj === 'line' && (r.s as { style?: string }).style === 'dashed'
  );
  if (!trendCreate) fail('no dashed line create (trend)');
  if ((trendCreate.s as { width?: number }).width !== 2) fail('trend width');
  const extLine = creates.find(
    (r) => r.obj === 'line' && (r.s as { extend?: string }).extend === 'right'
  );
  if (!extLine) fail('no extend=right line create');
  const labelCreate = creates.find((r) => r.obj === 'label');
  const labelState = labelCreate?.s as { text?: string; style?: string } | undefined;
  if (labelState?.text !== 'start') fail('label text');
  if (labelState?.style !== 'label_down') fail('label style');
  const tableCreate = creates.find((r) => r.obj === 'table');
  const tableState = tableCreate?.s as
    | { position?: string; cells?: Array<{ text?: string }> }
    | undefined;
  if (tableState?.position !== 'top_right') fail('table position');
  if ((tableState?.cells?.length ?? 0) < 2) fail('table cells');
  const polyCreate = creates.find((r) => r.obj === 'polyline');
  const polyState = polyCreate?.s as { points?: unknown[] } | undefined;
  if ((polyState?.points?.length ?? 0) !== 3) fail('polyline points');
  const lfCreate = creates.find((r) => r.obj === 'linefill');
  const lfState = lfCreate?.s as
    | { line1_state?: { extend?: string }; line2_state?: object }
    | undefined;
  if (lfState?.line1_state?.extend !== 'right' || !lfState.line2_state) {
    fail('linefill embedded line states');
  }

  const end = events.find((ev) => ev.e === 'end');
  if (!end || end.e !== 'end' || end.cancelled || end.bars === 0) fail('bad end (drawings)');
  const err = events.find((ev) => ev.e === 'error');
  if (err && err.e === 'error') fail(`error event (drawings): ${err.message}`);
  log(
    `Drawing journal OK: ${creates.length} creates, ${lineUpdates.length} line updates, ` +
      `${deletes.length} delete`
  );
}

function assertDegraded(events: BridgeEvent[]): void {
  if (events.some((ev) => ev.e === 'plotMeta' || ev.e === 'colors' || ev.e === 'drawings')) {
    fail('viz-incapable pynecore must not emit plotMeta/colors/drawings');
  }
  const end = events.find((ev) => ev.e === 'end');
  if (!end || end.e !== 'end' || end.cancelled || end.bars === 0) fail('bad end (degraded)');
  if (events.some((ev) => ev.e === 'error')) fail('error event (degraded)');
  log('Degradation OK: clean v1-shaped run without viz events');
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

  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pyneide-viz-'));
  const ws = await scaffoldWorkdirWithCli(pyneBinPath(pythonBin), path.join(base, 'workdir'), log);
  fs.writeFileSync(path.join(ws.workdir, 'scripts', 'viz_styles_demo.py'), VIZ_SCRIPT);
  fs.writeFileSync(path.join(ws.workdir, 'scripts', 'viz_drawings_demo.py'), DRAW_SCRIPT);
  fs.writeFileSync(path.join(ws.workdir, 'scripts', 'equity_demo.py'), STRATEGY_SCRIPT);

  const capable = await vizCapable(pythonBin);
  log(`pynecore viz layer: ${capable ? 'present' : 'absent (degradation path)'}`);

  const { events, exitCode } = await runBridge(pythonBin, ws.workdir, 'viz_styles_demo');
  if (exitCode !== 0) fail(`bridge exit code ${exitCode}`);
  if (capable) {
    assertVizStream(events);
    assertNativeVizFile(ws.workdir, 'viz_styles_demo');
  }
  else assertDegraded(events);

  if (capable) {
    const draw = await runBridge(pythonBin, ws.workdir, 'viz_drawings_demo');
    if (draw.exitCode !== 0) fail(`bridge exit code ${draw.exitCode} (drawings)`);
    assertDrawStream(draw.events);

    const strategy = await runBridge(pythonBin, ws.workdir, 'equity_demo');
    if (strategy.exitCode !== 0) fail(`bridge exit code ${strategy.exitCode} (strategy)`);
    assertNativeEquityFile(ws.workdir, 'equity_demo');
  }

  log('BRIDGE VIZ SMOKE OK');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
