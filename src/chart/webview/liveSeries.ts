/**
 * Live chart helpers that need no chart instance: the incremental indicator
 * calculation, and the bar-close countdown.
 */

/**
 * How far a datum reaches in the bar list. Datum `i` reads bar `i - offset`,
 * and a plot with `show_last = k` blanks every bar older than the last `k`.
 */
export interface DatumReach {
  /** Bars the series is shifted right by at most (the largest positive offset):
   * the result is this much longer than the bar list. */
  future: number;
  /** Datums before the last old bar that a single-bar update can change. */
  back: number;
}

/**
 * The reach of a series from its plots' `offset` and `show_last` values. A
 * changed last bar moves the datums from `last + min(offset, 0)` on; a new bar
 * also blanks a bar at `show_last` from the end.
 */
export function datumReach(plots: { offset?: number; show_last?: number }[]): DatumReach {
  let future = 0;
  let past = 0;
  let showLast = 0;
  for (const p of plots) {
    const offset = p.offset ?? 0;
    future = Math.max(future, offset);
    past = Math.max(past, -offset);
    showLast = Math.max(showLast, p.show_last ?? 0);
  }
  return { future, back: Math.max(1, showLast) + past };
}

/**
 * An indicator `calc` that recomputes only the tail on a live update.
 *
 * KLineChart recalculates every indicator over its whole data list after each
 * single-bar update, which a plot series over a long history cannot afford ten
 * times a second. The library updates its list in place (the last bar replaced,
 * or one appended), so the same list with no fewer bars means only the datums
 * around the old last bar can differ; any other list (a reload) is recomputed
 * in full.
 */
export class TailCalc<T> {
  private source: readonly unknown[] | undefined;
  private length = 0;
  private result: T[] = [];

  constructor(private readonly reach: DatumReach) {}

  calc(dataList: readonly unknown[], datum: (index: number) => T): T[] {
    const n = dataList.length;
    let from = 0;
    if (dataList === this.source && n >= this.length) {
      from = Math.max(0, this.length - this.reach.back);
    } else {
      this.result = [];
    }
    const total = n + this.reach.future;
    this.result.length = total;
    for (let i = from; i < total; i++) this.result[i] = datum(i);
    this.source = dataList;
    this.length = n;
    return this.result;
  }
}

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const DAY = 24 * 60 * MINUTE;

/**
 * Length of a bar of a TradingView period string ("30S", "15", "1D", "1W"),
 * or undefined where it is not fixed (months).
 */
export function periodMs(period: unknown): number | undefined {
  const m = /^(\d*)([SDWM]?)$/.exec(String(period ?? '').toUpperCase());
  if (!m) return undefined;
  const span = m[1] ? parseInt(m[1], 10) : 1;
  if (!(span > 0)) return undefined;
  switch (m[2]) {
    case 'S':
      return span * SECOND;
    case 'D':
      return span * DAY;
    case 'W':
      return span * 7 * DAY;
    case 'M':
      return undefined;
    default:
      return span * MINUTE;
  }
}

/**
 * Time from `now` to the end of the bar period it falls in, counted in steps of
 * `length` from the open of the last bar. The last bar may have ended already
 * when the next one has had no update yet.
 */
export function msToPeriodEnd(barTs: number, length: number, now: number): number {
  let end = barTs + length;
  if (end <= now) end += (Math.floor((now - end) / length) + 1) * length;
  return end - now;
}

/** Time left until a bar closes, as "m:ss", "h:mm:ss" or "Nd hh:mm:ss". */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / SECOND));
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const two = (v: number): string => String(v).padStart(2, '0');
  if (days) return `${days}d ${two(hours)}:${two(minutes)}:${two(seconds)}`;
  if (hours) return `${hours}:${two(minutes)}:${two(seconds)}`;
  return `${minutes}:${two(seconds)}`;
}
