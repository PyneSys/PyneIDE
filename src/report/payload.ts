/**
 * Problem-report payload contract and its final cleanup pass (VSCode-free).
 *
 * {@link ReportPayload} mirrors the server's `ProblemReportRequest`; the schema
 * version is frozen together with it. {@link finalizePayload} is the single
 * bottleneck every report passes through before it reaches the network — it
 * scrubs, enforces the user's script consent and truncates.
 */
import { scrubText, stripTracebackSource, type ScrubRoots } from './scrub';

/** Bumped only together with the server-side request model. */
export const REPORT_SCHEMA_VERSION = 1;

/** Header carrying the (public, non-secret) client key the API expects. */
export const REPORT_CLIENT_HEADER = 'X-PyneIDE-Client';

/**
 * Static client key. Not a secret: it ships inside the VSIX and anyone can
 * extract it. It only keeps random scanners from posting garbage; real abuse
 * protection is rate limiting in front of the API.
 */
export const REPORT_CLIENT_KEY = 'pyneide-16f0f1f5eb1c100e82af0e63';

export const MAX_SCRIPT_CHARS = 128_000;
export const MAX_LOG_CHARS = 96_000;

export type ReportSource = 'compile' | 'runtime' | 'manual';

/**
 * `pyne` is a `.py` with the `@pyne` marker, `python` any other `.py` — the
 * distinction matters on the receiving side, where a Pine compilation problem
 * and a plain-Python one look nothing alike.
 */
export type ReportScriptLanguage = 'pine' | 'pyne' | 'python';

export interface ReportPayload {
  schema_version: number;
  client: string;
  client_version: string;
  source: ReportSource;
  summary: string;
  note?: string | null;
  contact_email?: string | null;
  include_script: boolean;
  script?: string | null;
  script_language?: ReportScriptLanguage | null;
  script_sha256?: string | null;
  logs?: string | null;
  context: Record<string, unknown>;
}

export interface FinalizeOptions {
  /** The user's explicit choice; nothing else may turn this on. */
  includeScript: boolean;
  roots: ScrubRoots;
}

/** Keep the tail — the end of a log is where the failure is. */
function truncateHead(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const removed = text.length - limit;
  return `… [truncated ${removed} chars]\n${text.slice(removed)}`;
}

/** Scrub every string leaf of a free-form structure, preserving its shape. */
function scrubDeep(value: unknown, roots: ScrubRoots): unknown {
  if (typeof value === 'string') return scrubText(value, roots);
  if (Array.isArray(value)) return value.map((item) => scrubDeep(item, roots));
  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      result[key] = scrubDeep(item, roots);
    }
    return result;
  }
  return value;
}

/**
 * Produce the payload that may leave the machine.
 *
 * 1. Scrub the free-text fields and every string inside `context`.
 * 2. Without script consent: drop the source and remove the quoted source lines
 *    from the logs and the traceback as well. `script_sha256` survives either
 *    way, so two reports about the same file can be correlated without us
 *    holding the code.
 * 3. Truncate the script and the logs, keeping their tail.
 */
export function finalizePayload(draft: ReportPayload, opts: FinalizeOptions): ReportPayload {
  const { roots, includeScript } = opts;

  const context = scrubDeep(draft.context ?? {}, roots) as Record<string, unknown>;
  let logs = draft.logs ? scrubText(draft.logs, roots) : draft.logs ?? null;
  let script = includeScript ? draft.script ?? null : null;

  if (!includeScript) {
    if (logs) logs = stripTracebackSource(logs);
    if (typeof context.traceback === 'string') {
      context.traceback = stripTracebackSource(context.traceback);
    }
  }

  if (script && script.length > MAX_SCRIPT_CHARS) script = truncateHead(script, MAX_SCRIPT_CHARS);
  if (logs && logs.length > MAX_LOG_CHARS) logs = truncateHead(logs, MAX_LOG_CHARS);

  return {
    ...draft,
    schema_version: REPORT_SCHEMA_VERSION,
    summary: scrubText(draft.summary, roots),
    note: draft.note ? scrubText(draft.note, roots) : draft.note ?? null,
    include_script: includeScript,
    script,
    logs,
    context,
  };
}
