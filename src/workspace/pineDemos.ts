import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Pine demos shipped precompiled in resources/pine-demos (built by
 * `npm run demos:sync`): a new user can run and debug Pine right away, and
 * only editing a demo needs a compile, i.e. a PyneSys API key. Their maps
 * already carry the compile stamp, so copying the files is all it takes.
 */
const DEMOS = ['demo_sma_cross', 'demo_rsi_strategy'];

/** Copy the demos into `scriptsDir`, never touching a .pine or .py that already exists. */
export function seedPineDemos(
  extensionPath: string,
  scriptsDir: string,
  log: (message: string) => void
): void {
  const bundle = path.join(extensionPath, 'resources', 'pine-demos');
  for (const name of DEMOS) {
    const pinePath = path.join(scriptsDir, `${name}.pine`);
    const pyPath = path.join(scriptsDir, `${name}.py`);
    if (fs.existsSync(pinePath) || fs.existsSync(pyPath)) continue;
    fs.copyFileSync(path.join(bundle, `${name}.pine`), pinePath);
    fs.copyFileSync(path.join(bundle, `${name}.py`), pyPath);
    fs.copyFileSync(path.join(bundle, `${name}.sourcemap.json`), `${pyPath}.map`);
    log(`Added precompiled Pine demo: ${pinePath}`);
  }
}
