/**
 * A live chart keeps at most {@link LIVE_MAX_BARS} bars: the oldest ones are
 * dropped, {@link LIVE_TRIM_BARS} at a time, so the chart reloads its data once
 * every that many bars instead of on every new one. The host's snapshot is the
 * authority: it trims and tells the webview the bar index its first bar has now.
 */
import type { ColorDeltaRow, ColorEnc } from '../run/bridgeClient';

export const LIVE_MAX_BARS = 20_000;
export const LIVE_TRIM_BARS = 1_000;

/** How many bars to drop from the front of a live chart holding `length` bars. */
export function liveTrimCount(length: number): number {
  return length > LIVE_MAX_BARS ? length - (LIVE_MAX_BARS - LIVE_TRIM_BARS) : 0;
}

/**
 * The color deltas of a trimmed live chart: the deltas of the dropped bars fold
 * into one row at the first bar kept (later values win, and that bar's own
 * delta wins over them all), so every channel still carries its color forward.
 */
export function foldColorRows(rows: readonly ColorDeltaRow[], firstTs: number): ColorDeltaRow[] {
  const folded: Record<string, ColorEnc> = {};
  let dropped = false;
  let rest = 0;
  while (rest < rows.length && rows[rest][0] < firstTs) {
    Object.assign(folded, rows[rest][1]);
    dropped = true;
    rest++;
  }
  if (!dropped) return rows.slice();
  const out: ColorDeltaRow[] = [];
  if (rest < rows.length && rows[rest][0] === firstTs) {
    out.push([firstTs, { ...folded, ...rows[rest][1] }]);
    rest++;
  } else {
    out.push([firstTs, folded]);
  }
  for (; rest < rows.length; rest++) out.push(rows[rest]);
  return out;
}
