import { spawn } from 'node:child_process';

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
}

/** Run a process, log its output line-by-line, and resolve with the result. */
export function execProcess(
  command: string,
  args: string[],
  log: Logger,
  options: ExecOptions = {}
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    log(`$ ${command} ${args.join(' ')}`);
    const child = spawn(command, args, {
      env: { ...process.env, ...options.env },
      cwd: options.cwd,
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    const timeout = options.timeoutMs
      ? setTimeout(() => {
          child.kill();
          reject(new Error(`Timed out after ${options.timeoutMs} ms: ${command}`));
        }, options.timeoutMs)
      : undefined;
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
      for (const line of chunk.toString().split('\n')) {
        if (line.trim()) log(`  ${line}`);
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
      for (const line of chunk.toString().split('\n')) {
        if (line.trim()) log(`  ${line}`);
      }
    });
    child.on('error', (err) => {
      if (timeout) clearTimeout(timeout);
      reject(err);
    });
    child.on('close', (code) => {
      if (timeout) clearTimeout(timeout);
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
