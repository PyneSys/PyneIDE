/**
 * A user drawing as it leaves the chart: what a dashboard file keeps of it and
 * what the chart rebuilds it from. vscode- and DOM-free, so the extension (the
 * dashboard file) and the chart webview share it.
 */

export type DrawingDash = 'solid' | 'dashed' | 'dotted';

export interface DrawingStyle {
  /** `#RRGGBB` */
  color: string;
  /** Line width in pixels. */
  width: number;
  dash: DrawingDash;
}

/** One level of a Fibonacci retracement: 0 is the second point, 1 the first. */
export interface FibLevel {
  value: number;
  /** `#RRGGBB` */
  color: string;
  visible: boolean;
}

/** A point by its bar time when it has one; a point drawn before the chart
 * had bars has only its bar index. */
export interface DrawingPoint {
  timestamp?: number;
  dataIndex?: number;
  value?: number;
}

export interface DrawingRecord {
  /** The chart overlay that draws it (`segment`, `fibRetracement`, ...). */
  tool: string;
  points: DrawingPoint[];
  style: DrawingStyle;
  /** The timeframe it was drawn on: it expires only on that timeframe's data. */
  timeframe?: string;
  /** A Fibonacci retracement's levels. */
  levels?: FibLevel[];
}

/** Tools whose drawing does not depend on time, so it never expires. */
export const TIME_FREE_TOOLS: ReadonlySet<string> = new Set(['horizontalStraightLine']);

export const DRAWING_DASHES: readonly DrawingDash[] = ['solid', 'dashed', 'dotted'];
export const MIN_DRAWING_WIDTH = 1;
export const MAX_DRAWING_WIDTH = 4;

export const DEFAULT_DRAWING_STYLE: DrawingStyle = { color: '#2962FF', width: 1, dash: 'solid' };

export const DEFAULT_FIB_LEVELS: readonly FibLevel[] = [
  { value: 0, color: '#787B86', visible: true },
  { value: 0.236, color: '#F23645', visible: true },
  { value: 0.382, color: '#FF9800', visible: true },
  { value: 0.5, color: '#4CAF50', visible: true },
  { value: 0.618, color: '#089981', visible: true },
  { value: 0.786, color: '#00BCD4', visible: true },
  { value: 1, color: '#787B86', visible: true },
  { value: 1.618, color: '#2962FF', visible: false },
  { value: 2.618, color: '#F23645', visible: false },
];

const COLOR_RE = /^#[0-9A-Fa-f]{6}$/;

export function isDrawingColor(value: unknown): value is string {
  return typeof value === 'string' && COLOR_RE.test(value);
}

export function isDrawingDash(value: unknown): value is DrawingDash {
  return typeof value === 'string' && (DRAWING_DASHES as readonly string[]).includes(value);
}

export function clampDrawingWidth(width: number): number {
  return Math.min(MAX_DRAWING_WIDTH, Math.max(MIN_DRAWING_WIDTH, Math.round(width)));
}
