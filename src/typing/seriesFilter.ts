/**
 * Matching rules between pyright's `reportIndexIssue` ranges and the series
 * spans reported by `python/pyneide_series.py` (F7/L5c).
 *
 * Kept free of the `vscode` module so the smoke test can drive it directly
 * against real pyright output.
 */

/** A `[line, startCharacter, endCharacter]` triple in LSP coordinates. */
export type Span = [number, number, number];

/** Index the analyzer's spans for exact lookup. */
export function seriesSpanIndex(spans: Span[]): Set<string> {
  return new Set(spans.map((span) => span.join(':')));
}

/**
 * Whether a diagnostic range denotes an access pynecomp rewrites into a
 * series-buffer read.
 *
 * pyright anchors `reportIndexIssue` on the subscript's base expression alone,
 * so the analyzer's spans match exactly. The only fuzziness allowed is
 * surrounding parentheses: `(s)[1]` reaches pynecomp as `Subscript(Name)` and
 * is rewritten, but pyright's range covers the parens while the analyzer
 * reports the bare name. Trimming matched pairs reconciles the two without
 * making `(s + 1)[1]` — a genuine error — look like a series access.
 */
export function isSeriesAccess(
  index: Set<string>,
  lineText: string,
  line: number,
  start: number,
  end: number
): boolean {
  const [from, to] = trimParens(lineText, start, end);
  return index.has([line, from, to].join(':'));
}

/** Strip whitespace and matched parenthesis pairs from a `[start, end)` range. */
export function trimParens(line: string, start: number, end: number): [number, number] {
  for (;;) {
    while (start < end && /\s/.test(line[start])) start += 1;
    while (end > start && /\s/.test(line[end - 1])) end -= 1;
    if (end - start < 2 || line[start] !== '(' || line[end - 1] !== ')') return [start, end];
    start += 1;
    end -= 1;
  }
}
