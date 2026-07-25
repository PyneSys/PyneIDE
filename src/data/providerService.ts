/**
 * Host-side client for the `pyneide_bridge --provider-service` process: a
 * long-lived NDJSON RPC endpoint feeding the symbol browser (see
 * python/pyneide_bridge/provider_service.py).
 *
 * The process is spawned lazily on the first request and kept alive across
 * requests (provider instances cache their symbol lists / configs there). Each
 * request carries a correlation `id`; the reply is `{e:'result', id, result}`
 * or `{e:'result', id, error}`, with `{e:'progress', id, ...}` in between for a
 * download. If the process dies, every pending request rejects and the next
 * request respawns it.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import * as path from 'node:path';

/** A structured provider-side failure (mirrors the service's error payload). */
export class ProviderServiceError extends Error {
  constructor(
    message: string,
    readonly kind: string,
    readonly retryable: boolean
  ) {
    super(message);
    this.name = 'ProviderServiceError';
  }
}

/** Progress of an in-flight `download` request (seconds of the run window). */
export interface DownloadProgressEvent {
  done: number;
  total: number;
  /** True while the window end is open-ended (fetch-all) — total is a lower
   * bound, so the bar should render indeterminate. */
  indeterminate?: boolean;
}

export interface RequestOptions {
  /** Streamed progress events (download only). */
  onProgress?: (p: DownloadProgressEvent) => void;
  /** Reject after this many ms with no reply. 0 disables the timeout (used for
   * downloads, whose duration is unbounded). Defaults to 60s. */
  timeoutMs?: number;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  onProgress?: (p: DownloadProgressEvent) => void;
  timer?: NodeJS.Timeout;
}

export interface ProviderServiceOptions {
  /** Python interpreter of the managed venv with pynecore installed. */
  pythonBin: string;
  /** Directory that CONTAINS the pyneide_bridge package (`<ext>/python`). */
  bridgeRoot: string;
  /** Resolved pyne workdir (the service reads config/ and writes data/). */
  workdir: string;
  /** Diagnostic sink: pynecore logs (stderr) and lifecycle notes. */
  log?: (line: string) => void;
}

export class ProviderService {
  private child: ChildProcessWithoutNullStreams | undefined;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private stdoutBuf = '';
  private disposed = false;

  constructor(private readonly opts: ProviderServiceOptions) {}

