/**
 * Pyne Edge profile corpus test — the DEFINITION test of the Edge DSL (F8).
 *
 * The Edge profile is bounded by "what the pynecomp emitter can produce", so
 * every compiled corpus script, re-headed as `@pyne edge`, must pass the Edge
 * linter with zero `pyne-edge-*` findings. A finding here means either the
 * profile in python/pyneide_edge_rules.py is too tight or the emitter grew a
 * construct the profile must learn about — both are profile revisions.
 *
 * Only `.py` files with a `.pine` sibling participate: unpaired ones are
 * hand-written Pyne test scripts, not emitter output.
 *
 * The corpus lives in the pynecomp checkout (not in this repo), so this test
 * is local-only: without the corpus it reports SKIPPED and exits 0 (CI has no
 * monorepo checkout). Override the location with PYNECOMP_TESTS.
 *
 * Usage: node dist/edge-corpus-smoke.js
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Worker } from './checkerWorker';

const log = (msg: string): void => console.log(msg);

// Emitter output known to be stale relative to the current compiler (runtime
// corpus tests compare plot data, not text). Regenerate in pynecomp, then
// drop the entry.
const KNOWN_STALE = new Set([
  '24_hour_volume.py', // old match/case emission; switch is an if/elif chain now
]);

const CATEGORIES = ['indicators', 'strategies', 'libraries'];

function corpusRoot(): string | undefined {
  const override = process.env.PYNECOMP_TESTS;
  if (override) return override;
  // PyneIDE and the monorepo are siblings: ../PyneSys/pynecomp/tests
  const guess = path.resolve('..', 'PyneSys', 'pynecomp', 'tests');
  return fs.existsSync(guess) ? guess : undefined;
}

async function main(): Promise<void> {
  const root = corpusRoot();
  if (!root || !fs.existsSync(root)) {
    log('EDGE CORPUS SKIPPED (pynecomp corpus not found; set PYNECOMP_TESTS)');
    return;
  }

  const files: string[] = [];
  for (const category of CATEGORIES) {
    const dir = path.join(root, category, 'scripts');
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.py')) continue;
      const file = path.join(dir, name);
      if (fs.existsSync(file.replace(/\.py$/, '.pine'))) files.push(file);
    }
  }
  if (files.length === 0) throw new Error(`no compiled corpus scripts under ${root}`);

  const worker = new Worker(120000);
  let failures = 0;
  let skipped = 0;
  try {
    for (const file of files) {
      const name = path.basename(file);
      if (KNOWN_STALE.has(name)) {
        skipped++;
        continue;
      }
      const source = fs.readFileSync(file, 'utf8').replace(/@pyne\b/, '@pyne edge');
      const response = await worker.request(source);
      if (!response.ok) {
        failures++;
        console.error(`${name}: worker error ${response.error ?? ''}`);
        continue;
      }
      const edgeProblems = (response.problems ?? []).filter((p) => p[3].startsWith('pyne-edge'));
      if (edgeProblems.length > 0) {
        failures++;
        console.error(`${name}:`);
        for (const [line, , , code, message] of edgeProblems) {
          console.error(`  line ${line + 1}: ${code} ${message}`);
        }
      }
    }
  } finally {
    worker.close();
  }

  log(`${files.length - skipped} corpus scripts checked, ${skipped} known-stale skipped`);
  if (failures > 0) throw new Error(`EDGE CORPUS FAILED: ${failures} script(s) with findings`);
  log('EDGE CORPUS OK');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
