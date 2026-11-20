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
 * provider of its own, as before.
 *
 * Started through the bridge, the hub process is the provider service of the
 * symbol browser too (`pyneide_bridge --provider-service --hub`): the service
 * needs the same SDKs and market lists, so it holds the hub like a run does and
 * talks to it over the process's standard streams. vscode-free.
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

/** A provider service's hold on the hub process that answers its requests. */
export interface HubService {
  /**
   * Writes one request line to the service; false when the hub is not running
   * and could not be started, or the service was released or `wanted` returned
   * false while it waited for the hub.
   *
   * @param wanted Checked right before the write: a request dropped while it
   *   waited for the hub is not written.
   */
  send(message: object, wanted?: () => boolean): Promise<boolean>;
  /**
   * Writes one line to the running hub process at once, also after the
   * service was released (a cancel of a request written earlier); false
   * without a running process.
   */
  post(message: object): boolean;
  /** The hub process ended: its unanswered requests are lost. */
  onGone(listener: () => void): void;
  /** Ends the hub process; it is started again while anything uses it. */
  recycle(): void;
  /** The service is done with the hub. */
  release(): void;
  /**
   * Like {@link release}, and a hub nothing else uses ends at once; resolves
   * when its process is gone.
   */
  releaseNow(): Promise<void>;
}

type ServiceListener = (event: Record<string, unknown>) => void;

class Hub {
  readonly token = crypto.randomBytes(24).toString('hex');
  refs = 0;
  /** The installed PyneCore has no hub module. */
  unsupported = false;
  private child: ChildProcessWithoutNullStreams | undefined;
  private port = 0;
  private starting: Promise<boolean> | undefined;
  /** The process {@link recycle} ended, to be replaced by a new one. */
  private recycled: ChildProcessWithoutNullStreams | undefined;
  private stopping = false;
  private linger: ReturnType<typeof setTimeout> | undefined;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private readonly restarts: number[] = [];
  private readonly serviceListeners = new Set<ServiceListener>();
  private readonly goneListeners = new Set<() => void>();

