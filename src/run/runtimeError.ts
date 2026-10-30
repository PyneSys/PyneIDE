import * as fs from 'node:fs';
import * as path from 'node:path';

import { loadSourcemapFor, pineLineFor } from '../compile/sourcemap';

export interface RuntimeErrorLocation {
  path: string;
  /** One-based source line. */
  line: number;
  /** The script deliberately stopped via runtime.error(). */
  scriptStop: boolean;
}

function realPath(file: string): string {
  try {
    return fs.realpathSync(file);
  } catch {
    return path.resolve(file);
  }
}

/** Find the innermost user frame, skipping engine/bridge/dependency frames.
 * A runtime API may raise after the script calls it (e.g. runtime.error), so
 * the last Python frame is not necessarily the line the user can change. */
export function runtimeErrorLocation(
  traceback: string,
  scriptPath: string,
  workdir: string
): RuntimeErrorLocation | undefined {
  const script = realPath(scriptPath);
  const roots = [path.dirname(script), realPath(path.join(workdir, 'scripts'))];
  let source: RuntimeErrorLocation | undefined;
  let scriptStop = false;
  for (const match of traceback.matchAll(/^[ \t]*File "(.+?)", line (\d+)(?:, in (.*?))?\r?$/gm)) {
    scriptStop = /(?:^|[/\\])pynecore[/\\]lib[/\\]runtime\.py$/.test(match[1]) && match[3] === 'error';
    if (match[1].startsWith('<')) continue;
    const file = realPath(path.resolve(workdir, match[1]));
    const userFrame = file === script || roots.some((root) => {
      const relative = path.relative(root, file);
      return !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`) &&
        !relative.split(path.sep).some((part) =>
          ['.pyneide', '.venv', 'venv', 'site-packages', 'dist-packages'].includes(part));
    });
    const line = Number(match[2]);
    if (userFrame && Number.isSafeInteger(line) && line > 0) source = { path: file, line, scriptStop: false };
  }
  if (!source) return undefined;
  source.scriptStop = scriptStop;

  // Invalid/stale maps deliberately fall back to the executed Python source.
  const pinePath = source.path.replace(/\.py$/i, '.pine');
  try {
    if (pinePath !== source.path && fs.existsSync(pinePath)) {
      const map = loadSourcemapFor(source.path);
      const line = map && pineLineFor(map, source.line);
      if (line !== undefined && Number.isSafeInteger(line) && line > 0) return { path: pinePath, line, scriptStop };
    }
  } catch {
    // A malformed mapping must not prevent showing the Python error.
  }
  return source;
}
