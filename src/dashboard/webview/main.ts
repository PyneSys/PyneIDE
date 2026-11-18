/**
 * The dashboard page: the charts of a dashboard file, laid out in nested
 * horizontal / vertical splits. Each chart is an iframe of the chart page (see
 * frame.ts); the cells are positioned absolutely from the layout, so a layout
 * change moves and resizes the iframes without reloading them (moving an
 * iframe in the DOM would).
 */
import type { ChartFrameMessage } from './frame';
import type {
  DashboardInMessage,
  DashboardOutMessage,
  DashboardView,
  DashboardViewChart,
  DashboardViewScript,
} from '../messages';
import type { LayoutNode, SplitDirection } from '../model';

declare function acquireVsCodeApi(): { postMessage(message: DashboardOutMessage): void };

const vscode = acquireVsCodeApi();
const chartHtml = JSON.parse(document.getElementById('chart-frame-html')?.textContent ?? '""') as string;

const titleEl = document.getElementById('dash-title') as HTMLElement;
const addChartEl = document.getElementById('dash-add-chart') as HTMLButtonElement;
const openTextEl = document.getElementById('dash-open-text') as HTMLButtonElement;
const statusEl = document.getElementById('dash-status') as HTMLElement;
const areaEl = document.getElementById('dash-area') as HTMLDivElement;
const emptyEl = document.getElementById('dash-empty') as HTMLDivElement;
const errorEl = document.getElementById('dash-error') as HTMLDivElement;

/** Splitter thickness in pixels. */
const SPLITTER_PX = 4;

interface Cell {
  root: HTMLDivElement;
  header: HTMLDivElement;
  frame: HTMLIFrameElement;
  overlay: HTMLDivElement;
}

const cells = new Map<string, Cell>();
let view: DashboardView | undefined;

function post(message: DashboardOutMessage): void {
  vscode.postMessage(message);
}

addChartEl.addEventListener('click', () => post({ type: 'addChart' }));
openTextEl.addEventListener('click', () => post({ type: 'openText' }));
document.getElementById('dash-empty-add')?.addEventListener('click', () => post({ type: 'addChart' }));
document.getElementById('dash-error-open')?.addEventListener('click', () => post({ type: 'openText' }));

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function iconButton(label: string, glyph: string, onClick: () => void, disabled = false): HTMLButtonElement {
  const button = el('button', 'icon', glyph);
  button.title = label;
  button.setAttribute('aria-label', label);
  button.disabled = disabled;
  button.addEventListener('click', (event) => {
    event.stopPropagation();
    onClick();
  });
  return button;
}

// --- Layout geometry ---------------------------------------------------------

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface SplitterSpec {
  path: number[];
  /** The splitter sits after child `index`. */
  index: number;
  direction: SplitDirection;
  /** The split's own rectangle. */
  rect: Rect;
  sizes: number[];
}

function geometry(
  node: LayoutNode,
  rect: Rect,
  path: number[],
  leaves: Map<string, Rect>,
  splitters: SplitterSpec[]
): void {
  if (typeof node === 'string') {
    leaves.set(node, rect);
    return;
  }
  let offset = 0;
  node.children.forEach((child, i) => {
    const share = node.sizes[i];
    const childRect = node.split === 'horizontal'
      ? { x: rect.x + offset * rect.w, y: rect.y, w: share * rect.w, h: rect.h }
      : { x: rect.x, y: rect.y + offset * rect.h, w: rect.w, h: share * rect.h };
    geometry(child, childRect, [...path, i], leaves, splitters);
    offset += share;
    if (i < node.children.length - 1) {
      splitters.push({ path, index: i, direction: node.split, rect, sizes: node.sizes });
    }
  });
}

function pct(v: number): string {
  return `${(v * 100).toFixed(4)}%`;
}

/** Place a cell in its rectangle, leaving half a splitter on every inner edge. */
function place(node: HTMLElement, r: Rect): void {
  const half = SPLITTER_PX / 2;
  const left = r.x > 0 ? half : 0;
  const top = r.y > 0 ? half : 0;
  const right = r.x + r.w < 0.9999 ? half : 0;
  const bottom = r.y + r.h < 0.9999 ? half : 0;
  node.style.left = `calc(${pct(r.x)} + ${left}px)`;
  node.style.top = `calc(${pct(r.y)} + ${top}px)`;
  node.style.width = `calc(${pct(r.w)} - ${left + right}px)`;
  node.style.height = `calc(${pct(r.h)} - ${top + bottom}px)`;
}

// --- Splitter drag -----------------------------------------------------------

