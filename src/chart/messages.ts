/**
 * Message protocol between the extension host (ChartPanel) and the
 * chart webview. A thin projection of the bridge events: the panel forwards,
 * the webview owns all chart state.
 */
import type {
  BarRow,
  ColorDeltaRow,
  DrawingEventRecord,
  FeedStatusEvent,
  PlotMetaRecord,
  RobustnessReport,
  StartEvent,
  TickEvent,
  TradeRecord,
} from '../run/bridgeClient';
import type { CandleStyleId } from './candleStyle';
import type { ColorSchemeId } from './colorScheme';
import type { PriceScaleId } from './priceScale';

/** One visual chart marker aggregated from every native source breakpoint on
 * this script that contains the same managed time condition. */
export interface ChartBreakpointTarget {
  timestamp: number;
  enabled: boolean;
  count: number;
}

export interface ChartDebugPosition {
  barIndex: number;
  timestamp: number;
}

/** A script of a dashboard chart, as its Layers group shows it. */
export interface ChartCellScript {
  /** The script entry's id: the prefix of its plot ids (`ema_fast: `). */
  id: string;
  /** The script's title and the inputs the dashboard sets (`EMA · length 20`). */
  label: string;
  state: 'loading' | 'running' | 'error';
  /** Why it stopped. */
  message?: string;
}

/** What a chart in a dashboard cell shows beyond a chart tab: its scripts and
 * the cell's actions. */
export interface ChartCell {
  /** The chart's runners: `starting` and `loading` show `message` (the
   * download's progress) in the live indicator. */
  state: 'starting' | 'loading' | 'live' | 'reconnecting' | 'error' | 'stopped';
  message?: string;
  scripts: ChartCellScript[];
  /** Why no script can join the chart, when none can. */
  addScriptBlocked?: string;
  /** Why no chart can join the dashboard, when none can. */
  addChartBlocked?: string;
}

/** A dashboard cell's action, asked from its chart's toolbar or Layers menu. */
export type ChartCellAction =
  | { kind: 'addScript' }
  | { kind: 'editScript'; id: string }
  | { kind: 'removeScript'; id: string }
  | { kind: 'addChart'; direction: 'horizontal' | 'vertical' }
  | { kind: 'openFullChart' }
  | { kind: 'removeChart' }
  | { kind: 'restart' };

export type ChartInMessage =
  | { type: 'reset'; start: StartEvent }
  /** A dashboard cell's scripts and actions; each one replaces the last. */
  | { type: 'cell'; cell: ChartCell }
  /** Rows in time order; a row with the last row's timestamp replaces it. */
  | { type: 'bars'; rows: BarRow[] }
  /** A live chart's history is complete: from here on the chart takes single
   * bar updates and reloads its data only when it drops its oldest bars. */
  | { type: 'live' }
  /** A live chart dropped its oldest bars: `base` is the bar index of its first
   * bar now. Drop the bars before it (sent after the bars that pushed it over
   * the limit, and on a replay before the bars). */
  | { type: 'barBase'; base: number }
  /** The forming bar's latest update; the next tick or the bar's close
   * replaces it. */
  | { type: 'tick'; tick: TickEvent }
  | { type: 'feedStatus'; status: FeedStatusEvent }
  | { type: 'plotKeys'; keys: string[] }
  | { type: 'plotMeta'; metas: PlotMetaRecord[] }
  | { type: 'colors'; d: ColorDeltaRow[] }
  | { type: 'drawings'; d: DrawingEventRecord[] }
  | { type: 'trades'; trades: TradeRecord[] }
  /** The full set of open trades; each set replaces the previous one. */
  | { type: 'openTrades'; trades: TradeRecord[] }
  | { type: 'stats'; stats: Record<string, number | null> }
  /** Robustness tests of the run, sent after its last bar (before `end`). */
  | { type: 'robustness'; report: RobustnessReport }
  | { type: 'debugPosition'; position?: ChartDebugPosition }
  | { type: 'breakpoints'; targets: ChartBreakpointTarget[] }
  | { type: 'breakpointSelection'; label?: string }
  /** Persisted candle style pushed from the host: on webview load and on every
   * settings change, so every open chart follows the one setting. */
  | { type: 'candleStyle'; style: CandleStyleId }
  /** Persisted price-scale mode, pushed on the same occasions as candleStyle. */
  | { type: 'priceScale'; scale: PriceScaleId }
  /** Persisted direction-color scheme, pushed on the same occasions. */
  | { type: 'colorScheme'; scheme: ColorSchemeId }
  | { type: 'end'; bars: number; cancelled: boolean };

export type ChartOutMessage =
  | { type: 'ready' }
  | { type: 'openCsv'; which: 'plot' | 'trades' }
  | { type: 'editProperties' }
  /** Toolbar pick: the host owns persistence, the webview only asks. */
  | { type: 'setCandleStyle'; style: CandleStyleId }
  | { type: 'setPriceScale'; scale: PriceScaleId }
  | { type: 'setColorScheme'; scheme: ColorSchemeId }
  | { type: 'selectData' }
  /** A live chart's toolbar timeframe pick; without `timeframe` the host asks
   * for a custom one. */
  | { type: 'selectTimeframe'; timeframe?: string }
  | { type: 'selectBreakpointBar'; timestamp: number }
  | { type: 'removeBreakpointBar'; timestamp: number }
  | { type: 'cancelBreakpointSelection' }
  | { type: 'openLabelLink'; target: string }
  /** Data Window row click: the host owns the clipboard. */
  | { type: 'copyText'; text: string }
  /** A dashboard cell's action (embedded charts only). */
  | { type: 'cell'; action: ChartCellAction };
