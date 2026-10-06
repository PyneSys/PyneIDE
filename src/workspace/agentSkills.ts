import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { PYNECORE_VERSION, type Logger } from '../env/constants';

const SKILL_NAMES = ['pine-development', 'pyne-development', 'pyneide-workflow'] as const;
const SKILL_ROOTS = ['.agents/skills', '.claude/skills', '.cursor/skills'] as const;
const MANIFEST_PATH = '.agents/pyneide-skills.json';
const GENERATOR = 'pyneide-agent-skills';

interface GeneratedManifest {
  generator: typeof GENERATOR;
  format: 1;
  files: Record<string, string>;
  sections?: Record<string, string>;
}

interface DocsManifest {
  pynecoreVersion: string;
  sourceCommit: string;
  files: Record<string, string>;
}

export interface AgentSkillsOptions {
  projectRoot: string;
  workdir: string;
  extensionPath: string;
  extensionVersion: string;
  pythonBin: string;
  pyneBin: string;
  runtimeVersion?: string;
  log: Logger;
}

export interface AgentSkillsResult {
  created: number;
  updated: number;
  preserved: number;
}

function hash(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

export const AGENT_RULES_FILE = 'AGENT_RULES.md';

/** The preferences file belongs to the user from its first creation. */
export function ensureAgentRulesFile(projectRoot: string, extensionPath: string): boolean {
  const target = path.join(projectRoot, AGENT_RULES_FILE);
  try {
    fs.lstatSync(target);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const source = path.join(extensionPath, 'resources/agent-project/preferences.md');
  fs.writeFileSync(target, fs.readFileSync(source, 'utf8'), { flag: 'wx' });
  return true;
}

function writeProjectGuide(
  root: string,
  file: string,
  content: string,
  previous: GeneratedManifest,
  sections: Record<string, string>,
  result: AgentSkillsResult,
  log: Logger
): void {
  const target = path.join(root, file);
  const start = '<!-- pyneide-project:start -->';
  const end = '<!-- pyneide-project:end -->';
  const block = `${start}\n${content.trimEnd()}\n${end}`;
  let existing: string | undefined;
  try {
    if (!fs.lstatSync(target).isFile()) {
      result.preserved++;
      log(`Agent guide: preserved ${file} (not a regular file)`);
      return;
    }
    existing = fs.readFileSync(target, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  let next: string;
  const startIndex = existing?.indexOf(start) ?? -1;
  const endIndex = existing?.indexOf(end) ?? -1;
  if (existing !== undefined && (startIndex >= 0 || endIndex >= 0)) {
    if (startIndex < 0 || endIndex < startIndex ||
        existing.indexOf(start, startIndex + start.length) >= 0 ||
        existing.indexOf(end, endIndex + end.length) >= 0) {
      result.preserved++;
      log(`Agent guide: preserved ${file} (ambiguous project section)`);
      return;
    }
    const oldBlock = existing.slice(startIndex, endIndex + end.length);
    if (oldBlock !== block && hash(oldBlock) !== previous.sections?.[file]) {
      result.preserved++;
      log(`Agent guide: preserved edited project section in ${file}`);
      return;
    }
    next = existing.slice(0, startIndex) + block + existing.slice(endIndex + end.length);
  } else {
    const separator = !existing || existing.endsWith('\n\n') ? '' : existing.endsWith('\n') ? '\n' : '\n\n';
    next = (existing ?? '') + separator + block + '\n';
  }
  if (next !== existing) {
    fs.writeFileSync(target, next, { flag: existing === undefined ? 'wx' : 'w' });
    if (existing === undefined) result.created++;
    else result.updated++;
  }
  sections[file] = hash(block);
}

function readManifest(projectRoot: string): GeneratedManifest {
  const file = path.join(projectRoot, MANIFEST_PATH);
  try {
    if (!fs.lstatSync(file).isFile()) throw new Error('Agent skill manifest is not a regular file');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return { generator: GENERATOR, format: 1, files: {} };
  }
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8')) as GeneratedManifest;
  if (manifest.generator !== GENERATOR || manifest.format !== 1 ||
      !manifest.files || typeof manifest.files !== 'object' || Array.isArray(manifest.files)) {
    throw new Error('Unrecognized .agents/pyneide-skills.json; existing agent files were preserved');
  }
  return manifest;
}

function ensureLocalDirectory(projectRoot: string, relative: string): void {
  let directory = projectRoot;
  for (const part of relative.split('/')) {
    directory = path.join(directory, part);
    try {
      if (!fs.lstatSync(directory).isDirectory()) {
        throw new Error(`Agent skill directory is not a local directory: ${directory}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      fs.mkdirSync(directory);
    }
  }
}

function documentationIndex(docsRoot: string, manifest: DocsManifest): string {
  const entries = Object.keys(manifest.files).filter((file) => file.startsWith('docs/') &&
    file.endsWith('.md')).sort().map((file) => {
    const relative = file.slice('docs/'.length);
    const content = fs.readFileSync(path.join(docsRoot, relative), 'utf8');
    const title = /^# (.+)$/m.exec(content)?.[1] ?? relative;
    return [title.replaceAll('|', '\\|'), `\`${relative}\``];
  });
  const widths = [0, 1].map((column) => Math.max(
    ['Topic', 'Local document'][column].length, ...entries.map((entry) => entry[column].length)
  ));
  const row = (cells: string[]): string =>
    `| ${cells.map((cell, column) => cell.padEnd(widths[column])).join(' | ')} |`;
  return [
    '# Bundled PyneCore documentation contents', '',
    `Snapshot: PyneCore ${manifest.pynecoreVersion}, source commit ${manifest.sourceCommit}.`,
    'All paths are relative to `pynecoreDocs` in `project.json`. Read them from the local filesystem.',
    '', row(['Topic', 'Local document']), row(widths.map((width) => '-'.repeat(width))),
    ...entries.map(row), '',
  ].join('\n');
}

/** Write project-local skills only during explicit project initialization. */
export function ensureProjectAgentSkills(options: AgentSkillsOptions): AgentSkillsResult {
  const root = path.resolve(options.projectRoot);
  // Check parents before reading or writing: agent directories can link to global skills.
  for (const skillRoot of SKILL_ROOTS) ensureLocalDirectory(root, skillRoot);
  const previous = readManifest(root);
  const docsBundle = path.join(options.extensionPath, 'resources', 'pynecore');
  const docs = JSON.parse(fs.readFileSync(path.join(docsBundle, 'manifest.json'), 'utf8')) as DocsManifest;
  if (docs.pynecoreVersion !== PYNECORE_VERSION) {
    throw new Error('Bundled PyneCore documentation does not match the extension pin');
  }
  const docsRoot = path.join(docsBundle, 'docs');
  const readme = fs.readdirSync(options.extensionPath).find((file) =>
    file.toLowerCase() === 'readme.md');
  if (!readme) throw new Error('Bundled PyneIDE README is missing');
  const project = JSON.stringify({
    projectRoot: root,
    workdir: path.resolve(options.workdir),
    pythonBin: options.pythonBin,
    pyneBin: options.pyneBin,
    runtimeVersion: options.runtimeVersion ?? null,
    extensionPath: options.extensionPath,
    extensionVersion: options.extensionVersion,
    extensionReadme: path.join(options.extensionPath, readme),
    pynecoreDocs: docsRoot,
    documentationVersion: docs.pynecoreVersion,
    documentationSourceCommit: docs.sourceCommit,
    userRules: path.join(root, AGENT_RULES_FILE),
  }, null, 2) + '\n';

  const templates = new Map<string, string>();
  for (const name of SKILL_NAMES) {
    const directory = path.join(options.extensionPath, 'resources', 'agent-skills', name);
    templates.set(`${name}/SKILL.md`, fs.readFileSync(path.join(directory, 'SKILL.md'), 'utf8'));
    templates.set(`${name}/references/project.json`, project);
    if (name === 'pine-development') {
      templates.set(`${name}/references/documentation.md`, fs.readFileSync(
        path.join(directory, 'references', 'documentation.md'), 'utf8'
      ));
    } else if (name === 'pyne-development') {
      templates.set(`${name}/references/documentation.md`, documentationIndex(docsRoot, docs));
    }
  }

  const files = { ...previous.files };
  const sections = { ...previous.sections };
  const result: AgentSkillsResult = {
    created: ensureAgentRulesFile(root, options.extensionPath) ? 1 : 0, updated: 0, preserved: 0,
  };
  for (const [file, template] of [['AGENTS.md', 'project.md'], ['CLAUDE.md', 'claude.md']]) {
    const content = fs.readFileSync(path.join(options.extensionPath, 'resources/agent-project', template), 'utf8');
    writeProjectGuide(root, file, content, previous, sections, result, options.log);
  }
  for (const skillRoot of SKILL_ROOTS) {
    for (const [relative, content] of templates) {
      const relativePath = `${skillRoot}/${relative}`;
      const target = path.join(root, relativePath);
      ensureLocalDirectory(root, path.posix.dirname(relativePath));
      let existing: string | undefined;
      try {
        if (!fs.lstatSync(target).isFile()) {
          result.preserved++;
          options.log(`Agent skills: preserved ${relativePath} (not a regular file)`);
          continue;
        }
        existing = fs.readFileSync(target, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      if (existing !== undefined && hash(existing) !== previous.files[relativePath]) {
        result.preserved++;
        options.log(`Agent skills: preserved user-authored ${relativePath}`);
        continue;
      }
      if (existing !== content) {
        fs.writeFileSync(target, content, { flag: existing === undefined ? 'wx' : 'w' });
        if (existing === undefined) result.created++;
        else result.updated++;
      }
      files[relativePath] = hash(content);
    }
  }
  const manifest: GeneratedManifest = { generator: GENERATOR, format: 1, files, sections };
  fs.writeFileSync(path.join(root, MANIFEST_PATH), JSON.stringify(manifest, null, 2) + '\n');
  options.log(`Agent skills: ${result.created} created, ${result.updated} updated, ` +
    `${result.preserved} user files preserved`);
  return result;
}
