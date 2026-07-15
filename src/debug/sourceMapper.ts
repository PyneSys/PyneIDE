/**
 * Bidirectional Pine <-> Python source mapping for the debug proxy (vscode-free).
 *
 * A debug session launched from a `.pine` presents itself entirely in Pine
 * terms: breakpoints the client sets in the `.pine` are forwarded to the
 * debuggee against the compiled sibling `.py` (pine -> py, snapping forward to
 * the next mapped line), and every location the debuggee reports (stack
 * frames, breakpoint verifications) is mapped back (py -> pine, forward-fill —
 * see `pineLineFor`). Any `.pine`/`.py` sibling pair with a valid `.py.map`
 * participates, so imported Pine libraries compiled next to their sources map
 * too, not just the main script.
 *
 * Resolution is cached for the mapper's lifetime (one debug session): the
 * compiled artifacts cannot change under a live debuggee.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { loadSourcemapFor, pineLineFor, type StoredSourcemap } from '../compile/sourcemap';

export interface MappedLocation {
  path: string;
  line: number;
}

interface PairMapping {
  pinePath: string;
  pyPath: string;
  map: StoredSourcemap;
  /** pine line -> FIRST generated py line of that pine statement. */
  pineToPy: Map<number, number>;
  /** All mapped pine lines, ascending — the forward-snap search space. */
  pineLines: number[];
}

/** Canonical cache key for a file path (macOS paths are case-insensitive). */
function pathKey(p: string): string {
  return path.resolve(p).toLowerCase();
}

function buildPair(pinePath: string, pyPath: string): PairMapping | undefined {
  if (!fs.existsSync(pinePath)) return undefined;
  const map = loadSourcemapFor(pyPath);
  if (!map || map.mappings.length === 0) return undefined;
  const pineToPy = new Map<number, number>();
  for (const [py, pine] of map.mappings) {
    if (!pineToPy.has(pine)) pineToPy.set(pine, py);
  }
  const pineLines = [...pineToPy.keys()].sort((a, b) => a - b);
  return { pinePath, pyPath, map, pineToPy, pineLines };
}

export class PineSourceMapper {
  /** pathKey(.py) / pathKey(.pine) -> pair, or null when resolution failed
   * (cached too: a file without a usable map stays without one all session). */
  private readonly pairs = new Map<string, PairMapping | null>();

  /** The pair for a compiled `.py` (frame direction), if it maps to Pine. */
  private forPy(pyPath: string): PairMapping | null {
    const key = pathKey(pyPath);
    let pair = this.pairs.get(key);
    if (pair === undefined) {
      pair =
        (pyPath.toLowerCase().endsWith('.py') &&
          buildPair(pyPath.slice(0, -3) + '.pine', pyPath)) ||
        null;
      this.pairs.set(key, pair);
      if (pair) this.pairs.set(pathKey(pair.pinePath), pair);
    }
    return pair;
  }

  /** The pair for a Pine source (breakpoint direction), if it compiled with a map. */
  private forPine(pinePath: string): PairMapping | null {
    const key = pathKey(pinePath);
    let pair = this.pairs.get(key);
    if (pair === undefined) {
      pair =
        (pinePath.toLowerCase().endsWith('.pine') &&
          buildPair(pinePath, pinePath.slice(0, -5) + '.py')) ||
        null;
      this.pairs.set(key, pair);
      if (pair) this.pairs.set(pathKey(pair.pyPath), pair);
    }
    return pair;
  }

  /** Whether locations in this Pine source can be translated to the debuggee. */
  hasPineMapping(pinePath: string): boolean {
    return this.forPine(pinePath) !== null;
  }

  /**
   * A `.pine` location as the debuggee must see it: the compiled `.py` and the
   * first generated line of the statement on (or, when the line itself emitted
   * nothing — a comment, a declaration-only line — the next statement after)
   * the given pine line. Undefined when the file has no usable map or the line
   * is past the last mapped statement.
   */
  pineToPy(pinePath: string, pineLine: number): MappedLocation | undefined {
    const pair = this.forPine(pinePath);
    if (!pair) return undefined;
    const exact = pair.pineToPy.get(pineLine);
    if (exact !== undefined) return { path: pair.pyPath, line: exact };
    // Forward snap: the first mapped pine line after the requested one (what a
    // debugger's own line snapping would do for a non-executable line).
    for (const line of pair.pineLines) {
      if (line > pineLine) return { path: pair.pyPath, line: pair.pineToPy.get(line)! };
    }
    return undefined;
  }

  /**
   * The mapped (= breakpointable) Pine lines of a source in `[from, to]`,
   * ascending. Feeds a synthetic `breakpointLocations` answer — the map knows
   * the valid Pine lines exactly, no debuggee round-trip needed.
   */
  mappedPineLines(pinePath: string, from: number, to: number): number[] {
    const pair = this.forPine(pinePath);
    if (!pair) return [];
    return pair.pineLines.filter((line) => line >= from && line <= to);
  }

  /**
   * A debuggee-reported `.py` location in Pine terms (forward-fill semantics).
   * Undefined when the file does not map back to a Pine source or the line
   * precedes the first mapped statement (the generated header).
   */
  pyToPine(pyPath: string, pyLine: number): MappedLocation | undefined {
    const pair = this.forPy(pyPath);
    if (!pair) return undefined;
    const line = pineLineFor(pair.map, pyLine);
    return line === undefined ? undefined : { path: pair.pinePath, line };
  }
}
