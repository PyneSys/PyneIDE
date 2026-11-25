/**
 * A chart inside a dashboard cell (`body.embedded`): the cell's grip and toolbar
 * buttons ("Add script", split, full chart, remove), its split menu (a chart
 * beside this one, or in a new window), and what the Layers menu needs to group
 * the plots by script. The dashboard sends the cell's scripts and limits as
 * `cell` messages; the buttons answer with `cell` actions. A chart tab has none
 * of these elements, so nothing here runs there.
 */
import type { ChartCell, ChartCellAction, ChartCellScript, ChartOutMessage } from '../messages';
import { toolbarAnchor } from './toolbarOverflow';

export interface DashboardCellHooks {
  post: (message: ChartOutMessage) => void;
  /** Close the toolbar's other popups before the split menu opens. */
  closeOtherPopups: () => void;
  /** The cell changed: refresh what shows it (Layers menu, feed indicator). */
  onChange: () => void;
}

const addScriptEl = document.getElementById('tb-add-script') as HTMLButtonElement | null;
const splitEl = document.getElementById('tb-split') as HTMLButtonElement | null;
const fullChartEl = document.getElementById('tb-full-chart') as HTMLButtonElement | null;
const removeChartEl = document.getElementById('tb-remove-chart') as HTMLButtonElement | null;
const layersEl = document.getElementById('tb-layers') as HTMLButtonElement | null;
const moveEl = document.getElementById('tb-move') as HTMLDivElement | null;
/** The toolbar's empty middle: a second handle to drag the chart by, like a title bar. */
const toolbarSpaceEl = document.querySelector<HTMLElement>('#toolbar-items > .spacer');

let cell: ChartCell | undefined;
let hooks: DashboardCellHooks | undefined;
let splitPopupEl: HTMLDivElement | null = null;

/** The cell's latest state; undefined in a chart tab. */
export function currentCell(): ChartCell | undefined {
  return cell;
}

/** The script whose plots carry `id`'s prefix (`ema_fast: `). */
export function scriptOfPlot(id: string): ChartCellScript | undefined {
  return cell?.scripts.find((script) => id.startsWith(`${script.id}: `));
}

/** A plot's name inside its script's group: the id prefix taken off. */
export function plotLabelInScript(label: string, script: ChartCellScript): string {
  const prefix = `${script.id}: `;
  return label.startsWith(prefix) ? label.slice(prefix.length) : label;
}

export function cellAction(action: ChartCellAction): void {
  hooks?.post({ type: 'cell', action });
}

const SPLIT_CHOICES: Array<{ action: ChartCellAction; label: string; icon: string }> = [
  {
    action: { kind: 'addChart', direction: 'horizontal' },
    label: 'Add chart to the right',
    icon: 'M10 3.5v13M13 10h3M14.5 8.5v3',
  },
  { action: { kind: 'addChart', direction: 'vertical' }, label: 'Add chart below', icon: 'M2.5 10h15M10 12.5v3M8.5 14h3' },
  { action: { kind: 'addChartWindow' }, label: 'Add chart in a new window', icon: 'M11.5 6.5h4v4M15.5 6.5l-5 5' },
];

function ensureSplitPopup(): HTMLDivElement {
  if (splitPopupEl) return splitPopupEl;
  const popup = document.createElement('div');
  popup.id = 'split-popup';
  popup.setAttribute('role', 'menu');
  popup.hidden = true;
  for (const choice of SPLIT_CHOICES) {
    const item = document.createElement('button');
    item.type = 'button';
    item.setAttribute('role', 'menuitem');
    item.innerHTML = '<svg viewBox="0 0 20 20" aria-hidden="true">' +
      `<rect x="2.5" y="3.5" width="15" height="13" rx="1.5"></rect><path d="${choice.icon}"></path></svg>`;
    item.append(choice.label);
    item.addEventListener('click', (event) => {
      event.stopPropagation();
      closeSplitPopup();
      cellAction(choice.action);
    });
    popup.appendChild(item);
  }
  popup.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    closeSplitPopup();
    toolbarAnchor(splitEl)?.focus();
  });
  document.body.appendChild(popup);
  splitPopupEl = popup;
  return popup;
}

/** Below the split button (or the overflow button holding it), kept inside the frame. */
export function positionSplitPopup(): void {
  const anchor = toolbarAnchor(splitEl);
  if (!splitPopupEl || splitPopupEl.hidden || !anchor) return;
  const rect = anchor.getBoundingClientRect();
  const left = Math.max(6, Math.min(rect.right - splitPopupEl.offsetWidth, window.innerWidth - splitPopupEl.offsetWidth - 6));
  splitPopupEl.style.left = `${Math.round(left)}px`;
  splitPopupEl.style.top = `${Math.round(rect.bottom + 3)}px`;
}

function openSplitPopup(focusFirst: boolean): void {
  const popup = ensureSplitPopup();
  for (const item of Array.from(popup.querySelectorAll('button'))) {
    item.disabled = cell?.addChartBlocked !== undefined;
    item.title = cell?.addChartBlocked ?? '';
  }
  popup.hidden = false;
  positionSplitPopup();
  splitEl?.classList.add('active');
  splitEl?.setAttribute('aria-pressed', 'true');
  if (focusFirst) popup.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
}

export function closeSplitPopup(): void {
  if (splitPopupEl) splitPopupEl.hidden = true;
  splitEl?.classList.remove('active');
  splitEl?.setAttribute('aria-pressed', 'false');
}