  constructor(
    readonly pythonBin: string,
    private readonly workdir: string,
    private readonly bridgeRoot: string | undefined,
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

  /**
   * Resolves once the hub listens, like {@link ready}, but leaves a hub that
   * waits for its next start alone: false until that start.
   */
  running(): Promise<boolean> {
    if (this.starting) return this.starting;
    return this.retry ? Promise.resolve(false) : this.ready();
  }

  /** Writes a line to the running hub's provider service. */
  write(message: object): boolean {
    const child = this.child;
    if (!child || !child.stdin.writable) return false;
    child.stdin.write(JSON.stringify(message) + '\n');
    return true;
  }

  /** Subscribes a provider service to the hub's events; returns the unsubscribe. */
  listen(onEvent: ServiceListener, onGone: () => void): () => void {
    this.serviceListeners.add(onEvent);
    this.goneListeners.add(onGone);
    return () => {
      this.serviceListeners.delete(onEvent);
      this.goneListeners.delete(onGone);
    };
  }

  /**
   * Ends the process; the close handler starts it again while anything uses it.
   * Until the new process listens, {@link running} waits for it.
   */
  recycle(): void {
    const child = this.child;
    if (!child || this.recycled === child) return;
    this.recycled = child;
    const replaced: Promise<boolean> = new Promise<boolean>((resolve) => {
      // The close handler of the process has started the new one by now
      child.once('close', () => {
        const next = this.starting;
        resolve(next && next !== replaced ? next : false);
      });
    });
    this.starting = replaced;
    child.stdin.end();
    const killer = setTimeout(() => child.kill('SIGKILL'), STOP_GRACE_MS);
    child.once('close', () => clearTimeout(killer));
  }

  /** Stops the hub and resolves when its process is gone. */
  stopped(): Promise<void> {
    const child = this.child;
    this.stop();
    if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
    return new Promise((resolve) => child.once('close', () => resolve()));
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
      // Through the bridge the hub process is the symbol browser's provider service too
      const args = this.bridgeRoot
        ? ['-X', 'utf8', '-m', 'pyneide_bridge', '--provider-service', '--hub', '--workdir', this.workdir]
        : ['-X', 'utf8', '-m', 'pynecore.core.plugin.hub', '--config-dir', path.join(this.workdir, 'config')];
      // Started again: on the port the running bridges know
      if (this.port) args.push(this.bridgeRoot ? '--hub-port' : '--port', String(this.port));
      const pythonPath = this.bridgeRoot
        ? { PYTHONPATH: process.env.PYTHONPATH
          ? `${this.bridgeRoot}${path.delimiter}${process.env.PYTHONPATH}`
          : this.bridgeRoot }
        : {};
      const child = spawn(this.pythonBin, args, {
        cwd: this.workdir,
        env: {
          ...process.env,
          ...pythonPath,
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
        stdoutBuf += chunk;
        let nl: number;
        while ((nl = stdoutBuf.indexOf('\n')) >= 0) {
          const line = stdoutBuf.slice(0, nl);
          stdoutBuf = stdoutBuf.slice(nl + 1);
          let event: Record<string, unknown> | undefined;
          try {
            const parsed: unknown = JSON.parse(line);
            if (parsed && typeof parsed === 'object') event = parsed as Record<string, unknown>;
          } catch {
            event = undefined;
          }
          if (listening) {
            // Everything after the address belongs to the provider service
            if (event && child === this.child) for (const listener of [...this.serviceListeners]) listener(event);
          } else if (event && typeof event.port === 'number') {
            this.port = event.port;
            listening = true;
            clearTimeout(startTimer);
            resolve(true);
          } else if (event?.e !== 'hello') {
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
        if (listening) for (const listener of [...this.goneListeners]) listener();
        if (this.child !== child) return;
        this.child = undefined;
        this.starting = undefined;
        if (this.recycled === child) {
          this.recycled = undefined;
          // Ended on purpose: replaced at once, not counted as a crash
          if (this.refs === 0) {
            this.onGone();
            return;
          }
          void this.ready();
          return;
        }
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
   * @param bridgeRoot Directory that contains the `pyneide_bridge` package: the
   *   hub then starts through the bridge and serves provider services too.
   */
  constructor(
    private readonly log: (line: string) => void,
    private readonly lingerMs = HUB_LINGER_MS,
    private readonly startTimeoutMs = HUB_START_TIMEOUT_MS,
    private readonly restartWindowMs = HUB_RESTART_WINDOW_MS,
    private readonly bridgeRoot?: string
  ) {}

  /**
   * The hub of a live run, started when it is not running. Resolves with a
   * lease without a hub when the installed PyneCore has none or it cannot be
   * started: the run then holds its provider itself.
   */
  async acquire(pythonBin: string, workdir: string): Promise<HubLease> {
    return (await this.hold(pythonBin, workdir))?.lease ?? NO_HUB;
  }

  /**
   * The hub process as the provider service of a symbol browser, started when
   * it is not running. Resolves with undefined when the hubs do not start
   * through the bridge, the installed PyneCore has no hub or it cannot be
   * started: the service then runs a process of its own.
   *
   * @param onEvent Receives every event of the service, also other holders'.
   */
  async acquireService(
    pythonBin: string,
    workdir: string,
    onEvent: (event: Record<string, unknown>) => void
  ): Promise<HubService | undefined> {
    if (!this.bridgeRoot) return undefined;
    const held = await this.hold(pythonBin, workdir);
    if (!held) return undefined;
    const { hub, lease } = held;
    const goneListeners = new Set<() => void>();
    const unlisten = hub.listen(onEvent, () => {
      for (const listener of [...goneListeners]) listener();
    });
    let released = false;
    const leave = (): boolean => {
      if (released) return false;
      released = true;
      unlisten();
      return true;
    };
    return {
      send: async (message, wanted) =>
        !released && (await hub.running()) && !released && (wanted?.() ?? true) && hub.write(message),
      post: (message) => hub.write(message),
      onGone: (listener) => void goneListeners.add(listener),
      recycle: () => hub.recycle(),
      release: () => {
        if (leave()) lease.release();
      },
      releaseNow: async () => {
        if (!leave()) return;
        lease.release();
        if (hub.refs === 0) await hub.stopped();
      },
    };
  }

  private async hold(pythonBin: string, workdir: string): Promise<{ hub: Hub; lease: HubLease } | undefined> {
    if (this.unsupported.has(pythonBin)) return undefined;
    const key = `${pythonBin}\0${workdir}`;
    let hub = this.hubs.get(key);
    if (!hub) {
      const created: Hub = new Hub(
        pythonBin, workdir, this.bridgeRoot, this.log, this.lingerMs, this.startTimeoutMs, this.restartWindowMs,
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
      return undefined;
    }
    return { hub, lease: { env: hub.env, release } };
  }

  /**
   * Ends the hubs of a Python environment that nothing uses any more, without
   * their linger; resolves when their processes are gone. For a package update,
   * which must not find the environment's files in use.
   */
  async endIdle(pythonBin: string): Promise<void> {
    const idle = [...this.hubs.values()].filter((hub) => hub.pythonBin === pythonBin && hub.refs === 0);
    await Promise.all(idle.map((hub) => hub.stopped()));
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