function startDrag(spec: SplitterSpec, event: PointerEvent): void {
  event.preventDefault();
  const area = areaEl.getBoundingClientRect();
  const horizontal = spec.direction === 'horizontal';
  const span = horizontal ? spec.rect.w * area.width : spec.rect.h * area.height;
  const origin = horizontal ? event.clientX : event.clientY;
  const start = [...spec.sizes];
  const pair = start[spec.index] + start[spec.index + 1];
  const min = Math.min(0.1, pair / 2);
  let sizes = start;
  // The page re-renders its splitters on every move, so the drag is followed
  // on the window, not on the handle (the iframes take no pointer meanwhile)
  document.body.classList.add('dragging', horizontal ? 'drag-x' : 'drag-y');
  const move = (e: PointerEvent): void => {
    const delta = ((horizontal ? e.clientX : e.clientY) - origin) / span;
    const first = Math.min(Math.max(start[spec.index] + delta, min), pair - min);
    sizes = [...start];
    sizes[spec.index] = first;
    sizes[spec.index + 1] = pair - first;
    if (view?.layout) render(withSizes(view.layout, spec.path, sizes));
  };
  const up = (): void => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', up);
    document.body.classList.remove('dragging', 'drag-x', 'drag-y');
    if (view?.layout) view = { ...view, layout: withSizes(view.layout, spec.path, sizes) };
    post({ type: 'resize', path: spec.path, sizes });
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', up);
}

function withSizes(node: LayoutNode, path: number[], sizes: number[]): LayoutNode {
  if (typeof node === 'string') return node;
  if (path.length === 0) return { ...node, sizes };
  const children = [...node.children];
  children[path[0]] = withSizes(children[path[0]], path.slice(1), sizes);
  return { ...node, children };
}

// --- Cells -------------------------------------------------------------------

function createCell(key: string): Cell {
  const root = el('div', 'cell');
  const header = el('div', 'cell-header');
  const frame = el('iframe', 'cell-frame');
  frame.dataset.chart = key;
  frame.title = key;
  frame.srcdoc = chartHtml;
  const overlay = el('div', 'cell-overlay');
  overlay.hidden = true;
  root.append(header, frame, overlay);
  areaEl.appendChild(root);
  const cell = { root, header, frame, overlay };
  cells.set(key, cell);
  return cell;
}

const STATE_LABEL: Record<DashboardViewChart['state'], string> = {
  starting: 'Starting',
  loading: 'Loading',
  live: 'LIVE',
  reconnecting: 'Reconnecting',
  error: 'Error',
  stopped: 'Stopped',
};

function scriptChip(key: string, script: DashboardViewScript): HTMLElement {
  const chip = el('span', `chip state-${script.state}`);
  const name = el('button', 'chip-name', script.id);
  const lines = [script.path, ...script.overrides];
  if (script.message) lines.push('', script.message);
  lines.push('', 'Click to edit its inputs');
  name.title = lines.join('\n');
  name.addEventListener('click', () => post({ type: 'editScript', key, id: script.id }));
  const toggle = iconButton(
    script.state === 'off' ? `Run ${script.id}` : `Pause ${script.id}`,
    script.state === 'off' ? '▶' : '⏸',
    () => post({ type: 'toggleScript', key, id: script.id })
  );
  const remove = iconButton(`Remove ${script.id}`, '×', () => post({ type: 'removeScript', key, id: script.id }));
  chip.append(el('span', 'chip-dot'), name, toggle, remove);
  return chip;
}

function renderHeader(key: string, cell: Cell, chart: DashboardViewChart): void {
  const header = cell.header;
  header.replaceChildren();
  // The chart's own toolbar names the symbol and shows the live state: the
  // header only says what the toolbar cannot (starting, downloading, errors)
  header.title = `${chart.symbol} · ${chart.timeframe}\n${chart.provider}`;
  if (chart.state !== 'live') {
    const badge = el('span', `cell-state state-${chart.state}`,
      (chart.state === 'loading' || chart.state === 'starting') && chart.message
        ? chart.message : STATE_LABEL[chart.state]);
    if (chart.message) badge.title = chart.message;
    header.appendChild(badge);
  }
  const chips = el('span', 'cell-chips');
  for (const script of chart.scripts) chips.appendChild(scriptChip(key, script));
  chips.addEventListener('wheel', (event) => {
    if (Math.abs(event.deltaY) > Math.abs(event.deltaX)) chips.scrollLeft += event.deltaY;
  }, { passive: true });
  const addScript = el('button', 'add-script', '+ Script');
  addScript.disabled = !chart.canAddScript;
  addScript.title = chart.canAddScript
    ? 'Add an indicator or a strategy to this chart'
    : 'This chart runs as many scripts as it can';
  addScript.addEventListener('click', () => post({ type: 'addScript', key }));
  const actions = el('span', 'cell-actions');
  const canAdd = view?.canAddChart ?? false;
  actions.append(
    iconButton('Open in a chart tab: trades, performance and stats', '⤢', () => post({ type: 'openFullChart', key })),
    iconButton('Restart this chart', '↻', () => post({ type: 'restartChart', key })),
    iconButton('Add a chart to the right', '◫', () => post({ type: 'addChart', beside: key, direction: 'horizontal' }), !canAdd),
    iconButton('Add a chart below', '⬓', () => post({ type: 'addChart', beside: key, direction: 'vertical' }), !canAdd),
    iconButton('Remove this chart', '×', () => post({ type: 'removeChart', key }))
  );
  header.append(chips, addScript, el('span', 'cell-spacer'), actions);

  cell.overlay.replaceChildren();
  cell.overlay.hidden = chart.state !== 'error';
  if (chart.state === 'error') {
    const retry = el('button', 'primary', 'Retry');
    retry.addEventListener('click', () => post({ type: 'restartChart', key }));
    cell.overlay.append(el('div', 'overlay-message', chart.message ?? 'The chart stopped.'), retry);
  }
}

