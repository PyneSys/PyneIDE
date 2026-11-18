/**
 * The workdir scripts a dashboard chart can run: indicators and strategies,
 * Pine or Pyne, outside `scripts/lib`. vscode-free.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { detectPyne } from '../pyneDetect';
import type { ScriptKind } from './model';

/** How much of a source the declaration check reads. */
const HEAD_CHARS = 20000;
const STRATEGY_RE = /^\s*(?:strategy\s*\(|@?\s*script\.strategy\s*\()/m;
const LIBRARY_RE = /^\s*(?:library\s*\(|@?\s*script\.library\s*\()/m;

export interface DashboardScriptFile {
  /** Relative to the workdir, with forward slashes (`scripts/ema.py`). */
  path: string;
  kind: ScriptKind;
}

/** Indicator or strategy, from the declaration in a script's source; undefined
 * for a library or a file that is no Pine / Pyne script. */
export function scriptKindOf(file: string): ScriptKind | undefined {
  let head: string;
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(HEAD_CHARS);
      head = buf.toString('utf8', 0, fs.readSync(fd, buf, 0, HEAD_CHARS, 0));
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return undefined;
  }
  if (/\.py$/i.test(file)) {
    const pyne = detectPyne(head);
    if (pyne === undefined || pyne === 'lib') return undefined;
  } else if (!/\.pine$/i.test(file)) {
    return undefined;
  }
  if (LIBRARY_RE.test(head)) return undefined;
  return STRATEGY_RE.test(head) ? 'strategy' : 'indicator';
}

function walk(dir: string, out: string[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name === '__pycache__') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile() && /\.(?:py|pine)$/i.test(entry.name)) out.push(full);
  }
}

/** The runnable scripts of a workdir; a `.py` compiled from a `.pine` beside it
 * is listed as the `.pine`. */
export function listDashboardScripts(workdir: string): DashboardScriptFile[] {
  const dir = path.join(workdir, 'scripts');
  const lib = path.join(dir, 'lib');
  const files: string[] = [];
  walk(dir, files);
  const present = new Set(files);
  const out: DashboardScriptFile[] = [];
  for (const file of files) {
    if (file === lib || file.startsWith(`${lib}${path.sep}`)) continue;
    if (/\.py$/i.test(file) && present.has(file.replace(/\.py$/i, '.pine'))) continue;
    const kind = scriptKindOf(file);
    if (!kind) continue;
    out.push({ path: path.relative(workdir, file).split(path.sep).join('/'), kind });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}
