export interface EquitySample {
  timestamp: number;
  equity?: number | null;
}

export interface EquityPoint {
  timestamp: number;
  equity: number;
  pnl: number;
}

export interface EquitySummary {
  points: EquityPoint[];
  initialEquity: number;
  finalEquity: number;
  pnl: number;
  returnPct: number | null;
  maxRunup: number;
  maxRunupPct: number | null;
  maxDrawdown: number;
  maxDrawdownPct: number | null;
  minPnl: number;
  maxPnl: number;
}

export interface EquityTheme {
  foreground: string;
  muted: string;
  grid: string;
  positive: string;
  negative: string;
  crosshairBackground: string;
}

const PAD = { left: 10, right: 64, top: 12, bottom: 22 };

interface EquityLayout {
  width: number;
  height: number;
  ratio: number;
  plotWidth: number;
  plotHeight: number;
  xFor: (timestamp: number) => number;
  yFor: (value: number) => number;
}

/** Search the full-resolution series, including points omitted from the trace. */
export function equityPointAtX(
  points: readonly EquityPoint[],
  x: number,
  plotWidth: number
): EquityPoint | undefined {
  if (!points.length) return undefined;
  const first = points[0].timestamp;
  const last = points[points.length - 1].timestamp;
  const timestamp = first + Math.min(1, Math.max(0, (x - PAD.left) / plotWidth)) * (last - first);
  let low = 0;
  let high = points.length - 1;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (points[mid].timestamp < timestamp) low = mid + 1;
    else high = mid;
  }
  const before = points[Math.max(0, low - 1)];
  const after = points[low];
  return timestamp - before.timestamp <= after.timestamp - timestamp ? before : after;
}

/** Keep pointer repaints separate from the potentially large equity trace. */
export class EquityCrosshair {
  private pointer: { x: number; y: number } | undefined;
  private view: {
    canvas: HTMLCanvasElement;
    overlay: HTMLCanvasElement;
    summary: EquitySummary;
    theme: EquityTheme;
    layout: EquityLayout;
  } | undefined;

  constructor(
    container: HTMLElement,
    private readonly formatTime: (point: EquityPoint) => string,
    onSelect: (timestamp: number) => void
  ) {
    container.addEventListener('pointermove', (event) => {
      if (event.target !== this.view?.canvas) {
        this.clear();
        return;
      }
      this.pointer = { x: event.clientX, y: event.clientY };
      this.draw();
    });
    container.addEventListener('pointerleave', () => this.clear());
    container.addEventListener('click', (event) => {
      if (event.target !== this.view?.canvas) return;
      this.pointer = { x: event.clientX, y: event.clientY };
      const point = this.point();
      if (point) onSelect(point.timestamp);
    });
  }

  update(
    canvas: HTMLCanvasElement,
    overlay: HTMLCanvasElement,
    summary: EquitySummary,
    theme: EquityTheme,
    layout: EquityLayout
  ): void {
    this.view = { canvas, overlay, summary, theme, layout };
    overlay.width = canvas.width;
    overlay.height = canvas.height;
    this.draw();
  }

  clear(): void {
    this.pointer = undefined;
    this.draw();
  }

  reset(): void {
    this.clear();
    this.view = undefined;
  }

  private point(): EquityPoint | undefined {
    if (!this.view || !this.pointer) return undefined;
    const bounds = this.view.canvas.getBoundingClientRect();
    const x = this.pointer.x - bounds.left;
    const y = this.pointer.y - bounds.top;
    const { plotWidth, plotHeight } = this.view.layout;
    if (x < PAD.left || x > PAD.left + plotWidth || y < PAD.top || y > PAD.top + plotHeight) {
      return undefined;
    }
    return equityPointAtX(this.view.summary.points, x, plotWidth);
  }