  /**
   * Issue one RPC and resolve with its `result`. Rejects with a
   * `ProviderServiceError` on a provider-side failure, or a plain Error if the
   * process dies or the request times out. Spawns the process if needed.
   */
  request<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
    options: RequestOptions = {}
  ): Promise<T> {
    return this.requestWithHandle<T>(method, params, options).result;
  }

  /**
   * Like {@link request}, but also returns the correlation `id` so a
   * long-running request (a download) can be cancelled with {@link cancel}.
   */
  requestWithHandle<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
    options: RequestOptions = {}
  ): { id: number; result: Promise<T> } {
    if (this.disposed) {
      return { id: -1, result: Promise.reject(new Error('Provider service disposed')) };
    }
    const child = this.ensureChild();
    const id = this.nextId++;
    const timeoutMs = options.timeoutMs ?? 60_000;

    const result = new Promise<T>((resolve, reject) => {
      const entry: Pending = {
        resolve: resolve as (value: unknown) => void,
        reject,
        onProgress: options.onProgress,
      };
      if (timeoutMs > 0) {
        entry.timer = setTimeout(() => {
          this.pending.delete(id);
          this.send({ cmd: 'cancel', id });
          reject(new Error(`Request '${method}' timed out after ${timeoutMs} ms`));
        }, timeoutMs);
      }
      this.pending.set(id, entry);
      if (!child.stdin.writable) {
        this.settleReject(id, new Error('Provider service stdin is not writable'));
        return;
      }
      child.stdin.write(JSON.stringify({ cmd: 'rpc', id, method, params }) + '\n');
    });
    return { id, result };
  }

  /**
   * Drop an in-flight request: tell the service to stop, and settle the local
   * promise now (a cancelled browse request emits no reply; a download emits a
   * Cancelled result we no longer have a handler for). Safe to call with an
   * unknown id.
   */
  cancel(id: number): void {
    this.send({ cmd: 'cancel', id });
    this.settleReject(id, new ProviderServiceError('Cancelled', 'Cancelled', false));
  }

  dispose(): void {
    this.disposed = true;
    this.rejectAll(new Error('Provider service disposed'));
    this.killChild();
  }

  /**
   * Drop the running process so the next request spawns a fresh one. Needed
   * after a plugin install/uninstall: entry points are discovered at import
   * time, so a live service would keep serving the old provider set.
   */
  restart(): void {
    this.rejectAll(new Error('Provider service restarted'));
    this.killChild();
  }

  private killChild(): void {
    const child = this.child;
    this.child = undefined;
    child?.stdin.end();
    child?.kill('SIGTERM');
  }

  private ensureChild(): ChildProcessWithoutNullStreams {
    if (this.child) return this.child;

    const args = ['-X', 'utf8', '-m', 'pyneide_bridge', '--provider-service', '--workdir', this.opts.workdir];
    const pythonPath = process.env.PYTHONPATH
      ? `${this.opts.bridgeRoot}${path.delimiter}${process.env.PYTHONPATH}`
      : this.opts.bridgeRoot;
    const child = spawn(this.opts.pythonBin, args, {
      cwd: this.opts.workdir,
      env: {
        ...process.env,
        PYTHONPATH: pythonPath,
        PYNE_WORK_DIR: this.opts.workdir,
        PYTHONUNBUFFERED: '1',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    this.stdoutBuf = '';

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.onStdout(chunk));

    let stderrBuf = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderrBuf += chunk;
      let nl: number;
      while ((nl = stderrBuf.indexOf('\n')) >= 0) {
        const line = stderrBuf.slice(0, nl);
        stderrBuf = stderrBuf.slice(nl + 1);
        if (line.trim()) this.opts.log?.(line);
      }
    });

    child.on('error', (err) => {
      this.opts.log?.(`[provider-service] spawn failed: ${err.message}`);
      this.onChildGone(new Error(`Provider service failed to start: ${err.message}`));
    });
    child.on('close', (code) => {
      this.opts.log?.(`[provider-service] exited (code ${code ?? 'signal'})`);
      this.onChildGone(new Error(`Provider service exited (code ${code ?? 'signal'})`));
    });

    return child;
  }

  private onStdout(chunk: string): void {
    this.stdoutBuf += chunk;
    let nl: number;
    while ((nl = this.stdoutBuf.indexOf('\n')) >= 0) {
      const line = this.stdoutBuf.slice(0, nl).trim();
      this.stdoutBuf = this.stdoutBuf.slice(nl + 1);
      if (!line) continue;
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(line) as Record<string, unknown>;
      } catch {
        this.opts.log?.(`[provider-service] unparseable line: ${line.slice(0, 200)}`);
        continue;
      }
      this.handleEvent(event);
    }
  }

  private handleEvent(event: Record<string, unknown>): void {
    const e = event.e;
    if (e === 'hello') return; // startup handshake — nothing to correlate
    if (e === 'progress') {
      const id = event.id as number;
      const entry = this.pending.get(id);
      entry?.onProgress?.({
        done: Number(event.done) || 0,
        total: Number(event.total) || 0,
        indeterminate: Boolean(event.indeterminate),
      });
      return;
    }
    if (e === 'result') {
      const id = event.id as number;
      if (event.error) {
        const err = event.error as { kind?: string; message?: string; retryable?: boolean };
        this.settleReject(
          id,
          new ProviderServiceError(err.message ?? 'Provider error', err.kind ?? 'Error', Boolean(err.retryable))
        );
      } else {
        this.settleResolve(id, event.result);
      }
      return;
    }
    if (e === 'error') {
      // A top-level service crash (from __main__): fail everything in flight.
      const message = String(event.message ?? 'Provider service error');
      this.opts.log?.(`[provider-service] fatal: ${message}`);
      this.rejectAll(new Error(message));
    }
  }

  private settleResolve(id: number, value: unknown): void {
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    if (entry.timer) clearTimeout(entry.timer);
    entry.resolve(value);
  }

  private settleReject(id: number, err: Error): void {
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    if (entry.timer) clearTimeout(entry.timer);
    entry.reject(err);
  }

  private onChildGone(err: Error): void {
    if (this.child) this.child = undefined;
    this.rejectAll(err);
  }

  private rejectAll(err: Error): void {
    for (const [, entry] of this.pending) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.reject(err);
    }
    this.pending.clear();
  }

  private send(cmd: object): void {
    const child = this.child;
    if (child && child.stdin.writable) {
      child.stdin.write(JSON.stringify(cmd) + '\n');
    }
  }
}

// ---- typed request wrappers -------------------------------------------------

/** One installed data provider. */
export interface ProviderInfo {
  name: string;
  display_name: string;
  multi_broker: boolean;
  summary: string;
}

/** One broker/exchange of a multi-broker provider. */
export interface BrokerInfo {
  id: string;
  name: string;
}

export interface BrokersResult {
  /** False when the provider does not enumerate brokers (single-broker). */
  supported: boolean;
  brokers: BrokerInfo[];
}

/** A fully serialized SymInfo (flat fields + opening_hours / session arrays). */
export type SymInfoDict = Record<string, unknown>;

export interface DownloadResult {
  ohlcv_path: string;
  bars_written: number;
  from: number;
  to: number;
  fetch_all: boolean;
  syminfo: SymInfoDict | null;
}

export interface DownloadRequest {
  provider: string;
  broker?: string;
  symbol: string;
  timeframe: string;
  /** Epoch seconds, or the string 'continue' to resume an existing file. */
  from: number | 'continue';
  to: number;
  truncate?: boolean;
}
