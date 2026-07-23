/**
 * Message protocol between the extension host (ChartPanel) and the
 * chart webview. A thin projection of the bridge events: the panel forwards,
 * the webview owns all chart state.
 */
import type {
  BarRow,
  ColorDeltaRow,
  DrawingEventRecord,
  PlotMetaRecord,
  StartEvent,
  TradeRecord,
} from '../run/bridgeClient';

/** One visual chart marker aggregated from every native source breakpoint on
 * this script that contains the same managed time condition. */
export interface ChartBreakpointTarget {
  timestamp: number;
  enabled: boolean;
  count: number;
}

export type ChartInMessage =
  | { type: 'reset'; start: StartEvent }
  | { type: 'bars'; rows: BarRow[] }
  | { type: 'plotKeys'; keys: string[] }
  | { type: 'plotMeta'; metas: PlotMetaRecord[] }
  | { type: 'colors'; d: ColorDeltaRow[] }
  | { type: 'drawings'; d: DrawingEventRecord[] }
  | { type: 'trades'; trades: TradeRecord[] }
  | { type: 'openTrades'; trades: TradeRecord[] }
  | { type: 'stats'; stats: Record<string, number | null> }
  | { type: 'breakpoints'; targets: ChartBreakpointTarget[] }
  | { type: 'breakpointSelection'; label?: string }
  | { type: 'end'; bars: number; cancelled: boolean };

export type ChartOutMessage =
  | { type: 'ready' }
  | { type: 'openCsv'; which: 'plot' | 'trades' }
  | { type: 'selectData' }
  | { type: 'selectBreakpointBar'; timestamp: number }
  | { type: 'removeBreakpointBar'; timestamp: number }
  | { type: 'cancelBreakpointSelection' };
