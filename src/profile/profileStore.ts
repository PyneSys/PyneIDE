/**
 * Per-line run profiles (vscode-free).
 *
 * A profiled run (`pyne run --profile`, or the IDE's Profile button) writes
 * `<workdir>/output/<stem>_profile.json`: per source line the nanoseconds and
 * executions it took, the compound statements' totals, the run's time split
 * into categories, and the same lines measured in each `request.security`
 * child. Each file entry carries the sha256 of the source the run read: a
 * profile only annotates a file whose content is still that one.
 *
 * A Pine source is annotated through the compiled .py and its sourcemap: the
 * time of every Python line adds up on the Pine line it forward-fills to, while
 * the executions come from the line's first mapped statement (a statement spread
 * over several Python lines runs once, not once per line).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import type { PineSourcemap } from '../api/client';
import { pineLineFor, sha256 } from '../compile/sourcemap';

/** The file format version this reader understands. */
export const PROFILE_SCHEMA = 1;

/** Measured lines of one file: line number (as a string) -> [nanoseconds, executions]. */
type MeasuredLines = Record<string, [number, number]>;

export interface ProfileBlock {
  /** 'def' | 'loop' | 'if' | 'match' | 'with' | 'try' */
  kind: string;
  start: number;
  end: number;
  /** Time of the whole block. */
  ns: number;
  /** Time of the header line alone (for a `def`: the per-call setup). */
  header_ns: number;
  /** Executions of the header line. */
  hits: number;
}

export interface ProfileFileEntry {
  path: string;
  sha256: string;
  role: 'script' | 'library';
  lines: MeasuredLines;
  blocks: ProfileBlock[];
}

export interface ProfileContext {
  sec_ids: string[];
  timeframe: string;
  /** The context's data source (a file name or a provider symbol). */
  data: string;
  bars: number;
  script_ns: number;
  files: { path: string; lines: MeasuredLines; blocks: ProfileBlock[] }[];
}

export interface Profile {
  schema: number;
  pynecore: string | null;
  python: string;
  bars: number;
  wall_ns: number;
  /** Time spent in the script's own code: the base of every line percentage. */
  script_ns: number;
  categories: Record<string, number>;
  files: ProfileFileEntry[];
  contexts: ProfileContext[];
}

export interface LineStat {
  ns: number;
  hits: number;
}

export interface ContextLineStat extends LineStat {
  timeframe: string;
  data: string;
}

export interface SourceBlock {
  kind: string;
  start: number;
  end: number;
  ns: number;
  hits: number;
}

/** A profile as it lands on one source file, in that file's line numbers. */
export interface SourceProfile {
  lines: Map<number, LineStat>;
  /** Compound statements by header line (the costliest when several start there). */
  blocks: Map<number, SourceBlock>;
  /** The same line measured in the `request.security` children, one per context. */
  contexts: Map<number, ContextLineStat[]>;
  scriptNs: number;
  /** Lines are Pine lines: a Pine line can hold a function's setup and its body alike. */
  pine: boolean;
}

/** Display names of the time categories, in the order the summary lists them. */
export const CATEGORY_NAMES: Record<string, string> = {
  script: 'Script code',
  libraries: 'Libraries',
  engine: 'Strategy engine',
  output: 'Output',
  data: 'Data feed',
  security: 'request.security',
  runner: 'Runner',
};

/** Path of the profile a run of `scriptPath` writes in `workdir`. */
export function profilePathFor(workdir: string, scriptPath: string): string {
  return path.join(workdir, 'output', `${path.parse(scriptPath).name}_profile.json`);
}

/** Read a profile file; undefined when it is missing, malformed or of another schema. */
export function loadProfile(file: string): Profile | undefined {
  let profile: Profile;
  try {
    profile = JSON.parse(fs.readFileSync(file, 'utf8')) as Profile;
  } catch {
    return undefined;
  }
  if (
    profile?.schema !== PROFILE_SCHEMA ||
    !Array.isArray(profile.files) ||
    typeof profile.script_ns !== 'number'
  ) {
    return undefined;
  }
  profile.contexts ??= [];
  return profile;
}

