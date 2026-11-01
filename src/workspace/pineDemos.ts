import * as fs from 'node:fs';
import * as path from 'node:path';

import type { PineSourcemap } from '../api/client';
import type { CompileService } from '../compile/service';

/**
 * Pine demos shipped precompiled in resources/pine-demos (built by
 * `npm run demos:sync`): a new user can run and debug Pine right away, and
 * only editing a demo needs a compile, i.e. a PyneSys API key.
 */
const DEMOS = ['demo_sma_cross', 'demo_rsi_strategy'];

/** Copy the demos into `scriptsDir`, never touching a .pine or .py that already exists. */
export async function seedPineDemos(
  extensionPath: string,
  scriptsDir: string,
  compile: CompileService,
  log: (message: string) => void
): Promise<void> {
  const bundle = path.join(extensionPath, 'resources', 'pine-demos');
  for (const name of DEMOS) {
    const pinePath = path.join(scriptsDir, `${name}.pine`);
    if (fs.existsSync(pinePath) || fs.existsSync(path.join(scriptsDir, `${name}.py`))) continue;
    const code = fs.readFileSync(path.join(bundle, `${name}.py`), 'utf8');
    const sourcemap = JSON.parse(
      fs.readFileSync(path.join(bundle, `${name}.sourcemap.json`), 'utf8')
    ) as PineSourcemap;
    fs.copyFileSync(path.join(bundle, `${name}.pine`), pinePath);
    await compile.adoptPrecompiled(pinePath, code, sourcemap);
    log(`Added precompiled Pine demo: ${pinePath}`);
  }
}
