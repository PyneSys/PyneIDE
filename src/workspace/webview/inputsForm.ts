/**
 * Input-form webview: renders a script's `InputSpec` list as a grouped form
 * (int/float -> number, bool -> checkbox, options/enum -> select, color ->
 * color picker, string/source/... -> text) and posts the edited values back to
 * the host to write into the sibling `.toml`.
 */
import type {
  InputSpec,
  InputsInMessage,
  InputsOutMessage,
  InputsPayload,
  InputValue,
} from '../inputsMessages';

interface VsCodeApi {
  postMessage(message: InputsOutMessage): void;
}
declare function acquireVsCodeApi(): VsCodeApi;
const vscode = acquireVsCodeApi();

const titleEl = document.getElementById('title') as HTMLDivElement;
const warningEl = document.getElementById('warning') as HTMLDivElement;
const fieldsEl = document.getElementById('fields') as HTMLDivElement;
const emptyEl = document.getElementById('empty') as HTMLDivElement;
const saveBtn = document.getElementById('save') as HTMLButtonElement;
const resetBtn = document.getElementById('reset') as HTMLButtonElement;

let specs: InputSpec[] = [];
const values = new Map<string, InputValue>();

window.addEventListener('message', (ev: MessageEvent<InputsInMessage>) => {
  const msg = ev.data;
  if (msg.type === 'data') {
    render(msg.payload);
  } else if (msg.type === 'saved') {
    flashSave('Saved');
  } else if (msg.type === 'error') {
    flashSave(`Error: ${msg.message}`);
  }
});

saveBtn.addEventListener('click', () => {
  const out: Record<string, InputValue> = {};
  for (const [k, v] of values) out[k] = v;
  vscode.postMessage({ type: 'save', values: out });
});

resetBtn.addEventListener('click', () => {
  for (const spec of specs) {
    if (spec.defval !== null) values.set(spec.name, spec.defval);
  }
  renderFields();
});

function render(payload: InputsPayload): void {
  specs = payload.inputs;
  titleEl.textContent = payload.script;
  values.clear();
  for (const spec of specs) {
    const v = payload.values[spec.name];
    if (v !== undefined) values.set(spec.name, v);
    else if (spec.defval !== null) values.set(spec.name, spec.defval);
  }

  warningEl.hidden = !payload.warning;
  warningEl.textContent = payload.warning ?? '';

  const has = specs.length > 0;
  emptyEl.hidden = has;
  saveBtn.hidden = !has;
  resetBtn.hidden = !has;
  renderFields();
}

function renderFields(): void {
  fieldsEl.textContent = '';
  // Preserve declaration order while grouping by `group` (undefined -> "").
  const groups: { name: string; specs: InputSpec[] }[] = [];
  const byName = new Map<string, InputSpec[]>();
  for (const spec of specs) {
    const g = spec.group ?? '';
    let bucket = byName.get(g);
    if (!bucket) {
      bucket = [];
      byName.set(g, bucket);
      groups.push({ name: g, specs: bucket });
    }
    bucket.push(spec);
  }

  for (const group of groups) {
    const section = document.createElement('div');
    section.className = 'group';
    if (group.name) {
      const h = document.createElement('h3');
      h.textContent = group.name;
      section.appendChild(h);
    }
    for (const spec of group.specs) section.appendChild(fieldRow(spec));
    fieldsEl.appendChild(section);
  }
}

function fieldRow(spec: InputSpec): HTMLElement {
  const row = document.createElement('div');
  row.className = 'field';

  const label = document.createElement('label');
  label.textContent = spec.title || spec.name;
  if (spec.tooltip) label.title = spec.tooltip;
  label.htmlFor = `f_${spec.name}`;
  row.appendChild(label);

  const control = document.createElement('div');
  control.className = 'control';
  control.appendChild(makeControl(spec));
  row.appendChild(control);
  return row;
}

function makeControl(spec: InputSpec): HTMLElement {
  const id = `f_${spec.name}`;
  const current = values.get(spec.name);

  if (spec.options && spec.options.length > 0) {
    const select = document.createElement('select');
    select.id = id;
    for (const opt of spec.options) {
      const o = document.createElement('option');
      o.value = String(opt);
      o.textContent = String(opt);
      if (current !== undefined && String(opt) === String(current)) o.selected = true;
      select.appendChild(o);
    }
    select.addEventListener('change', () => coerceAndStore(spec, select.value));
    return select;
  }

  if (spec.type === 'bool') {
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.id = id;
    cb.checked = current === true;
    cb.addEventListener('change', () => values.set(spec.name, cb.checked));
    return cb;
  }

  if (spec.type === 'int' || spec.type === 'float') {
    const num = document.createElement('input');
    num.type = 'number';
    num.id = id;
    if (spec.minval !== null) num.min = String(spec.minval);
    if (spec.maxval !== null) num.max = String(spec.maxval);
    num.step = spec.step !== null ? String(spec.step) : spec.type === 'int' ? '1' : 'any';
    num.value = current !== undefined ? String(current) : '';
    num.addEventListener('input', () => {
      const n = Number(num.value);
      if (num.value.trim() !== '' && Number.isFinite(n)) {
        values.set(spec.name, spec.type === 'int' ? Math.trunc(n) : n);
      }
    });
    return num;
  }

  if (spec.type === 'color') {
    const wrap = document.createElement('div');
    wrap.className = 'control';
    const picker = document.createElement('input');
    picker.type = 'color';
    picker.id = id;
    picker.value = toHex6(current);
    const text = document.createElement('input');
    text.type = 'text';
    text.value = current !== undefined ? String(current) : '';
    picker.addEventListener('input', () => {
      text.value = picker.value;
      values.set(spec.name, picker.value);
    });
    text.addEventListener('input', () => {
      values.set(spec.name, text.value);
      const hex = toHex6(text.value);
      if (hex) picker.value = hex;
    });
    wrap.appendChild(picker);
    wrap.appendChild(text);
    return wrap;
  }

  // string, source, symbol, timeframe, session, text_area, and any unknown type.
  const txt = document.createElement('input');
  txt.type = 'text';
  txt.id = id;
  txt.value = current !== undefined ? String(current) : '';
  txt.addEventListener('input', () => values.set(spec.name, txt.value));
  return txt;
}

function coerceAndStore(spec: InputSpec, raw: string): void {
  if (spec.type === 'int') {
    values.set(spec.name, Math.trunc(Number(raw)));
  } else if (spec.type === 'float') {
    values.set(spec.name, Number(raw));
  } else {
    values.set(spec.name, raw);
  }
}

/** Best-effort 6-digit hex for the color picker (drops alpha); '#000000' fallback. */
function toHex6(value: InputValue | undefined): string {
  if (typeof value === 'string' && /^#[0-9a-fA-F]{6,8}$/.test(value)) {
    return value.slice(0, 7);
  }
  return '#000000';
}

function flashSave(text: string): void {
  const prev = saveBtn.textContent;
  saveBtn.textContent = text;
  saveBtn.disabled = true;
  setTimeout(() => {
    saveBtn.textContent = prev;
    saveBtn.disabled = false;
  }, 1200);
}

vscode.postMessage({ type: 'ready' });
