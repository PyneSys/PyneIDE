/**
 * Turning a plugin's class docstring into displayable paragraphs.
 *
 * The text comes from the index as the author wrote it in Python: indented to
 * its `class` block and hand-wrapped. Only the two structures a docstring
 * reliably has are recovered — the common indentation is stripped and blank
 * lines separate paragraphs. Everything else stays verbatim; it is third-party
 * plain text, so the renderer escapes it.
 */

/** Strip the common indentation a docstring carries from its source file. */
export function dedentDocstring(text: string): string {
  const lines = text.replace(/\t/g, '    ').split('\n');
  let indent = Infinity;
  // The first line starts right after the opening quotes, so it never carries
  // the block's indentation and must not lower the minimum.
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;
    indent = Math.min(indent, line.length - line.trimStart().length);
  }
  if (!isFinite(indent) || indent === 0) return text;
  return lines.map((line, i) => (i === 0 ? line : line.slice(indent))).join('\n');
}

/** Dedented, blank-line separated paragraphs; empty for a blank docstring. */
export function docstringParagraphs(text: string): string[] {
  return dedentDocstring(text)
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.replace(/\s+$/gm, '').trim())
    .filter(Boolean);
}
