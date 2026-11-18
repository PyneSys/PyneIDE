/**
 * Message protocol between a dashboard editor (the extension host) and its
 * webview. The webview draws the layout and the cell headers; each chart runs
 * in an iframe of the chart page, whose messages travel through the dashboard
 * page (`chart` in, `frame` out) as a chart tab's would.
 */
import type { ChartInMessage, ChartOutMessage } from '../chart/messages';
import type { LayoutNode, ScriptKind, SplitDirection } from './model';

export type DashboardChartState = 'starting' | 'loading' | 'live' | 'reconnecting' | 'error' | 'stopped';
export type DashboardScriptState = 'loading' | 'running' | 'error' | 'off';

export interface DashboardViewScript {
  id: string;
  path: string;
  kind?: ScriptKind;
  state: DashboardScriptState;
  /** The error that stopped it, or what it is waiting for. */
  message?: string;
  /** Inputs and settings the dashboard sets, as `name = value` lines. */
  overrides: string[];
}

export interface DashboardViewChart {
  /** `BINANCE:BTC/USDT` */
  symbol: string;
  /** `1`, `60`, `1D` */
  timeframe: string;
  provider: string;
  state: DashboardChartState;
  /** An error, or the download's progress. */
  message?: string;
  scripts: DashboardViewScript[];
  /** Another indicator / strategy may join. */
  canAddScript: boolean;
}

export interface DashboardView {
  name: string;
  layout: LayoutNode | undefined;
  charts: Record<string, DashboardViewChart>;
  canAddChart: boolean;
  /** The file does not describe a dashboard: why. */
  error?: string;
}

export type DashboardInMessage =
  | { type: 'view'; view: DashboardView }
  | { type: 'chart'; key: string; message: ChartInMessage };

export type DashboardOutMessage =
  | { type: 'ready' }
  | { type: 'frame'; key: string; message: ChartOutMessage }
  /** Without `beside`, at the right edge of the dashboard. */
  | { type: 'addChart'; beside?: string; direction?: SplitDirection }
  | { type: 'removeChart'; key: string }
  | { type: 'resize'; path: number[]; sizes: number[] }
  | { type: 'addScript'; key: string }
  | { type: 'removeScript'; key: string; id: string }
  | { type: 'toggleScript'; key: string; id: string }
  | { type: 'editScript'; key: string; id: string }
  | { type: 'restartChart'; key: string }
  /** Open the chart in a chart tab of its own (trades, performance, stats). */
  | { type: 'openFullChart'; key: string }
  | { type: 'openText' };
