/**
 * Progress model for the managed-environment setup — the longest operation the
 * extension ever performs.
 *
 * The three things it drives report completely differently: our own downloads
 * know their byte count; uv knows nothing we can read, because its progress
 * bars are drawn with a TTY-only renderer, so a piped run only emits line
 * markers (`Resolved 42 packages`, `Downloading pandas (10.8MiB)`,
 * ` Downloaded pandas`, `Prepared …`, `Installed …`); venv creation reports
 * nothing at all. This module folds all of that into ONE monotonic 0..1 bar
 * plus a human-readable label.
 *
 * The labels are authored here on purpose. Sniffing the log stream for UI text
 * is what used to put a raw GitHub release URL in the notification, and what
 * made the label freeze for minutes during `uv pip install` (uv's own lines are
 * indented by the exec logger, so they never matched the prefix filter).
 *
 * Kept vscode-free like the rest of src/env.
 */

import { PYTHON_VERSION } from './constants';

export interface SetupProgress {
  /** Human-readable step, e.g. `Downloading Python 3.14 (25.0 MB)…`. Never a URL. */
  message: string;
  /** Overall completion, 0..1, monotonically non-decreasing. */
  percent: number;
}

export type ProgressReporter = (progress: SetupProgress) => void;

export type SetupPhase = 'uv' | 'python' | 'packages' | 'verify';

/**
 * Share of the bar per phase, by rough wall-clock cost of a cold first run:
 * the uv binary is a few MB, the standalone CPython ~25 MB, and the pinned
 * wheel set both the largest download and the only phase that also unpacks.
 */
const PHASE_WEIGHTS: Record<SetupPhase, number> = { uv: 5, python: 25, packages: 65, verify: 5 };
const PHASE_ORDER: SetupPhase[] = ['uv', 'python', 'packages', 'verify'];

function phaseStart(phase: SetupPhase): number {
  let start = 0;
  for (const id of PHASE_ORDER) {
    if (id === phase) break;
    start += PHASE_WEIGHTS[id];
  }
  return start / 100;
}

/** Bytes as MB with one decimal, for user-facing labels. */
export function formatMb(bytes: number): string {
  return (bytes / 1_000_000).toFixed(1);
}

/**
 * Drives one setup run's progress. Phases may be skipped entirely (a warm
 * venv needs no Python download), so the bar jumps forward — but never back:
 * every emission is clamped to the maximum reached so far, which also keeps
 * the recreate-and-retry pass from rewinding a bar the user already watched.
 */
export class SetupProgressTracker {
  private phase: SetupPhase = 'uv';
  private percent = 0;
  private label = '';

  constructor(private readonly reporter?: ProgressReporter) {}

  /** Enter a phase; the bar moves to that phase's starting position. */
  begin(phase: SetupPhase, message: string): void {
    this.phase = phase;
    this.emit(phaseStart(phase), message);
  }

  /** Progress inside the current phase, as 0..1 of that phase's weight. */
  within(fraction: number, message?: string): void {
    const clamped = Math.min(Math.max(fraction, 0), 1);
    this.emit(phaseStart(this.phase) + (clamped * PHASE_WEIGHTS[this.phase]) / 100, message);
  }

  /** New label at the current position. */
  note(message: string): void {
    this.emit(this.percent, message);
  }

  done(message: string): void {
    this.emit(1, message);
  }

  private emit(percent: number, message?: string): void {
    this.percent = Math.max(this.percent, Math.min(percent, 1));
    if (message !== undefined) {
      this.label = message;
    }
    this.reporter?.({ message: this.label, percent: this.percent });
  }
}

export type UvOutputEvent =
  | { kind: 'downloading'; name: string; bytes?: number }
  | { kind: 'downloaded'; name: string }
  | { kind: 'resolved'; count: number }
  | { kind: 'prepared'; count: number }
  | { kind: 'installed'; count: number };

const UV_BINARY_UNITS: Record<string, number> = { K: 1024, M: 1024 ** 2, G: 1024 ** 3 };

/**
 * Recognize one line of piped uv output. Everything else (including the
 * ` + package==version` install listing) returns undefined.
 *
 * Note the completion marker is ` Downloaded x` with a LEADING SPACE — uv
 * aligns it under the started line — so lines must be trimmed before matching.
 */
export function parseUvOutput(line: string): UvOutputEvent | undefined {
  const text = line.trim();
  const counted = /^(Resolved|Prepared|Installed) (\d+) packages?\b/.exec(text);
  if (counted) {
    const count = parseInt(counted[2], 10);
    if (counted[1] === 'Resolved') return { kind: 'resolved', count };
    if (counted[1] === 'Prepared') return { kind: 'prepared', count };
    return { kind: 'installed', count };
  }
  const downloading = /^Downloading (\S+)(.*)$/.exec(text);
  if (downloading) {
    const size = /\(([\d.]+)([KMG])iB\)/.exec(downloading[2]);
    const bytes = size ? parseFloat(size[1]) * UV_BINARY_UNITS[size[2]] : undefined;
    return { kind: 'downloading', name: downloading[1], bytes };
  }
  const downloaded = /^Downloaded (\S+)/.exec(text);
  if (downloaded) {
    return { kind: 'downloaded', name: downloaded[1] };
  }
  return undefined;
}

export interface PhaseUpdate {
  /** Position inside the phase, 0..1. */
  fraction: number;
  message: string;
}

/**
 * `uv venv --python X` progress. The interpreter download is the only slow
 * part and uv announces its size, so the label can state it; there is no
 * byte-level feed, hence the two fixed steps.
 */
export class UvVenvProgress {
  accept(line: string): PhaseUpdate | undefined {
    const event = parseUvOutput(line);
    if (!event) return undefined;
    if (event.kind === 'downloading' && event.name.startsWith('cpython')) {
      const size = event.bytes ? ` (${formatMb(event.bytes)} MB)` : '';
      return { fraction: 0.1, message: `Downloading Python ${PYTHON_VERSION}${size}…` };
    }
    if (event.kind === 'downloaded' && event.name.startsWith('cpython')) {
      return { fraction: 0.8, message: `Creating the Python ${PYTHON_VERSION} environment…` };
    }
    return undefined;
  }
}

/**
 * `uv pip install` progress. `Resolved N packages` gives the denominator; the
 * numerator counts completed downloads. Cache hits are never announced, so a
 * warm run under-counts and then jumps at `Prepared` — deliberately
 * conservative, because the bar may not go backwards.
 */
export class UvInstallProgress {
  private total = 0;
  private completed = 0;

  accept(line: string): PhaseUpdate | undefined {
    const event = parseUvOutput(line);
    if (!event) return undefined;
    switch (event.kind) {
      case 'resolved':
        this.total = event.count;
        return { fraction: 0.08, message: `Preparing ${event.count} packages…` };
      case 'downloading':
        return { fraction: this.downloadFraction(), message: this.downloadMessage(event.name) };
      case 'downloaded':
        this.completed += 1;
        return { fraction: this.downloadFraction(), message: this.downloadMessage() };
      case 'prepared':
        return { fraction: 0.85, message: `Installing ${event.count} packages…` };
      case 'installed':
        return { fraction: 1, message: `Installed ${event.count} packages` };
      default:
        return undefined;
    }
  }

  private downloadFraction(): number {
    if (this.total <= 0) return 0.1;
    return 0.1 + 0.72 * Math.min(this.completed / this.total, 1);
  }

  private downloadMessage(name?: string): string {
    if (this.total > 0) return `Downloading packages… (${this.completed}/${this.total})`;
    return name ? `Downloading ${name}…` : 'Downloading packages…';
  }
}
