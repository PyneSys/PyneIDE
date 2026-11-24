/**
 * A chart inside a dashboard cell (`body.embedded`): the cell's toolbar
 * buttons ("Add script", split, full chart, remove), its split menu, and what
 * the Layers menu needs to group the plots by script. The dashboard sends the
 * cell's scripts and limits as `cell` messages; the buttons answer with `cell`
 * actions. A chart tab has none of these elements, so nothing here runs there.
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

const SPLIT_CHOICES: Array<{ direction: 'horizontal' | 'vertical'; label: string; icon: string }> = [
  { direction: 'horizontal', label: 'Add chart to the right', icon: 'M10 3.5v13M13 10h3M14.5 8.5v3' },
  { direction: 'vertical', label: 'Add chart below', icon: 'M2.5 10h15M10 12.5v3M8.5 14h3' },
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
    item.dataset.direction = choice.direction;
    item.innerHTML = '<svg viewBox="0 0 20 20" aria-hidden="true">' +
      `<rect x="2.5" y="3.5" width="15" height="13" rx="1.5"></rect><path d="${choice.icon}"></path></svg>`;
    item.append(choice.label);
    item.addEventListener('click', (event) => {
      event.stopPropagation();
      closeSplitPopup();
      cellAction({ kind: 'addChart', direction: choice.direction });
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

export function setCell(next: ChartCell): void {
  cell = next;
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
