import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { PYNECORE_VERSION } from '../../src/env/constants';
import { scaffoldWorkdirWithCli } from '../../src/env/workdir';
import { ensureProjectAgentSkills, type AgentSkillsOptions } from '../../src/workspace/agentSkills';

const extensionPath = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pyneide-agent-skills-'));
const roots = ['.agents/skills', '.claude/skills', '.cursor/skills'];
const names = ['pine-development', 'pyne-development', 'pyneide-workflow'];

function options(projectRoot: string, workdir = projectRoot): AgentSkillsOptions {
  fs.mkdirSync(projectRoot, { recursive: true });
  return {
    projectRoot, workdir, extensionPath, extensionVersion: '0.1.0',
    pythonBin: path.join(temp, 'external env', 'python'),
    pyneBin: path.join(temp, 'external env', 'pyne'),
    runtimeVersion: PYNECORE_VERSION, log: () => {},
  };
}

function readProject(root: string, skillRoot = roots[0], skill = names[0]) {
  return JSON.parse(fs.readFileSync(
    path.join(root, skillRoot, skill, 'references/project.json'), 'utf8'
  ));
}

async function main(): Promise<void> {
  try {
    for (const subfolder of [false, true]) {
      const root = path.join(temp, subfolder ? 'subfolder project' : 'root project');
      const workdir = subfolder ? path.join(root, 'workdir') : root;
      const opts = options(root, workdir);
      const generated = ensureProjectAgentSkills(opts);
      assert.equal(generated.created, 24);
      for (const skillRoot of roots) {
        for (const name of names) {
          const skill = path.join(root, skillRoot, name, 'SKILL.md');
          assert.equal(fs.readFileSync(skill, 'utf8'), fs.readFileSync(
            path.join(extensionPath, 'resources/agent-skills', name, 'SKILL.md'), 'utf8'
          ));
          const project = readProject(root, skillRoot, name);
          assert.equal(project.workdir, workdir);
          assert.equal(project.projectRoot, root);
          assert.equal(project.pythonBin, opts.pythonBin);
          assert.equal(project.documentationVersion, PYNECORE_VERSION);
          assert.ok(fs.existsSync(path.join(project.pynecoreDocs, 'reference/types.md')));
          assert.ok(fs.existsSync(project.extensionReadme));
        }
      }
      const index = fs.readFileSync(path.join(
        root, roots[0], 'pyne-development/references/documentation.md'
      ), 'utf8');
      const docs = readProject(root).pynecoreDocs;
      const paths = [...index.matchAll(/\| `([^`]+\.md)`\s*\|/g)].map((match) => match[1]);
      const docsManifest = JSON.parse(fs.readFileSync(
        path.join(extensionPath, 'resources/pynecore/manifest.json'), 'utf8'
      ));
      const expectedDocs = Object.keys(docsManifest.files).filter((file) =>
        file.startsWith('docs/') && file.endsWith('.md'));
      assert.equal(paths.length, expectedDocs.length);
      for (const file of paths) assert.ok(fs.existsSync(path.join(docs, file)), file);
      assert.deepEqual(ensureProjectAgentSkills(opts), { created: 0, updated: 0, preserved: 0 });

      const edited = path.join(root, roots[1], 'pine-development/SKILL.md');
      fs.appendFileSync(edited, '\nProject-specific Pine guidance.\n');
      const userText = fs.readFileSync(edited, 'utf8');
      const refreshed = ensureProjectAgentSkills({
        ...opts, extensionVersion: '0.2.0', runtimeVersion: '99.0.0',
      });
      assert.equal(refreshed.updated, 9);
      assert.equal(refreshed.preserved, 1);
      assert.equal(fs.readFileSync(edited, 'utf8'), userText);
      assert.equal(readProject(root).runtimeVersion, '99.0.0');
      assert.equal(readProject(root).documentationVersion, PYNECORE_VERSION);
    }

    const root = path.join(temp, 'user-authored project');
    const opts = options(root);
    const skill = path.join(root, roots[0], 'pyne-development/SKILL.md');
    fs.mkdirSync(path.dirname(skill), { recursive: true });
    fs.writeFileSync(skill, 'User-authored skill\n');
    assert.equal(ensureProjectAgentSkills(opts).preserved, 1);
    assert.equal(fs.readFileSync(skill, 'utf8'), 'User-authored skill\n');
    assert.equal(ensureProjectAgentSkills(opts).preserved, 1);

    const packaged = path.join(temp, 'packaged extension');
    fs.mkdirSync(packaged);
    fs.cpSync(path.join(extensionPath, 'resources'), path.join(packaged, 'resources'), { recursive: true });
    fs.copyFileSync(path.join(extensionPath, 'README.md'), path.join(packaged, 'readme.md'));
    const packagedProject = path.join(temp, 'packaged project');
    ensureProjectAgentSkills({ ...options(packagedProject), extensionPath: packaged });
    const packagedMetadata = readProject(packagedProject);
    assert.equal(path.basename(packagedMetadata.extensionReadme), 'readme.md');
    assert.ok(fs.existsSync(packagedMetadata.extensionReadme));
    assert.ok(packagedMetadata.pynecoreDocs.startsWith(packaged + path.sep));

    const unknown = path.join(temp, 'unknown manifest');
    const unknownOptions = options(unknown);
    fs.mkdirSync(path.join(unknown, '.agents'));
    fs.writeFileSync(path.join(unknown, '.agents/pyneide-skills.json'), '{}');
    assert.throws(() => ensureProjectAgentSkills(unknownOptions), /Unrecognized/);
    assert.equal(fs.readFileSync(path.join(unknown, '.agents/pyneide-skills.json'), 'utf8'), '{}');

    if (process.platform !== 'win32') {
      const linked = path.join(temp, 'linked project');
      const linkedOptions = options(linked);
      const outside = path.join(temp, 'global skills');
      fs.mkdirSync(outside);
      fs.symlinkSync(outside, path.join(linked, '.agents'), 'dir');
      assert.throws(() => ensureProjectAgentSkills(linkedOptions), /not a local directory/);
      assert.deepEqual(fs.readdirSync(outside), []);

      const dangling = path.join(temp, 'dangling manifest');
      const danglingOptions = options(dangling);
      fs.mkdirSync(path.join(dangling, '.agents'));
      const target = path.join(outside, 'manifest.json');
      fs.symlinkSync(target, path.join(dangling, '.agents/pyneide-skills.json'));
      assert.throws(() => ensureProjectAgentSkills(danglingOptions), /not a regular file/);
      assert.ok(!fs.existsSync(target));
    }

    const pyneBin = process.env.PYNEIDE_AGENT_SMOKE_PYNE;
    if (pyneBin) {
      for (const subfolder of [false, true]) {
        const root = path.join(temp, subfolder ? 'CLI subfolder' : 'CLI root');
        const opts = options(root, subfolder ? path.join(root, 'workdir') : root);
        const scaffold = await scaffoldWorkdirWithCli(pyneBin, opts.workdir, () => {});
        const pythonBin = path.join(path.dirname(pyneBin),
          process.platform === 'win32' ? 'python.exe' : 'python');
        ensureProjectAgentSkills({ ...opts, pyneBin, pythonBin });
        assert.ok(fs.existsSync(scaffold.demoScript));
        assert.equal(readProject(root).workdir, scaffold.workdir);
      }
      console.log('Real Pyne CLI scaffolding + skills passed for root and workdir/ layouts');
    }
    console.log('Agent skills: all three hosts, both layouts, offline index, reinitialization, ' +
      'metadata refresh and user-file preservation passed');
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
