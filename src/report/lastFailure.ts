/**
 * Ring of the most recent failures (VSCode-free).
 *
 * Compile and run failures record here even when they only reach the Problems
 * panel, so a report started later from the status-bar menu still knows what
 * went wrong.
 */

export type FailureKind = 'compile' | 'runtime';

export interface FailureRecord {
  kind: FailureKind;
  /** Epoch milliseconds. */
  at: number;
  summary: string;
  /** Structured extras (status, line, exit code, bar counters, …). */
  detail?: Record<string, unknown>;
  traceback?: string;
  scriptPath?: string;
  scriptLanguage?: 'pine' | 'pyne' | 'python';
}

export class FailureRing {
  private readonly records: FailureRecord[] = [];

  constructor(private readonly size = 3) {}

  record(entry: Omit<FailureRecord, 'at'> & { at?: number }): void {
    this.records.push({ ...entry, at: entry.at ?? Date.now() });
    while (this.records.length > this.size) this.records.shift();
  }

  /** The newest failure, or undefined when nothing failed in this session. */
  last(): FailureRecord | undefined {
    return this.records[this.records.length - 1];
  }

  all(): FailureRecord[] {
    return [...this.records];
  }

  clear(): void {
    this.records.length = 0;
  }
}

export const failures = new FailureRing(3);
