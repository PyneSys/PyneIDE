const overflowClass = 'in-overflow';

export function toolbarAnchor(button: HTMLButtonElement | null): HTMLButtonElement | null {
  if (button?.classList.contains(overflowClass)) {
    return document.querySelector<HTMLButtonElement>('#tb-more');
  }
  return button;
}

export function initToolbarOverflow(onLayout: () => void): void {
  const toolbar = document.getElementById('toolbar');
  const row = document.getElementById('toolbar-items');
  const more = document.querySelector<HTMLButtonElement>('#tb-more');
  const menu = document.getElementById('toolbar-overflow');
  if (!toolbar || !row || !more || !menu) return;

  const setOpen = (open: boolean): void => {
    menu.hidden = !open;
    more.setAttribute('aria-expanded', String(open));
  };

  const items = Array.from(row.querySelectorAll<HTMLElement>('.toolbar-group > *'), control => {
    const button = control instanceof HTMLButtonElement ? control : undefined;
    const entry = button ? document.createElement('button') : document.createElement('span');
    entry.className = 'toolbar-overflow-item';
    entry.hidden = true;
    if (entry instanceof HTMLButtonElement && button) {
      entry.type = 'button';
      entry.addEventListener('click', event => {
        // The original handler may open a popup. Keep this click from reaching
        // that popup's outside-click listener.
        event.stopPropagation();
        setOpen(false);
        more.focus({ preventScroll: true });
        button.click();
      });
    }
    menu.appendChild(entry);
    return { control, button, entry };
  });
  // Keep the instrument, timeframe, a dashboard cell's "Add script" and the
  // status visible for as long as possible.
  const kept = ['tb-data', 'tb-timeframe', 'tb-add-script'];
  const hideOrder = [
    ...items.filter(({ button }) => button && !kept.includes(button.id)).reverse(),
    ...items.filter(({ button }) => !button).reverse(),
    ...items.filter(({ control }) => kept.includes(control.id)).reverse(),
  ];

  const layout = (): void => {
    const focused = document.activeElement;
    const focusedItem = items.find(({ control, entry }) => control === focused || entry === focused);
    const returning = focusedItem?.button ?? items.find(({ control, button }) =>
      button && !button.hidden && !button.disabled && control.classList.contains(overflowClass)
    )?.button;
    for (const { control } of items) control.classList.remove(overflowClass);
    const needsMore = row.scrollWidth > row.clientWidth + more.offsetWidth;
    more.hidden = !needsMore;
    if (needsMore) {
      for (const { control } of hideOrder) {
        if (row.scrollWidth <= row.clientWidth) break;
        if (!control.hidden) control.classList.add(overflowClass);
      }
    } else {
      setOpen(false);
    }
    for (const { control, button, entry } of items) {
      entry.hidden = control.hidden || !control.classList.contains(overflowClass);
      if (entry.hidden) continue;
      entry.textContent = control.getAttribute('aria-label') || control.textContent || control.title;
      entry.title = control.title;
      if (entry instanceof HTMLButtonElement && button) {
        entry.disabled = button.disabled;
        const pressed = button.getAttribute('aria-pressed');
        if (pressed === null) entry.removeAttribute('aria-pressed');
        else entry.setAttribute('aria-pressed', pressed);
      }
    }
    const lostFocus = focusedItem && (
      focused === focusedItem.entry ? focusedItem.entry.hidden : !focusedItem.entry.hidden
    );
    if (needsMore && lostFocus) {
      more.focus({ preventScroll: true });
    } else if (!needsMore && (focused === more || menu.contains(focused))) {
      returning?.focus({ preventScroll: true });
    }
    onLayout();
  };

  // Focusing a minimized VS Code editor group on mouse down expands the group
  // and can remove the overflow button before the click reaches it.
  more.addEventListener('mousedown', event => {
    if (event.button === 0 && !document.hasFocus()) event.preventDefault();
  });
  more.addEventListener('click', event => {
    const open = menu.hidden;
    setOpen(open);
    if (open && event.detail === 0) {
      menu.querySelector<HTMLButtonElement>('button:not([hidden], :disabled)')?.focus({ preventScroll: true });
    }
  });
  document.addEventListener('pointerdown', event => {
    const target = event.target as Node;
    if (!menu.hidden && !menu.contains(target) && !more.contains(target)) setOpen(false);
  });
  toolbar.addEventListener('focusout', event => {
    const next = event.relatedTarget as Node | null;
    if (!menu.hidden && next !== more && !menu.contains(next)) setOpen(false);
  });
  toolbar.addEventListener('keydown', event => {
    if (menu.hidden || event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    setOpen(false);
    more.focus({ preventScroll: true });
  });

  new ResizeObserver(layout).observe(toolbar);
  new MutationObserver(layout).observe(row, {
    subtree: true, childList: true,
    attributeFilter: ['hidden', 'disabled', 'title', 'aria-label', 'aria-pressed'],
  });
  layout();
}
