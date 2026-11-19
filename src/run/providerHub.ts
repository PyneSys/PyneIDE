/**
 * The provider hubs of the live runs: one PyneCore process per Python
 * environment and workdir that holds the data providers (their SDK, market
 * lists and connections) for every live bridge of that workdir. A live bridge
 * started with a hub's environment holds no provider of its own, and neither do
 * the `request.security` processes it starts (see `pynecore.core.plugin.hub`).
 *
 * A hub starts with the first live run that asks for it and ends a little after
 * the last one ended, so a chart restart finds it running. One that dies while
 * runs use it is started again on the same port: their bridges reconnect by
 * themselves. A PyneCore without the hub module runs every bridge with a
 * provider of its own, as before. vscode-free.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as path from 'node:path';

import { trackInterpreter } from '../env/usage';

/** How long a hub without a run stays up, for the next run to find it. */
export const HUB_LINGER_MS = 10_000;

/** How long a hub may take to report its address before it is killed. */
export const HUB_START_TIMEOUT_MS = 30_000;

/** How long a stopped hub may take to exit before it is killed. */
const STOP_GRACE_MS = 4000;

/** A hub that died is started again at most this often within the window. */
const MAX_RESTARTS = 3;
export const HUB_RESTART_WINDOW_MS = 60_000;

/** How long a hub started again for running runs waits before the next try after a failed one. */
const RESTART_RETRY_MS = 1000;

/** A live run's hold on its hub. */
export interface HubLease {
  /** The environment variables that make a bridge use the hub; empty without one. */
  readonly env: Record<string, string>;
  /** The run ended. */
  release(): void;
}

const NO_HUB: HubLease = { env: {}, release: () => undefined };

class Hub {
  readonly token = crypto.randomBytes(24).toString('hex');
  refs = 0;
  /** The installed PyneCore has no hub module. */
  unsupported = false;
  private child: ChildProcessWithoutNullStreams | undefined;
  private port = 0;
  private starting: Promise<boolean> | undefined;
  private stopping = false;
  private linger: ReturnType<typeof setTimeout> | undefined;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private readonly restarts: number[] = [];

  constructor(
    private readonly pythonBin: string,
    private readonly workdir: string,
    private readonly log: (line: string) => void,
    private readonly lingerMs: number,
    private readonly startTimeoutMs: number,
    private readonly restartWindowMs: number,
    private readonly onGone: () => void
  ) {}

  get env(): Record<string, string> {
    return { PYNE_PROVIDER_HUB: `127.0.0.1:${this.port}`, PYNE_PROVIDER_HUB_TOKEN: this.token };
  }

  /** Resolves once the hub listens; false when it could not be started. */
  ready(): Promise<boolean> {
    if (this.linger) {
      clearTimeout(this.linger);
      this.linger = undefined;
    }
    if (this.retry) {
      clearTimeout(this.retry);
      this.retry = undefined;
    }
    this.starting ??= this.start();
    return this.starting;
  }

  /** The last run left: the hub ends unless another run comes in time. */
  idle(): void {
    if (this.linger) clearTimeout(this.linger);
    this.linger = setTimeout(() => {
      this.linger = undefined;
      if (this.refs === 0) this.stop();
    }, this.lingerMs);
  }

  stop(): void {
    if (this.linger) clearTimeout(this.linger);
    this.linger = undefined;
    if (this.retry) clearTimeout(this.retry);
    this.retry = undefined;
    this.stopping = true;
    const child = this.child;
    this.child = undefined;
    this.onGone();
    if (!child) return;
    // The hub runs until its standard input closes
    child.stdin.end();
    const killer = setTimeout(() => child.kill('SIGKILL'), STOP_GRACE_MS);
    child.once('close', () => clearTimeout(killer));
  }

