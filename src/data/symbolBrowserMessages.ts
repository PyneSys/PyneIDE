/**
 * Messages between the symbol-browser host (symbolBrowserPanel.ts) and its
 * webview (webview/symbolBrowser.ts). The host owns the ProviderService (the
 * long-lived Python RPC process); the webview drives the UI and posts user
 * actions, the host answers with data or error states.
 */
import type { BrokerInfo, ProviderInfo, SymInfoDict } from './providerService';

/** The last-used selection, restored from globalState on open. */
export interface BrowserDefaults {
  provider?: string;
  broker?: string;
  timeframe?: string;
}

/** The Symbol Browser picks the symbol of a live chart: Start Live replaces Download. */
export interface LiveModeInfo {
  /** File name of the script the live chart runs; empty for a chart without one. */
  script: string;
  /** A strategy: the "Trade on history" switch is shown. */
  strategy: boolean;
  /** Current timeframe when switching a live chart's symbol. */
  timeframe?: string;
  /** History start as the bridge's `--live-from` (`-N` bars). */
  from: string;
  historyTrades: boolean;
}

/** Host -> webview. */
export type BrowserInMessage =
  | { type: 'init'; providers: ProviderInfo[]; defaults: BrowserDefaults }
  | { type: 'brokers'; provider: string; supported: boolean; brokers: BrokerInfo[]; error?: string }
  | { type: 'symbols'; provider: string; broker?: string; symbols: string[]; error?: string }
  | { type: 'symbolsLoading'; provider: string; broker?: string }
  // reqId correlates a syminfo reply with the row the webview asked about.
  | { type: 'syminfo'; reqId: number; symbol: string; info: SymInfoDict }
  | { type: 'syminfoError'; reqId: number; symbol: string; message: string }
  // Does a download of the current symbol + timeframe already have a file?
  // Drives the smart From default and the Truncate toggle (TUI parity).
  | { type: 'targetInfo'; reqId: number; exists: boolean; error?: string }
  | { type: 'downloadProgress'; done: number; total: number; indeterminate?: boolean }
  | { type: 'downloadDone'; ohlcvPath: string; barsWritten: number; symbol: string }
  | { type: 'downloadError'; kind: string; message: string; retryable: boolean }
  // Seed the search box + timeframe for a security-download prefill.
  | { type: 'prefill'; symbol: string; timeframe?: string }
  // Enter (with the run's settings) or leave the live-chart pick.
  | { type: 'liveMode'; live: LiveModeInfo | null };

/** Webview -> host. */
export type BrowserOutMessage =
  | { type: 'ready' }
  | { type: 'selectProvider'; provider: string }
  | { type: 'selectBroker'; provider: string; broker?: string }
  | { type: 'requestSyminfo'; reqId: number; provider: string; broker?: string; symbol: string }
  | {
      type: 'requestTarget';
      reqId: number;
      provider: string;
      broker?: string;
      symbol: string;
      timeframe: string;
    }
  | {
      type: 'download';
      provider: string;
      broker?: string;
      symbol: string;
      timeframe: string;
      from: number | 'continue';
      to: number;
      truncate: boolean;
      extraData: boolean;
    }
  | { type: 'cancelDownload' }
  | {
      type: 'startLive';
      provider: string;
      broker?: string;
      symbol: string;
      timeframe: string;
      from: string;
      historyTrades: boolean;
    }
  // Open a live chart of the symbol without a script, in a tab of its own.
  | { type: 'openLiveChart'; provider: string; broker?: string; symbol: string; timeframe: string }
  // Persist the current selection so the next open restores it.
  | { type: 'persist'; provider?: string; broker?: string; timeframe?: string };
