/**
 * OHLCV table webview: decodes the binary handed over by the host through the
 * shared `ohlcvFormat` reader (v2 header-declared schema, or the legacy
 * header-less 24-byte records) and renders it in a virtualized table. Only the
 * visible window of rows is in the DOM at once, so a 100k+ bar file scrolls
 * smoothly. Legacy gap-fill records (volume < 0) are hidden, matching what a
 * run/chart sees; v2 files have none.
 */
import type { OhlcvMeta, TableInMessage, TableOutMessage } from '../messages';
import {
  OhlcvDecoder,
  parseOhlcvLayout,
  recordOffset,
  type OhlcvLayout,
} from '../ohlcvFormat';

const ROW_H = 22;
const OVERSCAN = 6;

interface VsCodeApi {
  postMessage(message: TableOutMessage): void;
}
declare function acquireVsCodeApi(): VsCodeApi;
const vscode = acquireVsCodeApi();

const titleEl = document.getElementById('title') as HTMLDivElement;
const subtitleEl = document.getElementById('subtitle') as HTMLDivElement;
const infoToggleEl = document.getElementById('info-toggle') as HTMLButtonElement;
const syminfoPanelEl = document.getElementById('syminfo-panel') as HTMLDivElement;
const theadEl = document.getElementById('thead') as HTMLDivElement;
const viewport = document.getElementById('viewport') as HTMLDivElement;
const spacer = document.getElementById('spacer') as HTMLDivElement;
const windowEl = document.getElementById('window') as HTMLDivElement;
const emptyEl = document.getElementById('empty') as HTMLDivElement;

let view: DataView | undefined;
/** How the loaded file's records are laid out (schema, count, version). */
let layout: OhlcvLayout | undefined;
let decoder: OhlcvDecoder | undefined;
/** Non-OHLCV columns the file declares (bid/ask/…), in record order. */
let extraNames: string[] = [];
/** Byte length of the loaded .ohlcv, for the file-stats panel. */
let fileByteLength = 0;
/** Record indices of the non-gap bars, in file order (virtual row -> record). */
let positions = new Int32Array(0);
let priceDecimals = 2;
let mintick = 0;
let tzFormatter: Intl.DateTimeFormat | undefined;
let tzName = 'UTC';
let tzMode: 'utc' | 'exchange' = 'utc';
/** Row order: oldest bar first (file order) or newest first. */
let ascending = true;
/** Current label of the time column, kept across header rebuilds. */
let timeHeaderText = 'Time (UTC)';

window.addEventListener('message', (ev: MessageEvent<TableInMessage>) => {
  const msg = ev.data;
  if (msg.type === 'error') {
    showError(msg.message);
  } else if (msg.type === 'data') {
    void loadFromUri(msg.uri, msg.meta);
  }
});

async function loadFromUri(uri: string, meta: OhlcvMeta): Promise<void> {
  try {
    // The browser streams the binary natively — no postMessage serialization.
    const buffer = await (await fetch(uri)).arrayBuffer();
    load(buffer, meta);
  } catch (err) {
    showError(`Could not load data: ${err instanceof Error ? err.message : String(err)}`);
  }
}

viewport.addEventListener('scroll', scheduleRender);
window.addEventListener('resize', scheduleRender);

vscode.postMessage({ type: 'ready' });

function showError(message: string): void {
  titleEl.textContent = 'OHLCV';
  subtitleEl.textContent = '';
  emptyEl.hidden = false;
  emptyEl.textContent = message;
}

