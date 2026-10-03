/**
 * Input-form webview: renders a script's `InputSpec` list as a grouped form
 * (int/float -> number, bool -> checkbox, options/enum -> select, color ->
 * color picker, string/source/... -> text) and posts the edited values back to
 * the host to write into the sibling `.toml`. A strategy gets a second,
 * TradingView-style Properties tab for its `[script]` settings, where every
 * field shows whether it overrides the script's own declaration.
 */
import type {
  InputSpec,
  InputsInMessage,
  InputsOutMessage,
  InputsPayload,
  InputsTab,
  InputValue,
  PropertyState,
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
const tabsEl = document.getElementById('tabs') as HTMLDivElement;
const tabInputsBtn = document.getElementById('tab-inputs') as HTMLButtonElement;
const tabPropertiesBtn = document.getElementById('tab-properties') as HTMLButtonElement;
const inputsPaneEl = document.getElementById('inputs-pane') as HTMLDivElement;
const propertiesPaneEl = document.getElementById('properties-pane') as HTMLDivElement;

/** One Properties row: a number or checkbox, optionally with a unit select
 * (order size type, commission type) that belongs to the same setting. */
interface PropertyField {
  key: string;
  label: string;
  kind: 'float' | 'int' | 'bool';
  min?: number;
  suffix?: string;
  tooltip?: string;
  unit?: { key: string; options: { value: string; label: string }[] };
}

/** The settings TradingView's Properties tab offers that PyneCore backtests
 * honour. Currency is left out (conversion needs an FX rate feed), so are the
 * settings PyneCore does not read (risk-free rate, limit-price verification,
 * standard-OHLC fills) and the realtime-only recalculation modes. */
const PROPERTY_GROUPS: { name: string; fields: PropertyField[] }[] = [
  {
    name: 'Capital',
    fields: [{ key: 'initial_capital', label: 'Initial capital', kind: 'float', min: 0 }],
  },
  {
    name: 'Orders',
    fields: [
      {
        key: 'default_qty_value',
        label: 'Order size',
        kind: 'float',
        min: 0,
        tooltip: 'Size of an order that does not specify its own quantity.',
        unit: {
          key: 'default_qty_type',
          options: [
            { value: 'fixed', label: 'Contracts' },
            { value: 'cash', label: 'Cash' },
            { value: 'percent_of_equity', label: '% of equity' },
          ],
        },
      },
      {
        key: 'pyramiding',
        label: 'Pyramiding',
        kind: 'int',
        min: 1,
        suffix: 'orders',
        tooltip: 'How many entries the strategy may open in the same direction.',
      },
    ],
  },
  {
    name: 'Costs',
    fields: [
      {
        key: 'commission_value',
        label: 'Commission',
        kind: 'float',
        min: 0,
        unit: {
          key: 'commission_type',
          options: [
            { value: 'percent', label: '% of order value' },
            { value: 'cash_per_contract', label: 'Cash per contract' },
            { value: 'cash_per_order', label: 'Cash per order' },
          ],
        },
      },
      {
        key: 'slippage',
        label: 'Slippage',
        kind: 'int',
        min: 0,
        suffix: 'ticks',
        tooltip: 'Ticks added against the strategy to the fill price of market and stop orders.',
      },
    ],
  },
  {
    name: 'Margin',
    fields: [
      {
        key: 'margin_long',
        label: 'Margin for long positions',
        kind: 'float',
        min: 0,
        suffix: '%',
        tooltip: 'Share of a long position\'s value the equity must cover. 0 turns margin calls off.',
      },
      {
        key: 'margin_short',
        label: 'Margin for short positions',
        kind: 'float',
        min: 0,
        suffix: '%',
        tooltip: 'Share of a short position\'s value the equity must cover. 0 turns margin calls off.',
      },
    ],
  },
  {
    name: 'Recalculate',
    fields: [
      {
        key: 'calc_on_order_fills',
        label: 'After order is filled',
        kind: 'bool',
        tooltip: 'Runs the script once more within the bar after each order fill.',
      },
    ],
  },
  {
    name: 'Fill orders',
    fields: [
      {
        key: 'process_orders_on_close',
        label: 'On bar close',
        kind: 'bool',
        tooltip: 'Fills market orders at the close of the bar that placed them instead of the next open.',
      },
      {
        key: 'use_bar_magnifier',
        label: 'Using bar magnifier',
        kind: 'bool',
        tooltip:
          'Checks order fills against the lower-timeframe bars when the chart runs on a higher timeframe than its data.',
      },
    ],
  },
];

let specs: InputSpec[] = [];
const values = new Map<string, InputValue>();
let properties: Record<string, PropertyState> | null = null;
const propValues = new Map<string, InputValue>();
let activeTab: InputsTab = 'inputs';

window.addEventListener('message', (ev: MessageEvent<InputsInMessage>) => {
  const msg = ev.data;
  if (msg.type === 'data') {
    render(msg.payload);
  } else if (msg.type === 'showTab') {
    showTab(msg.tab);
  } else if (msg.type === 'saved') {
    flashSave('Saved');
  } else if (msg.type === 'error') {
    flashSave(`Error: ${msg.message}`);
  }
});

saveBtn.addEventListener('click', () => {
  const out: Record<string, InputValue> = {};
  for (const [k, v] of values) out[k] = v;
  if (properties) {
    const props: Record<string, InputValue> = {};
    for (const [k, v] of propValues) props[k] = v;
    vscode.postMessage({ type: 'save', values: out, properties: props });
  } else {
    vscode.postMessage({ type: 'save', values: out });
  }
});

resetBtn.addEventListener('click', () => {
  if (activeTab === 'properties') {
    for (const key of propValues.keys()) revertProperty(key);
    renderProperties();
    return;
  }
  for (const spec of specs) {
    if (spec.defval !== null) values.set(spec.name, spec.defval);
  }
  renderFields();
});

tabInputsBtn.addEventListener('click', () => showTab('inputs'));
tabPropertiesBtn.addEventListener('click', () => showTab('properties'));

function render(payload: InputsPayload): void {
  specs = payload.inputs;
  titleEl.textContent = payload.script;
  values.clear();
  for (const spec of specs) {
    const v = payload.values[spec.name];
    if (v !== undefined) values.set(spec.name, v);
    else if (spec.defval !== null) values.set(spec.name, spec.defval);
  }

  properties = payload.properties ?? null;
  propValues.clear();
  for (const key of shownPropertyKeys()) {
    const value = properties?.[key]?.value;
    if (value !== null && value !== undefined) propValues.set(key, value);
  }

  warningEl.hidden = !payload.warning;
  warningEl.textContent = payload.warning ?? '';

  emptyEl.hidden = specs.length > 0;
  saveBtn.hidden = specs.length === 0 && propValues.size === 0;
  tabsEl.hidden = !properties;
  renderFields();
  renderProperties();
  showTab(properties && (payload.tab === 'properties' || specs.length === 0) ? 'properties' : 'inputs');
}

function showTab(tab: InputsTab): void {
  activeTab = properties ? tab : 'inputs';
  const onProperties = activeTab === 'properties';
  tabInputsBtn.setAttribute('aria-selected', String(!onProperties));
  tabPropertiesBtn.setAttribute('aria-selected', String(onProperties));
  inputsPaneEl.hidden = onProperties;
  propertiesPaneEl.hidden = !onProperties;
  resetBtn.hidden = onProperties ? propValues.size === 0 : specs.length === 0;
  hideTip();
}

/** Every setting key the Properties tab edits (value fields and their unit
 * selects) that the bridge reported. */
function shownPropertyKeys(): string[] {
  const keys: string[] = [];
  for (const group of PROPERTY_GROUPS) {
    for (const field of group.fields) {
      keys.push(field.key);
      if (field.unit) keys.push(field.unit.key);
    }
  }
  return keys.filter((key) => properties?.[key] !== undefined);
}

function isOverridden(key: string): boolean {
  return propValues.has(key) && propValues.get(key) !== properties?.[key]?.default;
}

function revertProperty(key: string): void {
  const def = properties?.[key]?.default;
  if (def !== null && def !== undefined && propValues.has(key)) propValues.set(key, def);
}

function renderProperties(): void {
  propertiesPaneEl.textContent = '';
  for (const group of PROPERTY_GROUPS) {
    const fields = group.fields.filter((f) => propValues.has(f.key));
    if (fields.length === 0) continue;
    const section = document.createElement('div');
    section.className = 'group';
    const h = document.createElement('h3');
    h.textContent = group.name;
    section.appendChild(h);
    for (const field of fields) section.appendChild(propertyRow(field));
    propertiesPaneEl.appendChild(section);
  }
}

function propertyRow(field: PropertyField): HTMLElement {
  const keys = [field.key, ...(field.unit && propValues.has(field.unit.key) ? [field.unit.key] : [])];
  const row = document.createElement('div');
  row.className = 'field';
  const syncModified = (): void => {
    row.classList.toggle('modified', keys.some(isOverridden));
  };

  const label = document.createElement('label');
  label.textContent = field.label;
  label.htmlFor = `p_${field.key}`;
  row.appendChild(label);

  const control = document.createElement('div');
  control.className = 'control';
  control.appendChild(propertyControl(field, syncModified));
  if (field.kind !== 'bool') {
    // A fixed-width slot after every number keeps the inputs aligned.
    const after = document.createElement('span');
    after.className = 'after';
    if (field.unit && propValues.has(field.unit.key)) {
      after.appendChild(unitSelect(field.unit, syncModified));
    } else if (field.suffix) {
      after.textContent = field.suffix;
    }
    control.appendChild(after);
  }
  row.appendChild(control);

  const revert = document.createElement('button');
  revert.type = 'button';
  revert.className = 'revert';
  revert.textContent = '↺';
  revert.title = `Revert to the script's value (${keys.map(describeDefault).join(' ')})`;
  revert.setAttribute('aria-label', revert.title);
  revert.addEventListener('click', () => {
    for (const key of keys) revertProperty(key);
    row.replaceWith(propertyRow(field));
  });
  row.appendChild(revert);

  row.appendChild(helpIcon(field.tooltip ?? null));
  syncModified();
  return row;
}

/** A setting's declared value for display; a unit shows its option label. */
function describeDefault(key: string): string {
  const def = properties?.[key]?.default;
  const unit = PROPERTY_GROUPS.flatMap((g) => g.fields).find((f) => f.unit?.key === key)?.unit;
  const label = unit?.options.find((o) => o.value === def)?.label;
  return label ?? (def === null || def === undefined ? 'none' : String(def));
}

function propertyControl(field: PropertyField, onChange: () => void): HTMLElement {
  const id = `p_${field.key}`;
  const current = propValues.get(field.key);

  if (field.kind === 'bool') {
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.id = id;
    cb.checked = current === true;
    cb.addEventListener('change', () => {
      propValues.set(field.key, cb.checked);
      onChange();
    });
    return cb;
  }

  const num = document.createElement('input');
  num.type = 'number';
  num.id = id;
  if (field.min !== undefined) num.min = String(field.min);
  num.step = field.kind === 'int' ? '1' : 'any';
  num.value = current !== undefined ? String(current) : '';
  num.addEventListener('input', () => {
    const n = Number(num.value);
    if (num.value.trim() !== '' && Number.isFinite(n)) {
      propValues.set(field.key, field.kind === 'int' ? Math.trunc(n) : n);
      onChange();
    }
  });
  return num;
}

function unitSelect(unit: NonNullable<PropertyField['unit']>, onChange: () => void): HTMLElement {
  const select = document.createElement('select');
  select.setAttribute('aria-label', unit.key.replace(/_/g, ' '));
  const current = String(propValues.get(unit.key));
  for (const opt of unit.options) {
    const o = document.createElement('option');
    o.value = opt.value;
    o.textContent = opt.label;
    o.selected = opt.value === current;
    select.appendChild(o);
  }
  select.addEventListener('change', () => {
    propValues.set(unit.key, select.value);
    onChange();
  });
  return select;
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
  label.htmlFor = `f_${spec.name}`;
  row.appendChild(label);

  const control = document.createElement('div');
  control.className = 'control';
  control.appendChild(makeControl(spec));
  row.appendChild(control);

  row.appendChild(helpIcon(spec.tooltip));
  return row;
}

/** The trailing `?` help bubble, or an empty spacer keeping the column aligned. */
function helpIcon(tooltip: string | null): HTMLElement {
  const help = document.createElement('span');
  help.className = 'help';
  if (tooltip) {
    help.textContent = '?';
    help.setAttribute('role', 'button');
    help.setAttribute('tabindex', '0');
    help.setAttribute('aria-label', tooltip);
    attachTooltip(help, tooltip);
  } else {
    help.classList.add('empty');
  }
  return help;
}

let activeTip: HTMLElement | null = null;
let pinned = false;

function hideTip(): void {
  if (activeTip) {
    activeTip.remove();
    activeTip = null;
  }
  pinned = false;
}

function showTip(anchor: HTMLElement, text: string): void {
  if (activeTip) activeTip.remove();
  const tip = document.createElement('div');
  tip.className = 'tooltip-pop';
  tip.textContent = text;
  document.body.appendChild(tip);
  const r = anchor.getBoundingClientRect();
  const margin = 8;
  // Prefer below the icon; flip above if it would overflow the viewport.
  let top = r.bottom + 6;
  if (top + tip.offsetHeight > window.innerHeight - margin) {
    top = Math.max(margin, r.top - tip.offsetHeight - 6);
  }
  // Right-align the bubble to the icon, clamped into view.
  let left = r.right - tip.offsetWidth;
  left = Math.max(margin, Math.min(left, window.innerWidth - tip.offsetWidth - margin));
  tip.style.top = `${top}px`;
  tip.style.left = `${left}px`;
  activeTip = tip;
}

/** TradingView-style help: hover previews instantly, click pins it open. */
function attachTooltip(anchor: HTMLElement, text: string): void {
  anchor.addEventListener('mouseenter', () => {
    if (!pinned) showTip(anchor, text);
  });
  anchor.addEventListener('mouseleave', () => {
    if (!pinned) hideTip();
  });
  anchor.addEventListener('click', (ev) => {
    ev.stopPropagation();
    if (pinned && activeTip) {
      hideTip();
    } else {
      showTip(anchor, text);
      pinned = true;
    }
  });
  anchor.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' || ev.key === ' ') {
      ev.preventDefault();
      showTip(anchor, text);
      pinned = true;
    } else if (ev.key === 'Escape') {
      hideTip();
    }
  });
}

document.addEventListener('click', () => {
  if (pinned) hideTip();
});

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
