import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));

export function releaseMetadata(root, tag) {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  const version = manifest.version;
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
    throw new Error('The extension version must be major.minor.patch');
  }
  if (tag !== `v${version}`) {
    throw new Error(`Release tag must be v${version}, got ${tag}`);
  }
  if (lock.version !== version || lock.packages?.['']?.version !== version) {
    throw new Error('package-lock.json versions must match package.json');
  }
  if (manifest.preview !== undefined && typeof manifest.preview !== 'boolean') {
    throw new Error('package.json preview must be a boolean');
  }
  const changelog = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8').replaceAll('\r\n', '\n');
  const sections = changelog.split(/^## /m).slice(1);
  const entries = sections.filter((section) => section.split('\n')[0].startsWith(`[${version}] - `));
  if (entries.length !== 1) {
    throw new Error(`CHANGELOG.md must have exactly one dated [${version}] section`);
  }
  const [heading, ...lines] = entries[0].split('\n');
  if (!new RegExp(`^\\[${version.replaceAll('.', '\\.')}\\] - \\d{4}-\\d{2}-\\d{2}$`).test(heading)) {
    throw new Error('Release notes heading must use YYYY-MM-DD');
  }
  const notes = lines.join('\n').trim();
  if (!/^\s*- \S/m.test(notes)) throw new Error('Release notes must contain a change list');
  const prerelease = manifest.preview === true;
  const notice = prerelease ? '**Preview release.** This build is for testing.\n\n' : '';
  const install = `Download \`pyneide-${version}.vsix\` below, then run **Extensions: Install from VSIX…** in VS Code.\n\nVSIX installations do not update automatically. Install each new build manually.\n`;
  return { version, prerelease, notes: `${notice}${notes}\n\n### Installation\n\n${install}` };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const metadata = releaseMetadata(projectRoot, process.argv[2]);
    fs.mkdirSync(path.join(projectRoot, 'build'), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, 'build/release-notes.md'), metadata.notes);
    if (process.env.GITHUB_OUTPUT) {
      fs.appendFileSync(process.env.GITHUB_OUTPUT, `version=${metadata.version}\nprerelease=${metadata.prerelease}\n`);
    }
    console.log(`Release v${metadata.version}: ${metadata.prerelease ? 'preview' : 'stable'}; notes in build/release-notes.md`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
