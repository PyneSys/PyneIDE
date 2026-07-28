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

/** Sentinel option value that reveals the neighbouring free-text / date input. */
const CUSTOM = '__custom__';
// Field model mirrored from the TUI wizard (cli/utils/symbol_browser.py): same
// options, same order, same defaults — only the widgets are VSCode's.
const TIMEFRAMES = ['1', '5', '15', '30', '60', '240', '1D', '1W', '1M'];
const FROM_OPTIONS: [string, string][] = [
  ['continue', 'Continue / resume'],
  ['1', '1 day back'],
  ['7', '7 days back'],
  ['30', '30 days back'],
  ['90', '90 days back'],
  ['180', '180 days back'],
  ['365', '365 days back'],
  [CUSTOM, 'Custom date…'],
];
const TO_OPTIONS: [string, string][] = [
  ['now', 'now'],
  [CUSTOM, 'Custom date…'],
];

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
const timeframeCustom = el<HTMLInputElement>('timeframe-custom');
const fromSel = el<HTMLSelectElement>('from');
const fromDate = el<HTMLInputElement>('from-date');
const toSel = el<HTMLSelectElement>('to');
const toDate = el<HTMLInputElement>('to-date');
const truncateLabel = el<HTMLLabelElement>('truncate-label');
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

// Download-target state: does the .ohlcv file of the current symbol + timeframe
// already exist? Drives the Truncate toggle and the smart From default.
let targetReqId = 0;
let lastTargetReqId = 0;
let targetTimer: ReturnType<typeof setTimeout> | undefined;
let targetExists = false;
/** True while a probe started by a symbol change is in flight: its answer
 * re-picks the From default, the way the TUI does on entering the wizard. */
let smartFromPending = false;
/** Last target-probe failure (an invalid custom timeframe, or a dead service). */
let targetError: string | undefined;

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
    case 'targetInfo':
      if (msg.reqId === lastTargetReqId) onTargetInfo(msg.exists, msg.error);
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
    case 'prefill':
      onPrefill(msg.symbol, msg.timeframe);
      break;
  }
});

/**
 * Seed the search box (and timeframe) for a security download. The symbols may
 * still be loading, so the filter value is applied now and re-applied whenever a
 * fresh symbol list arrives (`applyFilter` reads the box every time).
 */
