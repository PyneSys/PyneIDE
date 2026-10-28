import type { ChildProcess } from 'node:child_process';
import * as path from 'node:path';

const active = new Map<string, number>();
const key = (executable: string): string => path.dirname(path.resolve(executable));

/** Python and its console scripts share the environment's bin/Scripts directory. */
export function interpreterInUse(executable: string): boolean {
  return (active.get(key(executable)) ?? 0) > 0;
}

export function trackInterpreter(child: ChildProcess, executable: string): void {
  const directory = key(executable);
  active.set(directory, (active.get(directory) ?? 0) + 1);
  child.once('close', () => {
    const remaining = (active.get(directory) ?? 1) - 1;
    if (remaining) active.set(directory, remaining);
    else active.delete(directory);
  });
}
