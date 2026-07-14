/**
 * Chart webview: KLineChart v10 fed from the runner bridge event stream.
 *
 * Data flow: bar rows accumulate in `allBars`; a throttled tick calls
 * `chart.resetData()`, whose data loader serves the full array (v10 has no
 * push API — the loader model IS the API). Plot lines are grouped into two
 * dynamic indicators (candle pane vs a separate pane) driven by the script's
 * declared `overlay=` (indicator()/strategy()); pynecore's plot() carries no
 * per-plot style/force_overlay metadata yet. Strategy equity gets its own
 * pane; closed trades become annotation overlays at run end.
 */
import {
  init,
  dispose,
  registerIndicator,
  type Chart,
  type KLineData,
  type DeepPartial,
  type Period,
  type Styles,
  type VisibleRange,
} from 'klinecharts';

import type { BarRow, StartEvent, TradeRecord } from '../../run/bridgeClient';
import type { ChartInMessage, ChartOutMessage } from '../messages';

declare function acquireVsCodeApi(): { postMessage(msg: ChartOutMessage): void };

const vscode = acquireVsCodeApi();

const UI_TICK_MS = 400;
const MAX_TRADE_ANNOTATIONS = 2000;

const PLOT_COLORS = [
  '#2962ff',
  '#ff6d00',
  '#d500f9',
  '#00bfa5',
  '#ffd600',
  '#f50057',
  '#00b8d4',
  '#76ff03',
];

interface PyneBar extends KLineData {
  plots: (number | null)[];
  equity?: number | null;
}

interface RunState {
  chart: Chart;
  start: StartEvent;
  bars: PyneBar[];
  plotKeys: string[];
  trades: TradeRecord[];
  stats: Record<string, number | null> | undefined;
  dirty: boolean;
  ended: boolean;
  /** plot index -> 'overlay' | 'pane', once decided */
  plotPane: Map<number, 'overlay' | 'pane'>;
  overlayIndicatorId?: string;
  paneIndicatorId?: string;
  equityIndicatorId?: string;
  showVolume: boolean;
  volumeIndicatorId?: string;
}

let state: RunState | undefined;

const container = document.getElementById('chart') as HTMLDivElement;

function cssVar(name: string, fallback: string): string {
  const v = getComputedStyle(document.body).getPropertyValue(name).trim();
  return v || fallback;
}

function isDark(): boolean {
  return (
    document.body.classList.contains('vscode-dark') ||
    document.body.classList.contains('vscode-high-contrast')
  );
}

function chartStyles(): DeepPartial<Styles> {
  const dark = isDark();
  const text = cssVar('--vscode-editor-foreground', dark ? '#ccc' : '#333');
  const grid = dark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)';
  const axisLine = dark ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.2)';
  return {
    grid: {
      horizontal: { color: grid },
      vertical: { color: grid },
    },
    candle: {
      priceMark: { last: { text: { color: dark ? '#000' : '#fff' } } },
      tooltip: { legend: { color: text } },
    },
    indicator: {
      tooltip: { legend: { color: text } },
    },
    xAxis: {
      axisLine: { color: axisLine },
      tickText: { color: text },
    },
    yAxis: {
      axisLine: { color: axisLine },
      tickText: { color: text },
    },
    crosshair: {
      horizontal: { text: { backgroundColor: dark ? '#555' : '#333' } },
      vertical: { text: { backgroundColor: dark ? '#555' : '#333' } },
    },
  };
}

function mintickDecimals(mintick: unknown): number {
  const t = typeof mintick === 'number' ? mintick : 0;
  if (!(t > 0) || t >= 1) return 2;
  return Math.min(10, Math.max(0, Math.round(-Math.log10(t))));
}

/** TradingView period string ("60", "1D", "1W"...) to a v10 period object. */
function parsePeriod(period: unknown): Period {
  const p = String(period ?? '').toUpperCase();
  const m = /^(\d*)([SDWM]?)$/.exec(p);
  if (!m) return { span: 1, type: 'day' };
  const span = m[1] ? parseInt(m[1], 10) : 1;
  switch (m[2]) {
    case 'S':
      return { span, type: 'second' };
    case 'D':
      return { span, type: 'day' };
    case 'W':
      return { span, type: 'week' };
    case 'M':
      return { span, type: 'month' };
    default:
      return { span: span || 1, type: 'minute' };
  }
}

function rowToBar(row: BarRow): PyneBar {
  return {
    timestamp: row[0],
    open: row[1] ?? NaN,
    high: row[2] ?? NaN,
    low: row[3] ?? NaN,
    close: row[4] ?? NaN,
    volume: row[5] ?? undefined,
    plots: row[6] ?? [],
    equity: row[7] ?? null,
  };
}

