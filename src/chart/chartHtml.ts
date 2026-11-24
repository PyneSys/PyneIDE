/**
 * The chart webview's page. A chart tab loads it as its webview HTML; a
 * dashboard loads it into one iframe per chart (`embedded`), with a shim script
 * before the chart bundle that stands in for the VS Code webview API.
 */

export type ChartScript = { src: string } | { code: string };

export interface ChartHtmlOptions {
  /** The webview's resource origin, allowed as a script source. */
  cspSource: string;
  /** Scripts in load order; the chart bundle comes last. */
  scripts: ChartScript[];
  /** Allows the inline (`code`) scripts. */
  nonce?: string;
  /** A chart inside a dashboard cell. */
  embedded?: boolean;
}

function scriptTag(script: ChartScript, nonce: string | undefined): string {
  if ('src' in script) return `<script src="${script.src}"></script>`;
  // An inline script ends at the first `</script`, wherever it stands
  const code = script.code.replace(/<\/(script)/gi, '<\\/$1');
  return `<script nonce="${nonce ?? ''}">${code}</script>`;
}

/** The dashboard cell's "Add script", after the symbol and the timeframe. Where
 * the toolbar runs short of room it shrinks to its icon and a plus
 * (`data-compact`, see toolbarOverflow) before any tool goes to the overflow menu. */
const ADD_SCRIPT_GROUP = `  <div class="toolbar-group">
    <button id="tb-add-script" title="Add an indicator or a strategy to this chart"
            aria-label="Add script" data-compact>
      <svg viewBox="0 0 20 20" aria-hidden="true">
        <path d="M8.5 15.5c1.2 0 1.8-.8 2-2l1.3-7.5c.2-1.2.8-2 2-2M7.5 8.5h6"></path>
      </svg>
      <span class="compact-label">Add script</span>
      <svg class="compact-mark" viewBox="0 0 20 20" aria-hidden="true">
        <path d="M10 5.5v9M5.5 10h9"></path>
      </svg>
    </button>
  </div>`;

/** The dashboard cell's own actions, at the right end of the toolbar. */
const CELL_GROUP = `  <div class="toolbar-group">
    <button id="tb-split" class="icon-button" title="Add a chart beside this one"
            aria-label="Add a chart beside this one" aria-pressed="false" aria-haspopup="menu">
      <svg viewBox="0 0 20 20" aria-hidden="true">
        <rect x="2.5" y="3.5" width="15" height="13" rx="1.5"></rect>
        <path d="M10 3.5v13"></path>
      </svg>
    </button>
    <button id="tb-full-chart" class="icon-button"
            title="Maximize: fill the dashboard, with trades, performance and stats"
            aria-label="Maximize" aria-pressed="false">
      <svg viewBox="0 0 20 20" aria-hidden="true">
        <path d="M11.5 3.5h5v5M16.5 3.5l-6 6M8.5 16.5h-5v-5M3.5 16.5l6-6"></path>
      </svg>
    </button>
    <button id="tb-remove-chart" class="icon-button" title="Remove this chart from the dashboard"
            aria-label="Remove this chart">
      <svg viewBox="0 0 20 20" aria-hidden="true">
        <path d="M5 5l10 10M15 5 5 15"></path>
      </svg>
    </button>
  </div>`;

/** A chart tab's output files. */
const CSV_GROUP = `  <div class="toolbar-group">
    <button id="tb-csv-plot" class="icon-button" title="Open plot output CSV"
            aria-label="Open plot output CSV" disabled>
      <svg viewBox="0 0 20 20" aria-hidden="true">
        <path d="M3 15.5h14M4.5 13l3.4-3.5 2.7 2 4.9-5"></path>
        <path d="M13 6.5h2.5V9"></path>
      </svg>
    </button>
    <button id="tb-csv-trades" class="icon-button" title="Open trades output CSV"
            aria-label="Open trades output CSV" disabled hidden>
      <svg viewBox="0 0 20 20" aria-hidden="true">
        <rect x="3" y="3.5" width="14" height="13" rx="1.5"></rect>
        <path d="M3 8h14M8 3.5v13M12.5 8v8.5"></path>
      </svg>
    </button>
  </div>`;

