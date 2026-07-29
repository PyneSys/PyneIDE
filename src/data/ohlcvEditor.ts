/**
 * Read-only custom editor for `.ohlcv` files: opens a binary OHLCV data file as
 * a tabular view instead of raw bytes.
 *
 * The binary carries its own schema (v2 header) or is a legacy header-less
 * record array — both are decoded by `ohlcvFormat.ts`; the sibling `.toml`
 * holds the syminfo. The host hands over the file URI and the `[symbol]` toml
 * fields, and the webview parses the records and renders a virtualized table
 * (files reach 100k+ bars, so nothing is materialized on the host side).
 */
import * as path from 'node:path';

import * as vscode from 'vscode';

import type { OhlcvMeta, TableOutMessage } from './messages';
import { parseSymInfo } from './syminfo';

/** Minimal read-only document: the .ohlcv is loaded straight from its uri. */
class OhlcvDocument implements vscode.CustomDocument {
  constructor(public readonly uri: vscode.Uri) {}
  dispose(): void {}
}

export class OhlcvEditorProvider implements vscode.CustomReadonlyEditorProvider<OhlcvDocument> {
  static readonly viewType = 'pyneide.ohlcvTable';

  constructor(private readonly context: vscode.ExtensionContext) {}

  register(): vscode.Disposable {
    return vscode.window.registerCustomEditorProvider(OhlcvEditorProvider.viewType, this, {
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: false,
    });
  }

  openCustomDocument(uri: vscode.Uri): OhlcvDocument {
    return new OhlcvDocument(uri);
  }

  async resolveCustomEditor(
    document: OhlcvDocument,
    panel: vscode.WebviewPanel
  ): Promise<void> {
    const distRoot = vscode.Uri.joinPath(this.context.extensionUri, 'dist');
    const dataDir = vscode.Uri.joinPath(document.uri, '..');
    // The webview loads the big binary itself (see sendData) — its directory
    // must be a local resource root so the fetch() URI is allowed.
    panel.webview.options = { enableScripts: true, localResourceRoots: [distRoot, dataDir] };
    panel.webview.html = this.html(panel.webview, distRoot);

    // The webview reports 'ready' once its script is live; only then does a
    // postMessage reliably arrive. Load and push the data on that signal.
    panel.webview.onDidReceiveMessage(async (msg: TableOutMessage) => {
      if (msg.type === 'ready') {
        await this.sendData(document.uri, panel);
      }
    });
  }

  private async sendData(uri: vscode.Uri, panel: vscode.WebviewPanel): Promise<void> {
    const meta = await this.loadMeta(uri);
    // Hand over a fetchable resource URI, not the bytes: the webview streams the
    // file natively, avoiding VSCode's O(n) postMessage serialization of a
    // multi-MB Uint8Array (the "1 year takes a minute" bug).
    const dataUri = panel.webview.asWebviewUri(uri);
    void panel.webview.postMessage({ type: 'data', uri: dataUri.toString(), meta });
  }

  /** Read the sibling `.toml` and pull the `[symbol]` fields the table needs. */
  private async loadMeta(uri: vscode.Uri): Promise<OhlcvMeta> {
    const meta: OhlcvMeta = { fileName: path.basename(uri.fsPath) };
    const tomlUri = uri.with({ path: uri.path.replace(/\.ohlcv$/i, '.toml') });
    let text: string;
    try {
      text = Buffer.from(await vscode.workspace.fs.readFile(tomlUri)).toString('utf8');
    } catch {
      return meta; // no sibling toml — fall back to the raw records
    }
    const full = parseSymInfo(text);
    const sym = full.symbol;
    meta.description = sym.description;
    meta.ticker = sym.ticker;
    meta.currency = sym.currency;
    meta.basecurrency = sym.basecurrency;
    meta.period = sym.period;
    meta.type = sym.type;
    meta.timezone = sym.timezone;
    meta.mintick = numOr(sym.mintick);
    meta.pricescale = numOr(sym.pricescale);
    meta.full = full;
    return meta;
  }