function startRun(start: StartEvent): void {
  if (state) {
    dispose(state.chart);
  }
  container.innerHTML = '';
  const chart = init(container);
  if (!chart) return;

  chart.setStyles(chartStyles());
  const tz = start.syminfo.timezone;
  if (typeof tz === 'string' && tz) {
    try {
      chart.setTimezone(tz);
    } catch {
      // unknown IANA zone: keep the default
    }
  }

  state = {
    chart,
    start,
    bars: [],
    plotKeys: [],
    trades: [],
    stats: undefined,
    dirty: false,
    ended: false,
    plotPane: new Map(),
    showVolume: false,
  };
  renderTables();
  const st = state;

  chart.setDataLoader({
    getBars: ({ callback }) => {
      callback(st.bars.slice(), false);
    },
    subscribeBar: () => {},
    unsubscribeBar: () => {},
  });
  chart.setSymbol({
    ticker: String(start.syminfo.tickerid ?? start.syminfo.ticker ?? 'SYMBOL'),
    pricePrecision: mintickDecimals(start.syminfo.mintick),
    volumePrecision: 2,
  });
  chart.setPeriod(parsePeriod(start.syminfo.period));
  chart.subscribeAction('onVisibleRangeChange', (data) =>
    updateRealtimeButton(data as VisibleRange)
  );
  applyVolume(state, false);
  syncToolbar();
  updateRealtimeButton();
}

// --- "Back to realtime" floating button ------------------------------------
// KLineChart has no built-in TradingView-style jump-to-latest control; we show
// our own once the newest bar scrolls off the right edge. `range.to` is the
// last visible real bar index (exclusive), clamped to the data length, so
// `to < bars.length` means the newest bar is out of view.

const toRealtimeEl = document.getElementById('to-realtime') as HTMLButtonElement | null;

function updateRealtimeButton(range?: VisibleRange): void {
  if (!toRealtimeEl) return;
  const total = state?.bars.length ?? 0;
  const to = range ? range.to : state?.chart.getVisibleRange().to ?? 0;
  const show = total > 0 && to < total;
  toRealtimeEl.hidden = !show;
  if (show && state) {
    // Sit just left of the price axis (its width grows with the price digits).
    const yAxis = state.chart.getSize('candle_pane', 'yAxis');
    toRealtimeEl.style.right = `${Math.round((yAxis?.width ?? 60) + 8)}px`;
  }
}

toRealtimeEl?.addEventListener('click', () => {
  state?.chart.scrollToRealTime(300);
});

/**
 * Show/hide the volume histogram. Volume is opt-in (this is an indicator/
 * strategy dev tool, not a trading terminal). When on, draw a plain histogram —
 * calcParams: [] strips the built-in VOL indicator's MA5/MA10/MA20 lines.
 */
function applyVolume(st: RunState, on: boolean): void {
  st.showVolume = on;
  if (on && st.volumeIndicatorId === undefined) {
    st.volumeIndicatorId = st.chart.createIndicator({ name: 'VOL', calcParams: [] }) ?? undefined;
  } else if (!on && st.volumeIndicatorId !== undefined) {
    st.chart.removeIndicator({ id: st.volumeIndicatorId });
    st.volumeIndicatorId = undefined;
  }
}

/**
 * Assign plots to the candle pane (overlay) or a separate pane, honoring the
 * script's declared `overlay=` (indicator()/strategy()). Pine's model: overlay
 * scripts draw their plots on the price pane, non-overlay scripts in a separate
 * pane. Per-plot `force_overlay` is not yet exposed by pynecore, so every plot
 * follows the script-level flag.
 */
function assignPlotPanes(st: RunState): boolean {
  const target: 'overlay' | 'pane' = st.start.overlay ? 'overlay' : 'pane';
  let changed = false;
  for (let i = 0; i < st.plotKeys.length; i++) {
    if (st.plotPane.has(i)) continue;
    st.plotPane.set(i, target);
    changed = true;
  }
  return changed;
}

function figureKey(index: number): string {
  return `p${index}`;
}

