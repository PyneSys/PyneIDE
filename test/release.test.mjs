import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { releaseMetadata } from '../scripts/release.mjs';

function fixture(t, { version = '0.9.0', preview = true, lockVersion = version,
  rootVersion = version, changelog = `## [Unreleased]\n\n- Future change.\n\n## [${version}] - 2026-10-15\n\n### Added\n\n- Preview features.\n\n## [0.1.0] - 2026-07-24\n\n- Old features.\n` } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pyneide-release-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version, preview }));
  fs.writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify({ version: lockVersion, packages: { '': { version: rootVersion } } }));
  fs.writeFileSync(path.join(root, 'CHANGELOG.md'), changelog);
  return root;
}

test('preview releases use only their own notes and versioned installation instructions', (t) => {
  const metadata = releaseMetadata(fixture(t), 'v0.9.0');
  assert.equal(metadata.prerelease, true);
  assert.match(metadata.notes, /Preview release/);
  assert.match(metadata.notes, /Preview features/);
  assert.match(metadata.notes, /pyneide-0\.9\.0\.vsix/);
  assert.doesNotMatch(metadata.notes, /Future change|Old features/);
});

test('stable releases omit the preview notice', (t) => {
  const metadata = releaseMetadata(fixture(t, { version: '1.0.0', preview: false }), 'v1.0.0');
  assert.equal(metadata.prerelease, false);
  assert.doesNotMatch(metadata.notes, /Preview release/);
});

test('a branch name or mismatched tag cannot produce a release', (t) => {
  const root = fixture(t);
  for (const tag of ['main', 'v1.0.0', '0.9.0', 'v0.9.0-beta.1']) {
    assert.throws(() => releaseMetadata(root, tag), /Release tag must be/);
  }
});

test('both lockfile versions must match', (t) => {
  for (const mismatch of [{ lockVersion: '0.1.0' }, { rootVersion: '0.1.0' }]) {
    assert.throws(() => releaseMetadata(fixture(t, mismatch), 'v0.9.0'), /package-lock/);
  }
});

test('missing, duplicate, undated or empty notes stop the release', (t) => {
  for (const changelog of [
    '## [Unreleased]\n\n- Future change.\n',
    '## [0.9.0]\n\n- Missing date.\n',
    '## [0.9.0] - 2026-10-15\n\n### Added\n',
    '## [0.9.0] - 2026-10-15\n- One.\n## [0.9.0] - 2026-10-16\n- Two.\n',
  ]) {
    assert.throws(() => releaseMetadata(fixture(t, { changelog }), 'v0.9.0'), /CHANGELOG|Release notes/);
  }
});

test('unsupported extension versions and ambiguous preview flags stop the release', (t) => {
  assert.throws(() => releaseMetadata(fixture(t, { version: '1.0.0-beta.1' }), 'v1.0.0-beta.1'), /major.minor.patch/);
  assert.throws(() => releaseMetadata(fixture(t, { preview: 'false' }), 'v0.9.0'), /preview must be a boolean/);
});
