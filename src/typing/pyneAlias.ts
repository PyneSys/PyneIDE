import * as vscode from 'vscode';

/**
 * The PyneCore annotations their stubs declare as transparent aliases
 * (`Series: TypeAlias = T`). The alias is what makes `Series[float]` type as a
 * plain `float` everywhere it is used as a value, and the price is paid in the
 * hover: a checker resolves the name to the bare TypeVar behind it and titles
 * it `(type variable) T`, which tells a Pine author nothing about what they
 * hovered. `python/pyneide_series.py` carries the same names for analysis.
 */
const TRANSPARENT_ALIASES = new Set([
  'Series',
  'PersistentSeries',
  'Persistent',
  'IBPersistent',
  'IBPersistentSeries',
]);

const NAME_PATTERN = /[A-Za-z_][A-Za-z0-9_]*/;

/** How far a subscript may run before an unclosed bracket is assumed. */
const MAX_SUBSCRIPT = 200;

export interface PyneAlias {
  /** `Series[float]` where the source subscripts the name, `Series[T]` where it does not. */
  readonly label: string;
  /** The name itself, without the subscript. */
  readonly range: vscode.Range;
}

/**
 * The Pyne alias written at `position`, carrying the element type the source
 * spells out beside it.
 *
 * Purely lexical: the subscript is right there in the text, so no inference and
 * no analyzer are needed. That keeps it usable from both hover paths — the LSP
 * middleware that rewrites our own pyright's answer, and the standalone
 * provider that stacks beside a superseding extension's.
 */
export function pyneAliasAt(
  document: vscode.TextDocument,
  position: vscode.Position
): PyneAlias | undefined {
  const range = document.getWordRangeAtPosition(position, NAME_PATTERN);
  if (!range) return undefined;
  const name = document.getText(range);
  if (!TRANSPARENT_ALIASES.has(name)) return undefined;
  return { label: `${name}[${subscriptAt(document, range.end) ?? 'T'}]`, range };
}

/**
 * The text inside the `[...]` that follows `end`, collapsed onto one line.
 * Bracket depth is tracked so nested arguments (`Series[list[float]]`) survive.
 */
function subscriptAt(document: vscode.TextDocument, end: vscode.Position): string | undefined {
  const text = document.getText();
  let i = document.offsetAt(end);
  while (text[i] === ' ' || text[i] === '\t') i++;
  if (text[i] !== '[') return undefined;
  const open = ++i;
  let depth = 1;
  for (; i < text.length && i - open < MAX_SUBSCRIPT; i++) {
    if (text[i] === '[') depth++;
    else if (text[i] === ']' && --depth === 0) {
      return text.slice(open, i).replace(/\s+/g, ' ').trim() || undefined;
    }
  }
  return undefined;
}
