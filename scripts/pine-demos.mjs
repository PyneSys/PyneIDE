import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Pine demo scripts shipped precompiled, so a new user can run and debug Pine
 * without a PyneSys API key. The sources are PyneAPI's web demos; PyneComp is
 * not available in CI, so `--sync` compiles them locally with the monorepo's
 * PyneComp and every build only verifies the committed result.
 */
const DEMOS = [
  { name: 'demo_sma_cross', source: 'demo1.pine' },
  { name: 'demo_rsi_strategy', source: 'demo2.pine' },
];

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const bundlePath = (root) => path.join(root, 'resources', 'pine-demos');
const sha256 = (content) => createHash('sha256').update(content).digest('hex');

function demoFiles(name) {
  return [`${name}.pine`, `${name}.py`, `${name}.sourcemap.json`];
}

export function verifyPineDemos(root = projectRoot, directory = bundlePath(root)) {
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
  if (typeof manifest.pynecompVersion !== 'string' || !manifest.pynecompVersion) {
    throw new Error('Bundled Pine demos have no PyneComp version; run npm run demos:sync');
  }
  const expected = DEMOS.flatMap(({ name }) => demoFiles(name)).sort();
  const actual = fs.readdirSync(directory).filter((file) => file !== 'manifest.json').sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected) ||
      JSON.stringify(Object.keys(manifest.files).sort()) !== JSON.stringify(expected)) {
    throw new Error('Bundled Pine demo files differ from the demo list; run npm run demos:sync');
  }
  for (const file of actual) {
    if (sha256(fs.readFileSync(path.join(directory, file))) !== manifest.files[file]) {
      throw new Error(`Bundled Pine demo checksum mismatch: ${file}; run npm run demos:sync`);
    }
  }
  return { pynecompVersion: manifest.pynecompVersion, demos: DEMOS.length };
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, maxBuffer: 16 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${path.basename(command)} failed: ${result.stderr.toString().trim()}`);
  }
  return result.stdout.toString().trim();
}

function syncDemos(sourceDir, monorepo) {
  const bin = path.join(monorepo, 'venv', 'bin');
  const pynecompVersion = run(path.join(bin, 'python'),
    ['-c', 'from pynecomp._version import __version__; print(__version__)']);
  const destination = bundlePath(projectRoot);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const staging = fs.mkdtempSync(path.join(path.dirname(destination), '.pine-demos-'));
  // pynecomp looks for a workdir/ next to the current directory before compiling.
  const compileRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pyneide-demos-'));
  fs.mkdirSync(path.join(compileRoot, 'workdir'));
  try {
    const hashes = {};
    for (const { name, source } of DEMOS) {
      const pinePath = path.join(compileRoot, `${name}.pine`);
      const pyPath = path.join(compileRoot, `${name}.py`);
      fs.copyFileSync(path.join(sourceDir, source), pinePath);
      run(path.join(bin, 'pynecomp'), ['compile', pinePath, '-o', pyPath, '--sourcemap'], compileRoot);
      const pine = fs.readFileSync(pinePath);
      const py = fs.readFileSync(pyPath);
      // The compile stamp the IDE writes after its own compiles (see
      // src/compile/sourcemap.ts): it lets a seeded demo run without a key.
      const map = {
        ...JSON.parse(fs.readFileSync(`${pyPath}.map`, 'utf8')),
        py_sha256: sha256(py),
        pine_sha256: sha256(pine),
        strict: false,
      };
      const outputs = {
        [`${name}.pine`]: pine,
        [`${name}.py`]: py,
        [`${name}.sourcemap.json`]: Buffer.from(JSON.stringify(map)),
      };
      for (const [file, content] of Object.entries(outputs)) {
        fs.writeFileSync(path.join(staging, file), content);
        hashes[file] = sha256(content);
      }
    }
    fs.writeFileSync(path.join(staging, 'manifest.json'),
      JSON.stringify({ pynecompVersion, files: hashes }, null, 2) + '\n');
    verifyPineDemos(projectRoot, staging);
    fs.rmSync(destination, { recursive: true, force: true });
    fs.renameSync(staging, destination);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
    fs.rmSync(compileRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args[0] === '--sync' && args.length <= 2) {
      const monorepo = path.resolve(args[1] ?? path.join(projectRoot, '../PyneSys'));
      syncDemos(path.join(monorepo, 'pyneapi', 'api', 'demo_scripts'), monorepo);
    } else if (args.length) {
      throw new Error('Usage: node scripts/pine-demos.mjs [--sync [PyneSys monorepo checkout]]');
    }
    const result = verifyPineDemos();
    console.log(`Pine demos verified (${result.demos} demos, PyneComp ${result.pynecompVersion})`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
