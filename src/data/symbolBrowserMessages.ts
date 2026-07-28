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
  | { type: 'prefill'; symbol: string; timeframe?: string };

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
    }
  | { type: 'cancelDownload' }
  // Persist the current selection so the next open restores it.
  | { type: 'persist'; provider?: string; broker?: string; timeframe?: string };
