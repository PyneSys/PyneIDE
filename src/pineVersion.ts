/**
 * Pine Script version detection (vscode-free).
 *
 * A Pine script declares its language version with a `//@version=N` annotation
 * (TradingView's compiler directive), conventionally the first non-comment
 * line but allowed to follow other `//` comment lines. Only the first few
 * kilobytes are needed; callers may pass a truncated prefix of the file.
 */

const PINE_VERSION_RE = /\/\/\s*@version\s*=\s*(\d+)/;

/**
 * The declared Pine version, or undefined when the script carries no
 * `//@version` annotation (historically Pine v1).
 */
export function detectPineVersion(head: string): number | undefined {
  const match = PINE_VERSION_RE.exec(head);
  if (!match) return undefined;
  return parseInt(match[1], 10);
}