/**
 * Whether `text` is the source a profile entry was measured on. The run read the
 * file with universal newlines, and an editor hands the text over without a BOM.
 */
export function matchesSource(text: string, hash: string): boolean {
  const normalized = text.replace(/\r\n?/g, '\n');
  return sha256(normalized) === hash || sha256(`﻿${normalized}`) === hash;
}

/**
 * The profile of one source file.
 *
 * @param pyPath Real path of the Python file the run executed (for a Pine source,
 *   its compiled .py).
 * @param pyText That file's current content.
 * @param map The Pine sourcemap of the .py: lines are then Pine lines.
 * @returns undefined when the run did not measure the file or it changed since.
 */
export function sourceProfile(
  profile: Profile,
  pyPath: string,
  pyText: string,
  map?: PineSourcemap
): SourceProfile | undefined {
  const entry = profile.files.find((file) => file.path === pyPath);
  if (!entry || !matchesSource(pyText, entry.sha256)) return undefined;
  const toSource = map
    ? (line: number): number | undefined => pineLineFor(map, line)
    : (line: number): number | undefined => line;

  const blocks = new Map<number, SourceBlock>();
  for (const block of entry.blocks) {
    const start = toSource(block.start);
    if (start === undefined) continue;
    const existing = blocks.get(start);
    if (existing && existing.ns >= block.ns) continue;
    blocks.set(start, {
      kind: block.kind,
      start,
      end: toSource(block.end) ?? start,
      ns: block.ns,
      hits: block.hits,
    });
  }

  const contexts = new Map<number, ContextLineStat[]>();
  for (const context of profile.contexts) {
    const file = context.files.find((candidate) => candidate.path === pyPath);
    if (!file) continue;
    for (const [line, stat] of sourceLines(file.lines, map)) {
      let list = contexts.get(line);
      if (!list) contexts.set(line, (list = []));
      list.push({ timeframe: context.timeframe, data: context.data, ...stat });
    }
  }

  return {
    lines: sourceLines(entry.lines, map),
    blocks,
    contexts,
    scriptNs: profile.script_ns,
    pine: map !== undefined,
  };
}

/** Measured Python lines in source line numbers (Pine lines when a map is given). */
function sourceLines(measured: MeasuredLines, map?: PineSourcemap): Map<number, LineStat> {
  const lines = new Map<number, LineStat>();
  if (!map) {
    for (const [line, [ns, hits]] of Object.entries(measured)) {
      lines.set(Number(line), { ns, hits });
    }
    return lines;
  }
  for (const [pyLine, [ns]] of Object.entries(measured)) {
    // The generated header (imports, the module docstring) has no Pine line
    const line = pineLineFor(map, Number(pyLine));
    if (line === undefined) continue;
    const stat = lines.get(line);
    if (stat) stat.ns += ns;
    else lines.set(line, { ns, hits: 0 });
  }
  const counted = new Set<number>();
  for (const [pyLine, line] of map.mappings) {
    const stat = lines.get(line);
    const measuredLine = measured[String(pyLine)];
    if (!stat || !measuredLine || counted.has(line)) continue;
    stat.hits = measuredLine[1];
    counted.add(line);
  }
  return lines;
}

/** A duration in the unit that keeps it readable, with three significant digits. */
export function formatDuration(ns: number): string {
  for (const [scale, unit] of [
    [1e9, 's'],
    [1e6, 'ms'],
    [1e3, 'µs'],
    [1, 'ns'],
  ] as const) {
    if (ns >= scale || unit === 'ns') {
      const value = ns / scale;
      const digits = value >= 100 || unit === 'ns' ? 0 : value >= 10 ? 1 : 2;
      return `${value.toFixed(digits)} ${unit}`;
    }
  }
  throw new Error('unreachable');
}

/** Share of `ns` in `total`, as the summary and the annotations print it. */
export function formatShare(ns: number, total: number): string {
  return `${total > 0 ? ((ns / total) * 100).toFixed(1) : '0.0'}%`;
}