  private html(webview: vscode.Webview, distRoot: vscode.Uri): string {
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(distRoot, 'ohlcv-table.js'));
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; script-src ${webview.cspSource}; style-src 'unsafe-inline'; connect-src ${webview.cspSource};">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  html, body { height: 100%; margin: 0; padding: 0; }
  body {
    display: flex; flex-direction: column;
    font-family: var(--vscode-font-family);
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
  }
  #header {
    flex: 0 0 auto; padding: 6px 10px; user-select: none;
    border-bottom: 1px solid var(--vscode-panel-border, #444);
    background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
  }
  #title { font-size: 13px; font-weight: 600; }
  #subtitle {
    font-size: 11px; color: var(--vscode-descriptionForeground); margin-top: 2px;
    display: flex; flex-wrap: wrap; gap: 4px 14px; align-items: center;
  }
  #subtitle .kv b { color: var(--vscode-foreground); font-weight: 600; }
  #subtitle .spacer { flex: 1; }
  #tz-toggle {
    background: var(--vscode-button-secondaryBackground, transparent);
    color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
    border: 1px solid var(--vscode-panel-border, #444); border-radius: 3px;
    cursor: pointer; padding: 1px 8px; font-size: 11px; height: 20px;
  }
  #tz-toggle:hover { background: var(--vscode-list-hoverBackground, #333); }
  #tz-toggle[hidden] { display: none; }
  #info-toggle {
    margin-top: 6px; display: inline-flex; align-items: center; gap: 4px;
    background: none; border: none; cursor: pointer; padding: 0;
    color: var(--vscode-textLink-foreground, var(--vscode-foreground));
    font-size: 11px; font-family: var(--vscode-font-family);
  }
  #info-toggle:hover { text-decoration: underline; }
  #info-toggle[hidden] { display: none; }
  #info-toggle .chev { display: inline-block; transition: transform .12s ease; }
  #info-toggle.open .chev { transform: rotate(90deg); }
  #syminfo-panel {
    margin-top: 8px; display: none; gap: 18px 28px; flex-wrap: wrap;
    font-size: 11px;
  }
  #syminfo-panel.open { display: flex; }
  #syminfo-panel .group { min-width: 180px; }
  #syminfo-panel .group h4 {
    margin: 0 0 3px; font-size: 10px; text-transform: uppercase; letter-spacing: .04em;
    color: var(--vscode-descriptionForeground);
    border-bottom: 1px solid var(--vscode-panel-border, #333); padding-bottom: 2px;
  }
  #syminfo-panel .kv-grid { display: grid; grid-template-columns: max-content 1fr; gap: 1px 12px; }
  #syminfo-panel .kv-grid .k { color: var(--vscode-descriptionForeground); }
  #syminfo-panel .kv-grid .v { font-variant-numeric: tabular-nums; word-break: break-word; }
  #syminfo-panel table.hours { border-collapse: collapse; font-size: 11px; }
  #syminfo-panel table.hours td { padding: 1px 10px 1px 0; white-space: nowrap; }
  #syminfo-panel table.hours td.day { color: var(--vscode-descriptionForeground); }
  .grid-row {
    display: flex; align-items: center; height: 22px;
    font-size: 12px; font-variant-numeric: tabular-nums;
    box-sizing: border-box;
  }
  .grid-row > div {
    padding: 0 10px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    box-sizing: border-box;
  }
  .c-idx   { flex: 0 0 78px;  text-align: right; color: var(--vscode-descriptionForeground); }
  .c-time  { flex: 0 0 190px; text-align: left; }
  .c-num   { flex: 1 1 96px;  text-align: right; min-width: 84px; }
  #thead {
    flex: 0 0 auto;
    border-bottom: 1px solid var(--vscode-panel-border, #444);
    background: var(--vscode-editor-background);
    color: var(--vscode-descriptionForeground);
    font-weight: 600;
  }
  #thead .sortable { cursor: pointer; user-select: none; }
  #thead .sortable:hover { color: var(--vscode-foreground); }
  #thead .sort-arrow { font-size: 9px; opacity: .8; }
  #viewport { flex: 1 1 auto; min-height: 0; overflow: auto; position: relative; }
  #spacer { position: relative; width: 100%; }
  #window { position: absolute; left: 0; right: 0; top: 0; }
  #window .grid-row:nth-child(even) { background: var(--vscode-list-hoverBackground, rgba(128,128,128,0.06)); }
  .up { color: var(--vscode-charts-green, #26a69a); }
  .down { color: var(--vscode-charts-red, #ef5350); }
  #empty { padding: 20px; color: var(--vscode-descriptionForeground); }
</style>
</head>
<body>
<div id="header">
  <div id="title">Loading…</div>
  <div id="subtitle"></div>
  <button id="info-toggle" hidden><span class="chev">▸</span><span>Symbol info</span></button>
  <div id="syminfo-panel"></div>
</div>
<div id="thead" class="grid-row">
  <div class="c-idx">#</div>
  <div class="c-time" id="th-time">Time</div>
  <div class="c-num">Open</div>
  <div class="c-num">High</div>
  <div class="c-num">Low</div>
  <div class="c-num">Close</div>
  <div class="c-num">Volume</div>
</div>
<div id="viewport">
  <div id="spacer"><div id="window"></div></div>
</div>
<div id="empty" hidden></div>
<script src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function numOr(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}
