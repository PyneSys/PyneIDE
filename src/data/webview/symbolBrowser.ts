/**
 * Symbol browser webview: the searchable symbol list + live symbol info + inline
 * download bar. Mirrors the `pyne data download` TUI in VSCode idioms.
 *
 * The list is virtualized (only the visible window of rows lives in the DOM), so
 * a provider's thousands of symbols scroll smoothly; the filter binds into a
 * `positions` index the same way the OHLCV table does. The row under the cursor
 * is looked up with a 150 ms debounce (matching the TUI) via a `requestSyminfo`
 * carrying a monotonic reqId, so a stale reply for a row the cursor already left
 * is dropped.
 */
import type {
  BrokerInfo,
  ProviderInfo,
  SymInfoDict,
} from '../providerService';
import type {
  BrowserDefaults,
  BrowserInMessage,
  BrowserOutMessage,
} from '../symbolBrowserMessages';

const ROW_H = 22;
const OVERSCAN = 8;
const SYMINFO_DEBOUNCE_MS = 150;
const TIMEFRAMES = ['1', '5', '15', '60', '240', '1D', '1W'];

interface VsCodeApi {
  postMessage(message: BrowserOutMessage): void;
}
declare function acquireVsCodeApi(): VsCodeApi;
const vscode = acquireVsCodeApi();

const el = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const providerSel = el<HTMLSelectElement>('provider');
const brokerSel = el<HTMLSelectElement>('broker');
const brokerLabel = el<HTMLLabelElement>('broker-label');
const filterInput = el<HTMLInputElement>('filter');
const listStatus = el<HTMLDivElement>('list-status');
const viewport = el<HTMLDivElement>('viewport');
const spacer = el<HTMLDivElement>('spacer');
const windowEl = el<HTMLDivElement>('window');
const infoEmpty = el<HTMLDivElement>('info-empty');
const infoBody = el<HTMLDivElement>('info-body');
const timeframeSel = el<HTMLSelectElement>('timeframe');
const fromSel = el<HTMLSelectElement>('from');
const fromDate = el<HTMLInputElement>('from-date');
const truncateChk = el<HTMLInputElement>('truncate');
const downloadBtn = el<HTMLButtonElement>('download');
const cancelBtn = el<HTMLButtonElement>('cancel');
const progressWrap = el<HTMLDivElement>('progress-wrap');
const progressFill = el<HTMLDivElement>('progress-fill');
const progressText = el<HTMLSpanElement>('progress-text');
const downMsg = el<HTMLDivElement>('down-msg');

// --- state -------------------------------------------------------------------

let providers: ProviderInfo[] = [];
let currentMultiBroker = false;
let allSymbols: string[] = [];
/** Indices into `allSymbols` that pass the current filter, in list order. */
let positions: number[] = [];
let selected = -1; // index into `positions`
let syminfoReqId = 0;
let lastSyminfoReqId = 0;
let syminfoTimer: ReturnType<typeof setTimeout> | undefined;
let downloading = false;

// --- init / messaging --------------------------------------------------------

window.addEventListener('message', (ev: MessageEvent<BrowserInMessage>) => {
  const msg = ev.data;
  switch (msg.type) {
    case 'init':
      onInit(msg.providers, msg.defaults);
      break;
    case 'brokers':
      onBrokers(msg.provider, msg.supported, msg.brokers, msg.error);
      break;
    case 'symbolsLoading':
      listStatus.textContent = 'Loading symbols…';
      break;
    case 'symbols':
      onSymbols(msg.symbols, msg.error);
      break;
    case 'syminfo':
      if (msg.reqId === lastSyminfoReqId) renderSyminfo(msg.symbol, msg.info);
      break;
    case 'syminfoError':
      if (msg.reqId === lastSyminfoReqId) renderSyminfoError(msg.symbol, msg.message);
      break;
    case 'downloadProgress':
      onProgress(msg.done, msg.total, msg.indeterminate);
      break;
    case 'downloadDone':
      onDownloadDone(msg.symbol, msg.barsWritten);
      break;
    case 'downloadError':
      onDownloadError(msg.message);
      break;
  }
});

