export type LabelLink =
  | { kind: 'web'; url: URL }
  | { kind: 'file'; url: URL; line?: number }
  | { kind: 'relative'; path: string; line?: number };

function lineNumber(fragment: string): number | undefined {
  const match = /^#L([1-9]\d*)$/.exec(fragment);
  const line = match && Number(match[1]);
  return typeof line === 'number' && Number.isSafeInteger(line) ? line : undefined;
}

/** Used both for linkifying plain text and for validating clicks on the host. */
export function parseLabelLink(target: string): LabelLink | undefined {
  if (!target || /[\s\u0000-\u001f\u007f]/u.test(target)) return undefined;
  try {
    if (/^https?:\/\/[^/\\]/i.test(target)) {
      const url = new URL(target);
      return { kind: 'web', url };
    }
    if (/^file:\/\/.+/i.test(target)) {
      const url = new URL(target);
      const line = lineNumber(url.hash);
      if (url.search || (url.hash && line === undefined)) return undefined;
      return { kind: 'file', url, line };
    }

    const hash = target.indexOf('#');
    const line = hash < 0 ? undefined : lineNumber(target.slice(hash));
    if (hash >= 0 && line === undefined) return undefined;
    const name = hash < 0 ? target : target.slice(0, hash);
    // A bare word is prose. A separator, extension or line suffix makes
    // the token look like a path, including ./Makefile and Makefile#L12.
    if (!/^[\p{L}\p{M}\p{N}._%~+-][\p{L}\p{M}\p{N}._%~+\/\\-]*$/u.test(name) ||
        (line === undefined && !/[/\\]|\.[\p{L}\p{N}]+$/u.test(name))) return undefined;
    const file = decodeURIComponent(name);
    if (/^[/\\]|[:\u0000-\u001f\u007f]/u.test(file)) return undefined;
    return { kind: 'relative', path: file, line };
  } catch {
    return undefined;
  }
}

/** Link offsets into the original text, so spaces, punctuation and newlines
 * can be copied to text nodes verbatim. */
export function* labelLinkSpans(text: string): Iterable<{ start: number; target: string }> {
  for (const match of text.matchAll(/[^\s<>"'`]+/gu)) {
    const token = match[0];
    const leading = /^[([{]+/.exec(token)?.[0].length ?? 0;
    let target = token.slice(leading).replace(/[.,;:!?]+$/, '');
    for (const opener of token.slice(0, leading)) {
      const closer = opener === '(' ? ')' : opener === '[' ? ']' : '}';
      if (target.endsWith(closer)) target = target.slice(0, -1);
    }
    if (parseLabelLink(target)) yield { start: match.index + leading, target };
  }
}
