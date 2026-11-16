/**
 * Time-ordered bar lists shared by the host snapshot and the chart webview.
 */

/**
 * Add a bar to a time-ordered list. A bar with the timestamp of the last one
 * replaces it: on a live chart the last history bar was still forming at the
 * download, and its live close arrives with the same timestamp, as does the
 * close of every forming bar the ticks have drawn. Returns whether the bar
 * replaced the last one.
 */
export function upsertLastBar<T>(list: T[], bar: T, timestamp: (bar: T) => number): boolean {
  const last = list.length - 1;
  if (last >= 0 && timestamp(list[last]) === timestamp(bar)) {
    list[last] = bar;
    return true;
  }
  list.push(bar);
  return false;
}
