/**
 * Shared NDJSON test client for the python/pyneide_series.py worker — drives
 * it exactly like the extension does (one long-lived process, requests
 * matched by id). Used by checkerSmoke.ts and edgeCorpusSmoke.ts.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import * as path from 'node:path';

export type Span = [number, number, number];
export type Ref = [number, number, number, string];
export type Problem = [number, number, number, string, string];

export interface WorkerResponse {
  id: number;
  ok: boolean;
  spans?: Span[];
  refs?: Ref[];
  problems?: Problem[];
  overloads?: Span[];
  error?: string;
}

/**
 * A single long-lived worker process. Requests get incrementing ids and are
 * resolved as their matching response line arrives; a global deadline fails any
 * still-pending request so a hung worker cannot wedge the test.
 */
export class Worker {
  private readonly proc: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, (r: WorkerResponse) => void>();
  private readonly rejects = new Map<number, (e: Error) => void>();
  private readonly timer: NodeJS.Timeout;
  private buffer = '';
  private nextId = 1;
  private stderr = '';

  constructor(timeoutMs: number) {
    const script = path.resolve('python/pyneide_series.py');
    const python = process.platform === 'win32' ? 'python' : 'python3';
    this.proc = spawn(python, ['-u', script], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.timer = setTimeout(() => this.failAll(new Error('checker worker timed out')), timeoutMs);
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (chunk: string) => this.onData(chunk));
    this.proc.stderr.on('data', (chunk: Buffer) => {
      this.stderr += chunk.toString();
    });
    this.proc.on('error', (e) => this.failAll(new Error(`checker worker could not start (${python}): ${e.message}`)));
  }

  request(source: string): Promise<WorkerResponse> {
    const id = this.nextId++;
    return new Promise<WorkerResponse>((resolve, reject) => {
      this.pending.set(id, resolve);
      this.rejects.set(id, reject);
      this.proc.stdin.write(JSON.stringify({ id, source }) + '\n');
    });
  }

  close(): void {
    clearTimeout(this.timer);
    this.proc.kill();
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let newline: number;
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (!line.trim()) continue;
      const response = JSON.parse(line) as WorkerResponse;
      const resolve = this.pending.get(response.id);
      if (resolve) {
        this.pending.delete(response.id);
        this.rejects.delete(response.id);
        resolve(response);
      }
    }
  }

  private failAll(error: Error): void {
    clearTimeout(this.timer);
    if (this.stderr) error.message += `\n--- worker stderr ---\n${this.stderr}`;
    for (const reject of this.rejects.values()) reject(error);
    this.pending.clear();
    this.rejects.clear();
    this.proc.kill();
  }
}
