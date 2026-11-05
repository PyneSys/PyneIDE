import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Index of the names the PyneCore reference documents, built from the Core's own
 * Markdown docs: every function, variable and constant with the page and line
 * that describes it. The docs lie in the project's git-ignored environment, where
 * an agent's search tools find nothing; this index is written next to the skills,
 * so an ordinary text search turns `ta.crossover` into `reference/lib/ta.md:569`.
 */

export interface DocumentedSymbol {
  /** Qualified name, e.g. `ta.crossover()`, `strategy.position_size`. */
  name: string;
  /** Path relative to the docs root, `/`-separated. */
  file: string;
  line: number;
}

/** Table columns that list documented names (parameter tables do not). */
const NAME_COLUMNS = new Set(['Constant', 'Function', 'Name', 'Property']);

/**
 * A documented name as written in a heading or a table cell: lowercase dotted
 * identifiers (`timenow`, `currency.USD`), decorators (`@script.strategy`) or a type
 * (`Series[T]`), with an optional argument list. Section titles such as `Colors` or `Usage` don't match.
 */
const NAME = /^(?:@?[a-z_]\w*(?:\.[A-Za-z_]\w*)*|[A-Za-z_]\w*\[[^\]]*\])(?:\([^)]*\))?$/;

export function markdownFiles(directory: string, prefix = ''): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const relative = prefix + entry.name;
    if (entry.isDirectory()) return markdownFiles(path.join(directory, entry.name), `${relative}/`);
    return entry.isFile() && entry.name.endsWith('.md') ? [relative] : [];
  });
}

/** Split at top-level `, ` and ` and `, leaving argument lists whole. */
function splitList(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '(' || char === '[') depth++;
    else if (char === ')' || char === ']') depth--;
    if (depth) continue;
    const separator = /^(?:,\s+|\s+and\s+)/.exec(text.slice(i))?.[0];
    if (separator) {
      parts.push(text.slice(start, i));
      start = i + separator.length;
      i = start - 1;
    }
  }
  parts.push(text.slice(start));
  return parts.map((part) => part.trim());
}

/** The names a heading or cell holds; prose such as "Time and date" holds none. */
function names(text: string): string[] {
  const parts = splitList(text.replaceAll('`', '').trim());
  return parts.every((part) => NAME.test(part)) ? parts : [];
}

/** `crossover(a, b)` -> `crossover()`; the arguments stay on the page. */
function shortForm(name: string): string {
  return name.replace(/\(.*\)$/, '()');
}

function qualify(namespace: string, name: string): string {
  const base = name.replace(/[([].*$/, '');
  if (!namespace || base === namespace || base.startsWith(`${namespace}.`) || /^[A-Z]/.test(base)) {
    return name;
  }
  return `${namespace}.${name}`;
}

/**
 * Which lines are page structure. The front matter sits in an HTML comment and
 * examples in code fences; a `# comment` in either is not a heading.
 */
function pageStructure(lines: string[]): boolean[] {
  let fenced = false;
  let comment = false;
  return lines.map((line) => {
    if (comment) {
      comment = !line.includes('-->');
      return false;
    }
    const fence = /^\s*(```|~~~)/.test(line);
    if (fenced || fence) {
      if (fence) fenced = !fenced;
      return false;
    }
    const start = line.indexOf('<!--');
    if (start >= 0 && !line.slice(0, start).trim()) {
      comment = !line.includes('-->', start + 4);
      return false;
    }
    return true;
  });
}

function pageSymbols(file: string, content: string): DocumentedSymbol[] {
  const lines = content.split(/\r?\n/);
  const structural = pageStructure(lines);
  const title = lines.find((line, index) => structural[index] && line.startsWith('# '))
    ?.slice(2).trim() ?? '';
  // A namespace page is titled with the namespace (`# ta`, `# strategy.closedtrades`).
  const namespace = file.startsWith('reference/lib/') && /^[a-z_]\w*(?:\.[a-z_]\w*)*$/.test(title)
    ? title : '';
  const found: DocumentedSymbol[] = [];
  const add = (name: string, index: number): void => {
    found.push({ name: shortForm(qualify(namespace, name)), file, line: index + 1 });
  };
  let nameTable = false;
  lines.forEach((line, index) => {
    if (!structural[index]) {
      nameTable = false;
      return;
    }
    const heading = /^#{2,4}\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) {
      for (const name of names(heading[1])) add(name, index);
      return;
    }
    if (!line.startsWith('|')) {
      nameTable = false;
      return;
    }
    const first = line.split('|')[1]?.trim() ?? '';
    if (/^:?-+:?$/.test(first)) return;
    const next = lines[index + 1] ?? '';
    if (/^\|\s*:?-+:?\s*\|/.test(next)) {
      nameTable = NAME_COLUMNS.has(first);
      return;
    }
    if (nameTable) for (const name of names(first)) add(name, index);
  });
  return found;
}

/** Every name the reference pages document, sorted by name, then location. */
export function documentedSymbols(docsRoot: string): DocumentedSymbol[] {
  const seen = new Set<string>();
  return markdownFiles(docsRoot).filter((file) => file.startsWith('reference/')).sort()
    .flatMap((file) => pageSymbols(file, fs.readFileSync(path.join(docsRoot, file), 'utf8')))
    .filter((symbol) => {
      const key = `${symbol.name}\u0000${symbol.file}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => a.name.localeCompare(b.name, 'en') || a.file.localeCompare(b.file) || a.line - b.line);
}

/** The Markdown index written into the pyne-development skill. */
export function symbolIndex(docsRoot: string): string {
  const symbols = documentedSymbols(docsRoot);
  if (!symbols.length) throw new Error(`No documented PyneCore names found in ${docsRoot}`);
  return [
    '# PyneCore name index', '',
    'Every function, variable, constant and type the PyneCore reference documents, with the',
    'page and line that describes it. Paths are relative to `pynecoreDocs` in `project.json`.',
    'This file is not git-ignored, so an ordinary text search works here: search for the name,',
    'for example `crossover` or `position_size`, then read the page from the listed line.',
    'Each line holds one name and where it is documented.', '',
    'A name missing from this index can still be described in prose: look up its namespace',
    'page in `documentation.md`. This index was written with the agent files; after a PyneCore',
    'update, ask the user to run **PyneIDE: Update Agent Files** if the lines no longer match.', '',
    ...symbols.map((symbol) => `- \`${symbol.name}\` \`${symbol.file}:${symbol.line}\``), '',
  ].join('\n');
}
