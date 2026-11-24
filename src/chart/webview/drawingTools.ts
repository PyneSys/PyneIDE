/**
 * The user's own chart drawings: a TradingView-style vertical tool bar on the
 * left of the chart, opened from the toolbar's first button. Every tool is one
 * of KLineChart's built-in overlays, drawn on the price pane.
 *
 * A run disposes the chart and builds a new one, so the drawings are taken off
 * the old chart (`detach`) and put back on the new one (`attach`). They are
 * kept per symbol: a run on another symbol starts from that symbol's own
 * drawings, and coming back brings the first set back. Points are stored by
 * timestamp, so a drawing stays on its bars across timeframes and reloads. The
 * drawings live as long as the webview does; they are not saved to disk.
 *
 * On a chart too short for the whole bar, the buttons that do not fit go,
 * from the bottom up, into a menu behind a "more" button at the bar's end.
 */
import type { Chart, OverlayCreate, OverlayEvent, OverlayMode, Point } from 'klinecharts';

/** Overlay group of the user's drawings; nothing else on the chart uses it. */
const GROUP_ID = 'pyne-user-drawings';
const PANE_ID = 'candle_pane';

interface DrawingTool {
  /** KLineChart built-in overlay name. */
  overlay: string;
  label: string;
  /** Inner markup of a 20x20 stroked SVG icon. */
  icon: string;
}

const TOOL_GROUPS: DrawingTool[][] = [
  [
    {
      overlay: 'segment', label: 'Trend line',
      icon: '<path d="M5.6 14.4 14.4 5.6"/><circle cx="4.5" cy="15.5" r="1.5"/><circle cx="15.5" cy="4.5" r="1.5"/>',
    },
    {
      overlay: 'rayLine', label: 'Ray',
      icon: '<circle cx="4.5" cy="15.5" r="1.5"/><path d="M5.6 14.4 18 2"/>',
    },
    {
      overlay: 'straightLine', label: 'Extended line',
      icon: '<path d="M2 18l6.9-6.9M11.1 8.9 18 2"/><circle cx="10" cy="10" r="1.5"/>',
    },
    {
      overlay: 'horizontalStraightLine', label: 'Horizontal line',
      icon: '<path d="M2 10h6.5M11.5 10H18"/><circle cx="10" cy="10" r="1.5"/>',
    },
    {
      overlay: 'horizontalRayLine', label: 'Horizontal ray',
      icon: '<circle cx="4.5" cy="10" r="1.5"/><path d="M6 10h12"/>',
    },
    {
      overlay: 'verticalStraightLine', label: 'Vertical line',
      icon: '<path d="M10 2v6.5M10 11.5V18"/><circle cx="10" cy="10" r="1.5"/>',
    },
    {
      overlay: 'priceLine', label: 'Price line',
      icon: '<circle cx="4.5" cy="13" r="1.5"/><path d="M6 13h12M8 8.5h1.5M11 8.5h1.5M14 8.5h1.5"/>',
    },
  ],
  [
    {
      overlay: 'parallelStraightLine', label: 'Parallel channel',
      icon: '<path d="M2 13 13 2M7 18 18 7"/>',
    },
    {
      overlay: 'priceChannelLine', label: 'Price channel',
      icon: '<path d="M2 11 11 2M9 18 18 9"/><path d="M5.5 14.5 14.5 5.5" stroke-dasharray="1.6 1.8"/>',
    },
    {
      overlay: 'fibonacciLine', label: 'Fib retracement',
      icon: '<path d="M2.5 4h15M2.5 8h15M2.5 12h15M2.5 16h15"/>',
    },
  ],
  [
    {
      overlay: 'brush', label: 'Brush',
      icon: '<path d="M3 15c1.5-3 3-6.5 5-5.5s1 4.5 3.5 4 2.5-6 4-8.5c.6-1 1.2-1.5 1.5-1.5"/>',
    },
  ],
];

