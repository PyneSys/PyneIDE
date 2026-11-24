/**
 * The floating bar over the chart that styles the selected drawing: its color,
 * line width and dash, a Fibonacci retracement's levels, and its removal. Each
 * control opens a small popup under itself; a pick is handed to the hooks at
 * once, so the drawing follows the controls as they change.
 */
import {
  clampDrawingWidth,
  DEFAULT_FIB_LEVELS,
  type DrawingDash,
  type DrawingStyle,
  DRAWING_DASHES,
  type FibLevel,
  MAX_DRAWING_WIDTH,
  MIN_DRAWING_WIDTH,
} from '../drawingRecord';

export interface DrawingStyleTarget {
  style: DrawingStyle;
  /** A Fibonacci retracement's levels; their colors stand for the color. */
  levels?: FibLevel[];
}

export interface DrawingStyleHooks {
  onStyle(style: DrawingStyle): void;
  onLevels(levels: FibLevel[]): void;
  onRemove(): void;
}

const PALETTE = [
  '#F23645', '#FF9800', '#FFEB3B', '#4CAF50', '#089981', '#00BCD4', '#2962FF', '#9C27B0',
  '#E91E63', '#673AB7', '#FFFFFF', '#B2B5BE', '#787B86', '#5D606B', '#434651', '#000000',
];

const DASH_LABELS: Record<DrawingDash, string> = { solid: 'Solid', dashed: 'Dashed', dotted: 'Dotted' };

const LEVELS_ICON = '<path d="M2.5 4h15M2.5 8h15M2.5 12h15M2.5 16h15"/>';
const REMOVE_ICON = '<path d="M4 5.5h12M8 5.5v-2h4v2M5.5 5.5l.8 11h7.4l.8-11M8.5 8.5v5M11.5 8.5v5"/>';

type PopupKind = 'color' | 'width' | 'dash' | 'levels';

/** SVG stroke-dasharray of a dash at a width, as the chart draws it. */
export function dashArray(dash: DrawingDash, width: number): number[] {
  if (dash === 'dotted') return [width, width * 2];
  if (dash === 'dashed') return [width * 4, width * 3];
  return [];
}

function lineIcon(width: number, dash: DrawingDash): string {
  const array = dashArray(dash, width);
  const attr = array.length ? ` stroke-dasharray="${array.join(' ')}"` : '';
  return `<svg viewBox="0 0 28 20" aria-hidden="true"><path d="M3 10h22" stroke-width="${width}"${attr}/></svg>`;
}

export class DrawingStyleBar {
  private target: DrawingStyleTarget | undefined;
  private readonly bar: HTMLElement;
  private readonly colorButton: HTMLButtonElement;
  private readonly colorSwatch: HTMLElement;
  private readonly widthButton: HTMLButtonElement;
  private readonly dashButton: HTMLButtonElement;
  private readonly levelsButton: HTMLButtonElement;
  private readonly popup: HTMLElement;
  private popupKind: PopupKind | undefined;

