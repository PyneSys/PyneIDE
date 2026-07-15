/**
 * OHLCV table webview: parses the raw 24-byte records handed over by the host
 * (uint32 timestamp + 5x float32 OHLCV, little-endian) and renders them in a
 * virtualized table. Only the visible window of rows is in the DOM at once, so
 * a 100k+ bar file scrolls smoothly. Gap-fill records (volume < 0) are hidden,
 * matching what a run/chart sees.
 */
import type { OhlcvMeta, TableInMessage, TableOutMessage } from '../messages';

const RECORD_SIZE = 24;
const ROW_H = 22;
const OVERSCAN = 6;

interface VsCodeApi {
  postMessage(message: TableOutMessage): void;
}
declare function acquireVsCodeApi(): VsCodeApi;
const vscode = acquireVsCodeApi();

const titleEl = document.getElementById('title') as HTMLDivElement;
const subtitleEl = document.getElementById('subtitle') as HTMLDivElement;
const thTimeEl = document.getElementById('th-time') as HTMLDivElement;
const viewport = document.getElementById('viewport') as HTMLDivElement;
const spacer = document.getElementById('spacer') as HTMLDivElement;
const windowEl = document.getElementById('window') as HTMLDivElement;
const emptyEl = document.getElementById('empty') as HTMLDivElement;

let view: DataView | undefined;
/** Record indices of the non-gap bars, in file order (virtual row -> record). */
let positions = new Int32Array(0);
let priceDecimals = 2;
let mintick = 0;
let tzFormatter: Intl.DateTimeFormat | undefined;
let tzName = 'UTC';
let tzMode: 'utc' | 'exchange' = 'utc';

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
  view = new DataView(buffer);
  const recordCount = Math.floor(buffer.byteLength / RECORD_SIZE);

  mintick = meta.mintick && meta.mintick > 0 ? meta.mintick : 0;
  priceDecimals = decimalsFor(meta);
  setupTimezone(meta.timezone);

  // Build the virtual-row -> record map, dropping gap-fill records (volume < 0).
  const idx: number[] = [];
  for (let pos = 0; pos < recordCount; pos++) {
    if (view.getFloat32(pos * RECORD_SIZE + 20, true) >= 0) idx.push(pos);
  }
  positions = Int32Array.from(idx);

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
  chip('TF', meta.period);
  chip('TZ', tzName);
  chip('Tick', mintick ? String(mintick) : undefined);
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
    thTimeEl.textContent = 'Time (UTC)';
  }
}

function updateTimeHeader(toggle: HTMLButtonElement): void {
  const showingExchange = tzMode === 'exchange' && tzFormatter;
  thTimeEl.textContent = `Time (${showingExchange ? tzName : 'UTC'})`;
  toggle.textContent = showingExchange ? `Show UTC` : `Show ${tzName}`;
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
    parts.push(rowHtml(row, positions[row]));
  }
  windowEl.innerHTML = parts.join('');
}

function rowHtml(row: number, pos: number): string {
  const o = pos * RECORD_SIZE;
  const view0 = view as DataView;
  const ts = view0.getUint32(o, true);
  const open = snap(view0.getFloat32(o + 4, true));
  const high = snap(view0.getFloat32(o + 8, true));
  const low = snap(view0.getFloat32(o + 12, true));
  const close = snap(view0.getFloat32(o + 16, true));
  const volume = view0.getFloat32(o + 20, true);
  const dir = close >= open ? 'up' : 'down';
  return (
    `<div class="grid-row">` +
    `<div class="c-idx">${(row + 1).toLocaleString('en-US')}</div>` +
    `<div class="c-time">${formatTime(ts)}</div>` +
    `<div class="c-num">${price(open)}</div>` +
    `<div class="c-num">${price(high)}</div>` +
    `<div class="c-num">${price(low)}</div>` +
    `<div class="c-num ${dir}">${price(close)}</div>` +
    `<div class="c-num">${volumeStr(volume)}</div>` +
    `</div>`
  );
}

function snap(value: number): number {
  if (mintick > 0) return Math.round(value / mintick) * mintick;
  return value;
}

function price(value: number): string {
  return value.toFixed(priceDecimals);
}

function volumeStr(value: number): string {
  if (Number.isInteger(value)) return value.toLocaleString('en-US');
  // Trim float dust to 8 decimals, then strip trailing zeros.
  return String(Number(value.toFixed(8)));
}

function recordTime(pos: number): number {
  return (view as DataView).getUint32(pos * RECORD_SIZE, true);
}

function formatTime(tsSeconds: number): string {
  if (tzMode === 'exchange' && tzFormatter) return formatExchange(tsSeconds);
  return formatUtc(tsSeconds);
}

function formatUtc(tsSeconds: number): string {
  const d = new Date(tsSeconds * 1000);
  return (
    `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())} ` +
    `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())}`
  );
}

function formatExchange(tsSeconds: number): string {
  // en-CA yields YYYY-MM-DD; join parts as "date time".
  const parts = (tzFormatter as Intl.DateTimeFormat).formatToParts(new Date(tsSeconds * 1000));
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
