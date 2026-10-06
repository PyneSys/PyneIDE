import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const bundlePath = (root) => path.join(root, 'resources', 'pynecore');
const sha256 = (content) => createHash('sha256').update(content).digest('hex');

function pinnedVersion(root) {
  const constants = fs.readFileSync(path.join(root, 'src/env/constants.ts'), 'utf8');
  const version = /^export const PYNECORE_VERSION = '([^']+)';$/m.exec(constants)?.[1];
  if (!version) throw new Error('Cannot read PYNECORE_VERSION from src/env/constants.ts');
  return version;
}

function listFiles(directory, prefix = '') {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const relative = prefix + entry.name;
    if (entry.isDirectory()) return listFiles(path.join(directory, entry.name), relative + '/');
    if (!entry.isFile()) throw new Error(`Unexpected documentation entry: ${relative}`);
    return [relative];
  }).sort();
}

export function verifyPyneCoreDocs(root = projectRoot, directory = bundlePath(root)) {
  const version = pinnedVersion(root);
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
  if (manifest.pynecoreVersion !== version || manifest.sourceRef !== `v${version}`) {
    throw new Error(`Bundled PyneCore docs do not match pin ${version}; run npm run docs:sync`);
  }
  if (!/^[a-f0-9]{40}$/.test(manifest.sourceCommit)) {
    throw new Error('Bundled PyneCore docs have no valid source commit');
  }
  const expected = Object.keys(manifest.files).sort();
  const actual = listFiles(directory).filter((file) => file !== 'manifest.json');
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error('Bundled PyneCore documentation files differ from the manifest');
  }
  for (const required of ['docs/README.md', 'LICENSE', 'NOTICE']) {
    if (!expected.includes(required)) throw new Error(`Missing bundled PyneCore file: ${required}`);
  }
  for (const file of actual) {
    if (sha256(fs.readFileSync(path.join(directory, file))) !== manifest.files[file]) {
      throw new Error(`Bundled PyneCore documentation checksum mismatch: ${file}`);
    }
  }
  return { version, files: actual.length };
}

function git(source, args) {
  const result = spawnSync('git', ['-C', source, ...args], { maxBuffer: 16 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr.toString().trim());
  return result.stdout;
}

function syncDocs(source) {
  const version = pinnedVersion(projectRoot);
  const sourceRef = `v${version}`;
  const sourceCommit = git(source, ['rev-parse', '--verify', `${sourceRef}^{commit}`]).toString().trim();
  const metadata = git(source, ['show', `${sourceCommit}:pyproject.toml`]).toString();
  const sourceVersion = /^version\s*=\s*"([^"]+)"/m.exec(metadata)?.[1];
  if (sourceVersion !== version) {
    throw new Error(`${sourceRef} declares PyneCore ${sourceVersion}, expected ${version}`);
  }
  const files = git(source, ['ls-tree', '-r', '--name-only', '-z', sourceCommit, '--',
    'docs', 'LICENSE', 'NOTICE']).toString().split('\0').filter(Boolean).sort();
  const contents = files.map((file) => [file, git(source, ['show', `${sourceCommit}:${file}`])]);
  const destination = bundlePath(projectRoot);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const staging = fs.mkdtempSync(path.join(path.dirname(destination), '.pynecore-'));
  try {
    const hashes = {};
    for (const [file, content] of contents) {
      const target = path.join(staging, file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content);
      hashes[file] = sha256(content);
    }
    fs.writeFileSync(path.join(staging, 'manifest.json'), JSON.stringify({
      pynecoreVersion: version, sourceRef, sourceCommit, files: hashes,
    }, null, 2) + '\n');
    verifyPyneCoreDocs(projectRoot, staging);
    fs.rmSync(destination, { recursive: true, force: true });
    fs.renameSync(staging, destination);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args[0] === '--sync' && args.length <= 2) {
      syncDocs(path.resolve(args[1] ?? path.join(projectRoot, '../PyneSys/pynecore')));
    } else if (args.length) {
      throw new Error('Usage: node scripts/pynecore-docs.mjs [--sync [PyneCore checkout]]');
    }
    const result = verifyPyneCoreDocs();
    console.log(`PyneCore ${result.version} documentation verified (${result.files} files)`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
