/**
 * Pyne script detection.
 *
 * A `.py` module is a Pyne script when its module docstring STARTS with
 * `@pyne`. This mirrors pynecore's import-hook head check
 * (`pynecore/core/import_hook.py`, `_PYNE_HEAD_RE`): leading comment lines
 * are skipped so a PEP 723 `# /// script` metadata block before the
 * docstring does not hide it, and any quote style / string prefix is
 * accepted.
 */

const PYNE_HEAD_RE =
  /^(?:[^\S\r\n]*#[^\r\n]*(?:\r?\n|$))*\s*[rRbBuUfF]*("""|'''|"|')\s*@pyne(?:\s|\1|$)/;

const PYNE_EDGE_RE =
  /^(?:[^\S\r\n]*#[^\r\n]*(?:\r?\n|$))*\s*[rRbBuUfF]*("""|'''|"|')\s*@pyne[^\S\r\n]+edge(?:\s|\1|$)/;

// `@pyne lib`: a transformed Pyne module that scripts import but never run —
// the checker drops the `main` requirement for these. pynecore's import hook
// tolerates any token after `@pyne`, so the marker is runtime-compatible.
const PYNE_LIB_RE =
  /^(?:[^\S\r\n]*#[^\r\n]*(?:\r?\n|$))*\s*[rRbBuUfF]*("""|'''|"|')\s*@pyne[^\S\r\n]+lib(?:\s|\1|$)/;

// PYNE_EDGE_RE with the removable token split out: group 1 is everything up
// to and including `@pyne`, group 3 is the whitespace + `edge` sequence whose
// deletion turns an Edge script back into a plain Pyne script.
const PYNE_EDGE_TOKEN_RE =
  /^((?:[^\S\r\n]*#[^\r\n]*(?:\r?\n|$))*\s*[rRbBuUfF]*("""|'''|"|')\s*@pyne)([^\S\r\n]+edge)(?=\s|\2|$)/;

export type PyneKind = 'pyne' | 'edge' | 'lib';

/**
 * Classify a Python source head. Only the first few kilobytes are needed;
 * callers may pass a truncated prefix of the file.
 */
export function detectPyne(head: string): PyneKind | undefined {
  if (!PYNE_HEAD_RE.test(head)) {
    return undefined;
  }
  if (PYNE_EDGE_RE.test(head)) {
    return 'edge';
  }
  return PYNE_LIB_RE.test(head) ? 'lib' : 'pyne';
}

/**
 * Locate the removable ` edge` token (leading whitespace included) in a
 * source head, as character offsets. Deleting exactly this range converts an
 * Edge marker into a plain `@pyne` one.
 */
export function findEdgeToken(head: string): { start: number; end: number } | undefined {
  const match = PYNE_EDGE_TOKEN_RE.exec(head);
  if (!match) {
    return undefined;
  }
  const start = match[1].length;
  return { start, end: start + match[3].length };
}

/** How many bytes of a file are enough for detection. */
export const DETECT_HEAD_BYTES = 4096;
