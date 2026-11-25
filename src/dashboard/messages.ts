/**
 * Message protocol between a dashboard editor (the extension host) and its
 * webview. The webview draws the layout; each chart runs in an iframe of the
 * chart page, whose messages travel through the dashboard page (`chart` in,
 * `frame` out) as a chart tab's would. The chart's toolbar and Layers menu
 * carry the cell's own controls (`cell` messages of the chart protocol).
 */
import type { ChartCell, ChartInMessage, ChartOutMessage } from '../chart/messages';
import type { DropSide, LayoutNode } from './model';

export type DashboardChartState = ChartCell['state'];

export interface DashboardViewChart {
  state: DashboardChartState;
  /** An error, or the download's progress. */
  message?: string;
}

export interface DashboardView {
  name: string;
  layout: LayoutNode | undefined;
  /** Each chart's runner state; the iframe shows the rest (see `ChartCell`). */
  charts: Record<string, DashboardViewChart>;
  /** The file does not describe a dashboard: why. */
  error?: string;
}

export type DashboardInMessage =
  | { type: 'view'; view: DashboardView }
  | { type: 'chart'; key: string; message: ChartInMessage };

export type DashboardOutMessage =
  | { type: 'ready' }
  | { type: 'frame'; key: string; message: ChartOutMessage }
  /** The empty dashboard's "Add chart". */
  | { type: 'addChart' }
  | { type: 'resize'; path: number[]; sizes: number[] }
  /** A chart dragged onto `side` of `target`'s cell; no target:
   * onto that edge of the whole dashboard. */
  | { type: 'moveChart'; key: string; target: string | undefined; side: DropSide }
  /** A stopped chart's "Retry". */
  | { type: 'restartChart'; key: string }
  /** The invalid file's "Open as text". */
  | { type: 'openText' };
