import * as fs from 'node:fs';
import * as path from 'node:path';

export interface WorkspaceLibrary {
  publisher: string;
  name: string;
  version: number;
  languages: readonly ('pine' | 'pyne')[];
  pineImport: string;
  pyneImport: string;
}

export interface ImportFragment {
  start: number;
  text: string;
}

export type LibraryImportSyntax = 'pine' | 'pyne';

export interface WorkspaceLibraryImport {
  publisher: string;
  name: string;
  version: number;
  alias: string;
  pathStart: number;
  pathEnd: number;
}

const LIBRARY_SEGMENT = /^[A-Za-z_][A-Za-z0-9_-]*$/;
const PYTHON_IMPORT_FRAGMENT = /^lib(?:\.[A-Za-z_][A-Za-z0-9_]*)*\.?$/;
const SEGMENT_PATTERN = '[A-Za-z_][A-Za-z0-9_-]*';
const IDENTIFIER_PATTERN = '[A-Za-z_][A-Za-z0-9_]*';
const PINE_IMPORT_RE = new RegExp(
  `^(\\s*import\\s+)((${SEGMENT_PATTERN})/(${SEGMENT_PATTERN})/([1-9]\\d*))` +
    `(?:\\s+as\\s+(${IDENTIFIER_PATTERN}))?`
);
const PYNE_IMPORT_RE = new RegExp(
  `^(\\s*import\\s+)(lib\\.(${IDENTIFIER_PATTERN})\\.(${IDENTIFIER_PATTERN})\\.v([1-9]\\d*))` +
    `(?:\\s+as\\s+(${IDENTIFIER_PATTERN}))?`
);

/**
 * Discover the versioned modules under `scripts/lib`.
 *
 * Pine and Pyne sources with the same publisher/name/version are one logical
 * library completion. Scanning on demand keeps newly created/deleted versions
 * visible without a watcher or stale cache.
 */
export function discoverWorkspaceLibraries(workdir: string): WorkspaceLibrary[] {
  const root = path.join(workdir, 'scripts', 'lib');
  const found = new Map<
    string,
    {
      publisher: string;
      name: string;
      version: number;
      languages: Set<'pine' | 'pyne'>;
    }
  >();

  for (const publisher of childDirectories(root)) {
    for (const name of childDirectories(path.join(root, publisher))) {
      const libraryDir = path.join(root, publisher, name);
      for (const file of childFiles(libraryDir)) {
        const match = /^v([1-9]\d*)\.(pine|py)$/i.exec(file);
        if (!match) continue;
        const version = Number(match[1]);
        if (!Number.isSafeInteger(version)) continue;
        const key = `${publisher}\0${name}\0${version}`;
        let entry = found.get(key);
        if (!entry) {
          entry = { publisher, name, version, languages: new Set() };
          found.set(key, entry);
        }
        entry.languages.add(match[2].toLowerCase() === 'pine' ? 'pine' : 'pyne');
      }
    }
  }

  return [...found.values()]
    .map(({ publisher, name, version, languages }) => ({
      publisher,
      name,
      version,
      languages: [...languages].sort(),
      pineImport: `${publisher}/${name}/${version}`,
      pyneImport: `lib.${publisher}.${name}.v${version}`,
    }))
    .sort(
      (a, b) =>
        a.publisher.localeCompare(b.publisher) ||
        a.name.localeCompare(b.name) ||
        b.version - a.version
    );
}

/** The Pine library-path fragment before the cursor, if this is an import line. */
export function pineImportFragment(linePrefix: string): ImportFragment | undefined {
  const match = /^(\s*import\s+)([A-Za-z0-9_/-]*)$/.exec(linePrefix);
  if (!match) return undefined;
  return { start: match[1].length, text: match[2] };
}

/** The Pyne `lib.publisher.library.vN` fragment before the cursor. */
export function pyneImportFragment(linePrefix: string): ImportFragment | undefined {
  const match = /^(\s*import\s+)(.*)$/.exec(linePrefix);
  if (!match) return undefined;
  const text = match[2];
  if (text && !PYTHON_IMPORT_FRAGMENT.test(text)) return undefined;
  return { start: match[1].length, text };
}

/**
 * Whether a Pine line is a syntactically plausible, unfinished library import.
 *
 * Invalid constructs remain diagnostics. Only prefixes a user can complete
 * into `publisher/library/version [as alias]` are treated as editor-in-flight.
 */
export function isIncompletePineLibraryImport(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed === 'import') return true;
  if (!trimmed.startsWith('import ')) return false;

  const rest = trimmed.slice('import '.length).trim();
  if (!rest) return true;
  const tokens = rest.split(/\s+/);
  if (tokens.length > 2) return false;

  const pathParts = tokens[0].split('/');
  if (pathParts.length > 3) return false;
  if (!pathParts[0] || !LIBRARY_SEGMENT.test(pathParts[0])) return false;
  if (pathParts.length >= 2 && pathParts[1] && !LIBRARY_SEGMENT.test(pathParts[1])) {
    return false;
  }
  if (pathParts.length === 3 && pathParts[2] && !/^[1-9]\d*$/.test(pathParts[2])) {
    return false;
  }

  const completePath =
    pathParts.length === 3 &&
    pathParts[1].length > 0 &&
    /^[1-9]\d*$/.test(pathParts[2]);
  if (tokens.length === 1) return !completePath;
  return completePath && tokens[1] === 'as';
}

/** Parse one complete workspace-library import and its clickable path range. */
export function parseWorkspaceLibraryImport(
  line: string,
  syntax: LibraryImportSyntax
): WorkspaceLibraryImport | undefined {
  const match = (syntax === 'pine' ? PINE_IMPORT_RE : PYNE_IMPORT_RE).exec(line);
  if (!match) return undefined;
  return {
    publisher: match[3],
    name: match[4],
    version: Number(match[5]),
    alias: match[6] ?? match[4],
    pathStart: match[1].length,
    pathEnd: match[1].length + match[2].length,
  };
}

/**
 * Resolve a workspace import to its source file.
 *
 * Pine navigation prefers the authored `.pine`; Pyne navigation prefers the
 * importable `.py`. The other form is a fallback for single-source libraries.
 */
export function resolveWorkspaceLibraryFile(
  workdir: string,
  imported: Pick<WorkspaceLibraryImport, 'publisher' | 'name' | 'version'>,
  syntax: LibraryImportSyntax
): string | undefined {
  const publisher = imported.publisher.replaceAll('-', '_');
  const name = imported.name.replaceAll('-', '_');
  const stem = path.join(
    workdir,
    'scripts',
    'lib',
    publisher,
    name,
    `v${imported.version}`
  );
  const extensions = syntax === 'pine' ? ['.pine', '.py'] : ['.py', '.pine'];
  return extensions.map((extension) => stem + extension).find((file) => fs.existsSync(file));
}

function childDirectories(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name !== '__pycache__')
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

function childFiles(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}