function rebuildPlotIndicators(st: RunState): void {
  const overlayIdx = [...st.plotPane.entries()].filter(([, p]) => p === 'overlay').map(([i]) => i);
  const paneIdx = [...st.plotPane.entries()].filter(([, p]) => p === 'pane').map(([i]) => i);

  const makeDefinition = (name: string, indices: number[], precision: number) => ({
    name,
    shortName: 'Plots',
    precision,
    figures: indices.map((i, n) => ({
      key: figureKey(i),
      title: `${st.plotKeys[i]}: `,
      type: 'line',
      styles: () => ({ color: PLOT_COLORS[n % PLOT_COLORS.length] }),
    })),
    calc: (dataList: PyneBar[]) =>
      dataList.map((d) => {
        const out: Record<string, number | null> = {};
        for (const i of indices) out[figureKey(i)] = d.plots?.[i] ?? null;
        return out;
      }),
  });

  if (overlayIdx.length) {
    const pricePrecision = mintickDecimals(st.start.syminfo.mintick);
    registerIndicator(makeDefinition('PynePlotsOverlay', overlayIdx, pricePrecision) as never);
    if (st.overlayIndicatorId) st.chart.removeIndicator({ id: st.overlayIndicatorId });
    st.overlayIndicatorId =
      st.chart.createIndicator({ name: 'PynePlotsOverlay', paneId: 'candle_pane' }, true) ??
      undefined;
  }
  if (paneIdx.length) {
    registerIndicator(makeDefinition('PynePlotsPane', paneIdx, 2) as never);
    if (st.paneIndicatorId) st.chart.removeIndicator({ id: st.paneIndicatorId });
    st.paneIndicatorId = st.chart.createIndicator('PynePlotsPane') ?? undefined;
  }
}

function ensureEquityIndicator(st: RunState): void {
  if (st.equityIndicatorId) return;
  if (st.start.scriptType !== 'strategy') return;
  if (!st.bars.some((b) => typeof b.equity === 'number')) return;
  registerIndicator({
    name: 'PyneEquity',
    shortName: 'Equity',
    precision: 2,
    figures: [
      {
        key: 'equity',
        title: 'Equity: ',
        type: 'line',
        styles: () => ({ color: '#00bfa5' }),
      },
    ],
    calc: (dataList: PyneBar[]) => dataList.map((d) => ({ equity: d.equity ?? null })),
  } as never);
  st.equityIndicatorId = st.chart.createIndicator('PyneEquity') ?? undefined;
}

function addTradeAnnotations(st: RunState): void {
  let budget = MAX_TRADE_ANNOTATIONS;
  for (const trade of st.trades) {
    if (budget <= 0) break;
    const long = (trade.size ?? 0) > 0;
    if (trade.entryTime > 0 && trade.entryPrice != null) {
      st.chart.createOverlay({
        name: 'simpleAnnotation',
        points: [{ timestamp: trade.entryTime, value: trade.entryPrice }],
        extendData: `${long ? '▲ Long' : '▼ Short'} ${trade.entryId ?? ''}`,
        styles: {
          text: { color: long ? '#26a69a' : '#ef5350' },
        },
        lock: true,
      });
      budget--;
    }
    if (trade.exitTime > 0 && trade.exitPrice != null && budget > 0) {
      const win = (trade.profit ?? 0) >= 0;
      st.chart.createOverlay({
        name: 'simpleAnnotation',
        points: [{ timestamp: trade.exitTime, value: trade.exitPrice }],
        extendData: `✕ ${trade.exitId ?? ''} (${win ? '+' : ''}${(trade.profit ?? 0).toFixed(2)})`,
        styles: {
          text: { color: win ? '#26a69a' : '#ef5350' },
        },
        lock: true,
      });
      budget--;
    }
  }
}

/**
 * Adaptive UI tick: a full resetData() costs O(bars), so the next tick is
 * scheduled relative to how long the last one took — the main thread stays
 * mostly idle even while a 100k-bar backtest streams in, updates just get
 * less frequent as the dataset grows.
 */
function uiTick(): void {
  const st = state;
  let elapsed = 0;
  if (st && st.dirty && !st.ended) {
    st.dirty = false;
    const t0 = performance.now();
    const paneChange = assignPlotPanes(st);
    st.chart.resetData();
    // Follow the freshly streamed bars; resetData alone keeps the old anchor.
    st.chart.scrollToRealTime(0);
    if (paneChange) rebuildPlotIndicators(st);
    ensureEquityIndicator(st);
    elapsed = performance.now() - t0;
  }
  setTimeout(uiTick, Math.max(UI_TICK_MS, elapsed * 3));
}

setTimeout(uiTick, UI_TICK_MS);

// --- Bottom panel: trades / stats tables -----------------------------------
// The elements are absent in standalone test harnesses; every access is
// guarded so the chart works without the panel markup.

