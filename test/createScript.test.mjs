import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(import.meta.url);
const bundled = await build({
  entryPoints: [path.join(root, 'src/workspace/createScript.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  external: ['vscode'],
  write: false,
});

function fixture(t, { language = 'pyne', kind = 'indicator' } = {}) {
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'pyneide-create-script-'));
  t.after(() => fs.rmSync(workdir, { recursive: true, force: true }));
  const scripts = path.join(workdir, 'scripts');
  fs.mkdirSync(scripts);
  const documents = [];
  const validations = [];
  const errors = [];
  let beforeCreate = () => {};
  const target = kind === 'library'
    ? path.join(scripts, 'lib', 'author', 'first_chart', 'v1')
    : path.join(scripts, 'first_chart');
  const retain = (extension, isDirty = false) => {
    const file = `${target}${extension}`;
    const document = {
      uri: { fsPath: file },
      isDirty,
      text: 'previous script content',
      getText() { return this.text; },
      positionAt(offset) { return offset; },
      async save() {
        fs.writeFileSync(file, this.text);
        this.isDirty = false;
        return true;
      },
    };
    documents.push(document);
    return document;
  };
  const vscode = {
    Uri: { file: (fsPath) => ({ fsPath }) },
    SnippetString: class { constructor(value) { this.value = value; } },
    Range: class { constructor(start, end) { this.start = start; this.end = end; } },
    workspace: {
      workspaceFolders: [{ uri: { fsPath: workdir } }],
      getConfiguration: () => ({ get: () => '.' }),
      textDocuments: documents,
      async openTextDocument(uri) {
        return documents.find((document) => document.uri.fsPath === uri.fsPath)
          ?? retain(path.extname(uri.fsPath));
      },
    },
    window: {
      showQuickPick: async (choices) => choices.find(
        (choice) => choice.language === language && choice.scriptKind === kind
      ),
      async showInputBox(options) {
        const value = options.title.includes('2/3') ? 'author'
          : options.title.includes('3/3') ? '1' : 'first_chart';
        const error = options.validateInput(value);
        validations.push(error);
        if (error) return undefined;
        if (kind !== 'library' || options.title.includes('3/3')) beforeCreate();
        return value;
      },
      async showTextDocument(document) {
        return {
          async insertSnippet(snippet, range) {
            const start = range?.start ?? document.text.length;
            const end = range?.end ?? start;
            document.text = document.text.slice(0, start) + snippet.value + document.text.slice(end);
            return true;
          },
        };
      },
      showErrorMessage: (message) => errors.push(message),
    },
  };
  const module = { exports: {} };
  vm.runInNewContext(bundled.outputFiles[0].text, {
    module, exports: module.exports,
    require: (name) => name === 'vscode' ? vscode : require(name),
    process, Buffer, console,
  });
  return {
    target, retain, validations, errors,
    beforeCreate(callback) { beforeCreate = callback; },
    create: () => module.exports.createNewScript({
      extensionPath: root,
      workspaceState: { get: () => '', update: async () => {} },
    }),
  };
}

for (const kind of ['indicator', 'strategy', 'library']) {
  for (const language of ['pine', 'pyne']) {
    test(`${language} ${kind}: deleted scripts do not reserve the name`, async (t) => {
      const f = fixture(t, { language, kind });
      f.retain('.pine');
      f.retain('.py');
      await f.create();
      assert.ok(f.validations.every((error) => error === undefined));
      assert.deepEqual(f.errors, []);
      const content = fs.readFileSync(`${f.target}${language === 'pine' ? '.pine' : '.py'}`, 'utf8');
      assert.ok(content.length > 0);
      assert.ok(!content.includes('previous script content'), 'new template replaces retained content');
    });
  }

  for (const extension of ['.pine', '.py']) {
    test(`${kind}: existing ${extension} files remain protected`, async (t) => {
      const f = fixture(t, { kind });
      fs.mkdirSync(path.dirname(f.target), { recursive: true });
      fs.writeFileSync(`${f.target}${extension}`, 'existing script');
      await f.create();
      assert.match(f.validations.at(-1), /already exists/);
      assert.equal(fs.readFileSync(`${f.target}${extension}`, 'utf8'), 'existing script');
    });

    test(`${kind}: unsaved ${extension} changes remain protected`, async (t) => {
      const f = fixture(t, { kind });
      const document = f.retain(extension, true);
      await f.create();
      assert.match(f.validations.at(-1), /already exists/);
      assert.equal(document.text, 'previous script content');
      assert.equal(fs.existsSync(`${f.target}.py`), false);
    });
  }
}

test('the final creation check protects changes made after name validation', async (t) => {
  const f = fixture(t);
  const document = f.retain('.py');
  f.beforeCreate(() => { document.isDirty = true; });
  await f.create();
  assert.deepEqual(f.validations, [undefined]);
  assert.match(f.errors[0], /already exists/);
  assert.equal(document.text, 'previous script content');
  assert.equal(fs.existsSync(`${f.target}.py`), false);
});