function onInit(list: ProviderInfo[], defaults: BrowserDefaults): void {
  providers = list;
  providerSel.innerHTML = '';
  if (list.length === 0) {
    listStatus.textContent = 'Provider service unavailable.';
  }
  for (const p of list) {
    const opt = document.createElement('option');
    opt.value = p.name;
    opt.textContent = p.display_name && p.display_name !== p.name ? `${p.name} — ${p.display_name}` : p.name;
    providerSel.appendChild(opt);
  }

  timeframeSel.innerHTML = '';
  for (const tf of TIMEFRAMES) {
    const opt = document.createElement('option');
    opt.value = tf;
    opt.textContent = tf;
    timeframeSel.appendChild(opt);
  }
  timeframeSel.value = defaults.timeframe && TIMEFRAMES.includes(defaults.timeframe) ? defaults.timeframe : '1D';

  buildFromOptions();

  const startProvider = defaults.provider && list.some((p) => p.name === defaults.provider)
    ? defaults.provider
    : list[0]?.name;
  if (startProvider) {
    providerSel.value = startProvider;
    pendingBrokerDefault = defaults.broker;
    selectProvider(startProvider);
  }
}

let pendingBrokerDefault: string | undefined;

function selectProvider(name: string): void {
  const info = providers.find((p) => p.name === name);
  currentMultiBroker = Boolean(info?.multi_broker);
  brokerSel.hidden = !currentMultiBroker;
  brokerLabel.hidden = !currentMultiBroker;
  allSymbols = [];
  positions = [];
  selected = -1;
  renderList();
  showInfoEmpty('Pick a symbol to see its info.');
  if (currentMultiBroker) {
    listStatus.textContent = 'Loading brokers…';
    vscode.postMessage({ type: 'selectProvider', provider: name });
  } else {
    listStatus.textContent = 'Loading symbols…';
    vscode.postMessage({ type: 'selectBroker', provider: name });
  }
  persist();
}

function onBrokers(provider: string, supported: boolean, brokers: BrokerInfo[], error?: string): void {
  if (providerSel.value !== provider) return;
  if (error) {
    listStatus.textContent = `Broker list failed: ${error}`;
    return;
  }
  if (!supported) {
    // Single-broker provider that just does not enumerate — go straight to symbols.
    brokerSel.hidden = true;
    brokerLabel.hidden = true;
    listStatus.textContent = 'Loading symbols…';
    vscode.postMessage({ type: 'selectBroker', provider });
    return;
  }
  brokerSel.hidden = false;
  brokerLabel.hidden = false;
  brokerSel.innerHTML = '';
  for (const b of brokers) {
    const opt = document.createElement('option');
    opt.value = b.id;
    opt.textContent = b.name && b.name !== b.id ? `${b.id} — ${b.name}` : b.id;
    brokerSel.appendChild(opt);
  }
  const wanted = pendingBrokerDefault && brokers.some((b) => b.id === pendingBrokerDefault)
    ? pendingBrokerDefault
    : brokers[0]?.id;
  pendingBrokerDefault = undefined;
  if (wanted) {
    brokerSel.value = wanted;
    listStatus.textContent = 'Loading symbols…';
    vscode.postMessage({ type: 'selectBroker', provider, broker: wanted });
    persist();
  } else {
    listStatus.textContent = 'No brokers.';
  }
}

function onSymbols(symbols: string[], error?: string): void {
  if (error) {
    allSymbols = [];
    positions = [];
    selected = -1;
    renderList();
    listStatus.textContent = `Symbols failed: ${error}`;
    return;
  }
  allSymbols = symbols;
  applyFilter();
}

// --- filtering + virtualization ---------------------------------------------

function applyFilter(): void {
  const q = filterInput.value.trim().toLowerCase();
  const prevSymbol = selected >= 0 && selected < positions.length ? allSymbols[positions[selected]] : undefined;
  if (!q) {
    positions = allSymbols.map((_, i) => i);
  } else {
    positions = [];
    for (let i = 0; i < allSymbols.length; i++) {
      if (allSymbols[i].toLowerCase().includes(q)) positions.push(i);
    }
  }
  // Keep the previously selected symbol if it survived the filter, else first.
  selected = -1;
  if (prevSymbol) {
    const at = positions.findIndex((p) => allSymbols[p] === prevSymbol);
    if (at >= 0) selected = at;
  }
  if (selected < 0 && positions.length > 0) selected = 0;

  spacer.style.height = `${positions.length * ROW_H}px`;
  listStatus.textContent = `${positions.length.toLocaleString('en-US')} / ${allSymbols.length.toLocaleString('en-US')} symbols`;
  renderList();
  updateDownloadEnabled();
  if (selected >= 0) {
    ensureVisible(selected);
    scheduleSyminfo();
  } else {
    showInfoEmpty(allSymbols.length ? 'No match.' : 'No symbols.');
  }
}

