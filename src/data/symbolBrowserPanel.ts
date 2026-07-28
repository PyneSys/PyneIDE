/**
 * Symbol browser webview panel (viewType `pyneide.symbolBrowser`): the VSCode
 * equivalent of the `pyne data download` TUI. It shows a searchable symbol list,
 * live symbol info for the row under the cursor, and an inline download bar with
 * progress.
 *
 * The panel owns a ProviderService (the long-lived Python RPC process) and
 * bridges it to the webview: user actions come up as BrowserOutMessage, data
 * and error states go down as BrowserInMessage. `retainContextWhenHidden` keeps
 * the webview (and its downloaded symbol list) alive across tab switches; the
 * last provider/broker/timeframe survive a full close via globalState.
 *
 * One panel at a time (singleton): a second `show()` reveals the existing one.
 * A single download runs at a time — the service rejects a second one.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import * as vscode from 'vscode';

import { writeSymbolMapEntry } from '../run/symbolMapFile';
import { OhlcvEditorProvider } from './ohlcvEditor';
import { parseSymInfo } from './syminfo';
import {
  ProviderService,
  ProviderServiceError,
  type BrokersResult,
  type DownloadResult,
  type OhlcvPathResult,
  type ProviderInfo,
  type SymInfoDict,
} from './providerService';
import type { BrowserDefaults, BrowserInMessage, BrowserOutMessage } from './symbolBrowserMessages';

const LAST_PROVIDER_KEY = 'pyneide.symbolBrowser.provider';
const LAST_BROKER_KEY = 'pyneide.symbolBrowser.broker';
const LAST_TIMEFRAME_KEY = 'pyneide.symbolBrowser.timeframe';

/** Host-side syminfo LRU: avoids re-hitting the service (and provider REST) as
 * the cursor moves back over rows already seen. Keyed provider|broker|symbol|tf. */
const SYMINFO_CACHE_MAX = 300;

/** Host-side `.ohlcv` target-path cache, keyed provider|broker|symbol|tf. The
 * path is a pure function of that key, so only the existence check is redone. */
const OHLCV_PATH_CACHE_MAX = 500;

/**
 * A security-download prefill: the browser seeds its search box with the
 * ticker and selects the timeframe, and once the download finishes it writes the
 * `symbol_map.toml` entry (`mapKey` → the download's provider string) so both
 * the run and the CLI resolve the feed afterwards, then offers to run `chartKey`.
 */
export interface SecurityPrefill {
  /** Native symbol to seed the search with (the `PREFIX:` is stripped). */
  symbol: string;
  timeframe?: string;
  /** TV symbol the map entry is keyed under. */
  mapKey: string;
  workdir: string;
  /**
   * Source path of the script to offer a "Run" action for after the download.
   * Absent for a Symbol Map-initiated download, which has no waiting script — the
   * map write still happens, only the "Run" offer is skipped.
   */
  chartKey?: string;
}

export interface SymbolBrowserDeps {
  pythonBin: string;
  /** Directory that CONTAINS the pyneide_bridge package (`<ext>/python`). */
  bridgeRoot: string;
  workdir: string;
  output: vscode.OutputChannel;
  /** Invoked when the very first `providers` request fails (the service could
   * not start) so the caller can fall back to the QuickPick download wizard. */
  onServiceUnavailable?: () => void;
}

export class SymbolBrowserPanel {
  private static current: SymbolBrowserPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private readonly service: ProviderService;
  private readonly syminfoCache = new Map<string, SymInfoDict>();
  private readonly ohlcvPathCache = new Map<string, string>();
  private readonly disposables: vscode.Disposable[] = [];
  private activeDownloadId: number | undefined;
  /** Armed security-download prefill (map write + Run offer after download). */
  private prefill: SecurityPrefill | undefined;

