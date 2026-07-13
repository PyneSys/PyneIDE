/**
 * Message protocol between the extension host (ChartPanelManager) and the
 * chart webview. A thin projection of the bridge events: the panel forwards,
 * the webview owns all chart state.
 */
import type { BarRow, StartEvent, TradeRecord } from '../run/bridgeClient';

export type ChartInMessage =
  | { type: 'reset'; start: StartEvent; showVolume: boolean }
  | { type: 'bars'; rows: BarRow[] }
  | { type: 'plotKeys'; keys: string[] }
  | { type: 'trades'; trades: TradeRecord[] }
  | { type: 'openTrades'; trades: TradeRecord[] }
  | { type: 'stats'; stats: Record<string, number | null> }
  | { type: 'end'; bars: number; cancelled: boolean };

export type ChartOutMessage =
  | { type: 'ready' }
  | { type: 'openCsv'; which: 'plot' | 'trades' }
  | { type: 'setShowVolume'; value: boolean };