function onPrefill(symbol: string, timeframe?: string): void {
  filterInput.value = symbol;
  if (timeframe) {
    setTimeframe(timeframe);
    persist();
  }
  applyFilter();
}

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

  fillOptions(timeframeSel, [...TIMEFRAMES.map((tf): [string, string] => [tf, tf]), [CUSTOM, 'Custom…']]);
  setTimeframe(defaults.timeframe || '1D');
  fillOptions(fromSel, FROM_OPTIONS);
  setFrom('continue');
  fillOptions(toSel, TO_OPTIONS);
  setTo('now');

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
  resetTarget();
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
    onSymbolChanged();
  } else {
    showInfoEmpty(allSymbols.length ? 'No match.' : 'No symbols.');
    setTargetExists(false);
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
  onSymbolChanged();
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
    onSymbolChanged();
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

/** The cursor moved onto another symbol: refresh its info and re-pick the
 * download defaults for it (TUI: what entering the wizard does). */
function onSymbolChanged(): void {
  scheduleSyminfo();
  scheduleTargetProbe(true);
}

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

function fillOptions(sel: HTMLSelectElement, opts: [string, string][]): void {
  sel.innerHTML = '';
  for (const [value, label] of opts) {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = label;
    sel.appendChild(opt);
  }
}

/** Select a timeframe, dropping into the Custom text field for anything that is
 * not one of the presets (the TUI's `Custom...` option). */
function setTimeframe(tf: string): void {
  const upper = tf.trim().toUpperCase();
  if (TIMEFRAMES.includes(upper)) {
    timeframeSel.value = upper;
    timeframeCustom.value = '';
  } else {
    timeframeSel.value = CUSTOM;
    timeframeCustom.value = tf.trim();
  }
  timeframeCustom.hidden = timeframeSel.value !== CUSTOM;
}

function setFrom(value: string): void {
  fromSel.value = value;
  fromDate.hidden = fromSel.value !== CUSTOM;
}

function setTo(value: string): void {
  toSel.value = value;
  toDate.hidden = toSel.value !== CUSTOM;
}

/** The effective timeframe: the preset, or whatever is typed in Custom. */
function currentTimeframe(): string {
  return timeframeSel.value === CUSTOM ? timeframeCustom.value.trim().toUpperCase() : timeframeSel.value;
}

// --- download target probe ---------------------------------------------------

/**
 * Ask the host whether the target `.ohlcv` of the current symbol + timeframe
 * exists. With `smartFrom`, the answer also re-picks the From default —
 * `continue` when there is a file to resume, `365` when starting from scratch,
 * which is what the TUI does every time the wizard opens on a symbol.
 */
function scheduleTargetProbe(smartFrom: boolean): void {
  if (smartFrom) smartFromPending = true;
  if (targetTimer) clearTimeout(targetTimer);
  const symbol = selectedSymbol();
  const timeframe = currentTimeframe();
  updateDownloadEnabled();
  if (!symbol || !timeframe) {
    setTargetExists(false);
    return;
  }
  targetTimer = setTimeout(() => {
    const reqId = ++targetReqId;
    lastTargetReqId = reqId;
    vscode.postMessage({
      type: 'requestTarget',
      reqId,
      provider: providerSel.value,
      broker: currentMultiBroker ? brokerSel.value : undefined,
      symbol,
      timeframe,
    });
  }, SYMINFO_DEBOUNCE_MS);
}

function onTargetInfo(exists: boolean, error?: string): void {
  setTargetError(error);
  setTargetExists(exists);
}

function setTargetError(message: string | undefined): void {
  if (message) {
    targetError = message;
    setDownMsg(message, 'err');
  } else if (targetError) {
    // Only wipe the bar's message if it was ours — a download result stays put.
    targetError = undefined;
    setDownMsg('', '');
  }
  updateDownloadEnabled();
}

/** Forget the current target (provider / broker switch): drop a pending probe
 * and any reply still in flight, and clear the fields it drives. */
function resetTarget(): void {
  if (targetTimer) clearTimeout(targetTimer);
  lastTargetReqId = ++targetReqId;
  smartFromPending = false;
  setTargetError(undefined);
  setTargetExists(false);
}

function setTargetExists(exists: boolean): void {
  const appeared = exists && !targetExists;
  targetExists = exists;
  truncateLabel.hidden = !exists;
  // A hidden toggle must not carry a stale "yes", and the TUI's re-inserted
  // Truncate field always starts at No.
  if (!exists || appeared) truncateChk.checked = false;
  if (smartFromPending) {
    smartFromPending = false;
    setFrom(exists ? 'continue' : '365');
  }
}

timeframeSel.addEventListener('change', () => {
  timeframeCustom.hidden = timeframeSel.value !== CUSTOM;
  if (timeframeSel.value === CUSTOM) timeframeCustom.focus();
  // A timeframe change only re-checks the target file (From stays as picked) —
  // same as the TUI, where the smart default fires on wizard entry only.
  scheduleTargetProbe(false);
  persist();
});
// Probe per keystroke (debounced anyway), but only persist once the field settles.
timeframeCustom.addEventListener('input', () => scheduleTargetProbe(false));
timeframeCustom.addEventListener('change', persist);
fromSel.addEventListener('change', () => {
  fromDate.hidden = fromSel.value !== CUSTOM;
});
toSel.addEventListener('change', () => {
  toDate.hidden = toSel.value !== CUSTOM;
});

providerSel.addEventListener('change', () => selectProvider(providerSel.value));
brokerSel.addEventListener('change', () => {
  allSymbols = [];
  positions = [];
  selected = -1;
  renderList();
  resetTarget();
  listStatus.textContent = 'Loading symbols…';
  vscode.postMessage({ type: 'selectBroker', provider: providerSel.value, broker: brokerSel.value });
  persist();
});
function updateDownloadEnabled(): void {
  downloadBtn.disabled = downloading || !selectedSymbol() || !currentTimeframe() || Boolean(targetError);
}

function resolveFrom(): number | 'continue' | undefined {
  const v = fromSel.value;
  if (v === 'continue') return 'continue';
  if (v === CUSTOM) return dateToEpoch(fromDate.value);
  const days = Number(v);
  return Math.floor(Date.now() / 1000) - days * 86400;
}

function resolveTo(): number | undefined {
  if (toSel.value === CUSTOM) return dateToEpoch(toDate.value);
  return Math.floor(Date.now() / 1000);
}

/** `YYYY-MM-DD` (as an `input[type=date]` gives it) to epoch seconds, UTC. */
function dateToEpoch(value: string): number | undefined {
  if (!value) return undefined;
  const ms = Date.parse(`${value}T00:00:00Z`);
  return Number.isNaN(ms) ? undefined : Math.floor(ms / 1000);
}

downloadBtn.addEventListener('click', () => {
  const symbol = selectedSymbol();
  if (!symbol || downloading) return;
  const timeframe = currentTimeframe();
  if (!timeframe) {
    setDownMsg('Pick a timeframe.', 'err');
    return;
  }
  const from = resolveFrom();
  if (from === undefined) {
    setDownMsg('Pick a valid start date.', 'err');
    return;
  }
  const to = resolveTo();
  if (to === undefined) {
    setDownMsg('Pick a valid end date.', 'err');
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
    timeframe,
    from,
    to,
    truncate: targetExists && truncateChk.checked,
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
  // The file exists now: re-probe so Truncate shows up for a repeat download.
  scheduleTargetProbe(false);
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
    timeframe: currentTimeframe() || undefined,
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
