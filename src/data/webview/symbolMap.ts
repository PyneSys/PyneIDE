/**
 * Symbol Map webview: the whole `[symbol_map]` table as one editable view.
 *
 * A mapping is timeframe-independent: it names an instrument (TV symbol ->
 * provider-qualified native symbol), and the `.ohlcv` for whatever timeframe a
 * script requests is found automatically from it. So a row has no timeframe — it
 * shows which timeframes are already downloaded for the instrument, and offers a
 * Download when none are.
 *
 * The webview is a pure function of the {@link SymbolMapModel} the host last
 * posted: every edit posts a `setEntry`/`removeEntry` back and the host re-posts a
 * fresh model, which re-renders. Rows the user is still building (an "+ Add
 * mapping" click, a "Map to…" from an instrument) live as local `pending` rows
 * until their first write lands in the model.
 */
import type {
  SymbolMapEntry,
  SymbolMapInstrument,
  SymbolMapModel,
} from '../symbolMapModel';
import type { SymbolMapInMessage, SymbolMapOutMessage } from '../symbolMapMessages';

interface VsCodeApi {
  postMessage(message: SymbolMapOutMessage): void;
}
declare function acquireVsCodeApi(): VsCodeApi;
const vscode = acquireVsCodeApi();

/** Sentinel option values (a real native symbol can never be one). */
const MANUAL = ' manual';
const DOWNLOAD = ' download';

const el = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const mappingsEl = el<HTMLDivElement>('mappings');
const filesEl = el<HTMLDivElement>('files');

let model: SymbolMapModel = { entries: [], instruments: [] };

/** A row the user is building that has no committed map key yet. Kept until the
 * model comes back carrying `committedKey`. */
interface PendingRow {
  id: number;
  tvSymbol: string;
  value: string;
  committedKey?: string;
}
let pending: PendingRow[] = [];
let pendingSeq = 0;
/** The pending row whose TV-symbol input should grab focus on the next render. */
let focusPendingId: number | undefined;

// --- messaging ---------------------------------------------------------------

window.addEventListener('message', (ev: MessageEvent<SymbolMapInMessage>) => {
  if (ev.data.type === 'model') {
    model = ev.data.model;
    // Drop pending rows whose write has landed in the model.
    const keys = new Set(model.entries.map((e) => e.key));
    pending = pending.filter((p) => !(p.committedKey && keys.has(p.committedKey)));
    render();
  }
});

el<HTMLButtonElement>('open-raw').addEventListener('click', () => {
  vscode.postMessage({ type: 'openRaw' });
});

el<HTMLButtonElement>('add').addEventListener('click', () => {
  const row: PendingRow = { id: ++pendingSeq, tvSymbol: '', value: '' };
  pending.push(row);
  focusPendingId = row.id;
  render();
});

// --- helpers -----------------------------------------------------------------

/** The native symbol of a map VALUE — the value minus its `provider:` prefix. */
function nativeOf(value: string): string {
  const idx = value.indexOf(':');
  return idx < 0 ? value : value.slice(idx + 1);
}

function post(message: SymbolMapOutMessage): void {
  vscode.postMessage(message);
}

// --- target control ----------------------------------------------------------

/**
 * The editable Target cell: a `<select>` of every known instrument's native
 * symbol plus "Enter manually…" (reveals a text input) and "Download new…".
 * `onChange` fires with a concrete value whenever the effective target changes;
 * `onDownload` fires for the download option. `readValue()` returns the currently
 * effective value.
 */
function buildTargetCell(opts: {
  value: string;
  onChange: () => void;
  onDownload: () => void;
}): { cell: HTMLElement; readValue: () => string } {
  const cell = document.createElement('div');
  cell.className = 'target-cell';

  const select = document.createElement('select');
  const manual = document.createElement('input');
  manual.type = 'text';
  manual.placeholder = 'provider:BROKER:SYMBOL';
  manual.hidden = true;

  const natives = new Set<string>();
  for (const inst of model.instruments) {
    if (natives.has(inst.native)) continue;
    natives.add(inst.native);
    const opt = document.createElement('option');
    opt.value = inst.native;
    opt.textContent = `${inst.symbol} — ${inst.native}`;
    select.appendChild(opt);
  }
  select.appendChild(makeOption(MANUAL, 'Enter manually…'));
  select.appendChild(makeOption(DOWNLOAD, 'Download new…'));

  const matches = opts.value !== '' && natives.has(opts.value);
  if (matches) {
    select.value = opts.value;
    manual.hidden = true;
  } else {
    select.value = MANUAL;
    manual.hidden = false;
    manual.value = opts.value;
  }

  const readValue = (): string => (select.value === MANUAL ? manual.value.trim() : select.value);

  select.addEventListener('change', () => {
    if (select.value === DOWNLOAD) {
      // A menu action, not a value: revert the select and hand off to download.
      select.value = matches ? opts.value : MANUAL;
      manual.hidden = select.value !== MANUAL;
      opts.onDownload();
      return;
    }
    if (select.value === MANUAL) {
      manual.hidden = false;
      manual.focus();
      return;
    }
    manual.hidden = true;
    opts.onChange();
  });

  const commitManual = (): void => {
    if (select.value === MANUAL) opts.onChange();
  };
  manual.addEventListener('change', commitManual);
  manual.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      manual.blur();
    }
  });

  cell.appendChild(select);
  cell.appendChild(manual);
  return { cell, readValue };
}

