import type { TradeRecord } from '../../run/bridgeClient';

/** Prefer the trade containing the bar; in a gap, use the nearest entry/exit. */
export function tradeAtTimestamp(
  trades: readonly TradeRecord[],
  timestamp: number
): number | undefined {
  let selected: number | undefined;
  let bestDistance = Infinity;
  let bestEventDistance = Infinity;
  let bestExitDistance = Infinity;
  for (let i = 0; i < trades.length; i++) {
    const { entryTime, exitTime } = trades[i];
    if (!Number.isFinite(entryTime) || entryTime <= 0) continue;
    const closed = Number.isFinite(exitTime) && exitTime >= entryTime;
    const exitDistance = closed ? Math.abs(timestamp - exitTime) : Infinity;
    const eventDistance = Math.min(Math.abs(timestamp - entryTime), exitDistance);
    const distance = timestamp < entryTime
      ? entryTime - timestamp
      : closed && timestamp > exitTime ? timestamp - exitTime : 0;
    if (
      distance < bestDistance ||
      (distance === bestDistance && eventDistance < bestEventDistance) ||
      (distance === bestDistance && eventDistance === bestEventDistance && exitDistance < bestExitDistance)
    ) {
      selected = i;
      bestDistance = distance;
      bestEventDistance = eventDistance;
      bestExitDistance = exitDistance;
    }
  }
  return selected;
}
