/**
 * Cancellation for the vscode-free env layer.
 *
 * The interface is deliberately structurally compatible with
 * `vscode.CancellationToken`, so the manager can hand `withProgress`'s token
 * straight in while bootstrap.ts, download.ts and exec.ts stay importable
 * without vscode (the env smoke test runs them headless).
 */

export interface CancelToken {
  readonly isCancellationRequested: boolean;
  onCancellationRequested(listener: () => void): { dispose(): void };
}

/**
 * Thrown when the user aborts a long-running env operation. Callers must tell
 * this apart from a real failure: a cancel is not an error to report, and it
 * must never trigger the automatic recreate-and-retry path.
 */
export class CancelledError extends Error {
  constructor(message = 'Cancelled') {
    super(message);
    this.name = 'CancelledError';
  }
}

export function isCancelledError(err: unknown): boolean {
  return err instanceof Error && err.name === 'CancelledError';
}

export function throwIfCancelled(token?: CancelToken): void {
  if (token?.isCancellationRequested) {
    throw new CancelledError();
  }
}

/**
 * A cancellable token that is not driven by VSCode — the smoke test uses it to
 * exercise the abort paths headlessly.
 */
export class CancelSource implements CancelToken {
  private cancelled = false;
  private readonly listeners = new Set<() => void>();

  get isCancellationRequested(): boolean {
    return this.cancelled;
  }

  onCancellationRequested(listener: () => void): { dispose(): void } {
    if (this.cancelled) {
      listener();
      return { dispose: () => undefined };
    }
    this.listeners.add(listener);
    return {
      dispose: () => {
        this.listeners.delete(listener);
      },
    };
  }

  cancel(): void {
    if (this.cancelled) return;
    this.cancelled = true;
    for (const listener of [...this.listeners]) {
      listener();
    }
  }
}