function load(buffer: ArrayBuffer, meta: OhlcvMeta): void {
  try {
    layout = parseOhlcvLayout(new Uint8Array(buffer), buffer.byteLength);
    decoder = new OhlcvDecoder(layout);
  } catch (err) {
    showError(`Unreadable .ohlcv file: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  view = new DataView(buffer);
  fileByteLength = buffer.byteLength;
  extraNames = decoder.extraNames;
  const recordCount = layout.recordCount;

  mintick = meta.mintick && meta.mintick > 0 ? meta.mintick : 0;
  priceDecimals = decimalsFor(meta);
  setupTimezone(meta.timezone);
  renderThead();

  // Build the virtual-row -> record map. Only the legacy format has phantom
  // gap-fill records (volume < 0); v2 simply omits missing bars.
  if (layout.version === 1) {
    const idx: number[] = [];
    for (let pos = 0; pos < recordCount; pos++) {
      if (decoder.read(view, recordOffset(layout, pos)).volume >= 0) idx.push(pos);
    }
    positions = Int32Array.from(idx);
  } else {
    positions = new Int32Array(recordCount);
    for (let pos = 0; pos < recordCount; pos++) positions[pos] = pos;
  }

  renderHeader(meta, recordCount);

  if (positions.length === 0) {
    emptyEl.hidden = false;
    emptyEl.textContent = recordCount
      ? 'No bars to show (every record is a gap-fill).'
      : 'This .ohlcv file has no records.';
    spacer.style.height = '0px';
    windowEl.innerHTML = '';
    return;
  }
  emptyEl.hidden = true;
  spacer.style.height = `${positions.length * ROW_H}px`;
  render();
}

function decimalsFor(meta: OhlcvMeta): number {
  if (meta.mintick && meta.mintick > 0) {
    return clampDecimals(Math.round(-Math.log10(meta.mintick)));
  }
  if (meta.pricescale && meta.pricescale > 0) {
    return clampDecimals(Math.round(Math.log10(meta.pricescale)));
  }
  return 2;
}

function clampDecimals(d: number): number {
  if (!Number.isFinite(d) || d < 0) return 0;
  return Math.min(d, 10);
}

function setupTimezone(timezone: string | undefined): void {
  tzName = timezone && timezone.length ? timezone : 'UTC';
  tzFormatter = undefined;
  if (tzName !== 'UTC') {
    try {
      tzFormatter = new Intl.DateTimeFormat('en-CA', {
        timeZone: tzName,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
      });
      tzMode = 'exchange';
    } catch {
      tzFormatter = undefined; // invalid/unknown tz — stay on UTC
    }
  }
}

/**
 * Rebuild the column headers from the file's own schema: a v2 file may declare
 * columns beyond OHLCV (bid/ask/open interest/…), which the rows then show.
 * The `#` and time cells sort the table (both index and time are the same
 * ordering, so either one flips it).
 */
function renderThead(): void {
  const columns = ['Open', 'High', 'Low', 'Close', 'Volume', ...extraNames.map(prettyName)];
  const arrow = `<span class="sort-arrow">${ascending ? '▲' : '▼'}</span>`;
  theadEl.innerHTML =
    `<div class="c-idx sortable" id="th-index"># ${arrow}</div>` +
    `<div class="c-time sortable" id="th-time">` +
    `<span id="th-time-label">${escapeHtml(timeHeaderText)}</span> ${arrow}</div>` +
    columns.map((name) => `<div class="c-num">${escapeHtml(name)}</div>`).join('');
  for (const id of ['th-index', 'th-time']) {
    const cell = document.getElementById(id);
    if (cell) cell.onclick = toggleSort;
  }
}

function toggleSort(): void {
  ascending = !ascending;
  renderThead();
  viewport.scrollTop = 0;
  render();
}

/** `open_interest` -> `Open interest`, for a column header. */
function prettyName(name: string): string {
  const spaced = name.replace(/_/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function renderHeader(meta: OhlcvMeta, recordCount: number): void {
  titleEl.textContent = meta.description || meta.ticker || meta.fileName;

  const first = positions.length ? recordTime(positions[0]) : undefined;
  const last = positions.length ? recordTime(positions[positions.length - 1]) : undefined;
  const gaps = recordCount - positions.length;

  const chips: string[] = [];
  const chip = (label: string, value: string | undefined): void => {
    if (value) chips.push(`<span class="kv">${label} <b>${escapeHtml(value)}</b></span>`);
  };
  chip('Symbol', meta.ticker);
  chip('Type', meta.type);
  // The v2 header states the period as a fact; the toml only mirrors it.
  chip('TF', layout?.period ?? meta.period);
  chip('TZ', tzName);
  chip('Tick', mintick ? String(mintick) : undefined);
  chip('Format', layout ? `v${layout.version}` : undefined);
  chips.push(
    `<span class="kv">Bars <b>${positions.length.toLocaleString('en-US')}</b>${
      gaps > 0 ? ` (+${gaps.toLocaleString('en-US')} gaps)` : ''
    }</span>`
  );
  if (first !== undefined && last !== undefined) {
    chip('Range', `${formatUtc(first)} — ${formatUtc(last)} UTC`);
  }

  subtitleEl.innerHTML =
    chips.join('') +
    '<span class="spacer"></span>' +
    `<button id="tz-toggle"${tzFormatter ? '' : ' hidden'}></button>`;
  const toggle = document.getElementById('tz-toggle') as HTMLButtonElement | null;
  if (toggle) {
    toggle.onclick = (): void => {
      tzMode = tzMode === 'utc' ? 'exchange' : 'utc';
      updateTimeHeader(toggle);
      render();
    };
    updateTimeHeader(toggle);
  } else {
    setTimeHeader('Time (UTC)');
  }

  renderSymInfoPanel(meta, recordCount);
}

// --- expandable symbol-info panel -------------------------------------------

interface Group {
  title: string;
  keys: string[];
}
const INFO_GROUPS: Group[] = [
  { title: 'Identification', keys: ['prefix', 'ticker', 'description', 'type', 'currency', 'basecurrency', 'timezone'] },
  { title: 'Pricing', keys: ['mintick', 'pricescale', 'minmove', 'pointvalue', 'mincontract', 'volumetype'] },
  { title: 'Fees & spread', keys: ['avg_spread', 'taker_fee', 'maker_fee'] },
  { title: 'Reference', keys: ['country', 'sector', 'industry', 'isin', 'expiration_date', 'current_contract'] },
  {
    title: 'Fundamentals',
    keys: [
      'employees', 'shareholders', 'shares_outstanding_total', 'shares_outstanding_float',
      'target_price_average', 'target_price_high', 'target_price_low', 'target_price_median',
      'recommendations_total', 'recommendations_buy', 'recommendations_hold', 'recommendations_sell',
    ],
  },
];
const DAY_NAMES = ['', 'Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function renderSymInfoPanel(meta: OhlcvMeta, recordCount: number): void {
  const groups: string[] = [];

  // The file itself (always available, even without a .toml).
  const first = positions.length ? recordTime(positions[0]) : undefined;
  const last = positions.length ? recordTime(positions[positions.length - 1]) : undefined;
  const gaps = recordCount - positions.length;
  const fileRows: string[] = [];
  fileRows.push(kv('bars', positions.length.toLocaleString('en-US')));
  if (gaps > 0) fileRows.push(kv('gap-fills', gaps.toLocaleString('en-US')));
  if (first !== undefined && last !== undefined) {
    fileRows.push(kv('from', `${formatUtc(first)} UTC`));
    fileRows.push(kv('to', `${formatUtc(last)} UTC`));
  }
  fileRows.push(kv('size', formatBytes(fileByteLength)));
  if (layout) {
    const density = layout.dense === undefined ? '' : layout.dense ? ', dense' : ', sparse';
    fileRows.push(kv('format', `v${layout.version} (${layout.recordSize} B/bar${density})`));
  }
  if (meta.full?.provider) fileRows.push(kv('provider', meta.full.provider));
  groups.push(groupHtml('File', fileRows));

  const sym = meta.full?.symbol;
  if (sym) {
    for (const g of INFO_GROUPS) {
      const rows: string[] = [];
      for (const key of g.keys) {
        const v = sym[key];
        if (v === undefined || v === '') continue;
        rows.push(kv(key, v));
      }
      if (rows.length) groups.push(groupHtml(g.title, rows));
    }
    const hours = hoursHtml(meta.full?.openingHours);
    if (hours) groups.push(`<div class="group"><h4>Trading hours</h4>${hours}</div>`);
  }

  syminfoPanelEl.innerHTML = groups.join('');
  infoToggleEl.hidden = false;
  infoToggleEl.onclick = (): void => {
    const open = syminfoPanelEl.classList.toggle('open');
    infoToggleEl.classList.toggle('open', open);
  };
}

function groupHtml(title: string, rows: string[]): string {
  return `<div class="group"><h4>${title}</h4><div class="kv-grid">${rows.join('')}</div></div>`;
}

function kv(key: string, value: string): string {
  return `<div class="k">${escapeHtml(key)}</div><div class="v">${escapeHtml(value)}</div>`;
}

function hoursHtml(
  intervals: { day?: number; start?: string; end?: string }[] | undefined
): string | undefined {
  if (!intervals || intervals.length === 0) return undefined;
  const rows: string[] = [];
  for (const iv of intervals) {
    const day = typeof iv.day === 'number' ? (DAY_NAMES[iv.day] ?? String(iv.day)) : '';
    rows.push(
      `<tr><td class="day">${escapeHtml(day)}</td>` +
      `<td>${escapeHtml(hm(iv.start))} – ${escapeHtml(hm(iv.end))}</td></tr>`
    );
  }
  return rows.length ? `<table class="hours">${rows.join('')}</table>` : undefined;
}

function hm(t: string | undefined): string {
  if (!t) return '—';
  return t.endsWith(':00') ? t.slice(0, 5) : t;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function updateTimeHeader(toggle: HTMLButtonElement): void {
  const showingExchange = tzMode === 'exchange' && tzFormatter;
  setTimeHeader(`Time (${showingExchange ? tzName : 'UTC'})`);
  toggle.textContent = showingExchange ? `Show UTC` : `Show ${tzName}`;
}

/** The header row is rebuilt per file and per sort, so the label is kept here
 * and only the text node is touched — the sort arrow stays in place. */
function setTimeHeader(text: string): void {
  timeHeaderText = text;
  const label = document.getElementById('th-time-label');
  if (label) label.textContent = text;
}

// --- virtualization ---------------------------------------------------------

let rafPending = false;
function scheduleRender(): void {
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => {
    rafPending = false;
    render();
  });
}

function render(): void {
  if (!view || positions.length === 0) return;
  const total = positions.length;
  const scrollTop = viewport.scrollTop;
  const vh = viewport.clientHeight || 1;
  const start = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN);
  const end = Math.min(total, Math.ceil((scrollTop + vh) / ROW_H) + OVERSCAN);

  windowEl.style.top = `${start * ROW_H}px`;
  const parts: string[] = [];
  for (let row = start; row < end; row++) {
    // Descending only reverses which bar a screen row shows; the bar index
    // itself always counts from the oldest bar.
    const barIndex = ascending ? row : total - 1 - row;
    parts.push(rowHtml(barIndex, positions[barIndex]));
  }
  windowEl.innerHTML = parts.join('');
}

/** `barIndex` is Pine's zero-based `bar_index`, not a row number. */
function rowHtml(barIndex: number, pos: number): string {
  const bar = (decoder as OhlcvDecoder).read(
    view as DataView,
    recordOffset(layout as OhlcvLayout, pos)
  );
  const open = snap(bar.open);
  const close = snap(bar.close);
  const dir = close >= open ? 'up' : 'down';
  const extras = extraNames
    .map((name) => `<div class="c-num">${numberStr(bar.extra?.[name] ?? NaN)}</div>`)
    .join('');
  return (
    `<div class="grid-row">` +
    `<div class="c-idx">${barIndex.toLocaleString('en-US')}</div>` +
    `<div class="c-time">${formatTime(bar.timestamp)}</div>` +
    `<div class="c-num">${price(open)}</div>` +
    `<div class="c-num">${price(snap(bar.high))}</div>` +
    `<div class="c-num">${price(snap(bar.low))}</div>` +
    `<div class="c-num ${dir}">${price(close)}</div>` +
    `<div class="c-num">${numberStr(bar.volume)}</div>` +
    extras +
    `</div>`
  );
}

function snap(value: number): number {
  if (mintick > 0) return Math.round(value / mintick) * mintick;
  return value;
}

/** Missing values are NaN in the v2 format — show them as a dash, not "NaN". */
function price(value: number): string {
  return Number.isNaN(value) ? '—' : value.toFixed(priceDecimals);
}

function numberStr(value: number): string {
  if (Number.isNaN(value)) return '—';
  if (Number.isInteger(value)) return value.toLocaleString('en-US');
  // Trim float dust to 8 decimals, then strip trailing zeros.
  return String(Number(value.toFixed(8)));
}

/** Timestamp (ms) of one record, without decoding its prices. */
function recordTime(pos: number): number {
  return (decoder as OhlcvDecoder).timestampAt(
    view as DataView,
    recordOffset(layout as OhlcvLayout, pos)
  );
}

function formatTime(tsMs: number): string {
  if (tzMode === 'exchange' && tzFormatter) return formatExchange(tsMs);
  return formatUtc(tsMs);
}

function formatUtc(tsMs: number): string {
  const d = new Date(tsMs);
  return (
    `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())} ` +
    `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())}`
  );
}

function formatExchange(tsMs: number): string {
  // en-CA yields YYYY-MM-DD; join parts as "date time".
  const parts = (tzFormatter as Intl.DateTimeFormat).formatToParts(new Date(tsMs));
  const g: Record<string, string> = {};
  for (const part of parts) g[part.type] = part.value;
  return `${g.year}-${g.month}-${g.day} ${g.hour}:${g.minute}:${g.second}`;
}

function p2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;'
  );
}