function makeOption(value: string, label: string): HTMLOptionElement {
  const opt = document.createElement('option');
  opt.value = value;
  opt.textContent = label;
  return opt;
}

// --- rendering ---------------------------------------------------------------

function render(): void {
  renderMappings();
  renderInstruments();
}

function renderMappings(): void {
  mappingsEl.textContent = '';
  if (model.entries.length === 0 && pending.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'No mappings yet. Add one below, or map a data instrument.';
    mappingsEl.appendChild(empty);
    return;
  }

  const table = document.createElement('table');
  const thead = document.createElement('thead');
  thead.innerHTML =
    '<tr>' +
    '<th>TV symbol</th><th>Target (provider:native)</th>' +
    '<th class="col-data">Downloaded data</th><th class="col-remove"></th>' +
    '</tr>';
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  for (const entry of model.entries) tbody.appendChild(entryRow(entry));
  for (const row of pending) tbody.appendChild(pendingRow(row));
  table.appendChild(tbody);
  mappingsEl.appendChild(table);

  if (focusPendingId !== undefined) {
    const input = mappingsEl.querySelector<HTMLInputElement>(
      `input[data-pending-tv="${focusPendingId}"]`
    );
    input?.focus();
    focusPendingId = undefined;
  }
}

/** A committed mapping row. Edits post `setEntry` with `oldKey` = the entry's
 * current key, so a changed TV symbol renames the entry in one step. A rare
 * per-TF override entry (`tf` set, made by hand/CLI) keeps its `:TF` suffix
 * through edits and shows a small tag — the panel never strips it. */
function entryRow(entry: SymbolMapEntry): HTMLTableRowElement {
  const tr = document.createElement('tr');

  const tvCell = document.createElement('td');
  const tvInput = textInput(entry.tvSymbol);
  tvCell.appendChild(tvInput);
  if (entry.tf) tvCell.appendChild(tfTag(entry.tf));

  const keyOf = (tv: string): string => (entry.tf ? `${tv.trim()}:${entry.tf}` : tv.trim());

  const commit = (): void => {
    const key = keyOf(tvInput.value);
    const value = target.readValue();
    if (!tvInput.value.trim() || !value) return;
    if (key === entry.key && value === entry.value) return;
    post({ type: 'setEntry', key, value, oldKey: entry.key });
  };

  const download = (): void => {
    if (!tvInput.value.trim()) return;
    const value = target.readValue();
    post({ type: 'download', tvKey: keyOf(tvInput.value), symbol: value ? nativeOf(value) : tvInput.value.trim() });
  };

  const target = buildTargetCell({ value: entry.value, onChange: commit, onDownload: download });

  tvInput.addEventListener('change', commit);

  tr.appendChild(tvCell);
  tr.appendChild(td(target.cell));
  tr.appendChild(dataCell(entry.availableTfs, download));
  tr.appendChild(removeCell(() => post({ type: 'removeEntry', key: entry.key })));
  return tr;
}

/** A not-yet-committed row (from "+ Add mapping" or an instrument's "Map to…").
 * Its first complete write posts `setEntry` (no `oldKey`); the model reply then
 * turns it into a committed row. */
function pendingRow(row: PendingRow): HTMLTableRowElement {
  const tr = document.createElement('tr');

  const tvInput = textInput(row.tvSymbol);
  tvInput.dataset.pendingTv = String(row.id);

  const sync = (): void => {
    row.tvSymbol = tvInput.value;
    row.value = target.readValue();
  };
  const commit = (): void => {
    sync();
    const key = row.tvSymbol.trim();
    if (!key || !row.value) return;
    row.committedKey = key;
    post({ type: 'setEntry', key, value: row.value });
  };
  const download = (): void => {
    sync();
    const key = row.tvSymbol.trim();
    if (!key) return;
    post({ type: 'download', tvKey: key, symbol: row.value ? nativeOf(row.value) : key });
  };

  const target = buildTargetCell({ value: row.value, onChange: commit, onDownload: download });

  tvInput.addEventListener('input', sync);
  tvInput.addEventListener('change', commit);

  const availableTfs = tfsForValue(row.value);

  tr.appendChild(td(tvInput));
  tr.appendChild(td(target.cell));
  tr.appendChild(dataCell(availableTfs, download));
  tr.appendChild(removeCell(() => {
    pending = pending.filter((p) => p.id !== row.id);
    render();
  }));
  return tr;
}

