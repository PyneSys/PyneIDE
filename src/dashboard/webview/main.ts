/**
 * The dashboard page: the charts of a dashboard file, laid out in nested
 * horizontal / vertical splits. Each chart is an iframe of the chart page (see
 * frame.ts); the cells are positioned absolutely from the layout, so a layout
 * change moves and resizes the iframes without reloading them (moving an
 * iframe in the DOM would). A maximized chart fills the whole area over the
 * others, which stay loaded and keep their size behind it. A chart dragged by
 * its grip (or its toolbar's empty middle) shows where it would land, and
 * moves there on release.
 */
import type { ChartFrameMessage } from './frame';
import type {
  DashboardInMessage,
  DashboardOutMessage,
  DashboardView,
  DashboardViewChart,
} from '../messages';
import type { ChartInMessage } from '../../chart/messages';
import { moveInLayout, type DropSide, type LayoutNode, type SplitDirection } from '../model';
import { installTooltips } from '../../webview/tooltip';

installTooltips();

declare function acquireVsCodeApi(): {
  postMessage(message: DashboardOutMessage): void;
  setState(state: unknown): void;
};

const vscode = acquireVsCodeApi();
// A further window of the dashboard keeps which one it is, so VS Code can
// restore it where it was in the next session
const windowState = JSON.parse(document.getElementById('dash-window-state')?.textContent ?? 'null') as unknown;
if (windowState !== null) vscode.setState(windowState);
const chartHtml = JSON.parse(document.getElementById('chart-frame-html')?.textContent ?? '""') as string;

const areaEl = document.getElementById('dash-area') as HTMLDivElement;
const emptyEl = document.getElementById('dash-empty') as HTMLDivElement;
const errorEl = document.getElementById('dash-error') as HTMLDivElement;

/** Splitter thickness in pixels. */
const SPLITTER_PX = 4;

interface Cell {
  root: HTMLDivElement;
  frame: HTMLIFrameElement;
  overlay: HTMLDivElement;
}

const cells = new Map<string, Cell>();
let view: DashboardView | undefined;
/** The chart filling the whole area, if one does. */
let maximized: string | undefined;

function post(message: DashboardOutMessage): void {
  vscode.postMessage(message);
}

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

// --- Moving a chart ----------------------------------------------------------

/** Within this many pixels of the dashboard's edge a chart lands beside the whole layout. */
const EDGE_DROP_PX = 16;
/** A drop at least this far into a cell (a share of its width / height) from
 * every edge trades places with the cell's chart. */
const SWAP_INSET = 0.3;

interface Drop {
  target: string | undefined;
  side: DropSide;
  /** Where the chart would land. */
  rect: Rect;
}

interface MoveDrag {
  key: string;
  layout: LayoutNode;
  leaves: Map<string, Rect>;
}

let moving: MoveDrag | undefined;
const dropEl = el('div', 'drop-indicator');
dropEl.hidden = true;
areaEl.appendChild(dropEl);

function nearestSide(distances: Record<'left' | 'right' | 'top' | 'bottom', number>): {
  side: 'left' | 'right' | 'top' | 'bottom';
  distance: number;
} {
  let best: { side: 'left' | 'right' | 'top' | 'bottom'; distance: number } = { side: 'left', distance: Infinity };
  for (const side of ['left', 'right', 'top', 'bottom'] as const) {
    if (distances[side] < best.distance) best = { side, distance: distances[side] };
  }
  return best;
}

/** The drop at a point of the page; none off the area, over the dragged chart,
 * or where the layout would not change. */
function dropAt(drag: MoveDrag, clientX: number, clientY: number): Drop | undefined {
  const area = areaEl.getBoundingClientRect();
  const ax = clientX - area.left;
  const ay = clientY - area.top;
  if (ax < 0 || ay < 0 || ax > area.width || ay > area.height) return undefined;
  let target: string | undefined;
  let side: DropSide | undefined;
  const outer = nearestSide({ left: ax, right: area.width - ax, top: ay, bottom: area.height - ay });
  if (outer.distance < EDGE_DROP_PX) {
    side = outer.side;
  } else {
    const nx = ax / area.width;
    const ny = ay / area.height;
    for (const [key, r] of drag.leaves) {
      if (nx < r.x || nx > r.x + r.w || ny < r.y || ny > r.y + r.h) continue;
      if (key === drag.key) return undefined;
      const fx = (nx - r.x) / r.w;
      const fy = (ny - r.y) / r.h;
      const inner = nearestSide({ left: fx, right: 1 - fx, top: fy, bottom: 1 - fy });
      target = key;
      side = inner.distance >= SWAP_INSET ? 'swap' : inner.side;
      break;
    }
  }
  if (side === undefined) return undefined;
  const next = moveInLayout(drag.layout, drag.key, target, side);
  if (next === undefined || JSON.stringify(next) === JSON.stringify(drag.layout)) return undefined;
  const leaves = new Map<string, Rect>();
  geometry(next, { x: 0, y: 0, w: 1, h: 1 }, [], leaves, []);
  const rect = leaves.get(drag.key);
  return rect ? { target, side, rect } : undefined;
}

function showDrop(drop: Drop | undefined): void {
  dropEl.hidden = drop === undefined;
  if (drop) place(dropEl, drop.rect);
}

function endMove(): void {
  if (moving) cells.get(moving.key)?.root.classList.remove('moving');
  moving = undefined;
  document.body.classList.remove('moving-chart');
  showDrop(undefined);
}