const CURSOR_ICON = '<path d="M5.5 3 15 10.2l-4.3.6 2.6 4.9-1.9 1-2.6-4.9-3.3 3z"/>';
const MAGNET_ICON = '<path d="M4.5 3.5h3.5v6.5a2 2 0 0 0 4 0V3.5h3.5v6.5a5.5 5.5 0 0 1-11 0z"/><path d="M4.5 7h3.5M12 7h3.5"/>';
const LOCK_ICON = '<rect x="4.5" y="9" width="11" height="8" rx="1.5"/><path d="M7 9V6.5a3 3 0 0 1 6 0V9"/>';
const HIDE_ICON = '<path d="M2.5 10s2.7-5 7.5-5 7.5 5 7.5 5-2.7 5-7.5 5-7.5-5-7.5-5z"/><circle cx="10" cy="10" r="2.3"/><path class="slash" d="M4 16 16 4"/>';
const MORE_ICON = '<circle cx="5" cy="10" r="0.8" fill="currentColor"/><circle cx="10" cy="10" r="0.8" fill="currentColor"/><circle cx="15" cy="10" r="0.8" fill="currentColor"/>';
const REMOVE_ICON = '<path d="M4 5.5h12M8 5.5v-2h4v2M5.5 5.5l.8 11h7.4l.8-11M8.5 8.5v5M11.5 8.5v5"/>';

/** A bar item moved into the "more" menu for want of room. */
const OVERFLOW_CLASS = 'dt-overflow';

type StoredPoint = Partial<Pick<Point, 'timestamp' | 'dataIndex' | 'value'>>;

interface StoredDrawing {
  overlay: string;
  points: StoredPoint[];
}

function svg(markup: string): string {
  return `<svg viewBox="0 0 20 20" aria-hidden="true">${markup}</svg>`;
}

/** A point by its timestamp when it has one, so it survives a reload, a new
 * history window or another timeframe; a value-only point (a horizontal line)
 * has nothing else to keep. */
function storedPoint(point: Partial<Point>): StoredPoint {
  const stored: StoredPoint = {};
  if (typeof point.timestamp === 'number') stored.timestamp = point.timestamp;
  else if (typeof point.dataIndex === 'number') stored.dataIndex = point.dataIndex;
  if (typeof point.value === 'number') stored.value = point.value;
  return stored;
}

export interface DrawingToolsHooks {
  /** Called before a tool starts drawing: other chart modes give way to it. */
  beforeDraw(): void;
}

export class DrawingTools {
  private chart: Chart | undefined;
  private symbolKey: string | undefined;
  private readonly stored = new Map<string, StoredDrawing[]>();
  /** The overlay of the tool being drawn, until its last point is placed. */
  private drawingId: string | undefined;
  private activeTool: string | undefined;
  private selectedId: string | undefined;
  private open = false;
  private magnet = false;
  private locked = false;
  private hidden = false;
  private enabled = false;
  private readonly toolButtons = new Map<string, HTMLButtonElement>();
  private readonly cursorButton: HTMLButtonElement;
  private readonly magnetButton: HTMLButtonElement;
  private readonly lockButton: HTMLButtonElement;
  private readonly hideButton: HTMLButtonElement;
  private readonly removeButton: HTMLButtonElement;
  /** The bar's buttons and separators in order, without the "more" button. */
  private readonly items: HTMLElement[];
  private readonly moreButton: HTMLButtonElement;
  private readonly menu: HTMLElement;

