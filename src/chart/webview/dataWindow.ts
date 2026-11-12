/**
 * Data Window: a side panel listing every value of one bar, the way
 * TradingView's Data Window does — OHLCV plus each plot whose `display`
 * holds `data_window`, including plots the chart never draws. It follows the
 * crosshair, keeps the last hovered bar when the pointer leaves the chart (so
 * a value can be reached and copied), and otherwise shows the bar the
 * debugger is paused on, or the newest bar.
 *
 * This module only renders; the chart builds the model from its run state.
 */

/** Which bar the panel is showing, and why. */
export type DataWindowMode = 'cursor' | 'held' | 'paused' | 'latest';

export interface DataWindowRow {
  label: string;
  /** Display text (rounded to the plot's precision). */
  text: string;
  /** Full-precision text placed on the clipboard; absent: not copyable. */
  copy?: string;
  /** Swatch color; null = an na color (hollow swatch), absent = no swatch. */
  color?: string | null;
  /** The value is na. */
  na?: boolean;
  tone?: 'pos' | 'neg';
}

export interface DataWindowSection {
  title: string;
  rows: DataWindowRow[];
}

export interface DataWindowModel {
  barIndex: number;
  time: string;
  mode: DataWindowMode;
  sections: DataWindowSection[];
}

const MODE_LABEL: Record<DataWindowMode, string> = {
  cursor: 'Cursor',
  held: 'Held',
  paused: 'Paused',
  latest: 'Last bar',
};

const MODE_TITLE: Record<DataWindowMode, string> = {
  cursor: 'Following the crosshair',
  held: 'Holding the last hovered bar — click to return to the latest bar',
  paused: 'The bar the debugger is paused on',
  latest: 'The newest bar; hover the chart to inspect another one',
};

/**
 * Format a plot value the way Pine's `format`/`precision` would show it.
 * `precision` is the plot's own, or the script/symbol default.
 */
export function formatPlotValue(
  value: number,
  precision: number,
  format: string | undefined
): string {
  if (!Number.isFinite(value)) return String(value);
  if (format === 'volume') return formatVolume(value, precision);
  const text = value.toLocaleString('en-US', {
    minimumFractionDigits: precision,
    maximumFractionDigits: precision,
  });
  return format === 'percent' ? `${text}%` : text;
}

function formatVolume(value: number, precision: number): string {
  const abs = Math.abs(value);
  const units: Array<[number, string]> = [[1e12, 'T'], [1e9, 'B'], [1e6, 'M'], [1e3, 'K']];
  for (const [size, suffix] of units) {
    if (abs >= size) return `${trimZeros((value / size).toFixed(Math.max(precision, 2)))}${suffix}`;
  }
  return trimZeros(value.toFixed(precision));
}

function trimZeros(text: string): string {
  return text.includes('.') ? text.replace(/\.?0+$/, '') : text;
}

/**
 * Bar time in the symbol's timezone as `YYYY-MM-DD HH:mm` (seconds only when
 * the bar has them). An unknown zone falls back to UTC.
 */
