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

export interface LibraryMemberFragment extends ImportFragment {
  alias: string;
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

export type WorkspaceLibraryExportKind = 'function' | 'method';

export interface WorkspaceLibraryExport {
  name: string;
  kind: WorkspaceLibraryExportKind;
  signature: string;
  signatureSyntax?: LibraryImportSyntax;
  overloads?: readonly string[];
  documentation?: string;
}

export interface ParsedLibraryDocumentation {
  summary?: string;
  parameters: Readonly<Record<string, string>>;
  returns?: string;
}

export interface ActiveLibraryCall {
  alias: string;
  member: string;
  activeParameter: number;
}

export interface WorkspaceLibraryCallArgument {
  start: number;
  end: number;
  name?: string;
  spread: boolean;
}

export interface WorkspaceLibraryCall {
  alias: string;
  member: string;
  memberStart: number;
  memberEnd: number;
  arguments: readonly WorkspaceLibraryCallArgument[];
}

export interface LibraryCallIssue {
  start: number;
  end: number;
  code:
    | 'pyne-lib-argument-count'
    | 'pyne-lib-argument-name'
    | 'pyne-lib-argument-duplicate'
    | 'pyne-lib-argument-order';
  message: string;
}

interface LibraryParameterSpec {
  name: string;
  required: boolean;
  positional: boolean;
  keyword: boolean;
  variadic?: 'positional' | 'keyword';
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

/** The imported alias and partial member after the last `alias.` in code. */
export function libraryMemberFragment(
  linePrefix: string,
  syntax: LibraryImportSyntax
): LibraryMemberFragment | undefined {
  if (!cursorIsInLineCode(linePrefix, syntax)) return undefined;
  const match = /(?:^|[^A-Za-z0-9_])([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)?$/.exec(
    linePrefix
  );
  if (!match) return undefined;
  return {
    alias: match[1],
    start: linePrefix.length - (match[2]?.length ?? 0),
    text: match[2] ?? '',
  };
}

function cursorIsInLineCode(linePrefix: string, syntax: LibraryImportSyntax): boolean {
  let quote: string | undefined;
  let escaped = false;
  for (let index = 0; index < linePrefix.length; index += 1) {
    const char = linePrefix[index];
    const next = linePrefix[index + 1];
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === quote) {
        quote = undefined;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if ((syntax === 'pine' && char === '/' && next === '/') || (syntax === 'pyne' && char === '#')) {
      return false;
    }
  }
  return quote === undefined;
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

/** Collect complete workspace-library imports from a source document. */
export function collectWorkspaceLibraryImports(
  source: string,
  syntax: LibraryImportSyntax
): WorkspaceLibraryImport[] {
  return source
    .split(/\r?\n/)
    .map((line) => parseWorkspaceLibraryImport(line, syntax))
    .filter((entry): entry is WorkspaceLibraryImport => entry !== undefined);
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

/** Read callable exports from an authored Pine or native/compiled Pyne library. */
export function readWorkspaceLibraryExports(file: string): WorkspaceLibraryExport[] {
  let source: string;
  try {
    source = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  return path.extname(file).toLowerCase() === '.pine'
    ? parsePineLibraryExports(source)
    : parsePyneLibraryExports(source);
}

/** Extract `export f(...)` and `export method f(...)` declarations. */
export function parsePineLibraryExports(source: string): WorkspaceLibraryExport[] {
  const exports: WorkspaceLibraryExport[] = [];
  const declaration =
    /^[ \t]*export[ \t]+(?:(method)[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)[ \t]*(\()/gm;
  for (const match of source.matchAll(declaration)) {
    const open = (match.index ?? 0) + match[0].lastIndexOf('(');
    const close = matchingParen(source, open, false);
    if (close === undefined) continue;
    const name = match[2];
    exports.push({
      name,
      kind: match[1] ? 'method' : 'function',
      signature: normalizeSignature(source.slice((match.index ?? 0) + match[0].indexOf(name), close + 1)),
      signatureSyntax: 'pine',
      documentation: precedingComment(source, match.index ?? 0, '//'),
    });
  }
  return deduplicateExports(exports);
}

/**
 * Extract callable names from a static module-level `__all__`.
 *
 * Native `@pyne lib` modules expose top-level functions. Compiled Pine
 * libraries expose `Exported()` proxies typed by a Protocol whose `__call__`
 * carries the original signature, so both forms remain useful as a fallback
 * when only a `.py` library source exists.
 */
export function parsePyneLibraryExports(source: string): WorkspaceLibraryExport[] {
  const publicNames = staticPythonAll(source);
  if (publicNames.size === 0) return [];

  const exports: WorkspaceLibraryExport[] = [];
  const topLevelDef = /^(?:async[ \t]+)?def[ \t]+([A-Za-z_][A-Za-z0-9_]*)[ \t]*(\()/gm;
  for (const match of source.matchAll(topLevelDef)) {
    const name = match[1];
    if (!publicNames.has(name)) continue;
    const open = (match.index ?? 0) + match[0].lastIndexOf('(');
    const close = matchingParen(source, open, true);
    if (close === undefined) continue;
    exports.push({
      name,
      kind: 'function',
      signature: pythonSignature(source, name, close, open),
      signatureSyntax: 'pyne',
      documentation:
        pythonFunctionDocstring(source, close) ??
        precedingComment(source, match.index ?? 0, '#'),
    });
  }

  const proxy =
    /^([A-Za-z_][A-Za-z0-9_]*)[ \t]*:[ \t]*([A-Za-z_][A-Za-z0-9_]*)[ \t]*=[ \t]*Exported\s*\(/gm;
  for (const match of source.matchAll(proxy)) {
    const name = match[1];
    if (!publicNames.has(name) || exports.some((entry) => entry.name === name)) continue;
    const call = protocolCallSignature(source, match[2], name);
    exports.push({
      name,
      kind: call?.kind ?? 'function',
      signature: call?.signature ?? `${name}(…)`,
      signatureSyntax: 'pyne',
    });
  }
  return deduplicateExports(exports);
}

/** Split a callable signature into parameter labels without splitting nested defaults. */
export function librarySignatureParameters(signature: string): string[] {
  const open = signature.indexOf('(');
  if (open < 0) return [];
  const close = matchingParen(signature, open, false);
  if (close === undefined) return [];
  const body = signature.slice(open + 1, close);
  const parameters: string[] = [];
  let start = 0;
  let quote: string | undefined;
  let escaped = false;
  const brackets: string[] = [];
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index];
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === quote) {
        quote = undefined;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '(' || char === '[' || char === '{') brackets.push(char);
    if (
      char === '<' &&
      /\b(?:array|matrix|map)\s*$/.test(body.slice(0, index))
    ) {
      brackets.push(char);
    }
    if (char === ')' || char === ']' || char === '}') brackets.pop();
    if (char === '>' && brackets.at(-1) === '<') brackets.pop();
    if (char === ',' && brackets.length === 0) {
      const parameter = body.slice(start, index).trim();
      if (parameter) parameters.push(parameter);
      start = index + 1;
    }
  }
  const last = body.slice(start).trim();
  if (last) parameters.push(last);
  return parameters;
}

/** Recover a parameter's identifier from a Pine or Python signature label. */
export function libraryParameterName(
  label: string,
  syntax: LibraryImportSyntax
): string | undefined {
  const beforeDefault = label.split('=', 1)[0].trim();
  if (syntax === 'pyne') {
    return /^\*{0,2}([A-Za-z_][A-Za-z0-9_]*)/.exec(beforeDefault)?.[1];
  }
  const identifiers = beforeDefault.match(/[A-Za-z_][A-Za-z0-9_]*/g);
  return identifiers?.at(-1);
}

/** Parse Pine doc tags (and plain Pyne prose) into help-friendly sections. */
export function parseLibraryDocumentation(
  documentation: string | undefined
): ParsedLibraryDocumentation {
  const parameters: Record<string, string> = {};
  const summary: string[] = [];
  let returns: string | undefined;
  let continuation:
    | { kind: 'summary' }
    | { kind: 'parameter'; name: string }
    | { kind: 'returns' }
    | undefined;

  for (const rawLine of documentation?.split(/\r?\n/) ?? []) {
    const line = rawLine.trim();
    if (!line) continue;
    const functionTag = /^@(?:function|description)\s*(.*)$/i.exec(line);
    if (functionTag) {
      if (functionTag[1]) summary.push(functionTag[1]);
      continuation = { kind: 'summary' };
      continue;
    }
    const parameterTag = /^@param\s+([A-Za-z_][A-Za-z0-9_]*)\s*(.*)$/i.exec(line);
    if (parameterTag) {
      parameters[parameterTag[1]] = parameterTag[2];
      continuation = { kind: 'parameter', name: parameterTag[1] };
      continue;
    }
    const returnsTag = /^@returns?\s*(.*)$/i.exec(line);
    if (returnsTag) {
      returns = returnsTag[1];
      continuation = { kind: 'returns' };
      continue;
    }
    if (line.startsWith('@')) {
      continuation = undefined;
      continue;
    }
    if (continuation?.kind === 'parameter') {
      parameters[continuation.name] =
        `${parameters[continuation.name]} ${line}`.trim();
    } else if (continuation?.kind === 'returns') {
      returns = `${returns ?? ''} ${line}`.trim();
    } else {
      summary.push(line);
      continuation = { kind: 'summary' };
    }
  }
  return {
    summary: summary.join(' ').trim() || undefined,
    parameters,
    returns: returns?.trim() || undefined,
  };
}

/**
 * Find the innermost unfinished `alias.member(` call before the cursor and
 * count its top-level arguments for VS Code signature help.
 */
export function activeLibraryCall(
  sourcePrefix: string,
  syntax: LibraryImportSyntax
): ActiveLibraryCall | undefined {
  const code = maskLineStringsAndComments(sourcePrefix, syntax);
  const call = /\b([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;
  let active: ActiveLibraryCall | undefined;
  let match: RegExpExecArray | null;
  while ((match = call.exec(code))) {
    const open = (match.index ?? 0) + match[0].length - 1;
    const parameter = activeCallParameter(code, open);
    if (parameter === undefined) continue;
    active = {
      alias: match[1],
      member: match[2],
      activeParameter: parameter,
    };
  }
  return active;
}

/** Find completed direct calls through imported aliases, excluding comments and strings. */
export function workspaceLibraryCalls(
  source: string,
  syntax: LibraryImportSyntax
): WorkspaceLibraryCall[] {
  const code = maskLineStringsAndComments(source, syntax);
  const pattern =
    /\b([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;
  const calls: WorkspaceLibraryCall[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(code))) {
    const open = (match.index ?? 0) + match[0].length - 1;
    const parsed = completedCallArguments(code, source, open, syntax);
    if (!parsed) continue;
    const memberStart = (match.index ?? 0) + match[1].length + 1;
    calls.push({
      alias: match[1],
      member: match[2],
      memberStart,
      memberEnd: memberStart + match[2].length,
      arguments: parsed,
    });
  }
  return calls;
}

/** Bind one direct library call to its exported signature and report safe static errors. */
export function validateWorkspaceLibraryCall(
  call: WorkspaceLibraryCall,
  exported: WorkspaceLibraryExport,
  syntax: LibraryImportSyntax
): LibraryCallIssue[] {
  if (exported.overloads && exported.overloads.length > 1) {
    const candidates = exported.overloads.map((signature) =>
      validateWorkspaceLibraryCall(
        call,
        { ...exported, signature, overloads: undefined },
        syntax
      )
    );
    if (candidates.some((issues) => issues.length === 0)) return [];
    return candidates.reduce((best, issues) =>
      issues.length < best.length ? issues : best
    );
  }
  if (call.arguments.some((argument) => argument.spread)) return [];
  const parameters = libraryParameterSpecs(
    exported.signature,
    exported.signatureSyntax ?? syntax
  );
  const issues: LibraryCallIssue[] = [];
  const assigned = new Set<string>();
  let positionalCursor = 0;
  let namedSeen = false;

  for (const argument of call.arguments) {
    if (argument.name) {
      namedSeen = true;
      const parameter = parameters.find(
        (candidate) => candidate.name === argument.name
      );
      const keywordVariadic = parameters.find(
        (candidate) => candidate.variadic === 'keyword'
      );
      if (!parameter && !keywordVariadic) {
        issues.push({
          start: argument.start,
          end: argument.end,
          code: 'pyne-lib-argument-name',
          message: `Unknown argument '${argument.name}' for '${call.member}'.`,
        });
        continue;
      }
      if (!parameter) continue;
      if (!parameter.keyword) {
        issues.push({
          start: argument.start,
          end: argument.end,
          code: 'pyne-lib-argument-name',
          message: `Argument '${argument.name}' of '${call.member}' cannot be passed by name.`,
        });
        assigned.add(parameter.name);
        continue;
      }
      if (assigned.has(parameter.name)) {
        issues.push({
          start: argument.start,
          end: argument.end,
          code: 'pyne-lib-argument-duplicate',
          message: `Argument '${argument.name}' is provided more than once to '${call.member}'.`,
        });
        continue;
      }
      assigned.add(parameter.name);
      continue;
    }

    if (namedSeen) {
      issues.push({
        start: argument.start,
        end: argument.end,
        code: 'pyne-lib-argument-order',
        message: `Positional arguments must precede named arguments in '${call.member}'.`,
      });
    }
    while (
      positionalCursor < parameters.length &&
      (!parameters[positionalCursor].positional ||
        assigned.has(parameters[positionalCursor].name))
    ) {
      positionalCursor += 1;
    }
    const parameter = parameters[positionalCursor];
    if (!parameter) {
      const variadic = parameters.find(
        (candidate) => candidate.variadic === 'positional'
      );
      if (!variadic) {
        issues.push({
          start: argument.start,
          end: argument.end,
          code: 'pyne-lib-argument-count',
          message: `Too many positional arguments for '${call.member}'.`,
        });
      }
      continue;
    }
    if (parameter.variadic === 'positional') continue;
    assigned.add(parameter.name);
    positionalCursor += 1;
  }

  const missing = parameters
    .filter(
      (parameter) =>
        parameter.required &&
        parameter.variadic === undefined &&
        !assigned.has(parameter.name)
    )
    .map((parameter) => parameter.name);
  if (missing.length > 0) {
    issues.push({
      start: call.memberStart,
      end: call.memberEnd,
      code: 'pyne-lib-argument-count',
      message:
        `'${call.member}' is missing required argument` +
        `${missing.length === 1 ? '' : 's'}: ${missing.join(', ')}.`,
    });
  }
  return issues;
}

function libraryParameterSpecs(
  signature: string,
  syntax: LibraryImportSyntax
): LibraryParameterSpec[] {
  const labels = librarySignatureParameters(signature);
  if (syntax === 'pine') {
    return labels.flatMap((label) => {
      const name = libraryParameterName(label, syntax);
      if (!name) return [];
      return [{
        name,
        required: !label.includes('='),
        positional: true,
        keyword: true,
      }];
    });
  }

  const parameters: LibraryParameterSpec[] = [];
  let keywordOnly = false;
  for (const label of labels) {
    if (label === '/') {
      for (const parameter of parameters) parameter.keyword = false;
      continue;
    }
    if (label === '*') {
      keywordOnly = true;
      continue;
    }
    const name = libraryParameterName(label, syntax);
    if (!name) continue;
    const keywordVariadic = label.trimStart().startsWith('**');
    const positionalVariadic =
      !keywordVariadic && label.trimStart().startsWith('*');
    parameters.push({
      name,
      required: !label.includes('=') && !keywordVariadic && !positionalVariadic,
      positional: !keywordOnly && !keywordVariadic,
      keyword: !positionalVariadic,
      variadic: keywordVariadic
        ? 'keyword'
        : positionalVariadic
          ? 'positional'
          : undefined,
    });
    if (positionalVariadic) keywordOnly = true;
  }
  return parameters;
}

function completedCallArguments(
  code: string,
  source: string,
  open: number,
  syntax: LibraryImportSyntax
): WorkspaceLibraryCallArgument[] | undefined {
  const brackets: string[] = [];
  const arguments_: WorkspaceLibraryCallArgument[] = [];
  let argumentStart = open + 1;
  for (let index = open; index < code.length; index += 1) {
    const char = code[index];
    if (char === '(' || char === '[' || char === '{') {
      brackets.push(char);
      continue;
    }
    if (char === ')' || char === ']' || char === '}') {
      brackets.pop();
      if (brackets.length === 0) {
        appendCallArgument(
          arguments_,
          code,
          source,
          argumentStart,
          index,
          syntax
        );
        return arguments_;
      }
      continue;
    }
    if (char === ',' && brackets.length === 1) {
      appendCallArgument(
        arguments_,
        code,
        source,
        argumentStart,
        index,
        syntax
      );
      argumentStart = index + 1;
    }
  }
  return undefined;
}

function appendCallArgument(
  target: WorkspaceLibraryCallArgument[],
  code: string,
  source: string,
  rawStart: number,
  rawEnd: number,
  syntax: LibraryImportSyntax
): void {
  let start = rawStart;
  let end = rawEnd;
  while (start < end && /\s/.test(code[start])) start += 1;
  while (end > start && /\s/.test(code[end - 1])) end -= 1;
  if (start === end) return;
  const masked = code.slice(start, end);
  const named = /^([A-Za-z_][A-Za-z0-9_]*)\s*=(?!=|>)/.exec(masked);
  target.push({
    start,
    end,
    name: named?.[1],
    spread:
      syntax === 'pyne' &&
      /^\*{1,2}(?!\*)/.test(source.slice(start, end).trimStart()),
  });
}

function staticPythonAll(source: string): Set<string> {
  const match = /^__all__[ \t]*=[ \t]*\[([\s\S]*?)\]/m.exec(source);
  if (!match) return new Set();
  const names = new Set<string>();
  for (const literal of match[1].matchAll(/(['"])([A-Za-z_][A-Za-z0-9_]*)\1/g)) {
    names.add(literal[2]);
  }
  return names;
}

function protocolCallSignature(
  source: string,
  protocol: string,
  exportName: string
): Pick<WorkspaceLibraryExport, 'kind' | 'signature'> | undefined {
  const classMatch = new RegExp(
    `^class[ \\t]+${escapeRegExp(protocol)}\\([^\\n]*\\):[ \\t]*$`,
    'm'
  ).exec(source);
  if (!classMatch) return undefined;
  const classStart = (classMatch.index ?? 0) + classMatch[0].length;
  const rest = source.slice(classStart);
  const nextTopLevel = /^\S/m.exec(rest);
  const classBody = nextTopLevel ? rest.slice(0, nextTopLevel.index) : rest;
  const call = /^[ \t]+def[ \t]+__call__[ \t]*(\()/m.exec(classBody);
  if (!call) return undefined;
  const open = classStart + (call.index ?? 0) + call[0].lastIndexOf('(');
  const close = matchingParen(source, open, true);
  if (close === undefined) return undefined;
  const rawArgs = source.slice(open + 1, close).replace(
    /^[ \t]*[A-Za-z_][A-Za-z0-9_]*[ \t]*(?:,[ \t]*)?/,
    ''
  );
  const suffix = pythonReturnAnnotation(source, close);
  return {
    kind: /@[ \t]*method\b/.test(classBody) ? 'method' : 'function',
    signature: normalizeSignature(`${exportName}(${rawArgs})${suffix}`),
  };
}

function pythonSignature(source: string, name: string, close: number, open: number): string {
  return normalizeSignature(
    `${name}${source.slice(open, close + 1)}${pythonReturnAnnotation(source, close)}`
  );
}

function pythonReturnAnnotation(source: string, close: number): string {
  const lineEnd = source.indexOf('\n', close + 1);
  const tail = source.slice(close + 1, lineEnd < 0 ? source.length : lineEnd);
  const match = /^[ \t]*(->[ \t]*[^:]+)?[ \t]*:/.exec(tail);
  return match?.[1] ? ` ${match[1].trim()}` : '';
}

function pythonFunctionDocstring(source: string, close: number): string | undefined {
  const lineEnd = source.indexOf('\n', close + 1);
  if (lineEnd < 0) return undefined;
  const body = source.slice(lineEnd + 1);
  const match =
    /^(?:[ \t]*(?:#.*)?\r?\n)*[ \t]+(?:"""([\s\S]*?)"""|'''([\s\S]*?)'''|"([^"\r\n]*)"|'([^'\r\n]*)')/.exec(
      body
    );
  const documentation = match?.slice(1).find((value) => value !== undefined)?.trim();
  return documentation || undefined;
}

function matchingParen(
  source: string,
  open: number,
  pythonComments: boolean
): number | undefined {
  let depth = 0;
  let quote: string | undefined;
  let escaped = false;
  let lineComment = false;
  for (let index = open; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (lineComment) {
      if (char === '\n') lineComment = false;
      continue;
    }
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === quote) {
        quote = undefined;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if ((char === '/' && next === '/') || (pythonComments && char === '#')) {
      lineComment = true;
      continue;
    }
    if (char === '(') depth += 1;
    if (char === ')' && --depth === 0) return index;
  }
  return undefined;
}

function precedingComment(
  source: string,
  declarationStart: number,
  marker: '//' | '#'
): string | undefined {
  const lines = source.slice(0, declarationStart).split(/\r?\n/);
  if (lines.at(-1)?.trim() === '') lines.pop();
  const comments: string[] = [];
  while (lines.length > 0) {
    const line = lines.pop() ?? '';
    const trimmed = line.trim();
    if (!trimmed.startsWith(marker)) break;
    comments.unshift(trimmed.slice(marker.length).trim());
  }
  const documentation = comments.join('\n').trim();
  return documentation || undefined;
}

function normalizeSignature(signature: string): string {
  return signature
    .replace(/\s+/g, ' ')
    .replace(/\(\s+/g, '(')
    .replace(/\s+\)/g, ')')
    .trim();
}

function deduplicateExports(exports: WorkspaceLibraryExport[]): WorkspaceLibraryExport[] {
  const unique = new Map<string, WorkspaceLibraryExport>();
  for (const entry of exports) {
    const existing = unique.get(entry.name);
    if (!existing) {
      unique.set(entry.name, entry);
      continue;
    }
    const overloads = existing.overloads ?? [existing.signature];
    if (!overloads.includes(entry.signature)) {
      existing.overloads = [...overloads, entry.signature];
    }
  }
  return [...unique.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function maskLineStringsAndComments(
  source: string,
  syntax: LibraryImportSyntax
): string {
  const chars = source.split('');
  let quote: string | undefined;
  let escaped = false;
  let lineComment = false;
  for (let index = 0; index < chars.length; index += 1) {
    const char = chars[index];
    const next = chars[index + 1];
    if (lineComment) {
      if (char === '\n') {
        lineComment = false;
      } else {
        chars[index] = ' ';
      }
      continue;
    }
    if (quote) {
      chars[index] = ' ';
      if (quote.length === 3) {
        if (source.startsWith(quote, index)) {
          chars[index + 1] = ' ';
          chars[index + 2] = ' ';
          index += 2;
          quote = undefined;
        }
        continue;
      }
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === quote) {
        quote = undefined;
      }
      continue;
    }
    const triple = source.slice(index, index + 3);
    if (syntax === 'pyne' && (triple === '"""' || triple === "'''")) {
      quote = triple;
      chars[index] = ' ';
      chars[index + 1] = ' ';
      chars[index + 2] = ' ';
      index += 2;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      chars[index] = ' ';
      continue;
    }
    if ((syntax === 'pine' && char === '/' && next === '/') || (syntax === 'pyne' && char === '#')) {
      lineComment = true;
      chars[index] = ' ';
    }
  }
  return chars.join('');
}

function activeCallParameter(source: string, open: number): number | undefined {
  const brackets: string[] = [];
  let activeParameter = 0;
  for (let index = open; index < source.length; index += 1) {
    const char = source[index];
    if (char === '(' || char === '[' || char === '{') {
      brackets.push(char);
      continue;
    }
    if (char === ')' || char === ']' || char === '}') {
      brackets.pop();
      if (brackets.length === 0) return undefined;
      continue;
    }
    if (char === ',' && brackets.length === 1) activeParameter += 1;
  }
  return brackets.length > 0 ? activeParameter : undefined;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