  private start(): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const args = ['-X', 'utf8', '-m', 'pynecore.core.plugin.hub',
        '--config-dir', path.join(this.workdir, 'config')];
      // Started again: on the port the running bridges know
      if (this.port) args.push('--port', String(this.port));
      const child = spawn(this.pythonBin, args, {
        cwd: this.workdir,
        env: {
          ...process.env,
          PYNE_WORK_DIR: this.workdir,
          PYTHONUNBUFFERED: '1',
          PYNE_PROVIDER_HUB_TOKEN: this.token,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      trackInterpreter(child, this.pythonBin);
      this.child = child;
      let listening = false;
      let timedOut = false;
      // A hub that hangs before it listens must not hold its runs forever
      const startTimer = setTimeout(() => {
        timedOut = true;
        this.log(`[hub] did not report its address within ${this.startTimeoutMs / 1000} s`);
        child.kill('SIGKILL');
      }, this.startTimeoutMs);

      let stdoutBuf = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        if (listening) return;
        stdoutBuf += chunk;
        let nl: number;
        while (!listening && (nl = stdoutBuf.indexOf('\n')) >= 0) {
          const line = stdoutBuf.slice(0, nl);
          stdoutBuf = stdoutBuf.slice(nl + 1);
          try {
            const address = JSON.parse(line) as { port?: unknown };
            if (typeof address.port !== 'number') throw new Error('no port');
            this.port = address.port;
            listening = true;
            clearTimeout(startTimer);
            resolve(true);
          } catch {
            this.log(`[hub] unexpected output: ${line.slice(0, 200)}`);
          }
        }
      });

      let stderrBuf = '';
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => {
        stderrBuf += chunk;
        let nl: number;
        while ((nl = stderrBuf.indexOf('\n')) >= 0) {
          const line = stderrBuf.slice(0, nl);
          stderrBuf = stderrBuf.slice(nl + 1);
          if (!line.trim()) continue;
          if (!listening && /No module named ['"]?pynecore\.core\.plugin\.hub/.test(line)) {
            this.unsupported = true;
          } else {
            this.log(`[hub] ${line}`);
          }
        }
      });

      child.on('error', (err) => this.log(`[hub] spawn failed: ${err.message}`));
      child.once('close', (code) => {
        clearTimeout(startTimer);
        // A hub stopped before it listened leaves its acquirers without one
        if (!listening) resolve(false);
        if (this.child !== child) return;
        this.child = undefined;
        this.starting = undefined;
        if (!listening) {
          if (!this.unsupported && !timedOut) this.log(`[hub] did not start (exit code ${code})`);
          if (this.refs === 0) {
            this.onGone();
            return;
          }
          // Started again for the runs that use it: their bridges still wait for it
          if (this.port && !this.stopping && !this.unsupported) this.restart(RESTART_RETRY_MS);
          return;
        }
        if (this.stopping) return;
        if (this.refs === 0) {
          this.onGone();
          return;
        }
        this.log(`[hub] ended while live runs use it (exit code ${code})`);
        this.restart(0);
      });
    });
  }

  /**
   * Starts the hub again for its runs after `delayMs`. One that ended or failed
   * to start too often within the window waits until the oldest of those starts
   * leaves it: the runs' bridges keep reconnecting, so the hub must come back.
   */
  private restart(delayMs: number): void {
    const now = Date.now();
    while (this.restarts.length && now - this.restarts[0] > this.restartWindowMs) this.restarts.shift();
    if (this.restarts.length >= MAX_RESTARTS) {
      delayMs = Math.max(delayMs, this.restarts[0] + this.restartWindowMs - now + 1);
      this.log(`[hub] started again ${MAX_RESTARTS} times within ${this.restartWindowMs / 1000} s; trying again in ${Math.ceil(delayMs / 1000)} s`);
    } else if (delayMs > 0) {
      this.log(`[hub] trying again in ${Math.ceil(delayMs / 1000)} s`);
    } else {
      this.log('[hub] starting it again');
    }
    const attempt = (): void => {
      this.retry = undefined;
      if (this.stopping || this.refs === 0) return;
      this.restarts.push(Date.now());
      void this.ready();
    };
    if (delayMs > 0) this.retry = setTimeout(attempt, delayMs);
    else attempt();
  }
}

export class ProviderHubs {
  private readonly hubs = new Map<string, Hub>();
  /** Python environments whose PyneCore has no hub module. */
  private readonly unsupported = new Set<string>();

  /**
   * @param log Receives the hubs' own log lines.
   * @param lingerMs How long a hub without a run stays up.
   * @param startTimeoutMs How long a hub may take to report its address.
   * @param restartWindowMs The window a dying hub is started again at most three times in.
   */
  constructor(
    private readonly log: (line: string) => void,
    private readonly lingerMs = HUB_LINGER_MS,
    private readonly startTimeoutMs = HUB_START_TIMEOUT_MS,
    private readonly restartWindowMs = HUB_RESTART_WINDOW_MS
  ) {}

  /**
   * The hub of a live run, started when it is not running. Resolves with a
   * lease without a hub when the installed PyneCore has none or it cannot be
   * started: the run then holds its provider itself.
   */
  async acquire(pythonBin: string, workdir: string): Promise<HubLease> {
    if (this.unsupported.has(pythonBin)) return NO_HUB;
    const key = `${pythonBin}\0${workdir}`;
    let hub = this.hubs.get(key);
    if (!hub) {
      const created: Hub = new Hub(
        pythonBin, workdir, this.log, this.lingerMs, this.startTimeoutMs, this.restartWindowMs,
        () => {
          if (this.hubs.get(key) === created) this.hubs.delete(key);
        }
      );
      hub = created;
      this.hubs.set(key, hub);
    }
    hub.refs++;
    const held = hub;
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      held.refs--;
      if (held.refs === 0 && this.hubs.get(key) === held) held.idle();
    };
    if (!(await hub.ready())) {
      if (hub.unsupported) this.unsupported.add(pythonBin);
      released = true;
      hub.refs--;
      if (hub.refs === 0 && this.hubs.get(key) === hub) this.hubs.delete(key);
      return NO_HUB;
    }
    return { env: hub.env, release };
  }

  /** The Python environments may have changed: look for the hub module again. */
  forgetUnsupported(): void {
    this.unsupported.clear();
  }

  dispose(): void {
    for (const hub of [...this.hubs.values()]) hub.stop();
    this.hubs.clear();
  }
}