let rafPending = false;
function scheduleRender(): void {
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => {
    rafPending = false;
    renderList();
  });
}

function renderList(): void {
  const total = positions.length;
  if (total === 0) {
    windowEl.innerHTML = '';
    return;
  }
  const scrollTop = viewport.scrollTop;
  const vh = viewport.clientHeight || 1;
  const start = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN);
  const end = Math.min(total, Math.ceil((scrollTop + vh) / ROW_H) + OVERSCAN);
  windowEl.style.top = `${start * ROW_H}px`;
  const parts: string[] = [];
  for (let row = start; row < end; row++) {
    const sym = allSymbols[positions[row]];
    const cls = row === selected ? 'sym-row sel' : 'sym-row';
    parts.push(`<div class="${cls}" data-row="${row}">${escapeHtml(sym)}</div>`);
  }
  windowEl.innerHTML = parts.join('');
}

viewport.addEventListener('scroll', scheduleRender);
window.addEventListener('resize', scheduleRender);

windowEl.addEventListener('click', (ev) => {
  const target = (ev.target as HTMLElement).closest('.sym-row') as HTMLElement | null;
  if (!target) return;
  const row = Number(target.dataset.row);
  if (Number.isNaN(row)) return;
  setSelected(row);
});

function setSelected(row: number): void {
  if (row < 0 || row >= positions.length) return;
  selected = row;
  renderList();
  updateDownloadEnabled();
  scheduleSyminfo();
}

function ensureVisible(row: number): void {
  const top = row * ROW_H;
  const bottom = top + ROW_H;
  if (top < viewport.scrollTop) viewport.scrollTop = top;
  else if (bottom > viewport.scrollTop + viewport.clientHeight) {
    viewport.scrollTop = bottom - viewport.clientHeight;
  }
}

// --- keyboard ---------------------------------------------------------------

viewport.addEventListener('keydown', (ev) => {
  if (positions.length === 0) return;
  const page = Math.max(1, Math.floor(viewport.clientHeight / ROW_H) - 1);
  let next = selected;
  switch (ev.key) {
    case 'ArrowDown': next = Math.min(positions.length - 1, selected + 1); break;
    case 'ArrowUp': next = Math.max(0, selected - 1); break;
    case 'PageDown': next = Math.min(positions.length - 1, selected + page); break;
    case 'PageUp': next = Math.max(0, selected - page); break;
    case 'Home': next = 0; break;
    case 'End': next = positions.length - 1; break;
    case 'Enter': downloadBtn.focus(); ev.preventDefault(); return;
    default: return;
  }
  ev.preventDefault();
  if (next !== selected) {
    selected = next;
    ensureVisible(selected);
    renderList();
    updateDownloadEnabled();
    scheduleSyminfo();
  }
});

window.addEventListener('keydown', (ev) => {
  if (ev.key === '/' && document.activeElement !== filterInput) {
    filterInput.focus();
    filterInput.select();
    ev.preventDefault();
  }
});

filterInput.addEventListener('input', applyFilter);

// --- syminfo ----------------------------------------------------------------

function scheduleSyminfo(): void {
  if (syminfoTimer) clearTimeout(syminfoTimer);
  const symbol = selectedSymbol();
  if (!symbol) return;
  showInfoLoading(symbol);
  syminfoTimer = setTimeout(() => {
    const reqId = ++syminfoReqId;
    lastSyminfoReqId = reqId;
    vscode.postMessage({
      type: 'requestSyminfo',
      reqId,
      provider: providerSel.value,
      broker: currentMultiBroker ? brokerSel.value : undefined,
      symbol,
    });
  }, SYMINFO_DEBOUNCE_MS);
}

function selectedSymbol(): string | undefined {
  if (selected < 0 || selected >= positions.length) return undefined;
  return allSymbols[positions[selected]];
}

function showInfoEmpty(text: string): void {
  infoBody.hidden = true;
  infoEmpty.hidden = false;
  infoEmpty.textContent = text;
}

