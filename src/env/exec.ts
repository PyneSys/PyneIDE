import { spawn } from 'node:child_process';

import { CancelledError, type CancelToken } from './cancel';
import type { Logger } from './constants';

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface ExecOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  timeoutMs?: number;
  /** Kills the child and rejects with a CancelledError. */
  cancel?: CancelToken;
  /**
   * Every complete output line (stdout and stderr, in arrival order), for
   * progress parsing. Separate from the logger because the logger indents and
   * is free to reformat.
   */
  onLine?: (line: string) => void;
}

/** Split a byte stream into complete lines; chunks may cut a line in half. */
function lineBuffer(emit: (line: string) => void): { push(chunk: string): void; flush(): void } {
  let pending = '';
  return {
    push(chunk: string): void {
      pending += chunk;
      let index = pending.indexOf('\n');
      while (index >= 0) {
        emit(pending.slice(0, index).replace(/\r$/, ''));
        pending = pending.slice(index + 1);
        index = pending.indexOf('\n');
      }
    },
    flush(): void {
      if (pending) {
        emit(pending);
        pending = '';
      }
    },
  };
}

/** Run a process, log its output line-by-line, and resolve with the result. */
export function execProcess(
  command: string,
  args: string[],
  log: Logger,
  options: ExecOptions = {}
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    if (options.cancel?.isCancellationRequested) {
      reject(new CancelledError(`Cancelled before starting: ${command}`));
      return;
    }
    log(`$ ${command} ${args.join(' ')}`);
    const child = spawn(command, args, {
      env: { ...process.env, ...options.env },
      cwd: options.cwd,
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';

    const emit = (line: string): void => {
      if (!line.trim()) return;
      log(`  ${line}`);
      options.onLine?.(line);
    };
    const outLines = lineBuffer(emit);
    const errLines = lineBuffer(emit);

    // Declared before the subscriptions that call it: a token that is already
    // cancelled may fire its listener the moment it is attached.
    let timeout: NodeJS.Timeout | undefined;
    let cancelSub: { dispose(): void } | undefined;
    const cleanup = (): void => {
      if (timeout) clearTimeout(timeout);
      cancelSub?.dispose();
    };

    if (options.timeoutMs) {
      timeout = setTimeout(() => {
        cleanup();
        child.kill();
        reject(new Error(`Timed out after ${options.timeoutMs} ms: ${command}`));
      }, options.timeoutMs);
    }
    cancelSub = options.cancel?.onCancellationRequested(() => {
      cleanup();
      child.kill();
      reject(new CancelledError(`Cancelled: ${command}`));
    });

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
      outLines.push(chunk.toString());
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
      errLines.push(chunk.toString());
    });
    child.on('error', (err) => {
      cleanup();
      reject(err);
    });
    child.on('close', (code) => {
      cleanup();
      outLines.flush();
      errLines.flush();
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

/** Like execProcess, but rejects when the exit code is non-zero. */
export async function execChecked(
  command: string,
  args: string[],
  log: Logger,
  options: ExecOptions = {}
): Promise<ExecResult> {
  const result = await execProcess(command, args, log, options);
  if (result.code !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim();
    throw new Error(
      `Command failed (exit ${result.code}): ${command} ${args.join(' ')}` +
        (detail ? `\n${detail.slice(0, 2000)}` : '')
    );
  }
  return result;
}