/** The Layers button carries a mark while a script of the chart has stopped. */
function syncLayersMark(): void {
  if (!layersEl) return;
  const failed = cell?.scripts.filter((script) => script.state === 'error').length ?? 0;
  let badge = layersEl.querySelector<HTMLElement>('.count-badge');
  if (failed && !badge) {
    badge = document.createElement('span');
    badge.className = 'count-badge';
    badge.setAttribute('aria-hidden', 'true');
    layersEl.appendChild(badge);
  }
  if (badge) {
    badge.hidden = !failed;
    badge.textContent = '!';
  }
  layersEl.classList.toggle('has-error', failed > 0);
  const label = failed
    ? `Layers and indicators: ${failed === 1 ? 'a script has' : `${failed} scripts have`} stopped`
    : 'Layers and indicators';
  layersEl.title = label;
  layersEl.setAttribute('aria-label', label);
}

/** How far (px) the pointer goes before a press on a handle becomes a drag. */
const DRAG_THRESHOLD_PX = 4;

/**
 * Drag the chart by `handle` (the grip, or the toolbar's empty middle) once the
 * pointer has gone a few pixels, so a plain click moves nothing. The handle
 * holds the pointer for the whole drag, so its moves keep coming here even over
 * the dashboard's other charts; each goes to the dashboard page, which shows
 * where the chart would land and moves it on release. Escape cancels the drag.
 */
function initMoveHandle(handle: HTMLElement, canMove: () => boolean): void {
  handle.addEventListener('pointerdown', (down) => {
    if (down.button !== 0 || !canMove()) return;
    down.preventDefault();
    handle.setPointerCapture(down.pointerId);
    let last = { x: down.clientX, y: down.clientY };
    let started = false;
    let done = false;
    const send = (phase: 'start' | 'move' | 'end' | 'cancel'): void =>
      cellAction({ kind: 'move', phase, x: last.x, y: last.y });
    const move = (event: PointerEvent): void => {
      last = { x: event.clientX, y: event.clientY };
      if (!started) {
        if (Math.hypot(last.x - down.clientX, last.y - down.clientY) < DRAG_THRESHOLD_PX) return;
        started = true;
        handle.classList.add('dragging');
        send('start');
      }
      send('move');
    };
    const finish = (phase: 'end' | 'cancel'): void => {
      if (done) return;
      done = true;
      handle.classList.remove('dragging');
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', cancel);
      handle.removeEventListener('lostpointercapture', cancel);
      window.removeEventListener('keydown', key, true);
      if (handle.hasPointerCapture(down.pointerId)) handle.releasePointerCapture(down.pointerId);
      if (started) send(phase);
    };
    const up = (event: PointerEvent): void => {
      last = { x: event.clientX, y: event.clientY };
      finish('end');
    };
    const cancel = (): void => finish('cancel');
    const key = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      finish('cancel');
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', cancel);
    handle.addEventListener('lostpointercapture', cancel);
    window.addEventListener('keydown', key, true);
  });
}

export function setCell(next: ChartCell): void {
  cell = next;
  if (moveEl) moveEl.hidden = !next.movable;
  document.body.classList.toggle('cell-movable', next.movable);
  if (addScriptEl) {
    addScriptEl.disabled = next.addScriptBlocked !== undefined;
    addScriptEl.title = next.addScriptBlocked ?? 'Add an indicator or a strategy to this chart';
  }
  if (splitEl && splitPopupEl && !splitPopupEl.hidden) openSplitPopup(false);
  syncLayersMark();
  hooks?.onChange();
}

/** The chart fills the dashboard (or is back in its cell): it shows the
 * bottom panel (trades, performance, stats) only while it does. */
export function setMaximized(maximized: boolean): void {
  document.body.classList.toggle('maximized', maximized);
  if (!fullChartEl) return;
  fullChartEl.classList.toggle('active', maximized);
  fullChartEl.setAttribute('aria-pressed', String(maximized));
  fullChartEl.setAttribute('aria-label', maximized ? 'Restore' : 'Maximize');
  fullChartEl.title = maximized
    ? 'Restore: back to the dashboard layout'
    : 'Maximize: fill the dashboard, with trades, performance and stats';
}

export function initDashboardCell(cellHooks: DashboardCellHooks): void {
  if (!document.body.classList.contains('embedded')) return;
  hooks = cellHooks;
  if (moveEl) initMoveHandle(moveEl, () => !moveEl.hidden);
  if (toolbarSpaceEl) {
    initMoveHandle(toolbarSpaceEl, () =>
      cell?.movable === true && !document.body.classList.contains('maximized'));
  }
  addScriptEl?.addEventListener('click', () => cellAction({ kind: 'addScript' }));
  fullChartEl?.addEventListener('click', () => cellAction({ kind: 'toggleMaximize' }));
  removeChartEl?.addEventListener('click', () => cellAction({ kind: 'removeChart' }));
  splitEl?.addEventListener('click', (event) => {
    event.stopPropagation();
    if (splitPopupEl && !splitPopupEl.hidden) {
      closeSplitPopup();
      return;
    }
    cellHooks.closeOtherPopups();
    openSplitPopup(event.detail === 0);
  });
  document.addEventListener('click', (event) => {
    if (!splitPopupEl || splitPopupEl.hidden) return;
    const target = event.target as Node;
    if (splitPopupEl.contains(target) || splitEl?.contains(target)) return;
    closeSplitPopup();
  });
  window.addEventListener('resize', positionSplitPopup);
}