  static show(
    context: vscode.ExtensionContext,
    deps: SymbolBrowserDeps,
    prefill?: SecurityPrefill
  ): void {
    if (SymbolBrowserPanel.current) {
      const existing = SymbolBrowserPanel.current;
      existing.panel.reveal(vscode.ViewColumn.Active);
      if (prefill) existing.arm(prefill);
      return;
    }
    SymbolBrowserPanel.current = new SymbolBrowserPanel(context, deps, prefill);
  }

  /**
   * Re-read the provider list after a plugin was installed or removed. The
   * service discovers entry points at import time, so the live process has to
   * go before the new provider can show up.
   */
  static reloadProviders(): void {
    const panel = SymbolBrowserPanel.current;
    if (!panel) return;
    panel.service.restart();
    void panel.sendInit();
  }

  private constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly deps: SymbolBrowserDeps,
    prefill?: SecurityPrefill
  ) {
    this.prefill = prefill;
    this.service = new ProviderService({
      pythonBin: deps.pythonBin,
      bridgeRoot: deps.bridgeRoot,
      workdir: deps.workdir,
      log: (line) => deps.output.appendLine(line),
    });

    const distRoot = vscode.Uri.joinPath(context.extensionUri, 'dist');
    this.panel = vscode.window.createWebviewPanel(
      'pyneide.symbolBrowser',
      'Symbol Browser',
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [distRoot] }
    );
    this.panel.webview.html = this.html(this.panel.webview, distRoot);
    this.panel.webview.onDidReceiveMessage(
      (msg: BrowserOutMessage) => void this.onMessage(msg),
      null,
      this.disposables
    );
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
  }

  private post(message: BrowserInMessage): void {
    void this.panel.webview.postMessage(message);
  }

  /** Re-arm a prefill on the already-open panel and seed the webview. */
  private arm(prefill: SecurityPrefill): void {
    this.prefill = prefill;
    this.postPrefill(prefill);
  }

  /** Seed the webview search box + timeframe (the `PREFIX:` is dropped so the
   * broker-native ticker matches the symbol list). */
  private postPrefill(prefill: SecurityPrefill): void {
    const colon = prefill.symbol.indexOf(':');
    const search = colon >= 0 ? prefill.symbol.slice(colon + 1) : prefill.symbol;
    this.post({ type: 'prefill', symbol: search, timeframe: prefill.timeframe });
  }

  private async onMessage(msg: BrowserOutMessage): Promise<void> {
    switch (msg.type) {
      case 'ready':
        await this.sendInit();
        if (this.prefill) this.postPrefill(this.prefill);
        break;
      case 'selectProvider':
        await this.sendBrokers(msg.provider);
        break;
      case 'selectBroker':
        await this.sendSymbols(msg.provider, msg.broker);
        break;
      case 'requestSyminfo':
        await this.sendSyminfo(msg);
        break;
      case 'requestTarget':
        await this.sendTargetInfo(msg);
        break;
      case 'download':
        await this.runDownload(msg);
        break;
      case 'cancelDownload':
        if (this.activeDownloadId !== undefined) this.service.cancel(this.activeDownloadId);
        break;
      case 'persist':
        await this.persist(msg.provider, msg.broker, msg.timeframe);
        break;
    }
  }

  private async sendInit(): Promise<void> {
    const defaults: BrowserDefaults = {
      provider: this.context.globalState.get<string>(LAST_PROVIDER_KEY),
      broker: this.context.globalState.get<string>(LAST_BROKER_KEY),
      timeframe: this.context.globalState.get<string>(LAST_TIMEFRAME_KEY),
    };
    try {
      const providers = await this.service.request<ProviderInfo[]>('providers');
      this.post({ type: 'init', providers, defaults });
    } catch (err) {
      this.deps.output.appendLine(`PyneIDE: provider service failed: ${errMessage(err)}`);
      this.post({ type: 'init', providers: [], defaults });
      if (this.deps.onServiceUnavailable) {
        const choice = await vscode.window.showErrorMessage(
          `PyneIDE: could not start the provider service — ${errMessage(err)}`,
          'Use Download Wizard'
        );
        if (choice === 'Use Download Wizard') {
          this.panel.dispose();
          this.deps.onServiceUnavailable();
        }
      } else {
        void vscode.window.showErrorMessage(`PyneIDE: could not start the provider service — ${errMessage(err)}`);
      }
    }
  }

  private async sendBrokers(provider: string): Promise<void> {
    try {
      const res = await this.service.request<BrokersResult>('brokers', { provider });
      this.post({ type: 'brokers', provider, supported: res.supported, brokers: res.brokers });
    } catch (err) {
      this.post({ type: 'brokers', provider, supported: false, brokers: [], error: errMessage(err) });
    }
  }

  private async sendSymbols(provider: string, broker?: string): Promise<void> {
    this.post({ type: 'symbolsLoading', provider, broker });
    try {
      const symbols = await this.service.request<string[]>('symbols', { provider, broker });
      this.post({ type: 'symbols', provider, broker, symbols });
    } catch (err) {
      this.post({ type: 'symbols', provider, broker, symbols: [], error: errMessage(err) });
    }
  }

  private async sendSyminfo(msg: {
    reqId: number;
    provider: string;
    broker?: string;
    symbol: string;
  }): Promise<void> {
    const key = `${msg.provider}|${msg.broker ?? ''}|${msg.symbol}`;
    const cached = this.syminfoCache.get(key);
    if (cached) {
      // Refresh LRU recency.
      this.syminfoCache.delete(key);
      this.syminfoCache.set(key, cached);
      this.post({ type: 'syminfo', reqId: msg.reqId, symbol: msg.symbol, info: cached });
      return;
    }
    try {
      const info = await this.service.request<SymInfoDict>('syminfo', {
        provider: msg.provider,
        broker: msg.broker,
        symbol: msg.symbol,
      });
      this.syminfoCache.set(key, info);
      while (this.syminfoCache.size > SYMINFO_CACHE_MAX) {
        const oldest = this.syminfoCache.keys().next().value;
        if (oldest === undefined) break;
        this.syminfoCache.delete(oldest);
      }
      this.post({ type: 'syminfo', reqId: msg.reqId, symbol: msg.symbol, info });
    } catch (err) {
      this.post({ type: 'syminfoError', reqId: msg.reqId, symbol: msg.symbol, message: errMessage(err) });
    }
  }

  /**
   * Answer "would this download overwrite something?" for the download bar.
   *
   * The provider class names the file (only it knows the broker-qualified
   * form), so the path itself comes from the service — but it is a pure
   * function of provider|broker|symbol|tf, so it is cached and only the
   * existence check is redone, keeping the answer fresh right after a download.
   */
  private async sendTargetInfo(msg: {
    reqId: number;
    provider: string;
    broker?: string;
    symbol: string;
    timeframe: string;
  }): Promise<void> {
    const key = `${msg.provider}|${msg.broker ?? ''}|${msg.symbol}|${msg.timeframe}`;
    let target = this.ohlcvPathCache.get(key);
    if (target === undefined) {
      try {
        const res = await this.service.request<OhlcvPathResult>('ohlcv_path', {
          provider: msg.provider,
          broker: msg.broker,
          symbol: msg.symbol,
          timeframe: msg.timeframe,
        });
        target = res.path;
        this.ohlcvPathCache.set(key, target);
        while (this.ohlcvPathCache.size > OHLCV_PATH_CACHE_MAX) {
          const oldest = this.ohlcvPathCache.keys().next().value;
          if (oldest === undefined) break;
          this.ohlcvPathCache.delete(oldest);
        }
      } catch (err) {
        this.post({ type: 'targetInfo', reqId: msg.reqId, exists: false, error: errMessage(err) });
        return;
      }
    }
    this.post({ type: 'targetInfo', reqId: msg.reqId, exists: fs.existsSync(target) });
  }

  private async runDownload(msg: {
    provider: string;
    broker?: string;
    symbol: string;
    timeframe: string;
    from: number | 'continue';
    to: number;
    truncate: boolean;
  }): Promise<void> {
    if (this.activeDownloadId !== undefined) {
      this.post({
        type: 'downloadError',
        kind: 'Busy',
        message: 'A download is already in progress.',
        retryable: false,
      });
      return;
    }
    const { id, result } = this.service.requestWithHandle<DownloadResult>(
      'download',
      {
        provider: msg.provider,
        broker: msg.broker,
        symbol: msg.symbol,
        timeframe: msg.timeframe,
        from: msg.from,
        to: msg.to,
        truncate: msg.truncate,
      },
      {
        timeoutMs: 0, // a download's duration is unbounded
        onProgress: (p) =>
          this.post({ type: 'downloadProgress', done: p.done, total: p.total, indeterminate: p.indeterminate }),
      }
    );
    this.activeDownloadId = id;
    try {
      const res = await result;
      this.post({ type: 'downloadDone', ohlcvPath: res.ohlcv_path, barsWritten: res.bars_written, symbol: msg.symbol });
      await this.afterDownload(res, msg.symbol);
    } catch (err) {
      const kind = err instanceof ProviderServiceError ? err.kind : 'Error';
      const retryable = err instanceof ProviderServiceError ? err.retryable : false;
      this.post({ type: 'downloadError', kind, message: errMessage(err), retryable });
    } finally {
      this.activeDownloadId = undefined;
    }
  }

  /** Refresh the workspace tree and offer to open the freshly downloaded file.
   * With an armed security prefill, write the symbol_map entry and offer to run
   * the waiting script instead. */
  private async afterDownload(res: DownloadResult, symbol: string): Promise<void> {
    void vscode.commands.executeCommand('pyneide.workspace.refresh');
    const uri = vscode.Uri.file(res.ohlcv_path);
    const prefill = this.prefill;
    if (prefill) {
      this.prefill = undefined;
      await this.recordPrefillMapping(prefill, res.ohlcv_path);
      // A Symbol Map-initiated download carries no script, so the "Run" offer is
      // dropped; the map write above still happened either way.
      const runLabel = prefill.chartKey ? `Run ${path.basename(prefill.chartKey)}` : undefined;
      const actions = runLabel ? [runLabel, 'Open Table'] : ['Open Table'];
      const choice = await vscode.window.showInformationMessage(
        `PyneIDE: downloaded ${symbol} (${res.bars_written.toLocaleString('en-US')} bars) ` +
          `and mapped ${prefill.mapKey}.`,
        ...actions
      );
      if (runLabel && choice === runLabel && prefill.chartKey) {
        await vscode.commands.executeCommand('pyneide.runScript', vscode.Uri.file(prefill.chartKey));
      } else if (choice === 'Open Table') {
        await vscode.commands.executeCommand('vscode.openWith', uri, OhlcvEditorProvider.viewType);
      }
      return;
    }
    const choice = await vscode.window.showInformationMessage(
      `PyneIDE: downloaded ${symbol} (${res.bars_written.toLocaleString('en-US')} bars).`,
      'Open Table',
      'Preview Chart'
    );
    if (choice === 'Open Table') {
      await vscode.commands.executeCommand('vscode.openWith', uri, OhlcvEditorProvider.viewType);
    } else if (choice === 'Preview Chart') {
      await vscode.commands.executeCommand('pyneide.dataPreviewChart', { uri });
    }
  }

  /** Write `mapKey -> provider-qualified native symbol` into the workdir symbol
   * map, taking the provider string from the freshly written sibling `.toml`
   * (`[download]` provider minus its trailing `@TF`). */
  private async recordPrefillMapping(prefill: SecurityPrefill, ohlcvPath: string): Promise<void> {
    const tomlPath = `${ohlcvPath.slice(0, -path.extname(ohlcvPath).length)}.toml`;
    let value: string | undefined;
    try {
      const info = parseSymInfo(fs.readFileSync(tomlPath, 'utf8'));
      if (info.provider) {
        const at = info.provider.lastIndexOf('@');
        value = at > 0 ? info.provider.slice(0, at) : info.provider;
      }
    } catch {
      // No readable toml — skip the map write; the run's picker still resolves.
    }
    if (!value) return;
    try {
      writeSymbolMapEntry(prefill.workdir, prefill.mapKey, value);
      this.deps.output.appendLine(`symbol_map: "${prefill.mapKey}" -> "${value}"`);
    } catch (err) {
      this.deps.output.appendLine(`PyneIDE: symbol_map write failed: ${errMessage(err)}`);
    }
  }

  private async persist(provider?: string, broker?: string, timeframe?: string): Promise<void> {
    if (provider !== undefined) await this.context.globalState.update(LAST_PROVIDER_KEY, provider);
    await this.context.globalState.update(LAST_BROKER_KEY, broker);
    if (timeframe !== undefined) await this.context.globalState.update(LAST_TIMEFRAME_KEY, timeframe);
  }

  private dispose(): void {
    SymbolBrowserPanel.current = undefined;
    this.service.dispose();
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
  }

  private html(webview: vscode.Webview, distRoot: vscode.Uri): string {
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(distRoot, 'symbol-browser.js'));
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; script-src ${webview.cspSource}; style-src 'unsafe-inline';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  html, body { height: 100%; margin: 0; padding: 0; }
  body {
    display: flex; flex-direction: column;
    font-family: var(--vscode-font-family);
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    font-size: 12px;
  }
  #topbar {
    flex: 0 0 auto; display: flex; align-items: center; gap: 8px;
    padding: 6px 10px; user-select: none;
    border-bottom: 1px solid var(--vscode-panel-border, #444);
    background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
  }
  #topbar label { color: var(--vscode-descriptionForeground); }
  select, input[type="text"], input[type="date"] {
    background: var(--vscode-input-background); color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, var(--vscode-panel-border, #444));
    border-radius: 3px; padding: 2px 4px; font-size: 12px; height: 24px;
    color-scheme: light dark;
  }
  #filter { flex: 1; min-width: 80px; }
  #downbar input.custom { width: 90px; }
  #main { flex: 1; min-height: 0; display: flex; }
  #list-pane { flex: 0 0 42%; min-width: 220px; display: flex; flex-direction: column;
    border-right: 1px solid var(--vscode-panel-border, #444); }
  #list-status { flex: 0 0 auto; padding: 4px 10px; color: var(--vscode-descriptionForeground);
    border-bottom: 1px solid var(--vscode-panel-border, #333); }
  #viewport { flex: 1 1 auto; min-height: 0; overflow: auto; position: relative; outline: none; }
  #spacer { position: relative; width: 100%; }
  #window { position: absolute; left: 0; right: 0; top: 0; }
  .sym-row { display: flex; align-items: center; height: 22px; padding: 0 10px;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; cursor: pointer;
    font-variant-numeric: tabular-nums; box-sizing: border-box; }
  .sym-row:hover { background: var(--vscode-list-hoverBackground, rgba(128,128,128,0.1)); }
  .sym-row.sel {
    background: var(--vscode-list-activeSelectionBackground, #094771);
    color: var(--vscode-list-activeSelectionForeground, #fff);
  }
  #info-pane { flex: 1; min-width: 0; overflow: auto; padding: 10px 14px; }
  #info-pane h2 { font-size: 13px; margin: 0 0 2px; }
  #info-sub { color: var(--vscode-descriptionForeground); margin-bottom: 10px; }
  .info-group { margin-bottom: 12px; }
  .info-group h3 {
    font-size: 11px; text-transform: uppercase; letter-spacing: .04em;
    color: var(--vscode-descriptionForeground);
    margin: 0 0 4px; border-bottom: 1px solid var(--vscode-panel-border, #333); padding-bottom: 2px;
  }
  .kv-grid { display: grid; grid-template-columns: max-content 1fr; gap: 2px 14px; }
  .kv-grid .k { color: var(--vscode-descriptionForeground); }
  .kv-grid .v { font-variant-numeric: tabular-nums; word-break: break-word; }
  table.hours { border-collapse: collapse; font-size: 11px; margin-top: 2px; }
  table.hours td { padding: 1px 10px 1px 0; white-space: nowrap; }
  table.hours td.day { color: var(--vscode-descriptionForeground); }
  #info-empty { color: var(--vscode-descriptionForeground); }
  #downbar {
    flex: 0 0 auto; display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
    padding: 6px 10px; user-select: none;
    border-top: 1px solid var(--vscode-panel-border, #444);
    background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
  }
  #downbar label { color: var(--vscode-descriptionForeground); }
  button {
    background: var(--vscode-button-background, #0e639c);
    color: var(--vscode-button-foreground, #fff);
    border: none; border-radius: 3px; cursor: pointer; padding: 3px 12px;
    font-size: 12px; height: 24px;
  }
  button:hover:not(:disabled) { background: var(--vscode-button-hoverBackground, #1177bb); }
  button:disabled { opacity: 0.5; cursor: default; }
  button.secondary {
    background: var(--vscode-button-secondaryBackground, transparent);
    color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
    border: 1px solid var(--vscode-panel-border, #444);
  }
  .check { display: flex; align-items: center; gap: 4px; }
  #progress-wrap { flex: 1 1 100%; display: none; align-items: center; gap: 8px; }
  #progress-wrap.on { display: flex; }
  #progress-track { flex: 1; height: 6px; border-radius: 3px;
    background: var(--vscode-input-background, rgba(128,128,128,0.3)); overflow: hidden; }
  #progress-fill { height: 100%; width: 0%;
    background: var(--vscode-progressBar-background, var(--vscode-button-background, #0e639c));
    transition: width .1s linear; }
  #progress-fill.indeterminate { width: 40% !important; animation: slide 1.2s ease-in-out infinite; }
  @keyframes slide { 0% { margin-left: -40%; } 100% { margin-left: 100%; } }
  #progress-text { color: var(--vscode-descriptionForeground); min-width: 40px; }
  #down-msg { flex: 1 1 100%; }
  #down-msg.err { color: var(--vscode-errorForeground, #f48771); }
  #down-msg.ok { color: var(--vscode-charts-green, #89d185); }
</style>
</head>
<body>
<div id="topbar">
  <label>Provider</label>
  <select id="provider"></select>
  <label id="broker-label" hidden>Broker</label>
  <select id="broker" hidden></select>
  <input type="text" id="filter" placeholder="Filter symbols… (press / to focus)" />
</div>
<div id="main">
  <div id="list-pane">
    <div id="list-status">Select a provider.</div>
    <div id="viewport" tabindex="0">
      <div id="spacer"><div id="window"></div></div>
    </div>
  </div>
  <div id="info-pane">
    <div id="info-empty">Pick a symbol to see its info.</div>
    <div id="info-body" hidden></div>
  </div>
</div>
<div id="downbar">
  <label>Timeframe</label>
  <select id="timeframe"></select>
  <input type="text" id="timeframe-custom" class="custom" placeholder="e.g. 3, 90, 1D" hidden />
  <label>From</label>
  <select id="from"></select>
  <input type="date" id="from-date" hidden />
  <label>To</label>
  <select id="to"></select>
  <input type="date" id="to-date" hidden />
  <label class="check" id="truncate-label" hidden><input type="checkbox" id="truncate" /> truncate</label>
  <button id="download" disabled>Download</button>
  <button id="cancel" class="secondary" hidden>Cancel</button>
  <div id="progress-wrap">
    <div id="progress-track"><div id="progress-fill"></div></div>
    <span id="progress-text"></span>
  </div>
  <div id="down-msg"></div>
</div>
<script src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
