/**
 * Loaded into each chart iframe of a dashboard, before the chart bundle. The
 * chart page was written for a webview of its own: it asks for the VS Code
 * webview API and styles itself with the `--vscode-*` theme variables. Inside
 * an iframe neither exists, so this stands in for both:
 *
 * - `acquireVsCodeApi()` posts the chart's messages to the dashboard page,
 *   tagged with the chart's key (the iframe's `data-chart`); the dashboard
 *   relays them to the extension and posts the extension's answers back into
 *   the iframe, where the chart's own `message` listener takes them;
 * - the theme (the variables on the root element, the `vscode-*` body classes
 *   and VS Code's default styles) is copied from the dashboard page, and kept
 *   in step with it when the theme changes.
 */

/** The message a chart frame posts to the dashboard page. */
export interface ChartFrameMessage {
  pyneChartFrame: string;
  message: unknown;
}

const host = window.parent;
const key = (window.frameElement as HTMLElement | null)?.dataset.chart ?? '';
let savedState: unknown;

(window as unknown as { acquireVsCodeApi: () => unknown }).acquireVsCodeApi = () => ({
  postMessage(message: unknown): void {
    host.postMessage({ pyneChartFrame: key, message } satisfies ChartFrameMessage, '*');
  },
  getState(): unknown {
    return savedState;
  },
  setState<T>(state: T): T {
    savedState = state;
    return state;
  },
});

function syncTheme(): void {
  const source = host.document;
  const style = source.documentElement.getAttribute('style');
  if (style === null) document.documentElement.removeAttribute('style');
  else document.documentElement.setAttribute('style', style);
  const body = document.body;
  if (!body || !source.body) return;
  for (const cls of Array.from(body.classList)) {
    if (cls.startsWith('vscode-')) body.classList.remove(cls);
  }
  for (const cls of Array.from(source.body.classList)) {
    if (cls.startsWith('vscode-')) body.classList.add(cls);
  }
  for (const attr of Array.from(source.body.attributes)) {
    if (attr.name.startsWith('data-vscode-')) body.setAttribute(attr.name, attr.value);
  }
}

const defaults = host.document.getElementById('_defaultStyles');
if (defaults) document.head.appendChild(defaults.cloneNode(true));
syncTheme();
const observer = new MutationObserver(syncTheme);
observer.observe(host.document.documentElement, { attributes: true, attributeFilter: ['style'] });
if (host.document.body) {
  observer.observe(host.document.body, { attributes: true });
}