function renderInstruments(): void {
  filesEl.textContent = '';
  if (model.instruments.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'No data yet. Download an instrument from the Symbol Browser.';
    filesEl.appendChild(empty);
    return;
  }

  const table = document.createElement('table');
  table.className = 'files-table';
  const thead = document.createElement('thead');
  thead.innerHTML =
    '<tr><th>Symbol</th><th>Target (provider:native)</th>' +
    '<th class="col-data">Downloaded TFs</th><th class="col-remove"></th></tr>';
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  for (const inst of model.instruments) tbody.appendChild(instrumentRow(inst));
  table.appendChild(tbody);
  filesEl.appendChild(table);
}

function instrumentRow(inst: SymbolMapInstrument): HTMLTableRowElement {
  const tr = document.createElement('tr');
  tr.appendChild(td(textNode(inst.symbol), 'tv'));
  tr.appendChild(td(textNode(inst.native, 'mono')));
  tr.appendChild(td(tfChips(inst.timeframes)));

  const actionCell = document.createElement('td');
  const btn = document.createElement('button');
  btn.className = 'secondary';
  btn.type = 'button';
  btn.textContent = 'Map to…';
  btn.title = 'Add a mapping row targeting this instrument — just type the TV symbol.';
  const native = inst.native;
  btn.addEventListener('click', () => {
    const rowObj: PendingRow = { id: ++pendingSeq, tvSymbol: '', value: native };
    pending.push(rowObj);
    focusPendingId = rowObj.id;
    render();
    mappingsEl.scrollIntoView({ block: 'nearest' });
  });
  actionCell.appendChild(btn);
  tr.appendChild(actionCell);
  return tr;
}

/** The downloaded timeframes of the instrument a map VALUE targets, for a
 * pending row that already picked a target but is not yet committed. */
function tfsForValue(value: string): string[] {
  return model.instruments.find((i) => i.native === value)?.timeframes ?? [];
}

// --- small DOM builders ------------------------------------------------------

function textInput(value: string, cls?: string): HTMLInputElement {
  const input = document.createElement('input');
  input.type = 'text';
  input.value = value;
  if (cls) input.className = cls;
  return input;
}

function td(child: Node, cls?: string): HTMLTableCellElement {
  const cell = document.createElement('td');
  if (cls) cell.className = cls;
  cell.appendChild(child);
  return cell;
}

function textNode(text: string, cls?: string): HTMLElement {
  const span = document.createElement('span');
  if (cls) span.className = cls;
  span.textContent = text;
  return span;
}

/** A muted tag marking a rare per-TF override entry (`TF 60`), so a hand/CLI-made
 * `:TF` key reads as special — the panel preserves but never creates these. */
function tfTag(tf: string): HTMLElement {
  const tag = document.createElement('span');
  tag.className = 'tf-tag';
  tag.textContent = `TF ${tf}`;
  tag.title = 'Per-timeframe override (edit in TOML) — this mapping applies to this timeframe only.';
  return tag;
}

/** The "Downloaded data" cell of a mapping row: TF chips when data exists, or a
 * Download button when none is downloaded for the target yet. */
function dataCell(timeframes: string[], onDownload: () => void): HTMLTableCellElement {
  const cell = document.createElement('td');
  cell.className = 'col-data';
  if (timeframes.length > 0) {
    cell.appendChild(tfChips(timeframes));
  } else {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = 'Download';
    btn.addEventListener('click', onDownload);
    cell.appendChild(btn);
  }
  return cell;
}

/** A row of small timeframe chips (`15 · 60 · 1D`), or an em dash when empty. */
function tfChips(timeframes: string[]): HTMLElement {
  const wrap = document.createElement('span');
  wrap.className = 'tf-chips';
  if (timeframes.length === 0) {
    wrap.appendChild(textNode('—', 'file-name'));
    return wrap;
  }
  for (const tf of timeframes) {
    const chip = document.createElement('span');
    chip.className = 'tf-chip';
    chip.textContent = tf;
    wrap.appendChild(chip);
  }
  return wrap;
}

function removeCell(onRemove: () => void): HTMLTableCellElement {
  const cell = document.createElement('td');
  cell.className = 'col-remove';
  const btn = document.createElement('button');
  btn.className = 'icon';
  btn.type = 'button';
  btn.title = 'Remove mapping';
  btn.textContent = '×';
  btn.addEventListener('click', onRemove);
  cell.appendChild(btn);
  return cell;
}

render();
vscode.postMessage({ type: 'ready' });
