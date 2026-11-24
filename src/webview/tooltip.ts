/**
 * Hover tooltips for a webview page, drawn by the page itself. A VS Code
 * webview (and a dashboard's chart iframes inside one) shows no native
 * tooltip for `title`, so this takes the `title` of the element under the
 * pointer (or with keyboard focus) and shows it in a hover box styled like
 * VS Code's own. The element keeps its `title`: it is lifted off only while
 * the box shows, so the page code that reads or sets it is not affected, and
 * a browser that does show native tooltips does not show two.
 */

const SHOW_DELAY_MS = 500;
/** Moving onto another titled element soon after a tooltip closed shows its
 * tooltip at once, as VS Code's toolbars do. */
const WARM_MS = 300;
const GAP_PX = 4;
const EDGE_PX = 4;

const STYLE = `
#pyne-tooltip {
  position: fixed; z-index: 2147483647; pointer-events: none; box-sizing: border-box;
  max-width: min(320px, calc(100vw - 8px)); padding: 3px 7px; border-radius: 3px;
  font-family: var(--vscode-font-family, sans-serif); font-size: 12px; line-height: 1.4;
  white-space: pre-line; overflow-wrap: anywhere;
  color: var(--vscode-editorHoverWidget-foreground, var(--vscode-foreground, #ccc));
  background: var(--vscode-editorHoverWidget-background, #252526);
  border: 1px solid var(--vscode-editorHoverWidget-border, #454545);
  box-shadow: 0 2px 8px var(--vscode-widget-shadow, rgba(0, 0, 0, 0.36));
}
#pyne-tooltip[hidden] { display: none; }
`;

let installed = false;

export function installTooltips(): void {
  if (installed) return;
  installed = true;
  const style = document.createElement('style');
  style.textContent = STYLE;
  document.head.appendChild(style);
  const box = document.createElement('div');
  box.id = 'pyne-tooltip';
  box.setAttribute('role', 'tooltip');
  box.hidden = true;

  let target: HTMLElement | undefined;
  /** The title lifted off `target` while its tooltip shows. */
  let lifted: string | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closedAt = 0;

  const restore = (): void => {
    if (target && lifted !== undefined && !target.hasAttribute('title')) target.setAttribute('title', lifted);
    lifted = undefined;
  };

  const hide = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    if (!box.hidden) closedAt = performance.now();
    box.hidden = true;
    restore();
    target = undefined;
  };

  const show = (): void => {
    timer = undefined;
    const el = target;
    if (!el?.isConnected) return;
    const text = el.getAttribute('title');
    if (!text) return;
    lifted = text;
    el.removeAttribute('title');
    if (!box.isConnected) document.body.appendChild(box);
    box.textContent = text;
    box.hidden = false;
    const anchor = el.getBoundingClientRect();
    const width = box.offsetWidth;
    const height = box.offsetHeight;
    const left = Math.min(Math.max(EDGE_PX, anchor.left + anchor.width / 2 - width / 2),
      window.innerWidth - width - EDGE_PX);
    let top = anchor.bottom + GAP_PX;
    if (top + height > window.innerHeight - EDGE_PX) top = Math.max(EDGE_PX, anchor.top - GAP_PX - height);
    box.style.left = `${Math.round(left)}px`;
    box.style.top = `${Math.round(top)}px`;
  };

  const enter = (el: HTMLElement | undefined): void => {
    if (el === target) return;
    hide();
    if (!el) return;
    target = el;
    const warm = performance.now() - closedAt < WARM_MS;
    timer = setTimeout(show, warm ? 0 : SHOW_DELAY_MS);
  };

  const titled = (node: EventTarget | null): HTMLElement | undefined => {
    const el = node instanceof Element ? node.closest<HTMLElement>('[title]') : null;
    // An iframe's title names the frame for assistive technology only
    return el && el.tagName !== 'IFRAME' && el.getAttribute('title') ? el : undefined;
  };

  document.addEventListener('pointerover', (event) => {
    // The shown element has no title meanwhile: moving within it is no change
    if (target && event.target instanceof Node && target.contains(event.target)) return;
    enter(titled(event.target));
  });
  document.addEventListener('pointerout', (event) => {
    if (target && !(event.relatedTarget instanceof Node && target.contains(event.relatedTarget))) hide();
  });
  document.addEventListener('focusin', (event) => {
    const el = titled(event.target);
    if (el?.matches(':focus-visible')) enter(el);
  });
  document.addEventListener('focusout', hide);
  document.addEventListener('pointerdown', hide, true);
  document.addEventListener('keydown', hide, true);
  document.addEventListener('wheel', hide, { capture: true, passive: true });
  window.addEventListener('blur', hide);
  // A title set while its tooltip shows (a toggled button) replaces the text
  new MutationObserver(() => {
    if (!target || box.hidden) return;
    const text = target.getAttribute('title');
    if (text === null) return;
    lifted = text;
    target.removeAttribute('title');
    box.textContent = text;
  }).observe(document.documentElement, { subtree: true, attributes: true, attributeFilter: ['title'] });
}