  private draw(): void {
    if (!this.view) return;
    const { overlay, theme, layout } = this.view;
    const ctx = overlay.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(layout.ratio, 0, 0, layout.ratio, 0, 0);
    ctx.clearRect(0, 0, layout.width, layout.height);
    const point = this.point();
    if (!point) return;

    const x = layout.xFor(point.timestamp);
    const y = layout.yFor(point.pnl);
    ctx.beginPath();
    ctx.moveTo(x, PAD.top);
    ctx.lineTo(x, PAD.top + layout.plotHeight);
    ctx.moveTo(PAD.left, y);
    ctx.lineTo(PAD.left + layout.plotWidth, y);
    ctx.setLineDash([4, 3]);
    ctx.strokeStyle = theme.muted;
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.arc(x, y, 3, 0, Math.PI * 2);
    ctx.fillStyle = point.pnl >= 0 ? theme.positive : theme.negative;
    ctx.fill();

    ctx.font = '11px sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    const label = (text: string, left: number, top: number): void => {
      const width = Math.min(layout.width, ctx.measureText(text).width + 10);
      left = Math.max(0, Math.min(layout.width - width, left));
      top = Math.max(0, Math.min(layout.height - 18, top));
      ctx.fillStyle = theme.crosshairBackground;
      ctx.fillRect(left, top, width, 18);
      ctx.fillStyle = '#fff';
      ctx.fillText(text, left + 5, top + 9, Math.max(1, width - 10));
    };
    const time = this.formatTime(point);
    label(time, x - (ctx.measureText(time).width + 10) / 2, PAD.top + layout.plotHeight + 2);
    const value = `${point.pnl > 0 ? '+' : point.pnl < 0 ? '−' : ''}${Math.abs(point.pnl).toLocaleString(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`;
    label(value, PAD.left + layout.plotWidth + 2, y - 9);
  }
}

export function calculateEquitySummary(
  samples: readonly EquitySample[],
  baseline?: number
): EquitySummary | undefined {
  const finite = samples.filter(
    (sample): sample is EquitySample & { equity: number } =>
      typeof sample.equity === 'number' && Number.isFinite(sample.equity)
  );
  if (finite.length === 0) return undefined;

  const initialEquity =
    typeof baseline === 'number' && Number.isFinite(baseline) ? baseline : finite[0].equity;
  let peak = initialEquity;
  let trough = initialEquity;
  let maxRunup = 0;
  let maxRunupPct: number | null = null;
  let maxDrawdown = 0;
  let maxDrawdownPct: number | null = null;
  let minPnl = 0;
  let maxPnl = 0;

  const points = finite.map((sample) => {
    const pnl = sample.equity - initialEquity;
    minPnl = Math.min(minPnl, pnl);
    maxPnl = Math.max(maxPnl, pnl);

    peak = Math.max(peak, sample.equity);
    const drawdown = peak - sample.equity;
    if (drawdown > maxDrawdown) {
      maxDrawdown = drawdown;
      maxDrawdownPct = peak === 0 ? null : (drawdown / Math.abs(peak)) * 100;
    }

    trough = Math.min(trough, sample.equity);
    const runup = sample.equity - trough;
    if (runup > maxRunup) {
      maxRunup = runup;
      maxRunupPct = trough === 0 ? null : (runup / Math.abs(trough)) * 100;
    }
    return { timestamp: sample.timestamp, equity: sample.equity, pnl };
  });

  const finalEquity = points[points.length - 1].equity;
  const pnl = finalEquity - initialEquity;
  return {
    points,
    initialEquity,
    finalEquity,
    pnl,
    returnPct: initialEquity === 0 ? null : (pnl / Math.abs(initialEquity)) * 100,
    maxRunup,
    maxRunupPct,
    maxDrawdown,
    maxDrawdownPct,
    minPnl,
    maxPnl,
  };
}

function formatAxis(value: number): string {
  const abs = Math.abs(value);
  const sign = value > 0 ? '+' : value < 0 ? '−' : '';
  if (abs >= 1_000_000_000) return `${sign}${(abs / 1_000_000_000).toFixed(1)}B`;
  if (abs >= 1_000_000) return `${sign}${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${sign}${(abs / 1_000).toFixed(1)}K`;
  if (abs >= 10) return `${sign}${abs.toFixed(0)}`;
  return `${sign}${abs.toFixed(2)}`;
}

