import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(import.meta.url);
const bundled = await build({
  entryPoints: [path.join(root, 'src/pyneLanguage.ts')],
  bundle: true, platform: 'node', format: 'cjs', external: ['vscode'], write: false,
});

function fixture(initial = []) {
  const opened = new Set();
  const changed = new Set();
  const documents = [];
  const switches = [];
  const errors = [];
  let nextDocumentId = 0;
  let duringSwitch = () => {};
  const subscribe = (listeners, callback) => {
    listeners.add(callback);
    return { dispose: () => listeners.delete(callback) };
  };
  const document = (text, languageId = 'python', scheme = 'file') => {
    const uri = `${scheme}:///script${nextDocumentId++}.py`;
    return {
      text, languageId, isClosed: false,
      uri: { scheme, toString: () => uri },
      getText() { return this.text; },
    };
  };
  const vscode = {
    workspace: {
      textDocuments: documents,
      onDidOpenTextDocument: (callback) => subscribe(opened, callback),
      onDidChangeTextDocument: (callback) => subscribe(changed, callback),
    },
    languages: {
      async setTextDocumentLanguage(previous, languageId) {
        switches.push(languageId);
        previous.isClosed = true;
        const updated = { ...previous, isClosed: false, languageId };
        documents.splice(documents.indexOf(previous), 1, updated);
        for (const listener of opened) listener(updated);
        await duringSwitch(updated);
        return updated;
      },
    },
  };
  const module = { exports: {} };
  vm.runInNewContext(bundled.outputFiles[0].text, {
    module, exports: module.exports,
    require: (name) => name === 'vscode' ? vscode : require(name),
    console: { error: (...args) => errors.push(args) },
  });
  for (const text of initial) documents.push(document(text));
  const context = { subscriptions: [] };
  module.exports.registerPyneLanguage(context);
  return {
    documents, switches, errors,
    async flush() { await new Promise(setImmediate); assert.deepEqual(errors, []); },
    open(text, languageId, scheme) {
      const doc = document(text, languageId, scheme);
      documents.push(doc);
      for (const listener of opened) listener(doc);
      return doc;
    },
    edit(doc, text) {
      doc.text = text;
      for (const listener of changed) listener({ document: doc });
    },
    duringSwitch(callback) { duringSwitch = callback; },
    dispose() { for (const subscription of context.subscriptions) subscription.dispose(); },
  };
}

for (const marker of ['@pyne', '@pyne edge', '@pyne lib']) {
  test(`${marker}: already open files and newly opened files use Pyne mode`, async () => {
    const text = `"""\n${marker}\n"""\n`;
    const f = fixture([text, 'print("ordinary Python")']);
    await f.flush();
    f.open(text);
    await f.flush();
    assert.deepEqual(f.documents.map((doc) => doc.languageId), ['pyne', 'python', 'pyne']);
    assert.deepEqual(f.switches, ['pyne', 'pyne']);
  });
}

test('adding and removing the marker switches modes without saving the file', async () => {
  const f = fixture(['print("hello")']);
  f.edit(f.documents[0], '"""@pyne"""\ndef main():\n    pass\n');
  await f.flush();
  assert.equal(f.documents[0].languageId, 'pyne');
  f.edit(f.documents[0], 'print("ordinary Python again")');
  await f.flush();
  assert.equal(f.documents[0].languageId, 'python');
  assert.deepEqual(f.switches, ['pyne', 'python']);
});

test('marker edits during a pending language switch are reconciled', async () => {
  const f = fixture();
  f.duringSwitch((doc) => {
    if (doc.languageId === 'pyne') f.edit(doc, 'print("now Python")');
  });
  f.open('"""@pyne"""');
  await f.flush();
  assert.equal(f.documents[0].languageId, 'python');
  assert.deepEqual(f.switches, ['pyne', 'python']);
});

test('other languages, history documents and mentions inside Python code stay unchanged', async () => {
  const f = fixture();
  f.open('"""@pyne"""', 'plaintext');
  f.open('"""@pyne"""', 'python', 'git');
  f.open('message = "@pyne"');
  f.open('"""Documentation mentioning @pyne later."""');
  await f.flush();
  assert.deepEqual(f.switches, []);
});

test('untitled Pyne code is classified, and disposed listeners do not change new files', async () => {
  const f = fixture();
  f.open('"""@pyne"""', 'python', 'untitled');
  await f.flush();
  assert.equal(f.documents[0].languageId, 'pyne');
  f.dispose();
  f.open('"""@pyne"""');
  await f.flush();
  assert.deepEqual(f.switches, ['pyne']);
});

test('Pyne grammar retains Python token scopes and highlights the Pyne marker', async () => {
  const { Registry, parseRawGrammar } = require('vscode-textmate');
  const onig = require('vscode-oniguruma');
  await onig.loadWASM(fs.readFileSync(require.resolve('vscode-oniguruma/release/onig.wasm')).buffer);
  const grammars = {
    'source.python': 'test/grammar/vendor/MagicPython.tmLanguage.json',
    'source.python.pyne': 'syntaxes/pyne.tmLanguage.json',
    'pyne.injection': 'syntaxes/pyne.injection.json',
  };
  const registry = new Registry({
    onigLib: Promise.resolve({
      createOnigScanner: (patterns) => new onig.OnigScanner(patterns),
      createOnigString: (text) => new onig.OnigString(text),
    }),
    loadGrammar: async (scope) => grammars[scope]
      ? parseRawGrammar(fs.readFileSync(path.join(root, grammars[scope]), 'utf8'), grammars[scope])
      : null,
    getInjections: (scope) => scope === 'source.python.pyne' ? ['pyne.injection'] : [],
  });
  try {
    const grammar = await registry.loadGrammar('source.python.pyne');
    const head = grammar.tokenizeLine('"""@pyne edge"""');
    assert.ok(head.tokens.some((token) => token.scopes.includes('keyword.other.annotation.pyne')));
    const code = grammar.tokenizeLine('def main():', head.ruleStack);
    assert.ok(code.tokens.some((token) => token.scopes.includes('entity.name.function.python')));
  } finally {
    registry.dispose();
  }
});
