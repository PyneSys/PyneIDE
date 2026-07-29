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
import type { CandleStyleId } from './candleStyle';
import type { PriceScaleId } from './priceScale';

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
  /** Persisted candle style pushed from the host: on webview load and on every
   * settings change, so every open chart follows the one setting. */
  | { type: 'candleStyle'; style: CandleStyleId }
  /** Persisted price-scale mode, pushed on the same occasions as candleStyle. */
  | { type: 'priceScale'; scale: PriceScaleId }
  | { type: 'end'; bars: number; cancelled: boolean };

export type ChartOutMessage =
  | { type: 'ready' }
  | { type: 'openCsv'; which: 'plot' | 'trades' }
  /** Toolbar pick: the host owns persistence, the webview only asks. */
  | { type: 'setCandleStyle'; style: CandleStyleId }
  | { type: 'setPriceScale'; scale: PriceScaleId }
  | { type: 'selectData' }
  | { type: 'selectBreakpointBar'; timestamp: number }
  | { type: 'removeBreakpointBar'; timestamp: number }
  | { type: 'cancelBreakpointSelection' };