const bottomEl = document.getElementById('bottom');
const tabBodyEl = document.getElementById('tab-body');
const tabTradesEl = document.getElementById('tab-trades');
const tabStatsEl = document.getElementById('tab-stats');
const tabToggleEl = document.getElementById('tab-toggle');
let activeTab: 'trades' | 'stats' = 'trades';

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function fmt(v: number | null | undefined, decimals = 2): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return v.toLocaleString(undefined, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

function fmtTime(ts: number): string {
  if (!(ts > 0)) return '—';
  return new Date(ts).toISOString().replace('T', ' ').slice(0, 16);
}

function signClass(v: number | null | undefined): string {
  if (v === null || v === undefined || v === 0) return '';
  return v > 0 ? 'pos' : 'neg';
}

function setCollapsed(collapsed: boolean): void {
  if (!bottomEl) return;
  bottomEl.classList.toggle('collapsed', collapsed);
  if (tabToggleEl) tabToggleEl.textContent = collapsed ? '▴' : '▾';
  state?.chart.resize();
}

function renderTrades(): string {
  const st = state;
  if (!st || st.trades.length === 0) {
    return '<span class="muted">No trades (yet). Indicators produce no trades.</span>';
  }
  const d = mintickDecimals(st.start.syminfo.mintick);
  const rows = st.trades
    .map((t, i) => {
      const long = (t.size ?? 0) > 0;
      return (
        `<tr class="clickable" data-ts="${t.entryTime}">` +
        `<td>${i + 1} ${long ? '▲' : '▼'} ${esc(t.entryId ?? '')}</td>` +
        `<td>${fmtTime(t.entryTime)}</td><td>${fmt(t.entryPrice, d)}</td>` +
        `<td>${fmtTime(t.exitTime)}</td><td>${fmt(t.exitPrice, d)}</td>` +
        `<td>${fmt(Math.abs(t.size ?? 0), 4)}</td>` +
        `<td class="${signClass(t.profit)}">${fmt(t.profit)}</td>` +
        `<td class="${signClass(t.profitPct)}">${fmt(t.profitPct)}%</td>` +
        `<td class="${signClass(t.cumProfit)}">${fmt(t.cumProfit)}</td>` +
        `</tr>`
      );
    })
    .join('');
  return (
    '<table><thead><tr><th>Trade</th><th>Entry time</th><th>Entry price</th>' +
    '<th>Exit time</th><th>Exit price</th><th>Qty</th><th>Profit</th><th>Profit %</th>' +
    '<th>Cum. profit</th></tr></thead><tbody>' +
    rows +
    '</tbody></table>'
  );
}

function renderStats(): string {
  const st = state;
  if (!st?.stats) {
    return '<span class="muted">Strategy statistics appear when the run finishes.</span>';
  }
  const rows = Object.entries(st.stats)
    .map(([key, value]) => {
      const pct = key.includes('%');
      const isCount = Number.isInteger(value) && !pct && Math.abs(value ?? 0) < 1e6 &&
        /Trades|Wins|Losses|Calls|Bars/.test(key);
      return (
        `<tr><td>${esc(key)}</td>` +
        `<td class="${signClass(value)}">${isCount ? String(value) : fmt(value)}${pct ? '%' : ''}</td></tr>`
      );
    })
    .join('');
  return '<table><thead><tr><th>Metric</th><th>Value</th></tr></thead><tbody>' + rows + '</tbody></table>';
}

function renderTables(): void {
  if (!tabBodyEl || !bottomEl) return;
  tabTradesEl?.classList.toggle('active', activeTab === 'trades');
  tabStatsEl?.classList.toggle('active', activeTab === 'stats');
  if (tabTradesEl && state) tabTradesEl.textContent = `Trades (${state.trades.length})`;
  if (bottomEl.classList.contains('collapsed')) return;
  tabBodyEl.innerHTML = activeTab === 'trades' ? renderTrades() : renderStats();
}

tabTradesEl?.addEventListener('click', () => {
  activeTab = 'trades';
  setCollapsed(false);
  renderTables();
});
tabStatsEl?.addEventListener('click', () => {
  activeTab = 'stats';
  setCollapsed(false);
  renderTables();
});
tabToggleEl?.addEventListener('click', () => {
  setCollapsed(!bottomEl?.classList.contains('collapsed'));
  renderTables();
});
tabBodyEl?.addEventListener('click', (event) => {
  const row = (event.target as HTMLElement).closest('tr[data-ts]');
  const ts = row ? Number((row as HTMLElement).dataset.ts) : 0;
  if (ts > 0) state?.chart.scrollToTimestamp(ts, 200);
});

// --- Top toolbar: volume / go-to-date / CSV --------------------------------
// Elements are absent in standalone test harnesses; every access is guarded.

const tbDataEl = document.getElementById('tb-data') as HTMLButtonElement | null;
const tbVolumeEl = document.getElementById('tb-volume');
const tbGotoEl = document.getElementById('tb-goto');
const tbGotoBoxEl = document.getElementById('tb-goto-box');
const tbGotoInputEl = document.getElementById('tb-goto-input') as HTMLInputElement | null;
const tbGotoDoEl = document.getElementById('tb-goto-do');
const tbCsvPlotEl = document.getElementById('tb-csv-plot') as HTMLButtonElement | null;
const tbCsvTradesEl = document.getElementById('tb-csv-trades') as HTMLButtonElement | null;

/** The data name shown on the Data button (bare stem of the .ohlcv path). */
function dataLabel(dataPath?: string): string {
  if (!dataPath) return 'Data';
  const base = dataPath.split(/[\\/]/).pop() ?? dataPath;
  return base.endsWith('.ohlcv') ? base.slice(0, -'.ohlcv'.length) : base;
}

/** Reflect current run state onto the toolbar (data, volume, CSV). */
function syncToolbar(): void {
  const st = state;
  if (tbDataEl) tbDataEl.textContent = dataLabel(st?.start.data);
  tbVolumeEl?.classList.toggle('active', st?.showVolume === true);
  if (tbCsvPlotEl) tbCsvPlotEl.disabled = !(st?.ended && st.start.outputs.plot);
  if (tbCsvTradesEl) {
    const hasTrades = st?.ended === true && st.trades.length > 0 && !!st.start.outputs.trades;
    tbCsvTradesEl.hidden = st?.start.scriptType !== 'strategy';
    tbCsvTradesEl.disabled = !hasTrades;
  }
}

tbDataEl?.addEventListener('click', () => vscode.postMessage({ type: 'selectData' }));

tbVolumeEl?.addEventListener('click', () => {
  if (!state) return;
  applyVolume(state, !state.showVolume);
  syncToolbar();
});

tbGotoEl?.addEventListener('click', () => {
  const open = tbGotoBoxEl?.classList.toggle('open');
  if (open && tbGotoInputEl) {
    if (!tbGotoInputEl.value && state?.bars.length) {
      // Prefill with the first bar's time (UTC) as a sensible starting point.
      tbGotoInputEl.value = new Date(state.bars[0].timestamp).toISOString().slice(0, 19);
    }
    tbGotoInputEl.focus();
  }
});

/** Parse the datetime-local value as a UTC instant to match bar timestamps. */
function gotoInputTimestamp(): number | undefined {
  const v = tbGotoInputEl?.value;
  const m = v ? /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(v) : null;
  if (!m) return undefined;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], m[6] ? +m[6] : 0);
}