  constructor(host: HTMLElement, private readonly hooks: DrawingStyleHooks) {
    this.bar = document.createElement('div');
    this.bar.id = 'drawing-style-bar';
    this.bar.setAttribute('role', 'toolbar');
    this.bar.setAttribute('aria-label', 'Drawing style');
    this.bar.hidden = true;
    this.colorButton = this.button('Color', () => this.togglePopup('color', this.colorButton));
    this.colorSwatch = document.createElement('span');
    this.colorSwatch.className = 'ds-swatch';
    this.colorButton.appendChild(this.colorSwatch);
    this.widthButton = this.button('Line width', () => this.togglePopup('width', this.widthButton));
    this.dashButton = this.button('Line style', () => this.togglePopup('dash', this.dashButton));
    this.levelsButton = this.button('Fibonacci levels', () => this.togglePopup('levels', this.levelsButton));
    this.levelsButton.innerHTML = `<svg viewBox="0 0 20 20" aria-hidden="true">${LEVELS_ICON}</svg>`;
    const remove = this.button('Remove drawing', () => this.hooks.onRemove());
    remove.innerHTML = `<svg viewBox="0 0 20 20" aria-hidden="true">${REMOVE_ICON}</svg>`;
    host.appendChild(this.bar);

    this.popup = document.createElement('div');
    this.popup.id = 'drawing-style-popup';
    this.popup.hidden = true;
    document.body.appendChild(this.popup);

    // Capture: the popup takes Escape before the chart's own handlers see it
    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape' || this.popup.hidden) return;
      event.preventDefault();
      event.stopPropagation();
      this.closePopup();
    }, true);
    document.addEventListener('pointerdown', (event) => {
      const target = event.target as Node;
      if (this.popup.hidden || this.popup.contains(target) || this.bar.contains(target)) return;
      this.closePopup();
    });
    window.addEventListener('resize', () => this.closePopup());
  }

  /** Style `target`, or hide the bar without one. */
  show(target: DrawingStyleTarget | undefined): void {
    this.target = target;
    this.bar.hidden = !target;
    if (!target) {
      this.closePopup();
      return;
    }
    this.sync();
    if (this.popupKind) this.renderPopup(this.popupKind);
  }

  private sync(): void {
    const target = this.target;
    if (!target) return;
    const fib = target.levels !== undefined;
    this.colorButton.hidden = fib;
    this.levelsButton.hidden = !fib;
    this.colorSwatch.style.background = target.style.color;
    this.widthButton.innerHTML = lineIcon(target.style.width, 'solid');
    this.dashButton.innerHTML = lineIcon(Math.min(target.style.width, 2), target.style.dash);
  }

  private setStyle(change: Partial<DrawingStyle>): void {
    if (!this.target) return;
    this.target.style = { ...this.target.style, ...change };
    this.sync();
    this.hooks.onStyle(this.target.style);
  }

  private setLevels(levels: FibLevel[]): void {
    if (!this.target) return;
    this.target.levels = levels;
    this.hooks.onLevels(levels);
  }

  private togglePopup(kind: PopupKind, anchor: HTMLElement): void {
    if (this.popupKind === kind) {
      this.closePopup();
      return;
    }
    this.popupKind = kind;
    this.renderPopup(kind);
    this.popup.hidden = false;
    for (const button of [this.colorButton, this.widthButton, this.dashButton, this.levelsButton]) {
      button.classList.toggle('active', button === anchor);
    }
    const rect = anchor.getBoundingClientRect();
    const left = Math.min(rect.left, window.innerWidth - this.popup.offsetWidth - 4);
    this.popup.style.left = `${Math.max(4, left)}px`;
    this.popup.style.top = `${rect.bottom + 4}px`;
  }

  private closePopup(): void {
    this.popupKind = undefined;
    this.popup.hidden = true;
    for (const button of [this.colorButton, this.widthButton, this.dashButton, this.levelsButton]) {
      button.classList.remove('active');
    }
  }

  private renderPopup(kind: PopupKind): void {
    const target = this.target;
    if (!target) return;
    this.popup.replaceChildren();
    this.popup.dataset.kind = kind;
    if (kind === 'color') this.renderColors(target.style.color);
    else if (kind === 'width') this.renderWidths(target.style);
    else if (kind === 'dash') this.renderDashes(target.style);
    else this.renderLevels(target.levels ?? []);
  }

  private renderColors(current: string): void {
    const grid = document.createElement('div');
    grid.className = 'ds-palette';
    for (const color of PALETTE) {
      const swatch = document.createElement('button');
      swatch.type = 'button';
      swatch.className = 'ds-color';
      swatch.title = color;
      swatch.setAttribute('aria-label', color);
      swatch.setAttribute('aria-pressed', String(color.toUpperCase() === current.toUpperCase()));
      swatch.style.background = color;
      swatch.addEventListener('click', () => {
        this.setStyle({ color });
        this.renderPopup('color');
      });
      grid.appendChild(swatch);
    }
    const custom = document.createElement('label');
    custom.className = 'ds-custom';
    const input = document.createElement('input');
    input.type = 'color';
    input.value = current.toLowerCase();
    input.addEventListener('input', () => this.setStyle({ color: input.value.toUpperCase() }));
    custom.append(input, 'Custom color');
    this.popup.append(grid, custom);
  }

  private renderWidths(style: DrawingStyle): void {
    for (let width = MIN_DRAWING_WIDTH; width <= MAX_DRAWING_WIDTH; width++) {
      this.popup.appendChild(this.option(lineIcon(width, 'solid'), `${width}px`, style.width === width, () => {
        this.setStyle({ width: clampDrawingWidth(width) });
        this.closePopup();
      }));
    }
  }

  private renderDashes(style: DrawingStyle): void {
    for (const dash of DRAWING_DASHES) {
      this.popup.appendChild(this.option(lineIcon(2, dash), DASH_LABELS[dash], style.dash === dash, () => {
        this.setStyle({ dash });
        this.closePopup();
      }));
    }
  }

  private renderLevels(levels: FibLevel[]): void {
    const list = document.createElement('div');
    list.className = 'ds-levels';
    levels.forEach((level, index) => {
      const row = document.createElement('div');
      row.className = 'ds-level';
      const visible = document.createElement('input');
      visible.type = 'checkbox';
      visible.checked = level.visible;
      visible.title = 'Show this level';
      visible.addEventListener('change', () => this.updateLevel(index, { visible: visible.checked }));
      const value = document.createElement('input');
      value.type = 'number';
      value.step = '0.001';
      value.value = String(level.value);
      value.setAttribute('aria-label', 'Level');
      value.addEventListener('change', () => {
        const parsed = Number(value.value);
        if (value.value.trim() === '' || !Number.isFinite(parsed)) {
          value.value = String(level.value);
          return;
        }
        this.updateLevel(index, { value: parsed });
      });
      const color = document.createElement('input');
      color.type = 'color';
      color.value = level.color.toLowerCase();
      color.title = 'Level color';
      color.addEventListener('input', () => this.updateLevel(index, { color: color.value.toUpperCase() }, false));
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'ds-level-remove';
      remove.title = 'Remove this level';
      remove.setAttribute('aria-label', 'Remove this level');
      remove.textContent = '×';
      remove.addEventListener('click', () => {
        this.setLevels(levels.filter((_, i) => i !== index));
        this.renderPopup('levels');
      });
      row.append(visible, value, color, remove);
      list.appendChild(row);
    });
    const actions = document.createElement('div');
    actions.className = 'ds-level-actions';
    const add = document.createElement('button');
    add.type = 'button';
    add.textContent = 'Add level';
    add.addEventListener('click', () => {
      const top = levels.reduce((max, level) => Math.max(max, level.value), 0);
      this.setLevels([...levels, { value: Math.round((top + 0.5) * 1000) / 1000, color: '#2962FF', visible: true }]);
      this.renderPopup('levels');
    });
    const reset = document.createElement('button');
    reset.type = 'button';
    reset.textContent = 'Reset';
    reset.addEventListener('click', () => {
      this.setLevels(DEFAULT_FIB_LEVELS.map((level) => ({ ...level })));
      this.renderPopup('levels');
    });
    actions.append(add, reset);
    this.popup.append(list, actions);
  }

  /** Change one level; a color picked by dragging keeps the popup as it is. */
  private updateLevel(index: number, change: Partial<FibLevel>, rerender = true): void {
    const levels = (this.target?.levels ?? []).map((level, i) => (i === index ? { ...level, ...change } : level));
    this.setLevels(levels);
    if (rerender) this.renderPopup('levels');
  }

  private option(icon: string, label: string, selected: boolean, onClick: () => void): HTMLButtonElement {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'ds-option';
    item.setAttribute('aria-pressed', String(selected));
    item.innerHTML = icon;
    const text = document.createElement('span');
    text.textContent = label;
    item.appendChild(text);
    item.addEventListener('click', onClick);
    return item;
  }

  private button(label: string, onClick: () => void): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.title = label;
    button.setAttribute('aria-label', label);
    button.addEventListener('click', onClick);
    this.bar.appendChild(button);
    return button;
  }
}