  constructor(
    private readonly bar: HTMLElement,
    private readonly toggle: HTMLButtonElement | null,
    private readonly hooks: DrawingToolsHooks,
  ) {
    this.cursorButton = this.button('Cursor', CURSOR_ICON, () => this.cancelDrawing());
    this.separator();
    for (const group of TOOL_GROUPS) {
      for (const tool of group) {
        const button = this.button(tool.label, tool.icon, () => this.selectTool(tool.overlay));
        this.toolButtons.set(tool.overlay, button);
      }
      this.separator();
    }
    this.magnetButton = this.button('Magnet: snap to the bar prices', MAGNET_ICON, () => {
      this.setMagnet(!this.magnet);
    });
    this.lockButton = this.button('Lock all drawings', LOCK_ICON, () => this.setLocked(!this.locked));
    this.hideButton = this.button('Hide all drawings', HIDE_ICON, () => this.setHidden(!this.hidden));
    this.removeButton = this.button('Remove all drawings', REMOVE_ICON, () => this.removeAll());
    this.items = Array.from(bar.children) as HTMLElement[];
    this.moreButton = this.button('More drawing tools', MORE_ICON, () => this.setMenuOpen(this.menu.hidden));
    this.moreButton.setAttribute('aria-expanded', 'false');
    this.moreButton.setAttribute('aria-controls', 'drawing-tools-menu');
    this.moreButton.hidden = true;
    this.menu = document.createElement('div');
    this.menu.id = 'drawing-tools-menu';
    this.menu.setAttribute('role', 'group');
    this.menu.setAttribute('aria-label', 'More drawing tools');
    this.menu.hidden = true;
    document.body.appendChild(this.menu);

    toggle?.addEventListener('click', () => this.setOpen(!this.open));
    document.addEventListener('keydown', (event) => this.onKeyDown(event));
    // Capture: the menu takes Escape before the chart's own handlers see it
    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape' || this.menu.hidden) return;
      event.preventDefault();
      event.stopPropagation();
      this.setMenuOpen(false);
      this.moreButton.focus({ preventScroll: true });
    }, true);
    document.addEventListener('pointerdown', (event) => {
      const target = event.target as Node;
      if (this.menu.hidden || this.menu.contains(target) || this.moreButton.contains(target)) return;
      this.setMenuOpen(false);
    });
    new ResizeObserver(() => this.layout()).observe(bar);
    this.syncButtons();
  }

  /** Whether a tool is placing its points: chart clicks belong to it. */
  isDrawing(): boolean {
    return this.drawingId !== undefined;
  }

  /** The chart has (or no longer has) a run to draw on. */
  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    if (!enabled) this.cancelDrawing();
    this.syncButtons();
  }

  /** Put the symbol's drawings on a newly built chart. */
  attach(chart: Chart, symbolKey: string): void {
    this.chart = chart;
    this.symbolKey = symbolKey;
    for (const drawing of this.stored.get(symbolKey) ?? []) {
      this.createOverlay(drawing.overlay, drawing.points);
    }
    this.syncButtons();
  }

  /** Take the drawings off a chart about to be disposed. An unfinished one is
   * dropped, the way a run cancels any other pending chart gesture. */
  detach(): void {
    const chart = this.chart;
    if (!chart) return;
    this.cancelDrawing();
    if (this.symbolKey !== undefined) {
      const drawings = chart.getOverlays({ groupId: GROUP_ID }).map((overlay) => ({
        overlay: overlay.name,
        points: overlay.points.map(storedPoint),
      }));
      if (drawings.length) this.stored.set(this.symbolKey, drawings);
      else this.stored.delete(this.symbolKey);
    }
    this.chart = undefined;
    this.symbolKey = undefined;
    this.selectedId = undefined;
  }

  /** Stop the tool being drawn and drop its unfinished drawing. True if there
   * was one. */
  cancelDrawing(): boolean {
    const id = this.drawingId;
    this.drawingId = undefined;
    this.activeTool = undefined;
    if (id) this.chart?.removeOverlay({ id });
    this.syncButtons();
    return id !== undefined;
  }

  private selectTool(overlay: string): void {
    if (this.activeTool === overlay) {
      this.cancelDrawing();
      return;
    }
    this.cancelDrawing();
    if (!this.chart) return;
    this.hooks.beforeDraw();
    // A new drawing is meant to be seen, and so are the ones beside it.
    if (this.hidden) this.setHidden(false);
    const id = this.createOverlay(overlay);
    if (!id) return;
    this.drawingId = id;
    this.activeTool = overlay;
    this.syncButtons();
  }

  private createOverlay(name: string, points?: StoredPoint[]): string | undefined {
    const chart = this.chart;
    if (!chart) return undefined;
    const create: OverlayCreate = {
      name,
      groupId: GROUP_ID,
      paneId: PANE_ID,
      mode: this.mode(),
      // A locked overlay ignores the pointer, so one being drawn stays free
      // until its last point is placed.
      lock: points ? this.locked : false,
      visible: !this.hidden,
      onDrawEnd: (event: OverlayEvent<unknown>) => this.onDrawEnd(event),
      onRemoved: (event: OverlayEvent<unknown>) => this.onRemoved(event),
      onSelected: (event: OverlayEvent<unknown>) => {
        this.selectedId = event.overlay.id;
      },
      onDeselected: (event: OverlayEvent<unknown>) => {
        if (this.selectedId === event.overlay.id) this.selectedId = undefined;
      },
    };
    if (points) create.points = points;
    const id = chart.createOverlay(create);
    return typeof id === 'string' ? id : undefined;
  }

  private onDrawEnd({ overlay }: OverlayEvent<unknown>): void {
    if (overlay.id !== this.drawingId) return;
    this.drawingId = undefined;
    this.activeTool = undefined;
    if (this.locked) this.chart?.overrideOverlay({ id: overlay.id, lock: true });
    this.syncButtons();
  }

  private onRemoved({ overlay }: OverlayEvent<unknown>): void {
    if (this.selectedId === overlay.id) this.selectedId = undefined;
    if (overlay.id === this.drawingId) {
      this.drawingId = undefined;
      this.activeTool = undefined;
    }
    // Defer: KLineChart is still inside its removal loop.
    queueMicrotask(() => this.syncButtons());
  }

  private onKeyDown(event: KeyboardEvent): void {
    if (event.key !== 'Delete' && event.key !== 'Backspace') return;
    const target = event.target as HTMLElement | null;
    if (target && (target.closest('input, textarea, select') || target.isContentEditable)) return;
    const id = this.selectedId;
    if (!id || !this.chart || this.drawingId) return;
    event.preventDefault();
    this.chart.removeOverlay({ id });
  }

  private mode(): OverlayMode {
    return this.magnet ? 'weak_magnet' : 'normal';
  }

  private setMagnet(magnet: boolean): void {
    this.magnet = magnet;
    this.chart?.overrideOverlay({ groupId: GROUP_ID, mode: this.mode() });
    this.syncButtons();
  }

  private setLocked(locked: boolean): void {
    this.locked = locked;
    const chart = this.chart;
    if (chart) {
      for (const overlay of chart.getOverlays({ groupId: GROUP_ID })) {
        if (overlay.id !== this.drawingId) chart.overrideOverlay({ id: overlay.id, lock: locked });
      }
    }
    this.syncButtons();
  }

  private setHidden(hidden: boolean): void {
    this.hidden = hidden;
    if (hidden) this.cancelDrawing();
    this.chart?.overrideOverlay({ groupId: GROUP_ID, visible: !hidden });
    this.syncButtons();
  }

  private removeAll(): void {
    this.cancelDrawing();
    this.chart?.removeOverlay({ groupId: GROUP_ID });
    if (this.symbolKey !== undefined) this.stored.delete(this.symbolKey);
    this.syncButtons();
  }

  private setOpen(open: boolean): void {
    this.open = open;
    if (!open) {
      this.cancelDrawing();
      this.setMenuOpen(false);
    }
    this.bar.hidden = !open;
    this.syncButtons();
  }

  private hasDrawings(): boolean {
    const chart = this.chart;
    if (!chart) return false;
    return chart.getOverlays({ groupId: GROUP_ID }).some((overlay) => overlay.id !== this.drawingId);
  }

  private syncButtons(): void {
    if (this.toggle) {
      this.toggle.classList.toggle('active', this.open);
      this.toggle.setAttribute('aria-pressed', String(this.open));
      this.toggle.setAttribute('aria-expanded', String(this.open));
    }
    for (const [overlay, button] of this.toolButtons) {
      pressed(button, this.activeTool === overlay);
      button.disabled = !this.enabled;
    }
    pressed(this.cursorButton, this.activeTool === undefined);
    pressed(this.magnetButton, this.magnet);
    pressed(this.lockButton, this.locked);
    pressed(this.hideButton, this.hidden);
    this.lockButton.title = this.locked ? 'Unlock all drawings' : 'Lock all drawings';
    this.hideButton.title = this.hidden ? 'Show all drawings' : 'Hide all drawings';
    this.lockButton.setAttribute('aria-label', this.lockButton.title);
    this.hideButton.setAttribute('aria-label', this.hideButton.title);
    this.removeButton.disabled = !this.hasDrawings();
    this.syncMore();
  }

  /** Move the buttons that do not fit, from the bottom up, into the menu. */
  private layout(): void {
    this.setMenuOpen(false);
    for (const item of this.items) item.classList.remove(OVERFLOW_CLASS);
    const overflowing = (): boolean => this.bar.scrollHeight > this.bar.clientHeight;
    this.moreButton.hidden = this.bar.hidden || !overflowing();
    if (!this.moreButton.hidden) {
      for (let i = this.items.length - 1; i >= 0 && overflowing(); i--) {
        this.items[i].classList.add(OVERFLOW_CLASS);
      }
      // The visible part ends on a button, not on a group's separator
      const visible = this.items.filter((item) => !item.classList.contains(OVERFLOW_CLASS));
      const last = visible[visible.length - 1];
      if (last && !(last instanceof HTMLButtonElement)) last.classList.add(OVERFLOW_CLASS);
    }
    this.syncMore();
  }

  /** The "more" button shows a tool in use behind it; an open menu follows
   * the buttons it stands for. */
  private syncMore(): void {
    const hiddenActive = [...this.toolButtons.values()].some((button) =>
      button.classList.contains(OVERFLOW_CLASS) && button.classList.contains('active'));
    this.moreButton.classList.toggle('active', hiddenActive);
    if (!this.menu.hidden) this.renderMenu();
  }

  private setMenuOpen(open: boolean): void {
    if (open === !this.menu.hidden) return;
    this.menu.hidden = !open;
    this.moreButton.setAttribute('aria-expanded', String(open));
    if (!open) return;
    this.renderMenu();
    const bar = this.bar.getBoundingClientRect();
    const anchor = this.moreButton.getBoundingClientRect();
    this.menu.style.left = `${bar.right + 4}px`;
    const top = Math.min(anchor.top, window.innerHeight - this.menu.offsetHeight - 4);
    this.menu.style.top = `${Math.max(4, top)}px`;
  }

  private renderMenu(): void {
    this.menu.replaceChildren();
    let separate = false;
    for (const item of this.items) {
      if (!item.classList.contains(OVERFLOW_CLASS)) continue;
      if (!(item instanceof HTMLButtonElement)) {
        separate = this.menu.childElementCount > 0;
        continue;
      }
      if (separate) {
        const sep = document.createElement('div');
        sep.className = 'dt-menu-sep';
        sep.setAttribute('role', 'separator');
        this.menu.appendChild(sep);
        separate = false;
      }
      const entry = document.createElement('button');
      entry.type = 'button';
      entry.innerHTML = item.innerHTML;
      const label = document.createElement('span');
      label.textContent = item.getAttribute('aria-label') ?? item.title;
      entry.appendChild(label);
      entry.disabled = item.disabled;
      entry.setAttribute('aria-pressed', item.getAttribute('aria-pressed') ?? 'false');
      entry.addEventListener('click', () => {
        this.setMenuOpen(false);
        item.click();
      });
      this.menu.appendChild(entry);
    }
  }

  private button(label: string, icon: string, onClick: () => void): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.title = label;
    button.setAttribute('aria-label', label);
    button.innerHTML = svg(icon);
    button.addEventListener('click', onClick);
    this.bar.appendChild(button);
    return button;
  }

  private separator(): void {
    const sep = document.createElement('div');
    sep.className = 'dt-sep';
    sep.setAttribute('role', 'separator');
    this.bar.appendChild(sep);
  }
}

function pressed(button: HTMLButtonElement, on: boolean): void {
  button.classList.toggle('active', on);
  button.setAttribute('aria-pressed', String(on));
}
