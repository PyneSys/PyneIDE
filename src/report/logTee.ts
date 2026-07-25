/**
 * Output-channel tee (VSCode-free at runtime — the vscode import is types only).
 *
 * An {@link vscode.OutputChannel} is write-only: what it shows cannot be read
 * back, so the diagnostics the extension already logs would be unavailable to a
 * problem report. {@link LogTee} wraps a channel, forwards everything to it and
 * keeps a bounded tail in memory.
 */
import type * as vscode from 'vscode';

const MAX_LINES = 400;
const MAX_CHARS = 64 * 1024;

export class LogTee implements vscode.OutputChannel {
  private lines: string[] = [];
  private pending = '';
  private chars = 0;

  constructor(
    private readonly inner: vscode.OutputChannel,
    private readonly maxLines: number = MAX_LINES,
    private readonly maxChars: number = MAX_CHARS
  ) {}

  get name(): string {
    return this.inner.name;
  }

  append(value: string): void {
    this.inner.append(value);
    this.pending += value;
    const parts = this.pending.split('\n');
    this.pending = parts.pop() ?? '';
    for (const part of parts) this.push(part);
  }

  appendLine(value: string): void {
    this.inner.appendLine(value);
    if (this.pending) {
      this.push(this.pending + value);
      this.pending = '';
    } else {
      this.push(value);
    }
  }

  replace(value: string): void {
    this.inner.replace(value);
    this.reset();
    this.append(value);
  }

  clear(): void {
    this.inner.clear();
    this.reset();
  }

  show(preserveFocus?: boolean): void;
  show(column?: vscode.ViewColumn, preserveFocus?: boolean): void;
  show(columnOrPreserveFocus?: vscode.ViewColumn | boolean, preserveFocus?: boolean): void {
    if (typeof columnOrPreserveFocus === 'boolean') this.inner.show(columnOrPreserveFocus);
    else this.inner.show(columnOrPreserveFocus, preserveFocus);
  }

  hide(): void {
    this.inner.hide();
  }

  dispose(): void {
    this.inner.dispose();
  }

  /** The retained tail, oldest line first. */
  tail(): string {
    return this.pending ? [...this.lines, this.pending].join('\n') : this.lines.join('\n');
  }

  private push(line: string): void {
    this.lines.push(line);
    this.chars += line.length + 1;
    while (this.lines.length > this.maxLines || this.chars > this.maxChars) {
      const dropped = this.lines.shift();
      if (dropped === undefined) break;
      this.chars -= dropped.length + 1;
    }
  }

  private reset(): void {
    this.lines = [];
    this.pending = '';
    this.chars = 0;
  }
}

/**
 * Registry of the wrapped channels.
 *
 * A singleton because the channels are created in five unrelated places (four
 * in `extension.ts`, one inside `RunService`); threading a hub through their
 * constructors would change signatures for no gain. The bounded-ring logic
 * lives in {@link LogTee}, which tests instantiate directly.
 */
export class LogHub {
  private readonly tees = new Map<string, LogTee>();

  /** Wrap a channel and remember it by name. */
  wrap(channel: vscode.OutputChannel): LogTee {
    const tee = new LogTee(channel);
    this.tees.set(channel.name, tee);
    return tee;
  }

  /** The retained tail of every wrapped channel, keyed by channel name. */
  tail(): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [name, tee] of this.tees) {
      const text = tee.tail();
      if (text.trim()) result[name] = text;
    }
    return result;
  }
}

export const logHub = new LogHub();
