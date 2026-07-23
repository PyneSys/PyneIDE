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
}

const PAD = { left: 10, right: 64, top: 12, bottom: 22 };

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
): void {
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
}