/** A chart's drag began, went on or ended (frame coordinates). */
function onMoveAction(key: string, phase: 'start' | 'move' | 'end' | 'cancel', x: number, y: number): void {
  const cell = cells.get(key);
  if (phase === 'start') {
    endMove();
    if (!cell || maximized !== undefined || view?.error !== undefined || view?.layout === undefined) return;
    const leaves = new Map<string, Rect>();
    geometry(view.layout, { x: 0, y: 0, w: 1, h: 1 }, [], leaves, []);
    moving = { key, layout: view.layout, leaves };
    cell.root.classList.add('moving');
    document.body.classList.add('moving-chart');
    return;
  }
  const drag = moving;
  if (!drag || drag.key !== key || !cell) return;
  const frame = cell.frame.getBoundingClientRect();
  const drop = phase === 'cancel' ? undefined : dropAt(drag, frame.left + x, frame.top + y);
  if (phase === 'move') {
    showDrop(drop);
    return;
  }
  endMove();
  if (drop) {
    // Show the move at once; the extension's view confirms it
    if (view) view = { ...view, layout: moveInLayout(drag.layout, key, drop.target, drop.side) };
    render(view?.layout);
    post({ type: 'moveChart', key, target: drop.target, side: drop.side });
  }
}

// --- Cells -------------------------------------------------------------------

function createCell(key: string): Cell {
  const root = el('div', 'cell');
  const frame = el('iframe', 'cell-frame');
  frame.dataset.chart = key;
  frame.title = key;
  frame.srcdoc = chartHtml;
  const overlay = el('div', 'cell-overlay');
  overlay.hidden = true;
  root.append(frame, overlay);
  areaEl.appendChild(root);
  const cell = { root, frame, overlay };
  cells.set(key, cell);
  return cell;
}

/** A stopped chart covers its chart (below the toolbar, which can still
 * change the symbol or remove the chart) with the reason and a Retry. */
function renderOverlay(key: string, cell: Cell, chart: DashboardViewChart): void {
  cell.overlay.replaceChildren();
  cell.overlay.hidden = chart.state !== 'error';
  if (chart.state !== 'error') return;
  const retry = el('button', 'primary', 'Retry');
  retry.addEventListener('click', () => post({ type: 'restartChart', key }));
  cell.overlay.append(el('div', 'overlay-message', chart.message ?? 'The chart stopped.'), retry);
}

function postToFrame(key: string, message: ChartInMessage): void {
  cells.get(key)?.frame.contentWindow?.postMessage(message, '*');
}

/** Fill the area with `key`'s chart, or (undefined) go back to the layout. */
function setMaximized(key: string | undefined): void {
  if (key === maximized) return;
  const previous = maximized;
  maximized = key;
  if (previous !== undefined) postToFrame(previous, { type: 'maximized', maximized: false });
  if (key !== undefined) postToFrame(key, { type: 'maximized', maximized: true });
  render(view?.error === undefined ? view?.layout : undefined);
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
  // The layout changed under a drag (a text edit, a chart removed): its drops are stale
  if (moving && JSON.stringify(layout) !== JSON.stringify(moving.layout)) endMove();
  if (maximized !== undefined && !leaves.has(maximized)) {
    const key = maximized;
    maximized = undefined;
    postToFrame(key, { type: 'maximized', maximized: false });
  }
  document.body.classList.toggle('has-maximized', maximized !== undefined);
  for (const [key, rect] of leaves) {
    const cell = cells.get(key) ?? createCell(key);
    place(cell.root, key === maximized ? { x: 0, y: 0, w: 1, h: 1 } : rect);
    cell.root.classList.toggle('behind', maximized !== undefined && key !== maximized);
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

function showView(next: DashboardView): void {
  view = next;
  document.title = next.name;
  errorEl.hidden = next.error === undefined;
  const message = errorEl.querySelector('.error-message');
  if (message) message.textContent = next.error ?? '';
  emptyEl.hidden = next.error !== undefined || next.layout !== undefined;
  render(next.error === undefined ? next.layout : undefined);
  for (const [key, chart] of Object.entries(next.charts)) {
    const cell = cells.get(key);
    if (cell) renderOverlay(key, cell, chart);
  }
}

window.addEventListener('message', (event: MessageEvent) => {
  const data = event.data as DashboardInMessage | ChartFrameMessage;
  if (data && typeof data === 'object' && 'pyneChartFrame' in data) {
    const message = data.message as {
      type?: unknown;
      action?: { kind?: unknown; phase?: unknown; x?: unknown; y?: unknown };
    } | null;
    const key = data.pyneChartFrame;
    const cell = cells.get(key);
    if (!cell || event.source !== cell.frame.contentWindow || !message || typeof message.type !== 'string') return;
    // Maximizing is the page's own layout: the extension never hears of it
    if (message.type === 'cell' && message.action?.kind === 'toggleMaximize') {
      setMaximized(maximized === key ? undefined : key);
      return;
    }
    if (message.type === 'cell' && message.action?.kind === 'move') {
      const { phase, x, y } = message.action;
      if ((phase === 'start' || phase === 'move' || phase === 'end' || phase === 'cancel') &&
        typeof x === 'number' && typeof y === 'number') {
        onMoveAction(key, phase, x, y);
      }
      return;
    }
    post({ type: 'frame', key, message: message as never });
    // A reloaded frame starts in its cell
    if (message.type === 'ready' && key === maximized) postToFrame(key, { type: 'maximized', maximized: true });
    return;
  }
  switch (data?.type) {
    case 'view':
      showView(data.view);
      break;
    case 'chart':
      postToFrame(data.key, data.message);
      break;
  }
});

post({ type: 'ready' });