export function chartHtml(opts: ChartHtmlOptions): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; script-src ${opts.cspSource}${opts.nonce ? ` 'nonce-${opts.nonce}'` : ''}; style-src 'unsafe-inline';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  html, body { height: 100%; margin: 0; padding: 0; }
  body { display: flex; flex-direction: column; font-family: var(--vscode-font-family); }
  #toolbar {
    --toolbar-height: 36px;
    flex: 0 0 var(--toolbar-height); display: flex; align-items: center;
    box-sizing: border-box; padding: 3px 6px; user-select: none;
    border-bottom: 1px solid var(--vscode-panel-border, #444);
    background: var(--vscode-editor-background);
  }
  #toolbar-items {
    flex: 1; min-width: 0; display: flex; align-items: center; overflow: hidden;
  }
  #toolbar .toolbar-group { flex: none; display: flex; align-items: center; gap: 2px; }
  #toolbar .toolbar-group > *, #tb-more { flex: none; }
  #toolbar .toolbar-group:not(:has(> :not([hidden], .in-overflow))),
  #toolbar #toolbar-items .in-overflow { display: none; }
  #toolbar .toolbar-group:has(> :not([hidden], .in-overflow)) ~ .toolbar-group:not(.toolbar-status)::before {
    content: ""; width: 1px; height: 20px; margin: 0 4px 0 6px;
    background: var(--vscode-panel-border, #444);
  }
  #toolbar button {
    border: 0; color: var(--vscode-foreground); background: transparent;
    cursor: pointer; font: inherit;
  }
  #toolbar button:focus-visible {
    outline: 1px solid var(--vscode-focusBorder, #007fd4); outline-offset: -1px;
  }
  #toolbar button:hover:not(:disabled) {
    background: var(--vscode-toolbar-hoverBackground, var(--vscode-list-hoverBackground, #333));
  }
  #toolbar button:disabled { opacity: 0.35; cursor: default; }
  #toolbar .symbol-button {
    display: flex; align-items: center; gap: 7px; max-width: min(280px, 34vw);
    height: 28px; min-width: 35px; padding: 0 8px 0 5px; border-radius: 7px;
  }
  #toolbar .symbol-mark {
    display: flex; align-items: center; justify-content: center; flex: 0 0 auto;
    width: 22px; height: 22px; border-radius: 50%;
    color: var(--vscode-button-foreground, #fff);
    background: var(--vscode-button-background, #2962ff);
  }
  #toolbar .symbol-mark svg { width: 14px; height: 14px; }
  #toolbar .symbol-copy { display: flex; align-items: baseline; gap: 6px; min-width: 0; }
  #toolbar .symbol-name {
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    font-size: 12px; font-weight: 600; letter-spacing: 0.01em;
  }
  #toolbar .symbol-period {
    flex: 0 0 auto; color: var(--vscode-descriptionForeground);
    font-size: 11px; font-variant-numeric: tabular-nums;
  }
  #toolbar .symbol-period[hidden] { display: none; }
  #toolbar #tb-timeframe {
    height: 28px; min-width: 28px; padding: 0 8px; border-radius: 7px;
    font-size: 12px; font-weight: 600; font-variant-numeric: tabular-nums;
  }
  #toolbar #tb-timeframe[hidden] { display: none; }
  #toolbar #tb-timeframe.active {
    background: var(--vscode-toolbar-activeBackground, var(--vscode-list-hoverBackground, #333));
  }
  #debug-position { color: var(--vscode-editorWarning-foreground, #cca700); white-space: nowrap; }
  /* Live feed state; the dot pulses while the feed delivers. */
  #live-status {
    display: inline-flex; align-items: center; gap: 5px; margin-left: 6px;
    padding: 1px 8px 1px 7px; border-radius: 9px; white-space: nowrap;
    font-size: 10px; font-weight: 600; letter-spacing: 0.03em;
    color: var(--vscode-descriptionForeground);
    border: 1px solid var(--vscode-panel-border, #444);
  }
  #live-status[hidden] { display: none; }
  #live-status::before {
    content: ""; width: 7px; height: 7px; border-radius: 50%; background: currentColor;
  }
  #live-status[data-state="live"] { color: var(--vscode-testing-iconPassed, #73c991); }
  #live-status[data-state="live"]::before { animation: live-pulse 1.6s ease-in-out infinite; }
  #live-status[data-state="reconnecting"] { color: var(--vscode-editorWarning-foreground, #cca700); }
  #live-status[data-state="market_closed"] { color: var(--vscode-descriptionForeground); }
  #live-status[data-state="stopped"]::before { border-radius: 1px; }
  @keyframes live-pulse { 50% { opacity: 0.35; } }
  @media (prefers-reduced-motion: reduce) { #live-status::before { animation: none !important; } }
  #toolbar .icon-button {
    position: relative; display: inline-flex; align-items: center; justify-content: center;
    width: 28px; height: 28px; padding: 0; border-radius: 5px;
  }
  #toolbar .icon-button[hidden] { display: none; }
  #toolbar .icon-button svg {
    width: 17px; height: 17px; fill: none; stroke: currentColor;
    stroke-width: 1.45; stroke-linecap: round; stroke-linejoin: round;
  }
  #toolbar .icon-button.active {
    color: var(--vscode-button-foreground, #fff);
    background: var(--vscode-button-background, #0e639c);
  }
  /* Struck-through variant of an icon, drawn only while the button is on. */
  #toolbar .icon-button .slash { display: none; }
  #toolbar .icon-button.active .slash { display: inline; }
  #toolbar .count-badge {
    position: absolute; right: 1px; top: 1px; min-width: 11px; height: 11px;
    box-sizing: border-box; padding: 0 2px; border-radius: 6px;
    color: var(--vscode-badge-foreground, #fff);
    background: var(--vscode-badge-background, #4d4d4d);
    font-size: 8px; font-weight: 700; line-height: 11px; text-align: center;
  }
  #toolbar .spacer { flex: 1; }
  #toolbar #tb-more[aria-expanded="true"] {
    background: var(--vscode-toolbar-activeBackground, var(--vscode-list-hoverBackground, #333));
  }
  #toolbar-overflow {
    position: fixed; z-index: 20; top: calc(var(--toolbar-height) + 3px); right: 6px;
    display: flex; flex-direction: column; gap: 1px; width: max-content;
    max-width: calc(100% - 12px); max-height: calc(100% - var(--toolbar-height) - 8px);
    overflow: auto;
    box-sizing: border-box; padding: 4px;
    background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
    border: 1px solid var(--vscode-panel-border, #444); border-radius: 4px;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.35);
  }
  #toolbar-overflow[hidden], #toolbar-overflow [hidden] { display: none; }
  #toolbar-overflow .toolbar-overflow-item {
    flex: none; padding: 4px 10px; border-radius: 3px; text-align: left;
    font-size: 12px; overflow-wrap: anywhere;
  }
  #toolbar-overflow button[aria-pressed="true"] {
    background: var(--vscode-list-activeSelectionBackground, #04395e);
    color: var(--vscode-list-activeSelectionForeground, var(--vscode-foreground));
  }
  #toolbar-overflow span { color: var(--vscode-descriptionForeground); }
  #goto-popup {
    position: absolute; z-index: 20; display: flex; align-items: center; gap: 4px;
    box-sizing: border-box; width: min(340px, calc(100% - 12px)); padding: 6px;
    background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
    border: 1px solid var(--vscode-panel-border, #444); border-radius: 4px;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.35); user-select: none;
  }
  #goto-popup[hidden] { display: none; }
  #goto-popup input[type="datetime-local"] {
    flex: 1 1 auto; width: 0; min-width: 0; box-sizing: border-box;
    background: var(--vscode-input-background); color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, var(--vscode-panel-border, #444));
    border-radius: 3px; padding: 1px 4px; font-size: 11px; height: 22px;
    color-scheme: light dark;
  }
  #goto-popup button {
    flex: 0 0 auto; white-space: nowrap; height: 22px; padding: 2px 8px;
    background: var(--vscode-button-secondaryBackground, transparent);
    color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
    border: 1px solid var(--vscode-panel-border, #444); border-radius: 3px;
    cursor: pointer; font-size: 11px;
  }
  #goto-popup button:hover {
    background: var(--vscode-button-secondaryHoverBackground, var(--vscode-list-hoverBackground, #333));
  }
  #plots-popup {
    position: absolute; z-index: 20; display: flex; flex-direction: column; gap: 1px;
    min-width: min(140px, calc(100vw - 12px)); max-width: min(320px, calc(100vw - 12px));
    max-height: 60%; overflow: auto; box-sizing: border-box;
    padding: 4px; font-size: 11px; user-select: none;
    background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
    border: 1px solid var(--vscode-panel-border, #444); border-radius: 4px;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.35);
  }
  #plots-popup[hidden] { display: none; }
  #plots-popup .plot-row {
    display: flex; align-items: center; gap: 6px; padding: 2px 6px;
    width: 100%; border: 0; background: transparent; text-align: left; font: inherit;
    cursor: pointer; border-radius: 3px;
  }
  #plots-popup .plot-row:hover { background: var(--vscode-list-hoverBackground, #333); }
  #plots-popup .plot-swatch { width: 9px; height: 9px; flex: 0 0 auto; border-radius: 2px; }
  #plots-popup .plot-name { min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  #plots-popup .plot-sep { height: 1px; margin: 3px 4px; background: var(--vscode-panel-border, #444); }
  #plots-popup .plot-section {
    padding: 3px 6px 1px; font-size: 10px; text-transform: uppercase;
    letter-spacing: 0.04em; color: var(--vscode-descriptionForeground);
  }
  #plots-popup .plot-row.in-script { padding-left: 14px; }
  #plots-popup .script-group:not(:first-child) {
    margin-top: 3px; padding-top: 3px; border-top: 1px solid var(--vscode-panel-border, #444);
  }
  #plots-popup .script-head { display: flex; align-items: center; gap: 2px; }
  #plots-popup .script-name {
    flex: 1 1 auto; min-width: 0; padding: 3px 6px; border: 0; border-radius: 3px;
    background: transparent; color: var(--vscode-foreground); font: inherit; font-weight: 600;
    text-align: left; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; cursor: pointer;
  }
  #plots-popup .script-name:disabled { cursor: default; }
  #plots-popup .script-name.off { opacity: 0.5; text-decoration: line-through; }
  #plots-popup .script-name:hover:not(:disabled),
  #plots-popup .script-action:hover { background: var(--vscode-list-hoverBackground, #333); }
  #plots-popup .script-action {
    flex: none; display: inline-flex; align-items: center; justify-content: center;
    width: 22px; height: 22px; padding: 0; border: 0; border-radius: 3px; cursor: pointer;
    background: transparent; color: var(--vscode-descriptionForeground);
  }
  #plots-popup .script-action:hover { color: var(--vscode-foreground); }
  #plots-popup .script-action svg {
    width: 15px; height: 15px; fill: none; stroke: currentColor;
    stroke-width: 1.4; stroke-linecap: round; stroke-linejoin: round;
  }
  #plots-popup .script-status {
    display: flex; align-items: center; gap: 8px; padding: 1px 6px 3px 14px;
    color: var(--vscode-descriptionForeground);
  }
  #plots-popup .state-error .script-status { color: var(--vscode-errorForeground, #f14c4c); }
  #plots-popup .script-status span { min-width: 0; overflow-wrap: anywhere; }
  #plots-popup .script-status button {
    flex: none; padding: 1px 8px; border-radius: 3px; cursor: pointer; font: inherit;
    color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
    background: var(--vscode-button-secondaryBackground, transparent);
    border: 1px solid var(--vscode-panel-border, #444);
  }
  #candle-popup {
    position: absolute; z-index: 20; display: flex; flex-direction: column; gap: 1px;
    min-width: min(165px, calc(100vw - 12px)); max-width: calc(100vw - 12px);
    box-sizing: border-box; padding: 4px; font-size: 11px; user-select: none;
    background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
    border: 1px solid var(--vscode-panel-border, #444); border-radius: 4px;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.35);
  }
  #candle-popup[hidden] { display: none; }
  #candle-popup .candle-row {
    display: flex; align-items: center; gap: 7px; padding: 3px 6px;
    cursor: pointer; border-radius: 3px;
  }
  #candle-popup .candle-row:hover { background: var(--vscode-list-hoverBackground, #333); }
  #candle-popup .candle-row.active {
    color: var(--vscode-list-activeSelectionForeground, var(--vscode-foreground));
    background: var(--vscode-list-activeSelectionBackground, #04395e);
  }
  #candle-popup .candle-row svg {
    flex: 0 0 auto; width: 16px; height: 16px; display: block;
    fill: none; stroke: currentColor; stroke-width: 1.2;
    stroke-linecap: round; stroke-linejoin: round;
  }
  #candle-popup .candle-name { flex: 1 1 auto; overflow-wrap: anywhere; }
  #candle-popup .candle-check { flex: 0 0 auto; width: 10px; text-align: center; }
  #candle-popup .candle-sep { height: 1px; margin: 3px 4px; background: var(--vscode-panel-border, #444); }
  #candle-popup .candle-section {
    padding: 3px 6px 1px; font-size: 10px; text-transform: uppercase;
    letter-spacing: 0.04em; color: var(--vscode-descriptionForeground);
  }
  #tf-popup {
    position: absolute; z-index: 20; display: flex; flex-direction: column; gap: 1px;
    min-width: min(96px, calc(100vw - 12px)); max-width: calc(100vw - 12px);
    box-sizing: border-box; padding: 4px; font-size: 11px; user-select: none;
    background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
    border: 1px solid var(--vscode-panel-border, #444); border-radius: 4px;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.35);
  }
  #tf-popup[hidden] { display: none; }
  #tf-popup .tf-row {
    display: flex; align-items: center; gap: 7px; padding: 3px 6px;
    cursor: pointer; border-radius: 3px; font-variant-numeric: tabular-nums;
  }
  #tf-popup .tf-row:hover { background: var(--vscode-list-hoverBackground, #333); }
  #tf-popup .tf-row.active {
    color: var(--vscode-list-activeSelectionForeground, var(--vscode-foreground));
    background: var(--vscode-list-activeSelectionBackground, #04395e);
  }
  #tf-popup .tf-name { flex: 1 1 auto; overflow-wrap: anywhere; }
  #tf-popup .tf-check { flex: 0 0 auto; width: 10px; text-align: center; }
  #tf-popup .tf-sep { height: 1px; margin: 3px 4px; background: var(--vscode-panel-border, #444); }
  /* Price-scale controls, parked in the corner between the two axes the way a
     trading chart does it: they belong to the price axis, not to the toolbar. */
  #scale-controls {
    position: absolute; right: 3px; bottom: 3px; z-index: 6;
    display: flex; gap: 2px; user-select: none;
  }
  #scale-controls[hidden] { display: none; }
  #scale-controls button {
    min-width: 16px; height: 15px; padding: 0 3px;
    display: flex; align-items: center; justify-content: center;
    font-size: 9px; line-height: 1; font-family: inherit;
    color: var(--vscode-descriptionForeground, #999);
    background: none; border: 1px solid transparent; border-radius: 2px;
    cursor: pointer; opacity: 0.85;
  }
  #scale-controls button:hover {
    opacity: 1; color: var(--vscode-foreground, #ccc);
    background: var(--vscode-toolbar-hoverBackground, rgba(255, 255, 255, 0.1));
  }
  #scale-controls button.active {
    opacity: 1; color: var(--vscode-button-foreground, #fff);
    background: var(--vscode-button-background, #0e639c);
    border-color: var(--vscode-button-background, #0e639c);
  }
  #breakpoints-popup {
    position: absolute; z-index: 20; display: flex; flex-direction: column; gap: 1px;
    min-width: min(250px, calc(100vw - 12px)); max-width: min(420px, calc(100vw - 12px));
    max-height: 60%; overflow: auto; box-sizing: border-box; padding: 4px;
    font-size: 11px; user-select: none;
    background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
    border: 1px solid var(--vscode-panel-border, #444); border-radius: 4px;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.35);
  }
  #breakpoints-popup[hidden] { display: none; }
  #breakpoints-popup .breakpoint-row {
    display: flex; align-items: center; gap: 7px; padding: 3px 4px 3px 7px;
    cursor: pointer; border-radius: 3px;
  }
  #breakpoints-popup .breakpoint-row:hover {
    background: var(--vscode-list-hoverBackground, #333);
  }
  #breakpoints-popup .breakpoint-dot {
    width: 9px; height: 9px; flex: 0 0 auto; border-radius: 50%;
  }
  #breakpoints-popup .breakpoint-label {
    flex: 1 1 auto; min-width: 0; white-space: nowrap;
    overflow: hidden; text-overflow: ellipsis;
  }
  #breakpoints-popup .breakpoint-delete {
    flex: 0 0 auto; width: 20px; height: 20px; padding: 0; border: none;
    border-radius: 3px; background: transparent; color: var(--vscode-foreground);
    cursor: pointer; font-size: 14px; line-height: 20px;
  }
  #breakpoints-popup .breakpoint-delete:hover {
    background: var(--vscode-toolbar-hoverBackground, var(--vscode-list-hoverBackground, #333));
  }
  #script-legend {
    flex: 0 0 auto; padding: 4px 8px 0; min-width: 0;
    font-size: 12px; line-height: 18px; font-weight: 600;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  #script-legend[hidden] { display: none; }
  #chart-row { flex: 1; min-height: 0; display: flex; }
  #drawing-tools {
    flex: 0 0 auto; width: 38px; box-sizing: border-box; padding: 4px 0;
    display: flex; flex-direction: column; align-items: center; gap: 2px;
    overflow: hidden; user-select: none;
    border-right: 1px solid var(--vscode-panel-border, #444);
    background: var(--vscode-editor-background);
  }
  #drawing-tools[hidden], #drawing-tools [hidden], #drawing-tools .dt-overflow { display: none; }
  #drawing-tools button {
    flex: none; display: inline-flex; align-items: center; justify-content: center;
    width: 28px; height: 28px; padding: 0; border: 0; border-radius: 5px;
    color: var(--vscode-foreground); background: transparent; cursor: pointer;
  }
  #drawing-tools button:hover:not(:disabled) {
    background: var(--vscode-toolbar-hoverBackground, var(--vscode-list-hoverBackground, #333));
  }
  #drawing-tools button:focus-visible {
    outline: 1px solid var(--vscode-focusBorder, #007fd4); outline-offset: -1px;
  }
  #drawing-tools button:disabled { opacity: 0.35; cursor: default; }
  #drawing-tools button.active {
    color: var(--vscode-button-foreground, #fff);
    background: var(--vscode-button-background, #0e639c);
  }
  #drawing-tools svg {
    width: 17px; height: 17px; fill: none; stroke: currentColor;
    stroke-width: 1.45; stroke-linecap: round; stroke-linejoin: round;
  }
  #drawing-tools .slash { display: none; }
  #drawing-tools button.active .slash { display: inline; }
  #drawing-tools .dt-sep {
    flex: none; width: 20px; height: 1px; margin: 3px 0;
    background: var(--vscode-panel-border, #444);
  }
  #drawing-tools-menu {
    position: fixed; z-index: 20; display: flex; flex-direction: column; gap: 1px;
    width: max-content; max-height: calc(100% - 8px); overflow: auto;
    box-sizing: border-box; padding: 4px; font-size: 12px; user-select: none;
    background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
    border: 1px solid var(--vscode-panel-border, #444); border-radius: 4px;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.35);
  }
  #drawing-tools-menu[hidden] { display: none; }
  #drawing-tools-menu button {
    display: flex; align-items: center; gap: 8px; padding: 3px 10px 3px 6px;
    border: 0; border-radius: 3px; background: transparent; color: var(--vscode-foreground);
    font: inherit; text-align: left; white-space: nowrap; cursor: pointer;
  }
  #drawing-tools-menu button:hover:not(:disabled) {
    background: var(--vscode-list-hoverBackground, #333);
  }
  #drawing-tools-menu button:disabled { opacity: 0.4; cursor: default; }
  #drawing-tools-menu button[aria-pressed="true"] {
    background: var(--vscode-list-activeSelectionBackground, #04395e);
    color: var(--vscode-list-activeSelectionForeground, var(--vscode-foreground));
  }
  #drawing-tools-menu svg {
    flex: none; width: 16px; height: 16px; fill: none; stroke: currentColor;
    stroke-width: 1.45; stroke-linecap: round; stroke-linejoin: round;
  }
  #drawing-tools-menu .slash { display: none; }
  #drawing-tools-menu button[aria-pressed="true"] .slash { display: inline; }
  #drawing-tools-menu .dt-menu-sep {
    height: 1px; margin: 3px 4px; background: var(--vscode-panel-border, #444);
  }
  #chart-area { flex: 1; min-width: 0; min-height: 0; position: relative; }
  #drawing-style-bar {
    position: absolute; z-index: 12; top: 8px; left: 50%; transform: translateX(-50%);
    display: flex; align-items: center; gap: 2px; padding: 3px; user-select: none;
    background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
    border: 1px solid var(--vscode-panel-border, #444); border-radius: 5px;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.35);
  }
  #drawing-style-bar[hidden], #drawing-style-bar [hidden] { display: none; }
  #drawing-style-bar button {
    display: inline-flex; align-items: center; justify-content: center;
    min-width: 28px; height: 26px; padding: 0 3px; border: 0; border-radius: 4px;
    color: var(--vscode-foreground); background: transparent; cursor: pointer;
  }
  #drawing-style-bar button:hover {
    background: var(--vscode-toolbar-hoverBackground, var(--vscode-list-hoverBackground, #333));
  }
  #drawing-style-bar button.active { background: var(--vscode-toolbar-activeBackground, #3a3d41); }
  #drawing-style-bar button:focus-visible {
    outline: 1px solid var(--vscode-focusBorder, #007fd4); outline-offset: -1px;
  }
  #drawing-style-bar svg, #drawing-style-popup .ds-option svg {
    width: 28px; height: 20px; fill: none; stroke: currentColor; stroke-linecap: butt;
  }
  #drawing-style-bar svg[viewBox="0 0 20 20"] {
    width: 17px; height: 17px; stroke-width: 1.45; stroke-linecap: round; stroke-linejoin: round;
  }
  #drawing-style-bar .ds-swatch {
    width: 16px; height: 16px; border-radius: 3px; box-sizing: border-box;
    border: 1px solid var(--vscode-panel-border, #666);
  }
  #drawing-style-popup {
    position: fixed; z-index: 21; box-sizing: border-box; padding: 6px;
    max-height: calc(100% - 8px); overflow: auto; font-size: 12px; user-select: none;
    color: var(--vscode-foreground);
    background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
    border: 1px solid var(--vscode-panel-border, #444); border-radius: 4px;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.35);
  }
  #drawing-style-popup[hidden] { display: none; }
  #drawing-style-popup .ds-palette { display: grid; grid-template-columns: repeat(8, 20px); gap: 4px; }
  #drawing-style-popup .ds-color {
    width: 20px; height: 20px; padding: 0; border-radius: 3px; cursor: pointer;
    border: 1px solid var(--vscode-panel-border, #666);
  }
  #drawing-style-popup .ds-color[aria-pressed="true"] {
    outline: 2px solid var(--vscode-focusBorder, #007fd4); outline-offset: 1px;
  }
  #drawing-style-popup .ds-custom {
    display: flex; align-items: center; gap: 8px; margin-top: 8px; cursor: pointer;
  }
  #drawing-style-popup input[type="color"] {
    width: 24px; height: 20px; padding: 0; border: 1px solid var(--vscode-panel-border, #666);
    border-radius: 3px; background: transparent; cursor: pointer;
  }
  #drawing-style-popup .ds-option {
    display: flex; align-items: center; gap: 8px; width: 100%; padding: 3px 10px 3px 4px;
    border: 0; border-radius: 3px; background: transparent; color: inherit; font: inherit;
    text-align: left; white-space: nowrap; cursor: pointer;
  }
  #drawing-style-popup .ds-option:hover { background: var(--vscode-list-hoverBackground, #333); }
  #drawing-style-popup .ds-option[aria-pressed="true"] {
    background: var(--vscode-list-activeSelectionBackground, #04395e);
    color: var(--vscode-list-activeSelectionForeground, var(--vscode-foreground));
  }
  #drawing-style-popup .ds-levels { display: flex; flex-direction: column; gap: 3px; }
  #drawing-style-popup .ds-level { display: flex; align-items: center; gap: 6px; }
  #drawing-style-popup .ds-level input[type="number"] {
    width: 64px; padding: 1px 4px; font: inherit; color: var(--vscode-input-foreground, inherit);
    background: var(--vscode-input-background, transparent);
    border: 1px solid var(--vscode-input-border, var(--vscode-panel-border, #555)); border-radius: 2px;
  }
  #drawing-style-popup .ds-level-remove {
    width: 20px; height: 20px; padding: 0; border: 0; border-radius: 3px; font-size: 14px;
    color: inherit; background: transparent; cursor: pointer;
  }
  #drawing-style-popup .ds-level-remove:hover { background: var(--vscode-list-hoverBackground, #333); }
  #drawing-style-popup .ds-level-actions { display: flex; gap: 6px; margin-top: 8px; }
  #drawing-style-popup .ds-level-actions button {
    padding: 2px 8px; font: inherit; border: 0; border-radius: 2px; cursor: pointer;
    color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
    background: var(--vscode-button-secondaryBackground, #3a3d41);
  }
  #label-tooltip {
    position: absolute; z-index: 10; box-sizing: border-box;
    width: max-content; max-width: min(360px, calc(100% - 8px)); max-height: 45%;
    overflow: auto; overscroll-behavior: contain; white-space: pre-wrap; overflow-wrap: anywhere;
    padding: 6px 8px; border: 1px solid var(--vscode-editorHoverWidget-border, #555);
    border-radius: 4px; background: var(--vscode-editorHoverWidget-background, #252526);
    color: var(--vscode-editorHoverWidget-foreground, #ddd); user-select: text;
  }
  #label-tooltip a { color: var(--vscode-textLink-foreground, #4daafc); text-decoration: underline; }
  /* Data Window: every value of one bar, docked right of the chart. */
  #data-window {
    flex: 0 0 auto; width: 232px; max-width: 45%; min-width: 0;
    display: flex; flex-direction: column; overflow: hidden;
    border-left: 1px solid var(--vscode-panel-border, #444);
    background: var(--vscode-editor-background);
    color: var(--vscode-foreground); font-size: 11px; user-select: none;
  }
  #data-window[hidden] { display: none; }
  #data-window .dw-header {
    display: flex; align-items: flex-start; gap: 6px; padding: 6px 8px 5px;
    border-bottom: 1px solid var(--vscode-panel-border, #444);
  }
  #data-window .dw-where { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
  #data-window .dw-bar { font-size: 12px; font-weight: 600; font-variant-numeric: tabular-nums; }
  #data-window .dw-time {
    color: var(--vscode-descriptionForeground); font-variant-numeric: tabular-nums;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  #data-window .dw-mode {
    flex: 0 0 auto; margin-top: 1px; padding: 1px 7px; border-radius: 9px;
    border: 1px solid var(--vscode-panel-border, #444); background: transparent;
    color: var(--vscode-descriptionForeground); font: inherit; font-size: 10px;
    white-space: nowrap;
  }
  #data-window .dw-mode[hidden] { display: none; }
  #data-window .dw-mode:disabled { cursor: default; }
  #data-window .dw-mode[data-mode="held"] {
    cursor: pointer; color: var(--vscode-button-foreground, #fff);
    background: var(--vscode-button-background, #0e639c);
    border-color: var(--vscode-button-background, #0e639c);
  }
  #data-window .dw-mode[data-mode="held"]:hover {
    background: var(--vscode-button-hoverBackground, var(--vscode-button-background, #0e639c));
  }
  #data-window .dw-mode[data-mode="paused"] {
    color: var(--vscode-editorWarning-foreground, #cca700); border-color: currentColor;
  }
  #data-window .dw-body { flex: 1; min-height: 0; overflow: auto; padding: 0 0 6px; }
  #data-window .dw-section {
    padding: 8px 8px 2px; font-size: 10px; text-transform: uppercase; letter-spacing: 0.04em;
    color: var(--vscode-descriptionForeground);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  #data-window .dw-row {
    display: grid; grid-template-columns: 9px minmax(0, 1fr) auto; align-items: center;
    column-gap: 6px; width: 100%; box-sizing: border-box; padding: 2px 8px;
    border: 0; border-radius: 0; background: transparent; color: inherit;
    font: inherit; text-align: left; cursor: copy;
  }
  #data-window .dw-row.dw-plain { grid-template-columns: minmax(0, 1fr) auto; }
  #data-window .dw-row:hover:not(:disabled) { background: var(--vscode-list-hoverBackground, #333); }
  #data-window .dw-row:disabled { cursor: default; }
  #data-window .dw-row:focus-visible {
    outline: 1px solid var(--vscode-focusBorder, #007fd4); outline-offset: -1px;
  }
  #data-window .dw-row.dw-copied {
    color: var(--vscode-list-activeSelectionForeground, inherit);
    background: var(--vscode-list-activeSelectionBackground, #094771);
  }
  #data-window .dw-swatch { width: 9px; height: 9px; border-radius: 2px; }
  #data-window .dw-swatch.dw-hollow {
    box-shadow: inset 0 0 0 1px var(--vscode-descriptionForeground, #999);
  }
  #data-window .dw-label { min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  #data-window .dw-value {
    font-family: var(--vscode-editor-font-family, monospace); font-variant-numeric: tabular-nums;
    white-space: nowrap; text-align: right;
  }
  #data-window .dw-value.dw-na { color: var(--vscode-descriptionForeground); font-style: italic; }
  #chart { position: absolute; inset: 0; }
  #breakpoint-pick {
    position: absolute; z-index: 12; top: 8px; left: 50%; transform: translateX(-50%);
    display: flex; align-items: center; gap: 8px; max-width: calc(100% - 24px);
    box-sizing: border-box; padding: 5px 8px; border-radius: 4px;
    color: var(--vscode-editorWidget-foreground, var(--vscode-foreground));
    background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
    border: 1px solid var(--vscode-focusBorder, #007fd4);
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.35); font-size: 11px; user-select: none;
  }
  #breakpoint-pick[hidden] { display: none; }
  /* Shown over a held frame while a re-run recomputes (see freezeChart). */
  #chart-busy {
    position: absolute; z-index: 5; top: 10px; left: 50%; transform: translateX(-50%);
    width: 14px; height: 14px; box-sizing: border-box; border-radius: 50%;
    border: 2px solid var(--vscode-panel-border, #444);
    border-top-color: var(--vscode-progressBar-background, var(--vscode-focusBorder, #007fd4));
    opacity: 0.7; pointer-events: none; animation: chart-busy-spin 0.9s linear infinite;
  }
  #chart-busy[hidden] { display: none; }
  @keyframes chart-busy-spin { to { transform: translateX(-50%) rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { #chart-busy { animation: none; } }
  #breakpoint-pick-label { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  #breakpoint-pick button {
    flex: 0 0 auto; border: none; background: transparent; cursor: pointer;
    color: var(--vscode-foreground); padding: 1px 3px; font-size: 13px;
  }
  #to-realtime {
    position: absolute; right: 68px; top: 10px; z-index: 5;
    width: 22px; height: 22px; border-radius: 50%;
    display: flex; align-items: center; justify-content: center;
    background: var(--vscode-editorWidget-background, rgba(50, 50, 50, 0.75));
    color: var(--vscode-descriptionForeground, #bbb);
    border: 1px solid var(--vscode-panel-border, #444);
    cursor: pointer; font-size: 12px; line-height: 1; padding: 0;
    opacity: 0.55; box-shadow: 0 1px 3px rgba(0, 0, 0, 0.25);
    transition: opacity 0.15s ease, background 0.15s ease, color 0.15s ease;
  }
  #to-realtime:hover {
    opacity: 1;
    background: var(--vscode-button-background, #0e639c);
    color: var(--vscode-button-foreground, #fff);
    border-color: var(--vscode-button-background, #0e639c);
  }
  #to-realtime[hidden] { display: none; }
  #bottom {
    flex: 0 0 auto; height: var(--bottom-height, min(300px, 42vh));
    min-height: 0; display: flex; flex-direction: column;
    background: var(--vscode-editor-background);
    color: var(--vscode-editor-foreground);
  }
  #bottom.collapsed {
    height: 27px; border-top: 1px solid var(--vscode-panel-border, #444);
  }
  #bottom.collapsed .tab-body { display: none; }
  #panel-splitter {
    position: relative; flex: 0 0 5px; cursor: row-resize; touch-action: none;
    background: var(--vscode-editor-background); outline: none;
  }
  #panel-splitter::after {
    content: ""; position: absolute; inset: 2px 0 auto; height: 1px;
    background: var(--vscode-panel-border, #444);
  }
  #panel-splitter:hover::after, #panel-splitter:focus-visible::after,
  body.panel-resizing #panel-splitter::after {
    top: 1px; height: 3px;
    background: var(--vscode-focusBorder, #007fd4);
  }
  #panel-splitter[hidden] { display: none; }
  body.panel-resizing { cursor: row-resize; user-select: none; }
  .tab-bar {
    flex: 0 0 26px; display: flex; align-items: center; gap: 2px;
    padding: 0 6px; user-select: none;
    border-bottom: 1px solid var(--vscode-panel-border, #444);
  }
  .tab-bar button {
    background: none; border: none; cursor: pointer; padding: 4px 10px;
    color: var(--vscode-foreground); font-size: 11px; text-transform: uppercase;
  }
  .tab-bar button.active {
    color: var(--vscode-panelTitle-activeForeground, #fff);
    border-bottom: 1px solid var(--vscode-panelTitle-activeBorder, #fff);
  }
  .tab-bar .spacer { flex: 1; }
  .tab-body { flex: 1; overflow: auto; }
  .tab-body table { border-collapse: collapse; width: 100%; font-size: 12px; }
  .tab-body th, .tab-body td {
    text-align: right; padding: 2px 10px; white-space: nowrap;
    border-bottom: 1px solid var(--vscode-panel-border, #333);
  }
  .tab-body th:first-child, .tab-body td:first-child { text-align: left; }
  .tab-body th {
    position: sticky; top: 0; background: var(--vscode-editor-background);
    color: var(--vscode-descriptionForeground);
  }
  .tab-body tr.clickable { cursor: pointer; }
  .tab-body tr.clickable:hover { background: var(--vscode-list-hoverBackground, #333); }
  .tab-body tr.clickable.selected {
    background: var(--vscode-list-inactiveSelectionBackground, #37373d);
    color: var(--vscode-list-inactiveSelectionForeground, var(--vscode-editor-foreground));
    outline: 1px solid var(--vscode-focusBorder, #007fd4); outline-offset: -1px;
  }
  .trade-details-button {
    display: inline-flex; align-items: center; justify-content: center; vertical-align: middle;
    width: 22px; height: 22px; padding: 2px; border: none; border-radius: 3px;
    color: var(--vscode-descriptionForeground); background: transparent; cursor: pointer;
  }
  .trade-details-button svg { width: 15px; height: 15px; fill: none; stroke: currentColor; stroke-width: 1.4; }
  .trade-details-button:hover, #trade-details button:hover {
    color: var(--vscode-foreground); background: var(--vscode-toolbar-hoverBackground, #333);
  }
  .trade-details-button:focus-visible, #trade-details button:focus-visible {
    outline: 1px solid var(--vscode-focusBorder, #007fd4); outline-offset: -1px;
  }
  #trade-details {
    box-sizing: border-box; width: min(640px, calc(100vw - 24px));
    max-height: calc(100vh - 24px); padding: 0; overflow: auto;
    color: var(--vscode-editorWidget-foreground, var(--vscode-foreground));
    background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
    border: 1px solid var(--vscode-panel-border, #444); border-radius: 6px;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4); font-size: 12px;
  }
  #trade-details::backdrop { background: rgba(0, 0, 0, 0.45); }
  #trade-details header {
    position: sticky; top: 0; display: flex; align-items: center; gap: 12px;
    padding: 10px 16px; z-index: 1;
    background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
    border-bottom: 1px solid var(--vscode-panel-border, #444);
  }
  #trade-details h2 { flex: 1; margin: 0; font-size: 15px; font-weight: 600; }
  #trade-details button {
    width: 28px; height: 28px; padding: 0; border: none; border-radius: 3px;
    background: transparent; color: inherit; cursor: pointer; font-size: 22px;
  }
  .trade-details-content { padding: 0 16px; }
  #trade-details h3 {
    margin: 14px 0 8px; font-size: 12px; font-weight: 600;
    color: var(--vscode-descriptionForeground);
  }
  #trade-details dl { display: grid; grid-template-columns: minmax(100px, 1fr) minmax(0, 2fr); margin: 0; }
  #trade-details dt, #trade-details dd {
    margin: 0; padding: 5px 0; border-bottom: 1px solid var(--vscode-panel-border, #333);
    overflow-wrap: anywhere;
  }
  #trade-details dt { padding-right: 12px; color: var(--vscode-descriptionForeground); }
  #trade-details dd { white-space: pre-wrap; font-variant-numeric: tabular-nums; user-select: text; }
  .trade-details-note { margin: 12px 16px; color: var(--vscode-descriptionForeground); }
  .performance-view {
    height: 100%; min-height: 0; display: flex; flex-direction: column;
    box-sizing: border-box; padding: 8px 10px 6px;
  }
  .performance-summary {
    flex: 0 0 auto; display: grid;
    grid-template-columns: repeat(auto-fit, minmax(104px, 1fr));
    gap: 8px; margin-bottom: 6px;
  }
  .performance-metric {
    min-width: 0; padding: 4px 7px; border-left: 2px solid var(--vscode-panel-border, #444);
  }
  .performance-metric span, .performance-metric small, .performance-metric strong {
    display: block; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .performance-metric span {
    color: var(--vscode-descriptionForeground); font-size: 10px; text-transform: uppercase;
  }
  .performance-metric strong { margin-top: 1px; font-size: 15px; font-weight: 600; }
  .performance-metric small { color: var(--vscode-descriptionForeground); font-size: 10px; }
  .equity-chart-wrap { flex: 1 1 auto; min-height: 80px; position: relative; }
  .equity-chart-title {
    position: absolute; z-index: 1; top: 2px; left: 10px; font-size: 10px;
    color: var(--vscode-descriptionForeground); pointer-events: none;
  }
  #equity-canvas { display: block; width: 100%; height: 100%; cursor: crosshair; }
  .rb-view { box-sizing: border-box; padding: 8px 10px 10px; }
  .rb-view .performance-summary { grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); }
  .rb-view .performance-metric span, .rb-view .performance-metric small {
    white-space: normal; overflow: visible; text-overflow: clip; overflow-wrap: anywhere;
  }
  .rb-charts {
    display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
    gap: 8px; margin: 4px 0 8px;
  }
  .rb-chart {
    position: relative; height: 170px;
    border: 1px solid var(--vscode-panel-border, #333); border-radius: 2px;
  }
  .rb-chart canvas { display: block; width: 100%; height: 100%; }
  .rb-chart-title {
    position: absolute; top: 2px; left: 8px; right: 58px; font-size: 10px;
    color: var(--vscode-descriptionForeground); pointer-events: none;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .rb-notes { margin: 0 0 8px; padding-left: 18px; color: var(--vscode-descriptionForeground); font-size: 11px; }
  .rb-heading {
    margin: 12px 0 4px; font-size: 11px; font-weight: 600; text-transform: uppercase;
    color: var(--vscode-descriptionForeground);
  }
  .tab-body .rb-table th.rb-text, .tab-body .rb-table td.rb-text { text-align: left; white-space: normal; }
  .tab-body .rb-table tr.rb-group td { border-top: 1px solid var(--vscode-panel-border, #444); }
  .tab-body .rb-table th { position: static; }
  #equity-crosshair { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; }
  @media (max-width: 620px) {
    .performance-summary { gap: 5px; grid-template-columns: repeat(auto-fit, minmax(88px, 1fr)); }
    .performance-metric { padding: 3px 5px; }
    .performance-metric strong { font-size: 13px; }
  }
  @media (max-width: 420px) {
    .performance-metric strong { font-size: 12px; }
  }
  /* --pyne-up/--pyne-down are set on the body by the webview from the chosen
     color scheme, so the Stats numbers say up and down the same way the bars
     above them do. The theme colors stay as the fallback for the first paint,
     before the host has pushed the setting. */
  .pos { color: var(--pyne-up, var(--vscode-charts-green, #26a69a)); }
  .neg { color: var(--pyne-down, var(--vscode-charts-red, #ef5350)); }
  .muted { color: var(--vscode-descriptionForeground); padding: 8px; display: block; }
  /* A chart inside a dashboard cell: the dashboard owns the run, so the
     bottom panel, the chart breakpoints and the script's name have no use here
     (the Layers menu names the scripts) */
  /* A cell is narrower than a chart tab: the symbol may take more of it, its
     tools go to the overflow menu first */
  body.embedded #toolbar .symbol-button { max-width: min(280px, 55vw); }
  body.embedded:not(.maximized) #bottom, body.embedded:not(.maximized) #panel-splitter,
  body.embedded #script-legend,
  body.embedded #tb-breakpoints, body.embedded #breakpoint-pick { display: none !important; }
  #toolbar #tb-add-script {
    display: inline-flex; align-items: center; gap: 5px; height: 28px; padding: 0 9px 0 6px;
    border-radius: 7px; font-size: 12px; white-space: nowrap;
  }
  #toolbar #tb-add-script svg {
    width: 16px; height: 16px; fill: none; stroke: currentColor;
    stroke-width: 1.45; stroke-linecap: round; stroke-linejoin: round;
  }
  #toolbar #tb-add-script .compact-mark { display: none; width: 12px; height: 12px; }
  #toolbar #tb-add-script.compact { gap: 0; padding: 0 5px 0 4px; }
  #toolbar #tb-add-script.compact .compact-label { display: none; }
  #toolbar #tb-add-script.compact .compact-mark { display: inline; margin-left: -3px; }
  #toolbar #tb-layers.has-error .count-badge {
    color: var(--vscode-editor-background, #1e1e1e);
    background: var(--vscode-errorForeground, #f14c4c);
  }
  #split-popup {
    position: absolute; z-index: 20; display: flex; flex-direction: column; gap: 1px;
    box-sizing: border-box; padding: 4px; font-size: 11px; user-select: none;
    background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
    border: 1px solid var(--vscode-panel-border, #444); border-radius: 4px;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.35);
  }
  #split-popup[hidden] { display: none; }
  #split-popup button {
    display: flex; align-items: center; gap: 7px; padding: 3px 8px 3px 6px; border: 0;
    border-radius: 3px; background: transparent; color: var(--vscode-foreground);
    font: inherit; text-align: left; cursor: pointer; white-space: nowrap;
  }
  #split-popup button:hover:not(:disabled) { background: var(--vscode-list-hoverBackground, #333); }
  #split-popup button:disabled { opacity: 0.4; cursor: default; }
  #split-popup svg {
    width: 16px; height: 16px; fill: none; stroke: currentColor;
    stroke-width: 1.2; stroke-linecap: round; stroke-linejoin: round;
  }
</style>
</head>
<body${opts.embedded ? ' class="embedded"' : ''}>
<div id="toolbar">
<div id="toolbar-items">
  <div class="toolbar-group">
    <button id="tb-drawings" class="icon-button" title="Drawing tools"
            aria-label="Drawing tools" aria-pressed="false" aria-expanded="false"
            aria-controls="drawing-tools">
      <svg viewBox="0 0 20 20" aria-hidden="true">
        <path d="M12.6 3.4 16.6 7.4 7.5 16.5 3 17l.5-4.5z"></path>
        <path d="M10.8 5.2 14.8 9.2"></path>
      </svg>
    </button>
  </div>
  <div class="toolbar-group">
    <button id="tb-data" class="symbol-button" title="Select the OHLCV data for this script">
      <span class="symbol-mark" aria-hidden="true">
        <svg viewBox="0 0 16 16">
          <path d="M4 3.5v9M2.5 6h3v4h-3zM11.5 2.5v11M10 5h3v5h-3z"
                fill="none" stroke="currentColor" stroke-width="1.35"></path>
        </svg>
      </span>
      <span class="symbol-copy">
        <span id="tb-symbol-name" class="symbol-name">Select data</span>
        <span id="tb-symbol-period" class="symbol-period"></span>
      </span>
    </button>
    <button id="tb-timeframe" title="Timeframe of the live chart" aria-label="Timeframe"
            aria-pressed="false" hidden></button>
  </div>
${opts.embedded ? ADD_SCRIPT_GROUP : ''}
  <div class="toolbar-group">
    <button id="tb-layers" class="icon-button" title="Layers and indicators"
            aria-label="Layers and indicators" aria-pressed="false">
      <svg viewBox="0 0 20 20" aria-hidden="true">
        <path d="m10 3-7 3.6 7 3.6 7-3.6L10 3Z"></path>
        <path d="m4.5 9.5-1.5.8 7 3.7 7-3.7-1.5-.8M4.5 13.2l-1.5.8 7 3.5 7-3.5-1.5-.8"></path>
      </svg>
    </button>
    <button id="tb-candle" class="icon-button" title="Chart style"
            aria-label="Chart style" aria-pressed="false">
      <svg viewBox="0 0 20 20" aria-hidden="true">
        <path d="M6 3v3.2M6 13.8V17M14 5v2.2M14 14.8V17"></path>
        <rect x="3.6" y="6.2" width="4.8" height="7.6" rx="0.8"></rect>
        <rect x="11.6" y="7.2" width="4.8" height="7.6" rx="0.8"
              fill="currentColor" stroke="none"></rect>
      </svg>
    </button>
    <button id="tb-legend" class="icon-button" title="Hide the chart legend"
            aria-label="Hide the chart legend" aria-pressed="false">
      <svg viewBox="0 0 20 20" aria-hidden="true">
        <rect x="2.5" y="4" width="15" height="12" rx="1.5"></rect>
        <path d="M5.5 8h3M5.5 11.5h3M11 8h3.5M11 11.5h3.5"></path>
        <path class="slash" d="M4 16 16 4"></path>
      </svg>
    </button>
    <button id="tb-datawindow" class="icon-button" title="Data Window: every value of a bar"
            aria-label="Data Window" aria-pressed="false" aria-controls="data-window">
      <svg viewBox="0 0 20 20" aria-hidden="true">
        <rect x="2.5" y="3.5" width="15" height="13" rx="1.5"></rect>
        <path d="M10.5 3.5v13M12.5 7h3M12.5 10h3M12.5 13h3M5 7h3M5 10h1.5"></path>
      </svg>
    </button>
  </div>
  <div class="toolbar-group">
    <button id="tb-measure" class="icon-button" title="Measure price movement"
            aria-label="Measure price movement" aria-pressed="false">
      <svg viewBox="0 0 20 20" aria-hidden="true">
        <path d="M3 3.5v3M17 3.5v3M3 5h14"></path>
        <rect x="3" y="10" width="14" height="6" rx="1.2"></rect>
        <path d="M6 10v2.5M9 10v1.6M12 10v2.5M15 10v1.6"></path>
      </svg>
    </button>
    <button id="tb-goto" class="icon-button" title="Go to date"
            aria-label="Go to date" aria-pressed="false">
      <svg viewBox="0 0 20 20" aria-hidden="true">
        <rect x="3" y="4.5" width="14" height="12.5" rx="2"></rect>
        <path d="M6.5 2.8v3.4M13.5 2.8v3.4M3 8h14M7.5 12h5M10.8 9.7 13 12l-2.2 2.3"></path>
      </svg>
    </button>
    <button id="tb-breakpoints" class="icon-button" title="Chart breakpoints"
            aria-label="Chart breakpoints" aria-pressed="false" hidden>
      <svg viewBox="0 0 20 20" aria-hidden="true">
        <circle cx="10" cy="10" r="6"></circle>
        <circle cx="10" cy="10" r="2.5" fill="currentColor" stroke="none"></circle>
      </svg>
      <span id="tb-breakpoints-count" class="count-badge"></span>
    </button>
  </div>
  <div class="toolbar-group toolbar-status">
    <span id="debug-position" hidden></span>
    <span id="live-status" role="status" hidden></span>
  </div>
  <span class="spacer"></span>
${opts.embedded ? CELL_GROUP : CSV_GROUP}
</div>
  <button id="tb-more" class="icon-button" title="More chart actions" aria-label="More chart actions"
          aria-controls="toolbar-overflow" aria-expanded="false" hidden>
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <circle cx="5" cy="10" r="0.8" fill="currentColor"></circle>
      <circle cx="10" cy="10" r="0.8" fill="currentColor"></circle>
      <circle cx="15" cy="10" r="0.8" fill="currentColor"></circle>
    </svg>
  </button>
  <div id="toolbar-overflow" role="group" aria-labelledby="tb-more" hidden></div>
</div>
<div id="script-legend" hidden></div>
<div id="chart-row">
<aside id="drawing-tools" aria-label="Drawing tools" hidden></aside>
<div id="chart-area">
  <div id="chart"></div>
  <div id="chart-busy" role="progressbar" aria-label="Recomputing the chart" hidden></div>
  <div id="breakpoint-pick" hidden>
    <span id="breakpoint-pick-label"></span>
    <button id="breakpoint-pick-cancel" title="Cancel (Escape)">×</button>
  </div>
  <div id="goto-popup" hidden>
    <input type="datetime-local" id="tb-goto-input" step="1">
    <button id="tb-goto-do">Go</button>
  </div>
  <button id="to-realtime" title="Scroll to the latest bar" hidden>⇥</button>
  <div id="scale-controls" hidden>
    <button id="sc-auto" title="Auto fit the price scale to the visible bars"
            aria-label="Auto fit the price scale">A</button>
    <button id="sc-log" title="Logarithmic price scale"
            aria-label="Logarithmic price scale" aria-pressed="false">L</button>
    <button id="sc-percent" title="Percent price scale"
            aria-label="Percent price scale" aria-pressed="false">%</button>
  </div>
</div>
<aside id="data-window" aria-label="Data Window" hidden></aside>
</div>
<div id="panel-splitter" role="separator" aria-orientation="horizontal"
     aria-label="Resize chart and bottom panel" tabindex="0" hidden></div>
<div id="bottom" class="collapsed">
  <div class="tab-bar">
    <button id="tab-performance" hidden>Performance</button>
    <button id="tab-trades" class="active">Trades</button>
    <button id="tab-stats">Stats</button>
    <button id="tab-robustness" hidden>Robustness</button>
    <span class="spacer"></span>
    <button id="strategy-properties" title="Strategy properties: capital, order size, costs"
            aria-label="Strategy properties" hidden>⚙</button>
    <button id="tab-toggle" title="Show/hide panel">▴</button>
  </div>
  <div class="tab-body" id="tab-body"></div>
</div>
${opts.scripts.map((script) => scriptTag(script, opts.nonce)).join('\n')}
</body>
</html>`;
}
