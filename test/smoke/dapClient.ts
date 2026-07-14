/**
 * Minimal DAP (Debug Adapter Protocol) client for the smoke test — just
 * enough to talk to a debugpy listener over TCP: Content-Length framing,
 * request/response correlation, event waiting. Not a general DAP library.
 */
import * as net from 'node:net';

interface DapMessage {
  seq: number;
  type: 'request' | 'response' | 'event';
  command?: string;
  event?: string;
  request_seq?: number;
  success?: boolean;
  message?: string;
  body?: unknown;
}

export class DapClient {
  private seq = 1;
  private buffer = Buffer.alloc(0);
  private readonly pending = new Map<
    number,
    { resolve: (body: unknown) => void; reject: (err: Error) => void }
  >();
  private readonly eventQueue: DapMessage[] = [];
  private eventWaiter: { name: string; resolve: (body: unknown) => void } | undefined;

  private constructor(private readonly socket: net.Socket) {
    socket.on('data', (chunk) => this.onData(chunk));
  }

  static connect(host: string, port: number, timeoutMs = 10000): Promise<DapClient> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ host, port });
      const timer = setTimeout(
        () => reject(new Error(`DAP connect timeout to ${host}:${port}`)),
        timeoutMs
      );
      socket.once('connect', () => {
        clearTimeout(timer);
        resolve(new DapClient(socket));
      });
      socket.once('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  request(command: string, args?: unknown, timeoutMs = 20000): Promise<unknown> {
    const seq = this.seq++;
    const payload = JSON.stringify({ seq, type: 'request', command, arguments: args ?? {} });
    this.socket.write(`Content-Length: ${Buffer.byteLength(payload)}\r\n\r\n${payload}`);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(seq);
        reject(new Error(`DAP request timeout: ${command}`));
      }, timeoutMs);
      this.pending.set(seq, {
        resolve: (body) => {
          clearTimeout(timer);
          resolve(body);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
    });
  }

  /** Resolve with the body of the next `name` event (queued events count). */
  waitForEvent(name: string, timeoutMs = 30000): Promise<unknown> {
    const queuedIdx = this.eventQueue.findIndex((m) => m.event === name);
    if (queuedIdx >= 0) {
      const [msg] = this.eventQueue.splice(queuedIdx, 1);
      return Promise.resolve(msg.body);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.eventWaiter = undefined;
        reject(new Error(`DAP event timeout: ${name}`));
      }, timeoutMs);
      this.eventWaiter = {
        name,
        resolve: (body) => {
          clearTimeout(timer);
          resolve(body);
        },
      };
    });
  }

  close(): void {
    this.socket.destroy();
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd < 0) return;
      const header = this.buffer.subarray(0, headerEnd).toString('ascii');
      const lengthMatch = /Content-Length:\s*(\d+)/i.exec(header);
      if (!lengthMatch) throw new Error(`DAP: malformed header: ${header}`);
      const bodyLength = Number(lengthMatch[1]);
      const total = headerEnd + 4 + bodyLength;
      if (this.buffer.length < total) return;
      const body = this.buffer.subarray(headerEnd + 4, total).toString('utf8');
      this.buffer = this.buffer.subarray(total);
      this.onMessage(JSON.parse(body) as DapMessage);
    }
  }

  private onMessage(msg: DapMessage): void {
    if (msg.type === 'response' && msg.request_seq !== undefined) {
      const pending = this.pending.get(msg.request_seq);
      if (!pending) return;
      this.pending.delete(msg.request_seq);
      if (msg.success) pending.resolve(msg.body);
      else pending.reject(new Error(`DAP ${msg.command} failed: ${msg.message}`));
      return;
    }
    if (msg.type === 'event') {
      if (this.eventWaiter && this.eventWaiter.name === msg.event) {
        const waiter = this.eventWaiter;
        this.eventWaiter = undefined;
        waiter.resolve(msg.body);
        return;
      }
      this.eventQueue.push(msg);
    }
  }
}
