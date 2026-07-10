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
  /^(?:[^\S\r\n]*#[^\r\n]*(?:\r?\n|$))*\s*[rRbBuUfF]*("""|'''|"|')[^\S\r\n]*@pyne(?:\s|\1|$)/;

const PYNE_EDGE_RE =
  /^(?:[^\S\r\n]*#[^\r\n]*(?:\r?\n|$))*\s*[rRbBuUfF]*("""|'''|"|')[^\S\r\n]*@pyne[^\S\r\n]+edge(?:\s|\1|$)/;

export type PyneKind = 'pyne' | 'edge';

/**
 * Classify a Python source head. Only the first few kilobytes are needed;
 * callers may pass a truncated prefix of the file.
 */
export function detectPyne(head: string): PyneKind | undefined {
  if (!PYNE_HEAD_RE.test(head)) {
    return undefined;
  }
  return PYNE_EDGE_RE.test(head) ? 'edge' : 'pyne';
}

/** How many bytes of a file are enough for detection. */
export const DETECT_HEAD_BYTES = 4096;
