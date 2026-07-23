/** Pure condition grammar shared by the source-breakpoint host integration. */
export interface ChartConditionParts {
  base: string | undefined;
  timestamps: number[];
}

/** Exact suffix emitted by composeCondition(). A conservative recognizer is
 * intentional: an arbitrarily edited condition remains a normal breakpoint
 * instead of PyneIDE guessing at its meaning. */
const MANAGED_SUFFIX = /^(?:\((.*)\) and )?\(time (?:== (\d+)|in \((\d+(?:, \d+)*)\))\)$/;
const BARE_TIME = /^time (?:== (\d+)|in \((\d+(?:, \d+)*)\))$/;

export function splitChartCondition(condition: string | undefined): ChartConditionParts {
  const text = condition?.trim();
  if (!text) return { base: undefined, timestamps: [] };

  const managed = MANAGED_SUFFIX.exec(text);
  if (managed) {
    return {
      base: managed[1]?.trim() || undefined,
      timestamps: parseTimestamps(managed[2], managed[3]),
    };
  }

  const bare = BARE_TIME.exec(text);
  if (bare) {
    return { base: undefined, timestamps: parseTimestamps(bare[1], bare[2]) };
  }

  return { base: text, timestamps: [] };
}

/** True only for the exact chart-managed condition with no user-authored
 * condition alongside it. These breakpoints can use the bridge's bar-boundary
 * fast path without changing user condition semantics. */
export function pureChartBreakpointTimestamps(
  condition: string | undefined
): number[] | undefined {
  const parts = splitChartCondition(condition);
  return parts.base === undefined && parts.timestamps.length > 0
    ? parts.timestamps
    : undefined;
}

function parseTimestamps(single: string | undefined, many: string | undefined): number[] {
  const raw = single ? [single] : many?.split(', ') ?? [];
  return raw
    .map(Number)
    .filter((value) => Number.isSafeInteger(value) && value >= 0)
    .sort((a, b) => a - b);
}

function composeCondition(base: string | undefined, timestamps: readonly number[]): string | undefined {
  const unique = [...new Set(timestamps)]
    .filter((value) => Number.isSafeInteger(value) && value >= 0)
    .sort((a, b) => a - b);
  if (!unique.length) return base?.trim() || undefined;

  const timeClause = unique.length === 1
    ? `time == ${unique[0]}`
    : `time in (${unique.join(', ')})`;
  const cleanBase = base?.trim();
  return cleanBase ? `(${cleanBase}) and (${timeClause})` : `(${timeClause})`;
}

export function addChartTimestamp(condition: string | undefined, timestamp: number): string {
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
    throw new RangeError('Chart breakpoint timestamp must be a non-negative safe integer.');
  }
  const parts = splitChartCondition(condition);
  return composeCondition(parts.base, [...parts.timestamps, timestamp])!;
}

export function removeChartTimestamp(
  condition: string | undefined,
  timestamp: number
): string | undefined {
  const parts = splitChartCondition(condition);
  return composeCondition(parts.base, parts.timestamps.filter((value) => value !== timestamp));
}
