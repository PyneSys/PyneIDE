import { spawn, type ChildProcess } from 'node:child_process';

/** Minimal Content-Length framed LSP client over a server's stdio. */
export class LspStdio {
  private readonly child: ChildProcess;
  private buffer = Buffer.alloc(0);
  private nextId = 1;
  private readonly pending = new Map<
    number,
    (result: unknown, error?: { code: number; message: string }) => void
  >();
  private readonly notificationWaiters: {
    method: string;
    predicate?: (params: unknown) => boolean;
    resolve: (params: unknown) => void;
  }[] = [];
  stderr = '';

  constructor(executable: string, args: string[] = []) {
    this.child = spawn(executable, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stdout!.on('data', (chunk: Buffer) => this.onData(chunk));
    this.child.stderr!.on('data', (chunk: Buffer) => {
      this.stderr += chunk.toString();
    });
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd < 0) return;
      const header = this.buffer.subarray(0, headerEnd).toString('ascii');
      const length = parseInt(/Content-Length: (\d+)/i.exec(header)?.[1] ?? '', 10);
      if (!Number.isFinite(length)) throw new Error(`lsp: bad header: ${header}`);
      const bodyStart = headerEnd + 4;
      if (this.buffer.length < bodyStart + length) return;
      const body = this.buffer.subarray(bodyStart, bodyStart + length).toString('utf8');
      this.buffer = this.buffer.subarray(bodyStart + length);
      const message = JSON.parse(body) as {
        id?: number;
        method?: string;
        result?: unknown;
        error?: { code: number; message: string };
        params?: unknown;
      };
      if (message.id !== undefined && message.method === undefined) {
        this.pending.get(message.id)?.(message.result, message.error);
        this.pending.delete(message.id);
      } else if (message.method) {
        // Server->client requests (client/registerCapability, ...) must get a
        // response or the server stalls; null acknowledges them all.
        if (message.id !== undefined) {
          this.send({ jsonrpc: '2.0', id: message.id, result: null });
        }
        for (let i = this.notificationWaiters.length - 1; i >= 0; i--) {
          const waiter = this.notificationWaiters[i];
          if (waiter.method === message.method && (waiter.predicate?.(message.params) ?? true)) {
            waiter.resolve(message.params);
            this.notificationWaiters.splice(i, 1);
          }
        }
      }
    }
  }

  private send(message: object): void {
    const body = Buffer.from(JSON.stringify(message), 'utf8');
    this.child.stdin!.write(`Content-Length: ${body.length}\r\n\r\n`);
    this.child.stdin!.write(body);
  }

  request(method: string, params?: unknown, timeoutMs = 15000): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`lsp: ${method} timed out`)), timeoutMs);
      this.pending.set(id, (result, error) => {
        clearTimeout(timer);
        if (error) reject(new Error(`lsp: ${method} error ${error.code}: ${error.message}`));
        else resolve(result);
      });
      // Parameterless messages omit `params` entirely (JSON-RPC structured
      // params rule; vscode-languageclient does the same for shutdown/exit).
      this.send(params === undefined ? { jsonrpc: '2.0', id, method } : { jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method: string, params?: unknown): void {
    this.send(params === undefined ? { jsonrpc: '2.0', method } : { jsonrpc: '2.0', method, params });
  }

  /**
   * Wait for a notification; an optional predicate skips non-matching ones
   * (e.g. diagnostics for another file or an interim empty publish).
   */
  waitForNotification(
    method: string,
    timeoutMs = 15000,
    predicate?: (params: unknown) => boolean
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`lsp: no ${method} received`)), timeoutMs);
      this.notificationWaiters.push({
        method,
        predicate,
        resolve: (params) => {
          clearTimeout(timer);
          resolve(params);
        },
      });
    });
  }

  exited(): Promise<number> {
    return new Promise((resolve) => this.child.on('close', (code) => resolve(code ?? -1)));
  }
}
