/**
 * Line-level Pine sourcemap handling (vscode-free).
 *
 * A compiled `<stem>.py` may carry a sibling `<stem>.py.map` JSON produced by
 * PyneComp: sparse `[python_line, pine_line]` pairs (1-indexed, sorted by
 * python line), one per statement's first emitted line. Python lines between
 * two pairs belong to the earlier one (forward fill).
 *
 * The IDE-written map additionally carries `py_sha256` (hash of the .py it was
 * generated with): the .py is free to edit, and a map that no longer matches
 * the file must not be trusted — a confidently wrong Pine line is worse than
 * no mapping. With `pine_sha256` and `strict` it is also the compile stamp:
 * proof that the .py is an unmodified compile of exactly that Pine source. The
 * stamp travels with the files, so moving, copying or cloning the project
 * keeps it, and deleting the files leaves nothing behind.
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';

import type { PineSourcemap } from '../api/client';

export interface StoredSourcemap extends PineSourcemap {
  /** sha256 of the .py content the map belongs to (IDE-written maps only). */
  py_sha256?: string;
  /** sha256 of the Pine source the .py was compiled from (IDE-written maps only). */
  pine_sha256?: string;
  /** Whether that compile was strict (IDE-written maps only). */
  strict?: boolean;
  /**
   * True when the source was a Pine v4/v5 script the compiler internally
   * upgraded to v6: the mappings then point at converted v6 lines, not the
   * on-disk source, so the map must not be used to map back to the .pine.
   */
  converted_source?: boolean;
}

export function sha256(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Path of the sourcemap sitting next to a compiled .py. */
export function sourcemapPathFor(pyPath: string): string {
  return `${pyPath}.map`;
}

function readStoredSourcemap(pyPath: string): StoredSourcemap | undefined {
  try {
    return JSON.parse(fs.readFileSync(sourcemapPathFor(pyPath), 'utf8')) as StoredSourcemap;
  } catch {
    return undefined;
  }
}

function pyMatchesStamp(pyPath: string, map: StoredSourcemap | undefined): boolean {
  if (!map?.py_sha256) return false;
  try {
    return sha256(fs.readFileSync(pyPath, 'utf8')) === map.py_sha256;
  } catch {
    return false;
  }
}

/** Whether the .py is exactly what the IDE last wrote there, i.e. not edited since. */
export function isGeneratedOutput(pyPath: string): boolean {
  return pyMatchesStamp(pyPath, readStoredSourcemap(pyPath));
}

/** Whether the .py is an unmodified compile of exactly this Pine source. */
export function isCompiledFrom(pyPath: string, pine: string, strict: boolean): boolean {
  const map = readStoredSourcemap(pyPath);
  return (
    map?.pine_sha256 === sha256(pine) &&
    (map.strict ?? false) === strict &&
    pyMatchesStamp(pyPath, map)
  );
}

/**
 * Load and validate the sourcemap for a compiled .py. Returns undefined when
 * there is no map, it is malformed, or it carries a `py_sha256` that no
 * longer matches the current .py content (stale after a manual edit).
 */
export function loadSourcemapFor(pyPath: string): StoredSourcemap | undefined {
  const map = readStoredSourcemap(pyPath);
  if (!map) return undefined;
  if (map.version !== 1 || !Array.isArray(map.mappings)) return undefined;
  // Mappings for a converted v4/v5 source point at internal v6 lines, not the
  // on-disk .pine — a confidently wrong Pine line is worse than no mapping.
  if (map.converted_source) return undefined;
  if (map.py_sha256) {
    try {
      if (sha256(fs.readFileSync(pyPath, 'utf8')) !== map.py_sha256) return undefined;
    } catch {
      return undefined;
    }
  }
  return map;
}

/**
 * Pine line for a generated Python line: the last mapping at or before it
 * (forward-fill semantics). Undefined before the first mapping — those lines
 * are the generated header (docstring, imports), which has no Pine source.
 */
export function pineLineFor(map: PineSourcemap, pyLine: number): number | undefined {
  let result: number | undefined;
  for (const [py, pine] of map.mappings) {
    if (py > pyLine) break;
    result = pine;
  }
  return result;
}

export interface MappedFrame {
  pyPath: string;
  pyLine: number;
  pinePath: string;
  pineLine: number;
}

const FRAME_RE = /File "(.+?)", line (\d+)/g;

/**
 * Map the frames of a Python traceback back to Pine sources. Only frames
 * whose file has a valid sibling sourcemap AND a sibling .pine file are
 * returned, in traceback order (the last one is the deepest mapped frame).
 */
export function mapTracebackFrames(traceback: string): MappedFrame[] {
  const frames: MappedFrame[] = [];
  const maps = new Map<string, StoredSourcemap | undefined>();
  for (const match of traceback.matchAll(FRAME_RE)) {
    const pyPath = match[1];
    if (!pyPath.endsWith('.py')) continue;
    const pinePath = pyPath.replace(/\.py$/, '.pine');
    if (!fs.existsSync(pinePath)) continue;
    if (!maps.has(pyPath)) maps.set(pyPath, loadSourcemapFor(pyPath));
    const map = maps.get(pyPath);
    if (!map) continue;
    const pyLine = parseInt(match[2], 10);
    const pineLine = pineLineFor(map, pyLine);
    if (pineLine === undefined) continue;
    frames.push({ pyPath, pyLine, pinePath, pineLine });
  }
  return frames;
}
