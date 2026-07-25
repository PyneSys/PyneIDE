/**
 * Path and secret scrubbing for problem reports (VSCode-free).
 *
 * Everything that leaves the machine goes through here first. Two independent
 * jobs:
 *
 * - {@link scrubText} replaces the known roots (workdir, workspace, storage,
 *   extension, home) with placeholders and removes credential-shaped strings.
 * - {@link stripTracebackSource} removes the *quoted source lines* of Python
 *   tracebacks. The bridge sends `traceback.format_exc()`, which embeds the
 *   user's own source lines — without this, "send it without my code" would be
 *   a lie.
 */

/** Absolute directories worth replacing with a stable placeholder. */
export interface ScrubRoots {
  workdir?: string;
  workspace?: string;
  storage?: string;
  extension?: string;
  home?: string;
}

const PLACEHOLDERS: [keyof ScrubRoots, string][] = [
  ['workdir', '<workdir>'],
  ['workspace', '<workspace>'],
  ['storage', '<storage>'],
  ['extension', '<ext>'],
  ['home', '~'],
];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * A regex matching `dir` with either separator. Windows paths are matched
 * case-insensitively, since the same directory is logged with varying case
 * (`C:\Users` vs `c:\users`).
 */
function rootPattern(dir: string): RegExp {
  const pattern = dir
    .replace(/[\\/]+$/, '')
    .split(/[\\/]/)
    .map(escapeRegExp)
    .join('[\\\\/]');
  return new RegExp(pattern, process.platform === 'win32' ? 'gi' : 'g');
}

/**
 * Replace known roots, leftover home directories and credential-shaped strings.
 *
 * Roots are applied longest-first: the storage and extension directories
 * usually live under the home directory, so replacing `home` first would hide
 * the more specific placeholder.
 */
export function scrubText(text: string, roots: ScrubRoots): string {
  let result = text;

  const entries = PLACEHOLDERS.map(([key, placeholder]) => ({
    dir: roots[key]?.trim(),
    placeholder,
  }))
    .filter((entry): entry is { dir: string; placeholder: string } => !!entry.dir)
    .sort((a, b) => b.dir.length - a.dir.length);

  for (const { dir, placeholder } of entries) {
    result = result.replace(rootPattern(dir), placeholder);
  }

  // Home directories of other shapes (a path logged by a subprocess, a
  // different user, a container mount).
  result = result.replace(/(?:\/Users|\/home)\/[^/\s"':]+/g, '~');
  result = result.replace(/[A-Za-z]:\\Users\\[^\\\s"':]+/gi, '~');

  // Credentials, unconditionally.
  result = result.replace(/Bearer\s+\S+/gi, 'Bearer <redacted>');
  result = result.replace(/\beyJ[A-Za-z0-9_-]{6,}(?:\.[A-Za-z0-9_-]+){0,2}/g, '<token>');
  result = result.replace(
    /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|passwd|pwd)\b(\s*[:=]\s*)("[^"]*"|'[^']*'|\S+)/gi,
    (_match, key: string, sep: string) => `${key}${sep}<redacted>`
  );
  result = result.replace(/([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]+@/gi, '$1<redacted>@');

  return result;
}

/** `  File "<path>", line <n>[, in <fn>]` — the header of a traceback frame. */
const FRAME_HEADER_RE = /^(\s*)File "[^"]*", line \d+/;

const REMOVED_MARKER = '<source lines removed>';

/**
 * Remove the source lines Python quotes under each traceback frame, keeping
 * every `File "...", line N` header and the final exception line.
 *
 * The rule is strictly local: after a frame header, lines indented deeper than
 * the header belong to that frame's quoted source (the statement itself and the
 * `^^^^` caret line) and are dropped — one marker per frame. Anything at or
 * below the header's indentation ends the frame, so ordinary log lines are
 * never touched.
 */
export function stripTracebackSource(text: string): string {
  const out: string[] = [];
  let frameIndent: number | undefined;
  let markerWritten = false;

  for (const line of text.split('\n')) {
    const header = FRAME_HEADER_RE.exec(line);
    if (header) {
      frameIndent = header[1].length;
      markerWritten = false;
      out.push(line);
      continue;
    }

    if (frameIndent !== undefined) {
      const indent = line.length - line.trimStart().length;
      if (line.trim() !== '' && indent > frameIndent) {
        if (!markerWritten) {
          out.push(`${' '.repeat(frameIndent + 2)}${REMOVED_MARKER}`);
          markerWritten = true;
        }
        continue;
      }
      frameIndent = undefined;
    }

    out.push(line);
  }

  return out.join('\n');
}