function dateLabel(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

/**
 * Retain local extrema while capping canvas work to roughly two points per
 * horizontal pixel. A plain stride would hide the spikes that matter most in
 * an equity curve.
 */
function displayPoints(points: readonly EquityPoint[], width: number): EquityPoint[] {
  const buckets = Math.max(1, Math.floor(width));
  if (points.length <= buckets * 2) return [...points];

  const out: EquityPoint[] = [points[0]];
  for (let bucket = 0; bucket < buckets; bucket++) {
    const from = Math.max(1, Math.floor((bucket * points.length) / buckets));
    const to = Math.min(points.length - 1, Math.floor(((bucket + 1) * points.length) / buckets));
    if (to <= from) continue;

    let minIndex = from;
    let maxIndex = from;
    for (let i = from + 1; i < to; i++) {
      if (points[i].pnl < points[minIndex].pnl) minIndex = i;
      if (points[i].pnl > points[maxIndex].pnl) maxIndex = i;
    }
    if (minIndex < maxIndex) {
      out.push(points[minIndex], points[maxIndex]);
    } else if (maxIndex < minIndex) {
      out.push(points[maxIndex], points[minIndex]);
    } else {
      out.push(points[minIndex]);
    }
  }
  const last = points[points.length - 1];
  if (out[out.length - 1] !== last) out.push(last);
  return out;
}

export function drawEquityCurve(
  canvas: HTMLCanvasElement,
  summary: EquitySummary,
  theme: EquityTheme
): EquityLayout | undefined {
  const bounds = canvas.getBoundingClientRect();
  const width = Math.max(1, Math.floor(bounds.width));
  const height = Math.max(1, Math.floor(bounds.height));
  const ratio = Math.max(1, window.devicePixelRatio || 1);
  canvas.width = Math.floor(width * ratio);
  canvas.height = Math.floor(height * ratio);

  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.scale(ratio, ratio);
  ctx.clearRect(0, 0, width, height);

  const plotWidth = Math.max(1, width - PAD.left - PAD.right);
  const plotHeight = Math.max(1, height - PAD.top - PAD.bottom);
  const rawRange = summary.maxPnl - summary.minPnl;
  const padding = rawRange > 0 ? rawRange * 0.08 : Math.max(1, Math.abs(summary.pnl) * 0.08);
  const minY = Math.min(0, summary.minPnl) - padding;
  const maxY = Math.max(0, summary.maxPnl) + padding;
  const yRange = Math.max(Number.EPSILON, maxY - minY);
  const xFor = (timestamp: number): number => {
    const first = summary.points[0].timestamp;
    const last = summary.points[summary.points.length - 1].timestamp;
    const fraction = last === first ? 0 : (timestamp - first) / (last - first);
    return PAD.left + Math.min(1, Math.max(0, fraction)) * plotWidth;
  };
  const yFor = (value: number): number => PAD.top + ((maxY - value) / yRange) * plotHeight;

  ctx.font = '10px sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  for (let i = 0; i <= 4; i++) {
    const value = maxY - (yRange * i) / 4;
    const y = yFor(value);
    ctx.beginPath();
    ctx.moveTo(PAD.left, y);
    ctx.lineTo(PAD.left + plotWidth, y);
    ctx.strokeStyle = theme.grid;
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = theme.muted;
    ctx.fillText(formatAxis(value), PAD.left + plotWidth + 7, y);
  }

  const points = displayPoints(summary.points, plotWidth);
  const zeroY = yFor(0);
  const trace = (): void => {
    ctx.beginPath();
    for (let i = 0; i < points.length; i++) {
      const x = xFor(points[i].timestamp);
      const y = yFor(points[i].pnl);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
  };
  const area = (): void => {
    trace();
    ctx.lineTo(xFor(points[points.length - 1].timestamp), zeroY);
    ctx.lineTo(xFor(points[0].timestamp), zeroY);
    ctx.closePath();
  };

  const paintHalf = (positive: boolean): void => {
    ctx.save();
    ctx.beginPath();
    ctx.rect(
      PAD.left,
      positive ? PAD.top : zeroY,
      plotWidth,
      positive ? Math.max(0, zeroY - PAD.top) : Math.max(0, PAD.top + plotHeight - zeroY)
    );
    ctx.clip();
    const color = positive ? theme.positive : theme.negative;
    area();
    ctx.globalAlpha = 0.16;
    ctx.fillStyle = color;
    ctx.fill();
    ctx.globalAlpha = 1;
    trace();
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.stroke();
    ctx.restore();
  };
  paintHalf(true);
  paintHalf(false);

  ctx.beginPath();
  ctx.moveTo(PAD.left, zeroY);
  ctx.lineTo(PAD.left + plotWidth, zeroY);
  ctx.setLineDash([4, 3]);
  ctx.strokeStyle = theme.muted;
  ctx.globalAlpha = 0.75;
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;

  const last = summary.points[summary.points.length - 1];
  ctx.beginPath();
  ctx.arc(xFor(last.timestamp), yFor(last.pnl), 3, 0, Math.PI * 2);
  ctx.fillStyle = last.pnl >= 0 ? theme.positive : theme.negative;
  ctx.fill();

  ctx.fillStyle = theme.muted;
  ctx.textBaseline = 'bottom';
  ctx.textAlign = 'left';
  ctx.fillText(dateLabel(summary.points[0].timestamp), PAD.left, height - 2);
  ctx.textAlign = 'right';
  ctx.fillText(dateLabel(last.timestamp), PAD.left + plotWidth, height - 2);
  return { width, height, ratio, plotWidth, plotHeight, xFor, yFor };
}