export function createBarTimeFormatter(timeZone: string | undefined): (timestamp: number) => string {
  const options: Intl.DateTimeFormatOptions = {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  };
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat('en-US', { ...options, timeZone: timeZone || 'UTC' });
  } catch {
    formatter = new Intl.DateTimeFormat('en-US', { ...options, timeZone: 'UTC' });
  }
  return (timestamp) => {
    const parts = formatter.formatToParts(timestamp);
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
    const seconds = get('second');
    return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}` +
      (seconds && seconds !== '00' ? `:${seconds}` : '');
  };
}

export function formatBarTime(timestamp: number, timeZone: string | undefined): string {
  return createBarTimeFormatter(timeZone)(timestamp);
}

/** Render target for the panel; owns only the DOM below `root`. */
export class DataWindowView {
  private readonly heading: HTMLElement;
  private readonly time: HTMLElement;
  private readonly mode: HTMLButtonElement;
  private readonly body: HTMLElement;
  private layout = '';
  private valueEls: HTMLElement[] = [];
  private swatchEls: Array<HTMLElement | undefined> = [];
  private rowEls: HTMLButtonElement[] = [];
  private rows: DataWindowRow[] = [];

  constructor(
    root: HTMLElement,
    private readonly handlers: { release(): void; copy(text: string): Promise<boolean> }
  ) {
    root.innerHTML = '';
    const header = document.createElement('div');
    header.className = 'dw-header';
    const where = document.createElement('div');
    where.className = 'dw-where';
    this.heading = document.createElement('span');
    this.heading.className = 'dw-bar';
    this.time = document.createElement('span');
    this.time.className = 'dw-time';
    where.append(this.heading, this.time);
    this.mode = document.createElement('button');
    this.mode.type = 'button';
    this.mode.className = 'dw-mode';
    this.mode.addEventListener('click', () => {
      if (this.mode.dataset.mode === 'held') this.handlers.release();
    });
    header.append(where, this.mode);
    this.body = document.createElement('div');
    this.body.className = 'dw-body';
    root.append(header, this.body);
  }

  render(model: DataWindowModel | undefined): void {
    if (!model) {
      this.heading.textContent = 'No data';
      this.time.textContent = '';
      this.mode.hidden = true;
      this.layout = '';
      this.body.innerHTML = '';
      return;
    }
    this.heading.textContent = `Bar ${model.barIndex}`;
    this.time.textContent = model.time;
    this.mode.hidden = false;
    this.mode.dataset.mode = model.mode;
    this.mode.textContent = model.mode === 'held' ? `${MODE_LABEL.held} ×` : MODE_LABEL[model.mode];
    this.mode.title = MODE_TITLE[model.mode];
    this.mode.disabled = model.mode !== 'held';

    // Hovering only changes values: keep the rows and patch their text, so
    // the panel neither flickers nor loses keyboard focus.
    const layout = model.sections
      .map((s) => `${s.title}\u0001${s.rows.map((r) => `${r.label}\u0002${r.color === undefined}`).join('\u0001')}`)
      .join('\u0000');
    if (layout !== this.layout) this.build(model, layout);
    this.rows = model.sections.flatMap((s) => s.rows);
    this.rows.forEach((row, n) => this.patch(n, row));
  }

  private build(model: DataWindowModel, layout: string): void {
    this.layout = layout;
    this.body.innerHTML = '';
    this.valueEls = [];
    this.swatchEls = [];
    this.rowEls = [];
    for (const section of model.sections) {
      const title = document.createElement('div');
      title.className = 'dw-section';
      title.textContent = section.title;
      title.title = section.title;
      this.body.appendChild(title);
      for (const row of section.rows) {
        const n = this.rowEls.length;
        const el = document.createElement('button');
        el.type = 'button';
        el.className = 'dw-row';
        let swatch: HTMLElement | undefined;
        if (row.color !== undefined) {
          swatch = document.createElement('span');
          swatch.className = 'dw-swatch';
          el.appendChild(swatch);
        } else {
          el.classList.add('dw-plain');
        }
        const label = document.createElement('span');
        label.className = 'dw-label';
        label.textContent = row.label;
        const value = document.createElement('span');
        value.className = 'dw-value';
        el.append(label, value);
        el.addEventListener('click', () => void this.copyRow(n));
        this.body.appendChild(el);
        this.rowEls.push(el);
        this.valueEls.push(value);
        this.swatchEls.push(swatch);
      }
    }
  }

  private patch(n: number, row: DataWindowRow): void {
    const el = this.rowEls[n];
    const value = this.valueEls[n];
    value.textContent = row.text;
    value.classList.toggle('dw-na', row.na === true);
    value.classList.toggle('pos', row.tone === 'pos');
    value.classList.toggle('neg', row.tone === 'neg');
    const swatch = this.swatchEls[n];
    if (swatch) {
      swatch.classList.toggle('dw-hollow', row.color === null);
      swatch.style.background = row.color ?? 'transparent';
    }
    el.disabled = row.copy === undefined;
    el.title = row.copy === undefined ? row.label : `${row.label}: ${row.copy}\nClick to copy`;
  }

  private async copyRow(n: number): Promise<void> {
    const text = this.rows[n]?.copy;
    const el = this.rowEls[n];
    if (text === undefined || !el) return;
    if (!(await this.handlers.copy(text))) return;
    el.classList.add('dw-copied');
    setTimeout(() => el.classList.remove('dw-copied'), 900);
  }
}