function showInfoLoading(symbol: string): void {
  infoEmpty.hidden = true;
  infoBody.hidden = false;
  infoBody.innerHTML = `<h2>${escapeHtml(symbol)}</h2><div id="info-sub">Loading…</div>`;
}

function renderSyminfoError(symbol: string, message: string): void {
  infoEmpty.hidden = true;
  infoBody.hidden = false;
  infoBody.innerHTML =
    `<h2>${escapeHtml(symbol)}</h2>` +
    `<div id="info-sub" style="color:var(--vscode-errorForeground,#f48771)">${escapeHtml(message)}</div>`;
}

interface Group {
  title: string;
  keys: string[];
}
const INFO_GROUPS: Group[] = [
  { title: 'Identification', keys: ['ticker', 'prefix', 'type', 'currency', 'basecurrency', 'timezone'] },
  { title: 'Pricing', keys: ['mintick', 'pricescale', 'minmove', 'pointvalue', 'mincontract', 'volumetype'] },
  { title: 'Fees & spread', keys: ['avg_spread', 'taker_fee', 'maker_fee'] },
  { title: 'Reference', keys: ['country', 'sector', 'industry', 'isin', 'expiration_date', 'current_contract'] },
  {
    title: 'Fundamentals',
    keys: [
      'employees', 'shareholders', 'shares_outstanding_total', 'shares_outstanding_float',
      'target_price_average', 'target_price_high', 'target_price_low', 'target_price_median',
      'recommendations_total', 'recommendations_buy', 'recommendations_buy_strong',
      'recommendations_hold', 'recommendations_sell', 'recommendations_sell_strong',
    ],
  },
];
const TS_FIELDS = new Set(['expiration_date', 'recommendations_date', 'target_price_date']);
const DAY_NAMES = ['', 'Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function renderSyminfo(symbol: string, info: SymInfoDict): void {
  infoEmpty.hidden = true;
  infoBody.hidden = false;
  const parts: string[] = [];
  const desc = typeof info.description === 'string' && info.description ? info.description : symbol;
  parts.push(`<h2>${escapeHtml(String(desc))}</h2>`);
  // No `period` here: symbol info is timeframe-independent, so period is only a
  // cosmetic label (the real timeframe is picked in the download bar below).
  const subBits: string[] = [];
  if (info.ticker && info.ticker !== desc) subBits.push(escapeHtml(String(info.ticker)));
  if (info.type) subBits.push(escapeHtml(String(info.type)));
  if (info.currency) subBits.push(escapeHtml(String(info.currency)));
  parts.push(`<div id="info-sub">${subBits.join(' · ') || '&nbsp;'}</div>`);

  for (const group of INFO_GROUPS) {
    const rows: string[] = [];
    for (const key of group.keys) {
      const raw = info[key];
      if (raw === null || raw === undefined || raw === '') continue;
      rows.push(`<div class="k">${escapeHtml(key)}</div><div class="v">${escapeHtml(fmtValue(key, raw))}</div>`);
    }
    if (rows.length) {
      parts.push(`<div class="info-group"><h3>${group.title}</h3><div class="kv-grid">${rows.join('')}</div></div>`);
    }
  }

  const hours = renderHours(info.opening_hours);
  if (hours) parts.push(`<div class="info-group"><h3>Trading hours</h3>${hours}</div>`);

  infoBody.innerHTML = parts.join('');
}

function renderHours(value: unknown): string | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const rows: string[] = [];
  for (const iv of value) {
    if (!iv || typeof iv !== 'object') continue;
    const rec = iv as { day?: number; start?: string; end?: string };
    const day = typeof rec.day === 'number' ? (DAY_NAMES[rec.day] ?? String(rec.day)) : '';
    rows.push(
      `<tr><td class="day">${escapeHtml(day)}</td>` +
      `<td>${escapeHtml(fmtTime(rec.start))} – ${escapeHtml(fmtTime(rec.end))}</td></tr>`
    );
  }
  return rows.length ? `<table class="hours">${rows.join('')}</table>` : undefined;
}

function fmtTime(t: string | undefined): string {
  if (!t) return '—';
  // ISO time "HH:MM:SS" -> "HH:MM" (keep seconds only when non-zero).
  return t.endsWith(':00') ? t.slice(0, 5) : t;
}

function fmtValue(key: string, raw: unknown): string {
  if (TS_FIELDS.has(key) && typeof raw === 'number') {
    const d = new Date(raw * 1000);
    return `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}`;
  }
  if (typeof raw === 'number') return String(raw);
  if (typeof raw === 'boolean') return raw ? 'true' : 'false';
  return String(raw);
}

