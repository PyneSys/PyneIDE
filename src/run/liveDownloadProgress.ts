/**
 * The history download of a live chart, shown as a cancellable notification
 * until the run starts: there is no chart yet to show it on.
 */
import * as vscode from 'vscode';

import type { DownloadEvent } from './bridgeClient';

interface ProgressStep {
  message?: string;
  increment?: number;
}

export class LiveDownloadProgress {
  private report: ((step: ProgressStep) => void) | undefined;
  private finish: (() => void) | undefined;
  /** The step reported before the notification's task started. */
  private pending: ProgressStep | undefined;
  private opened = false;
  private closed = false;
  /** The history percentage the bar already shows. */
  private shownPercent = 0;

  /**
   * @param title The notification's title.
   * @param onCancel Stops the run: the Cancel button of the notification.
   */
  constructor(
    private readonly title: string,
    private readonly onCancel: () => void
  ) {}

  update(event: DownloadEvent): void {
    if (this.closed) return;
    if (!this.opened) this.open();
    switch (event.step) {
      case 'symbolInfo':
        this.show({ message: 'Reading symbol info…' });
        break;
      case 'history': {
        const percent = event.total > 0
          ? Math.max(0, Math.min(100, Math.floor((event.done / event.total) * 100)))
          : 0;
        // A retried download starts over: the bar only moves forward
        const increment = Math.max(0, percent - this.shownPercent);
        this.shownPercent = Math.max(this.shownPercent, percent);
        this.show({ message: `Downloading the history… ${percent}%`, increment });
        break;
      }
      case 'retry':
        this.show({
          message: `Retry ${event.attempt} in ${Math.round(event.delay)} s: ${event.message}`,
        });
        break;
    }
  }

  /** The download is over (the run started, or it ended). */
  close(): void {
    this.closed = true;
    this.finish?.();
  }

  private show(step: ProgressStep): void {
    if (this.report) this.report(step);
    else this.pending = { message: step.message, increment: (this.pending?.increment ?? 0) + (step.increment ?? 0) };
  }

  private open(): void {
    this.opened = true;
    void vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: this.title, cancellable: true },
      (progress, token) => {
        if (this.closed) return Promise.resolve();
        this.report = (step) => progress.report(step);
        if (this.pending) {
          progress.report(this.pending);
          this.pending = undefined;
        }
        token.onCancellationRequested(() => this.onCancel());
        return new Promise<void>((resolve) => {
          this.finish = resolve;
        });
      }
    );
  }
}