function doGoto(): void {
  const ts = gotoInputTimestamp();
  if (ts !== undefined) state?.chart.scrollToTimestamp(ts, 200);
}

tbGotoDoEl?.addEventListener('click', doGoto);
tbGotoInputEl?.addEventListener('keydown', (e) => {
  if ((e as KeyboardEvent).key === 'Enter') doGoto();
});

tbCsvPlotEl?.addEventListener('click', () => vscode.postMessage({ type: 'openCsv', which: 'plot' }));
tbCsvTradesEl?.addEventListener('click', () =>
  vscode.postMessage({ type: 'openCsv', which: 'trades' })
);

window.addEventListener('message', (event: MessageEvent<ChartInMessage>) => {
  const msg = event.data;
  switch (msg.type) {
    case 'reset':
      startRun(msg.start);
      break;
    case 'bars': {
      if (!state) break;
      for (const row of msg.rows) {
        const bar = rowToBar(row);
        state.bars.push(bar);
      }
      state.dirty = true;
      break;
    }
    case 'plotKeys':
      if (state) {
        state.plotKeys = msg.keys;
        state.dirty = true;
      }
      break;
    case 'trades':
    case 'openTrades':
      if (state) state.trades.push(...msg.trades);
      break;
    case 'stats':
      if (state) state.stats = msg.stats;
      break;
    case 'end':
      if (state) {
        state.ended = true;
        state.dirty = false;
        assignPlotPanes(state);
        state.chart.resetData();
        state.chart.scrollToRealTime(0);
        rebuildPlotIndicators(state);
        ensureEquityIndicator(state);
        addTradeAnnotations(state);
        if (state.trades.length) setCollapsed(false);
        renderTables();
        syncToolbar();
      }
      break;
  }
});

window.addEventListener('resize', () => state?.chart.resize());

vscode.postMessage({ type: 'ready' });