// --- download bar -----------------------------------------------------------

function buildFromOptions(): void {
  fromSel.innerHTML = '';
  const opts: [string, string][] = [
    ['continue', 'Continue / resume'],
    ['30', 'Last 30 days'],
    ['90', 'Last 90 days'],
    ['365', 'Last 365 days'],
    ['custom', 'Custom start date…'],
  ];
  for (const [value, label] of opts) {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = label;
    fromSel.appendChild(opt);
  }
  fromSel.value = 'continue';
}

fromSel.addEventListener('change', () => {
  fromDate.hidden = fromSel.value !== 'custom';
});

providerSel.addEventListener('change', () => selectProvider(providerSel.value));
brokerSel.addEventListener('change', () => {
  allSymbols = [];
  positions = [];
  selected = -1;
  renderList();
  listStatus.textContent = 'Loading symbols…';
  vscode.postMessage({ type: 'selectBroker', provider: providerSel.value, broker: brokerSel.value });
  persist();
});
timeframeSel.addEventListener('change', persist);

function updateDownloadEnabled(): void {
  downloadBtn.disabled = downloading || !selectedSymbol();
}

function resolveFrom(): number | 'continue' | undefined {
  const v = fromSel.value;
  if (v === 'continue') return 'continue';
  if (v === 'custom') {
    if (!fromDate.value) return undefined;
    const ms = Date.parse(`${fromDate.value}T00:00:00Z`);
    if (Number.isNaN(ms)) return undefined;
    return Math.floor(ms / 1000);
  }
  const days = Number(v);
  return Math.floor(Date.now() / 1000) - days * 86400;
}

downloadBtn.addEventListener('click', () => {
  const symbol = selectedSymbol();
  if (!symbol || downloading) return;
  const from = resolveFrom();
  if (from === undefined) {
    setDownMsg('Pick a valid start date.', 'err');
    return;
  }
  downloading = true;
  updateDownloadEnabled();
  cancelBtn.hidden = false;
  progressWrap.classList.add('on');
  setDownMsg('', '');
  setProgress(0, 0, false);
  vscode.postMessage({
    type: 'download',
    provider: providerSel.value,
    broker: currentMultiBroker ? brokerSel.value : undefined,
    symbol,
    timeframe: timeframeSel.value,
    from,
    to: Math.floor(Date.now() / 1000),
    truncate: truncateChk.checked,
  });
});

cancelBtn.addEventListener('click', () => {
  if (downloading) vscode.postMessage({ type: 'cancelDownload' });
});

function onProgress(done: number, total: number, indeterminate?: boolean): void {
  setProgress(done, total, Boolean(indeterminate));
}

function setProgress(done: number, total: number, indeterminate: boolean): void {
  if (indeterminate || total <= 0) {
    progressFill.classList.add('indeterminate');
    progressText.textContent = indeterminate ? '…' : '';
    return;
  }
  progressFill.classList.remove('indeterminate');
  const pct = Math.max(0, Math.min(100, (done / total) * 100));
  progressFill.style.width = `${pct}%`;
  progressText.textContent = `${Math.round(pct)}%`;
}

function onDownloadDone(symbol: string, bars: number): void {
  endDownload();
  setDownMsg(`Downloaded ${symbol}: ${bars.toLocaleString('en-US')} bars.`, 'ok');
}

function onDownloadError(message: string): void {
  endDownload();
  setDownMsg(message, 'err');
}

function endDownload(): void {
  downloading = false;
  cancelBtn.hidden = true;
  progressWrap.classList.remove('on');
  progressFill.classList.remove('indeterminate');
  progressFill.style.width = '0%';
  progressText.textContent = '';
  updateDownloadEnabled();
}

function setDownMsg(text: string, cls: '' | 'ok' | 'err'): void {
  downMsg.textContent = text;
  downMsg.className = cls;
}

// --- misc -------------------------------------------------------------------

function persist(): void {
  vscode.postMessage({
    type: 'persist',
    provider: providerSel.value || undefined,
    broker: currentMultiBroker ? brokerSel.value || undefined : undefined,
    timeframe: timeframeSel.value || undefined,
  });
}

function p2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;'
  );
}

vscode.postMessage({ type: 'ready' });
