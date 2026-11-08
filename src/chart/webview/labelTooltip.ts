import { labelLinkSpans } from '../labelLinks';
import type { LabelHit } from './drawings';

export class LabelTooltip {
  private readonly el = document.createElement('div');
  private readonly hits = new Map<string, LabelHit[]>();
  private pointer: { x: number; y: number } | undefined;
  private active: LabelHit['label'] | undefined;
  private frame = 0;
  private hideTimer: number | undefined;

  constructor(
    private readonly area: HTMLElement,
    private readonly chart: HTMLElement,
    private readonly paneBounds: (pane: string) => DOMRect | undefined,
    openLink: (target: string) => void
  ) {
    this.el.id = 'label-tooltip';
    this.el.hidden = true;
    area.appendChild(this.el);
    area.addEventListener('pointermove', (event) => {
      if (event.pointerType === 'touch' || event.buttons) return;
      this.pointer = { x: event.clientX, y: event.clientY };
      this.refresh();
    });
    area.addEventListener('pointerleave', () => {
      this.pointer = undefined;
      this.dismiss();
    });
    chart.addEventListener('pointerdown', () => {
      this.pointer = undefined;
      this.dismiss();
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        this.pointer = undefined;
        this.dismiss();
      }
    });
    this.el.addEventListener('click', (event) => {
      const link = (event.target as HTMLElement).closest<HTMLAnchorElement>('a[data-target]');
      if (!link?.dataset.target) return;
      event.preventDefault();
      openLink(link.dataset.target);
    });
  }

  update(pane: string, hits: LabelHit[]): void {
    this.hits.set(pane, hits);
    if (!this.frame && this.pointer) {
      this.frame = requestAnimationFrame(() => {
        this.frame = 0;
        this.refresh();
      });
    }
  }

  reset(): void {
    this.hits.clear();
    this.dismiss();
  }

  dismiss(): void {
    this.cancelHide();
    this.active = undefined;
    this.el.hidden = true;
  }

  private cancelHide(): void {
    window.clearTimeout(this.hideTimer);
    this.hideTimer = undefined;
  }

  private refresh(): void {
    if (!this.pointer) return;
    const { x, y } = this.pointer;
    const underPointer = document.elementFromPoint(x, y);
    if (this.active && this.el.contains(underPointer)) {
      for (const hits of this.hits.values()) {
        if (hits.some(({ label }) => label.id === this.active?.id && label.tooltip === this.active?.tooltip)) {
          this.cancelHide();
          return;
        }
      }
      this.dismiss();
      return;
    }

    if (this.chart.contains(underPointer)) {
      for (const [pane, hits] of this.hits) {
        if (!hits.length) continue;
        const bounds = this.paneBounds(pane);
        if (!bounds || x < bounds.left || x >= bounds.right || y < bounds.top || y >= bounds.bottom) continue;
        const px = x - bounds.left;
        const py = y - bounds.top;
        for (let i = hits.length - 1; i >= 0; i--) {
          const hit = hits[i];
          if (px < hit.x || px >= hit.x + hit.width || py < hit.y || py >= hit.y + hit.height) continue;
          this.cancelHide();
          if (hit.label.id !== this.active?.id || hit.label.tooltip !== this.active?.tooltip) {
            this.show(hit.label, x, y);
          }
          return;
        }
      }
    }
    // Leave time to cross the small gap between the canvas and the tooltip.
    if (this.active && this.hideTimer === undefined) {
      this.hideTimer = window.setTimeout(() => this.dismiss(), 220);
    }
  }

  private show(label: LabelHit['label'], clientX: number, clientY: number): void {
    this.active = label;
    this.el.replaceChildren();
    const text = label.tooltip ?? '';
    let offset = 0;
    for (const { start, target } of labelLinkSpans(text)) {
      this.el.append(text.slice(offset, start));
      const link = document.createElement('a');
      link.href = '#';
      link.dataset.target = target;
      link.textContent = target;
      this.el.append(link);
      offset = start + target.length;
    }
    this.el.append(text.slice(offset));
    this.el.hidden = false;
    this.el.scrollTop = 0;

    const area = this.area.getBoundingClientRect();
    const x = clientX - area.left;
    const y = clientY - area.top;
    const width = this.el.offsetWidth;
    const height = this.el.offsetHeight;
    const gap = 8;
    let left = x + gap;
    let top = y - gap;
    if (left + width > area.width) {
      left = x - gap - width;
      if (left < 0) {
        left = Math.min(x, area.width - width);
        top = y + gap + height <= area.height ? y + gap : y - gap - height;
      }
    }
    this.el.style.left = `${Math.max(0, left)}px`;
    this.el.style.top = `${Math.max(0, Math.min(top, area.height - height))}px`;
  }
}