function render(layout: LayoutNode | undefined): void {
  const leaves = new Map<string, Rect>();
  const splitters: SplitterSpec[] = [];
  if (layout !== undefined) geometry(layout, { x: 0, y: 0, w: 1, h: 1 }, [], leaves, splitters);
  for (const [key, cell] of cells) {
    if (leaves.has(key)) continue;
    cell.root.remove();
    cells.delete(key);
  }
  for (const [key, rect] of leaves) {
    const cell = cells.get(key) ?? createCell(key);
    place(cell.root, rect);
  }
  for (const old of Array.from(areaEl.querySelectorAll('.splitter'))) old.remove();
  for (const spec of splitters) {
    const handle = el('div', `splitter ${spec.direction}`);
    const before = spec.sizes.slice(0, spec.index + 1).reduce((a, b) => a + b, 0);
    const r = spec.rect;
    if (spec.direction === 'horizontal') {
      handle.style.left = `calc(${pct(r.x + before * r.w)} - ${SPLITTER_PX / 2}px)`;
      handle.style.top = pct(r.y);
      handle.style.width = `${SPLITTER_PX}px`;
      handle.style.height = pct(r.h);
    } else {
      handle.style.top = `calc(${pct(r.y + before * r.h)} - ${SPLITTER_PX / 2}px)`;
      handle.style.left = pct(r.x);
      handle.style.height = `${SPLITTER_PX}px`;
      handle.style.width = pct(r.w);
    }
    handle.addEventListener('pointerdown', (event) => startDrag(spec, event));
    areaEl.appendChild(handle);
  }
}

function summary(v: DashboardView): string {
  const charts = Object.values(v.charts);
  const live = charts.filter((c) => c.state === 'live').length;
  const errors = charts.filter((c) => c.state === 'error').length +
    charts.reduce((n, c) => n + c.scripts.filter((s) => s.state === 'error').length, 0);
  const parts = [`${charts.length} chart${charts.length === 1 ? '' : 's'}`];
  if (charts.length) parts.push(`${live} live`);
  if (errors) parts.push(`${errors} error${errors === 1 ? '' : 's'}`);
  return parts.join(' · ');
}

function showView(next: DashboardView): void {
  view = next;
  titleEl.textContent = next.name;
  document.title = next.name;
  addChartEl.disabled = !next.canAddChart;
  addChartEl.title = next.canAddChart ? 'Add a chart' : 'This dashboard holds as many charts as it can';
  errorEl.hidden = next.error === undefined;
  const message = errorEl.querySelector('.error-message');
  if (message) message.textContent = next.error ?? '';
  emptyEl.hidden = next.error !== undefined || next.layout !== undefined;
  statusEl.textContent = next.error === undefined ? summary(next) : '';
  render(next.error === undefined ? next.layout : undefined);
  for (const [key, chart] of Object.entries(next.charts)) {
    const cell = cells.get(key);
    if (cell) renderHeader(key, cell, chart);
  }
}

window.addEventListener('message', (event: MessageEvent) => {
  const data = event.data as DashboardInMessage | ChartFrameMessage;
  if (data && typeof data === 'object' && 'pyneChartFrame' in data) {
    const message = data.message as { type?: unknown } | null;
    const cell = cells.get(data.pyneChartFrame);
    if (cell && event.source === cell.frame.contentWindow && message && typeof message.type === 'string') {
      post({ type: 'frame', key: data.pyneChartFrame, message: message as never });
    }
    return;
  }
  switch (data?.type) {
    case 'view':
      showView(data.view);
      break;
    case 'chart':
      cells.get(data.key)?.frame.contentWindow?.postMessage(data.message, '*');
      break;
  }
});

post({ type: 'ready' });
