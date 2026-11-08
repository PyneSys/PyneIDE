/**
 * The Robustness tab of the chart's bottom panel: the robustness tests PyneCore
 * ran on the strategy's closed trades after the last bar.
 *
 * The tab shows the headline numbers, one histogram per coin-flip test (the
 * random totals, the real total and the random p95), the Monte Carlo fans of
 * the trade sequence, and the summary, cost and period tables. The report is
 * the bridge's `robustness` payload; this module only renders it.
 */
import type {
  CoinFlipRecord,
  MonteCarloRecord,
  RobustnessReport,
  RobustnessRow,
  SampleSummary,
} from '../../run/bridgeClient';

export interface RobustnessTheme {
  foreground: string;
  muted: string;
  grid: string;
  positive: string;
  negative: string;
  accent: string;
}

const PAD = { left: 8, right: 58, top: 30, bottom: 20 };

const UNIT_LABELS: Record<string, string> = { r: 'R', currency: '', percent: '%' };

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function num(v: number | string | boolean | null | undefined, decimals?: number): string {
  if (typeof v === 'string') return esc(v);
  if (typeof v !== 'number' || !Number.isFinite(v)) return '—';
  if (decimals === undefined) {
    if (Number.isInteger(v)) return v.toLocaleString();
    decimals = Math.abs(v) < 1 ? 3 : 2;
  }
  return v.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

function pct(fraction: number | null | undefined, decimals = 1): string {
  return typeof fraction === 'number' && Number.isFinite(fraction)
    ? `${num(fraction * 100, decimals)}%`
    : '—';
}

function signClass(v: number | null | undefined): string {
  if (typeof v !== 'number' || v === 0 || !Number.isFinite(v)) return '';
  return v > 0 ? 'pos' : 'neg';
}

function withUnit(value: string, unit: string): string {
  if (!unit) return value;
  return unit === '%' ? `${value}%` : `${value} ${unit}`;
}

function metric(label: string, value: string, sign: number | null, detail?: string): string {
  const title = esc(`${label}: ${value}${detail ? ` (${detail})` : ''}`);
  return (
    `<div class="performance-metric" title="${title}">` +
    `<span class="performance-label">${esc(label)}</span>` +
    `<strong class="${signClass(sign)}">${esc(value)}</strong>` +
    (detail ? `<small>${esc(detail)}</small>` : '') +
    '</div>'
  );
}

function numberOf(record: Record<string, unknown>, key: string): number | null {
  const v = record[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function headline(report: RobustnessReport): string {
  const unit = UNIT_LABELS[report.unit] ?? report.unit;
  const total = numberOf(report.summary, 'total');
  const parts = [
    metric('Total', withUnit(num(total), unit), total, `${num(report.trades)} closed trades`),
  ];
  const hit = report.hit_rate;
  parts.push(
    metric(
      'Hit rate',
      pct(numberOf(hit, 'rate')),
      null,
      `${pct(numberOf(hit, 'confidence'), 0)} CI ${pct(numberOf(hit, 'low'))}–${pct(numberOf(hit, 'high'))}`
    )
  );
  const boot = report.bootstrap;
  const low = numberOf(boot, 'low');
  const high = numberOf(boot, 'high');
  parts.push(
    metric(
      'Mean per trade',
      withUnit(num(numberOf(boot, 'mean')), unit),
      low !== null && low > 0 ? 1 : high !== null && high < 0 ? -1 : null,
      `bootstrap ${num(low)} … ${num(high)}`
    )
  );
  const mc = report.monte_carlo;
  parts.push(
    metric(
      'Monte Carlo P5',
      withUnit(num(mc.final.p5), unit),
      mc.final.p5,
      `median ${num(mc.final.p50)}, ${pct(mc.share_losing)} losing`
    )
  );
  if (report.account?.share_ruined !== null && report.account?.share_ruined !== undefined) {
    const capped = report.account_capped;
    parts.push(metric('Ruined paths', pct(report.account.share_ruined), null,
      `account at or below ${num(report.account.ruin_level, 0)}` +
        (typeof capped === 'number' ? `, ${num(capped)} trades capped by the leverage limit` : '')));
  }
  for (const flip of report.coinflips) {
    if (flip.valid === false) {
      parts.push(metric(`Coin flip (${flip.mode})`, 'not valid', null,
        `only ${num(flip.trades, 0)} of ${num(flip.trades + (flip.unpaired ?? 0), 0)} trades paired`));
      continue;
    }
    parts.push(
      metric(
        `Coin flip (${flip.mode})`,
        `beats ${pct(flip.percentile, 0)}`,
        null,
        `${pct(flip.share_better, 0)} of ${num(flip.draws)} random draws did better` +
          (flip.stop_reason ? ` (stopped early, of ${num(flip.planned)} planned)` : '')
      )
    );
  }
  const breakEven = report.costs.break_even_bps;
  if (typeof breakEven === 'number') {
    parts.push(metric('Break-even cost', `${num(breakEven)} bps`, null, 'extra per side'));
  }
  return `<div class="performance-summary">${parts.join('')}</div>`;
}

/** The test, metric and the four statistic columns of the summary table. */
function rowsTable(rows: RobustnessRow[]): string {
  let previous = '';
  const body = rows
    .map((row) => {
      const test = String(row['Test'] ?? '');
      const unit = row['Unit'] === 'currency' ? '' : String(row['Unit'] ?? '');
      const cell = (key: string): string => {
        const v = row[key];
        return v === null || v === undefined || v === '' ? '' : num(v as number | string);
      };
      const shown = test === previous ? '' : esc(test);
      previous = test;
      const verdict = String(row['Verdict'] ?? '');
      const method = String(row['Method'] ?? '');
      return (
        `<tr${shown ? ' class="rb-group"' : ''}><td>${shown}</td>` +
        `<td class="rb-text" title="${esc(method)}">${esc(String(row['Metric'] ?? ''))}</td>` +
        `<td>${withUnit(cell('Value'), unit)}</td>` +
        `<td>${cell('Low / P5')}</td><td>${cell('Median / P50')}</td><td>${cell('High / P95')}</td>` +
        `<td class="rb-text">${esc(verdict)}</td></tr>`
      );
    })
    .join('');
  return (
    '<table class="rb-table"><thead><tr><th>Test</th><th class="rb-text">Metric</th><th>Value</th>' +
    '<th>Low / P5</th><th>Median</th><th>High / P95</th><th class="rb-text">Verdict</th></tr></thead>' +
    `<tbody>${body}</tbody></table>`
  );
}

function sampleTable(
  title: string,
  first: string,
  samples: (SampleSummary & { key: string })[],
  unit: string
): string {
  if (!samples.length) return '';
  const body = samples
    .map((s) => {
      const total = numberOf(s, 'total');
      return (
        `<tr><td>${esc(s.key)}</td><td>${num(numberOf(s, 'trades'))}</td>` +
        `<td>${pct(numberOf(s, 'hit_rate'))}</td>` +
        `<td class="${signClass(total)}">${num(total)}</td>` +
        `<td class="${signClass(numberOf(s, 'mean'))}">${num(numberOf(s, 'mean'))}</td>` +
        `<td>${num(numberOf(s, 'profit_factor'))}</td>` +
        `<td>${num(numberOf(s, 'max_drawdown'))}</td></tr>`
      );
    })
    .join('');
  const u = unit ? ` (${unit})` : '';
  return (
    `<h4 class="rb-heading">${esc(title)}</h4>` +
    `<table class="rb-table"><thead><tr><th>${esc(first)}</th><th>Trades</th><th>Hit rate</th>` +
    `<th>Total${u}</th><th>Mean${u}</th><th>Profit factor</th><th>Max drawdown${u}</th></tr></thead>` +
    `<tbody>${body}</tbody></table>`
  );
}

function chartBox(id: string, title: string): string {
  return (
    `<div class="rb-chart"><span class="rb-chart-title">${esc(title)}</span>` +
    `<canvas id="${id}"></canvas></div>`
  );
}

/** The tab's HTML; {@link drawRobustness} paints its canvases once it is in the DOM. */
export function renderRobustness(report: RobustnessReport | undefined): string {
  if (!report) {
    return (
      '<span class="muted">Run the strategy with Robustness (the CodeLens or the ' +
      'PyneIDE: Robustness Tests command) to test it.</span>'
    );
  }
  const unit = UNIT_LABELS[report.unit] ?? report.unit;
  const charts = [
    ...report.coinflips.map((flip, i) =>
      chartBox(`rb-coinflip-${i}`, `Coin flip (${flip.mode}): random vs real`)
    ),
    chartBox('rb-montecarlo', `Monte Carlo total${unit ? ` (${unit})` : ''}, P5–P95`),
    ...(report.account ? [chartBox('rb-account', 'Account equity, P5–P95')] : []),
  ];
  const notes = report.coinflips
    .flatMap((flip) => flip.notes.map((note) => `Coin flip (${flip.mode}): ${note}`))
    .concat(report.skipped ? [`${num(report.skipped)} trades had no value in this unit and were skipped`] : []);
  return (
    '<div class="rb-view">' +
    headline(report) +
    `<div class="rb-charts">${charts.join('')}</div>` +
    (notes.length ? `<ul class="rb-notes">${notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : '') +
    rowsTable(report.rows) +
    sampleTable(
      'Extra costs per side',
      'Cost (bps)',
      report.costs.rows.map((r) => ({ ...r, key: num(r.bps) })),
      unit
    ) +
    sampleTable(
      'Periods',
      'Period',
      report.periods.map((p) => ({ ...p, key: `${p.label}` })),
      unit
    ) +
    '</div>'
  );
}

interface Frame {
  ctx: CanvasRenderingContext2D;
  plotWidth: number;
  plotHeight: number;
}

function frame(canvas: HTMLCanvasElement): Frame | undefined {
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (width < PAD.left + PAD.right + 20 || height < PAD.top + PAD.bottom + 20) return undefined;
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);
  const ctx = canvas.getContext('2d');
  if (!ctx) return undefined;
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, width, height);
  ctx.font = '10px var(--vscode-font-family, sans-serif)';
  return {
    ctx,
    plotWidth: width - PAD.left - PAD.right,
    plotHeight: height - PAD.top - PAD.bottom,
  };
}

/** Grid lines with their labels on the right for five evenly spaced values of [min, max]. */
function valueAxis(
  f: Frame,
  min: number,
  max: number,
  theme: RobustnessTheme,
  label: (v: number) => string = compact
): (v: number) => number {
  const y = (v: number): number => PAD.top + f.plotHeight - ((v - min) / (max - min)) * f.plotHeight;
  const { ctx } = f;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  for (let i = 0; i <= 4; i++) {
    const v = min + ((max - min) * i) / 4;
    const py = y(v);
    ctx.strokeStyle = theme.grid;
    ctx.beginPath();
    ctx.moveTo(PAD.left, py);
    ctx.lineTo(PAD.left + f.plotWidth, py);
    ctx.stroke();
    ctx.fillStyle = theme.muted;
    ctx.fillText(label(v), PAD.left + f.plotWidth + 6, py);
  }
  return y;
}

function compact(v: number): string {
  const a = Math.abs(v);
  if (a >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (a >= 1e4) return `${(v / 1e3).toFixed(0)}k`;
  if (a >= 100) return v.toFixed(0);
  return v.toFixed(a >= 10 ? 1 : 2);
}

/** A marker line across the plot; a solid line is labelled above the plot, a dashed one below it. */
function verticalLine(f: Frame, x: number, color: string, dashed: boolean, label: string): void {
  const { ctx } = f;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = dashed ? 1 : 2;
  if (dashed) ctx.setLineDash([4, 3]);
  ctx.beginPath();
  ctx.moveTo(x, PAD.top);
  ctx.lineTo(x, PAD.top + f.plotHeight);
  ctx.stroke();
  ctx.restore();
  ctx.fillStyle = color;
  if (dashed) {
    ctx.textBaseline = 'top';
    ctx.textAlign = 'center';
    ctx.fillText(label, x, PAD.top + f.plotHeight + 4);
    return;
  }
  ctx.textBaseline = 'bottom';
  ctx.textAlign = x > PAD.left + f.plotWidth * 0.7 ? 'right' : 'left';
  ctx.fillText(label, x + (ctx.textAlign === 'right' ? -3 : 3), PAD.top - 3);
}

function drawHistogram(canvas: HTMLCanvasElement, flip: CoinFlipRecord, theme: RobustnessTheme): void {
  const f = frame(canvas);
  const { edges, counts } = flip.histogram;
  if (!f || counts.length === 0 || edges.length !== counts.length + 1) return;
  const low = edges[0];
  const high = edges[edges.length - 1];
  if (low === null || high === null || !(high > low)) return;
  const x = (v: number): number => PAD.left + ((v - low) / (high - low)) * f.plotWidth;
  // A count axis: the top is the first multiple of 4 above the tallest bin,
  // so every grid line lands on a whole number of draws
  const peak = Math.ceil(Math.max(...counts, 1) / 4) * 4;
  const y = valueAxis(f, 0, peak, theme, (v) => v.toFixed(0));
  const { ctx } = f;
  const barWidth = f.plotWidth / counts.length;
  counts.forEach((count, i) => {
    const left = edges[i];
    if (left === null || count === 0) return;
    const top = y(count);
    ctx.fillStyle = theme.muted;
    ctx.globalAlpha = 0.55;
    ctx.fillRect(x(left) + 0.5, top, Math.max(1, barWidth - 1), PAD.top + f.plotHeight - top);
    ctx.globalAlpha = 1;
  });
  ctx.fillStyle = theme.muted;
  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';
  ctx.fillText(compact(low), PAD.left, PAD.top + f.plotHeight + 4);
  ctx.textAlign = 'right';
  ctx.fillText(compact(high), PAD.left + f.plotWidth, PAD.top + f.plotHeight + 4);
  const p95 = flip.distribution.p95;
  if (p95 !== null) verticalLine(f, x(p95), theme.muted, true, 'P95');
  if (flip.real !== null) {
    const color = flip.percentile !== null && flip.percentile >= 0.5 ? theme.positive : theme.negative;
    verticalLine(f, x(flip.real), color, false, `real ${compact(flip.real)}`);
  }
}

function drawFan(canvas: HTMLCanvasElement, mc: MonteCarloRecord, theme: RobustnessTheme): void {
  const f = frame(canvas);
  const bands = mc.bands.filter(
    (b) => b.p5 !== null && b.p25 !== null && b.p50 !== null && b.p75 !== null && b.p95 !== null
  );
  if (!f || bands.length < 2) return;
  const start = mc.initial_capital ?? 0;
  const values = bands.flatMap((b) => [b.p5 as number, b.p95 as number]).concat(start);
  let min = Math.min(...values);
  let max = Math.max(...values);
  if (!(max > min)) max = min + 1;
  const margin = (max - min) * 0.05;
  min -= margin;
  max += margin;
  const lastTrade = bands[bands.length - 1].trade;
  const x = (trade: number): number => PAD.left + (trade / lastTrade) * f.plotWidth;
  const y = valueAxis(f, min, max, theme);
  const { ctx } = f;
  const area = (lowKey: 'p5' | 'p25', highKey: 'p95' | 'p75', alpha: number): void => {
    ctx.beginPath();
    ctx.moveTo(x(0), y(start));
    for (const b of bands) ctx.lineTo(x(b.trade), y(b[highKey] as number));
    for (let i = bands.length - 1; i >= 0; i--) ctx.lineTo(x(bands[i].trade), y(bands[i][lowKey] as number));
    ctx.closePath();
    ctx.globalAlpha = alpha;
    ctx.fillStyle = theme.accent;
    ctx.fill();
    ctx.globalAlpha = 1;
  };
  area('p5', 'p95', 0.18);
  area('p25', 'p75', 0.3);
  ctx.save();
  ctx.strokeStyle = theme.muted;
  ctx.setLineDash([4, 3]);
  ctx.beginPath();
  ctx.moveTo(PAD.left, y(start));
  ctx.lineTo(PAD.left + f.plotWidth, y(start));
  ctx.stroke();
  ctx.restore();
  ctx.strokeStyle = theme.accent;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(x(0), y(start));
  for (const b of bands) ctx.lineTo(x(b.trade), y(b.p50 as number));
  ctx.stroke();
  ctx.lineWidth = 1;
  ctx.fillStyle = theme.muted;
  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';
  ctx.fillText('trade 0', PAD.left, PAD.top + f.plotHeight + 4);
  ctx.textAlign = 'right';
  ctx.fillText(`trade ${lastTrade.toLocaleString()}`, PAD.left + f.plotWidth, PAD.top + f.plotHeight + 4);
}

/** Paint the canvases {@link renderRobustness} put into `root`. */
export function drawRobustness(root: ParentNode, report: RobustnessReport, theme: RobustnessTheme): void {
  report.coinflips.forEach((flip, i) => {
    const canvas = root.querySelector<HTMLCanvasElement>(`#rb-coinflip-${i}`);
    if (canvas) drawHistogram(canvas, flip, theme);
  });
  const fan = root.querySelector<HTMLCanvasElement>('#rb-montecarlo');
  if (fan) drawFan(fan, report.monte_carlo, theme);
  const account = root.querySelector<HTMLCanvasElement>('#rb-account');
  if (account && report.account) drawFan(account, report.account, theme);
}
