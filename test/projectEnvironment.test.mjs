import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';
import vm from 'node:vm';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const helpers = await build({
  stdin: { contents: "export * from './src/env/bootstrap'; export * from './src/env/remove'; export * from './src/env/uv'; export * from './src/env/workdir';", resolveDir: process.cwd() },
  bundle: true, platform: 'node', format: 'cjs', write: false,
});
const helperModule = { exports: {} };
vm.runInNewContext(helpers.outputFiles[0].text, {
  module: helperModule, exports: helperModule.exports, require, process, Buffer, console, setTimeout, clearTimeout,
});
const actual = helperModule.exports;
const bundled = await build({
  stdin: { contents: "export * from './src/env/manager'; export * from './src/env/usage'; export * from './src/env/terminalEnv'; export * from './src/plugins/service';", resolveDir: process.cwd() },
  bundle: true, platform: 'node', format: 'cjs', external: ['vscode'], write: false,
  plugins: [{ name: 'environment-fixture', setup(build) {
    build.onLoad({ filter: /\/env\/bootstrap\.ts$/ }, () => ({ contents: `
      export const compareVersions = (...args) => fixture.actual.compareVersions(...args);
      export const readMarker = (...args) => fixture.actual.readMarker(...args);
      export const markerUpToDate = (...args) => fixture.actual.markerUpToDate(...args);
      export const validateCoreVersion = (...args) => fixture.actual.validateCoreVersion(...args);
      export const verifyPython = (...args) => fixture.verify(...args);
      export const bootstrapManagedEnv = (...args) => fixture.bootstrap(...args);
    ` }));
    build.onLoad({ filter: /\/env\/packages\.ts$/ }, () => ({ contents: `
      export const installPackages = async (op) => fixture.packages.push({action:'install', ...op});
      export const uninstallPackages = async (op) => fixture.packages.push({action:'uninstall', ...op});
    ` }));
  } }],
});

class Emitter {
  listeners = new Set();
  event = (listener) => { this.listeners.add(listener); return { dispose: () => this.listeners.delete(listener) }; };
  fire(value) { for (const listener of this.listeners) listener(value); }
  dispose() { this.listeners.clear(); }
}
const uri = (fsPath) => ({ fsPath, toString: () => `file://${fsPath}` });

function fixture(t, initialFolder = 0) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pyneide-project-env-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const folders = ['production', 'development'].map((name) => ({ uri: uri(path.join(root, name)), name }));
  for (const folder of folders) fs.mkdirSync(folder.uri.fsPath);
  const globalDir = path.join(root, 'shared');
  fs.mkdirSync(path.join(globalDir, 'venv'), { recursive: true });
  const legacy = path.join(globalDir, 'venv', 'sentinel');
  fs.writeFileSync(legacy, 'legacy environment');
  const editor = new Emitter();
  const changed = new Emitter();
  const configs = new Map(folders.map((folder) => [folder.uri.toString(), {}]));
  const versions = new Map();
  const installs = [];
  const notices = [];
  const packages = [];
  const runtime = {
    actual, installs, packages, latest: '6.11.2', fail: false,
    async verify(pythonBin) {
      return { ok: true, pythonVersion: '3.14.0', pynecoreVersion: versions.get(pythonBin), debugpyVersion: '1.8.21' };
    },
    async bootstrap(options) {
      installs.push(options);
      if (runtime.fail) throw new Error('offline');
      const version = options.pynecoreVersion || runtime.latest;
      const pythonBin = actual.venvPythonPath(actual.managedVenvDir(options.environmentDir));
      fs.mkdirSync(path.dirname(pythonBin), { recursive: true });
      fs.writeFileSync(pythonBin, 'fixture interpreter');
      fs.writeFileSync(path.join(actual.managedVenvDir(options.environmentDir), 'pyvenv.cfg'), 'home = shared Python\n');
      versions.set(pythonBin, version);
      fs.writeFileSync(actual.markerPath(options.environmentDir), JSON.stringify({
        ...actual.currentMarker(), pynecore: version, selection: options.pynecoreVersion, checkedAt: Date.now(),
      }));
      return { pythonBin, verify: await runtime.verify(pythonBin) };
    },
  };
  const vscode = {
    EventEmitter: Emitter, ProgressLocation: { Window: 10, Notification: 15 },
    commands: { executeCommand: async () => {} },
    workspace: {
      workspaceFolders: folders,
      getWorkspaceFolder(resource) { return folders.find((folder) => resource.fsPath === folder.uri.fsPath || resource.fsPath.startsWith(folder.uri.fsPath + path.sep)); },
      getConfiguration(_section, resource) { return { get: (key, fallback) => configs.get(resource?.toString())?.[key] ?? fallback }; },
      onDidChangeConfiguration: changed.event,
      onDidChangeWorkspaceFolders: new Emitter().event,
    },
    window: {
      activeTextEditor: { document: { uri: uri(path.join(folders[initialFolder].uri.fsPath, 'script.py')) } },
      onDidChangeActiveTextEditor: editor.event,
      withProgress: async (_options, run) => run({ report() {} }, { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) }),
      showInformationMessage: async (message) => { notices.push(message); return 'Setup Now'; },
      showWarningMessage: async (message) => notices.push(message),
      showErrorMessage: async (message) => notices.push(message),
    },
  };
  const module = { exports: {} };
  vm.runInNewContext(bundled.outputFiles[0].text, {
    module, exports: module.exports, require: (name) => name === 'vscode' ? vscode : require(name),
    fixture: runtime, process, Buffer, console, setTimeout, clearTimeout,
  });
  const manager = new module.exports.EnvManager(globalDir, { appendLine() {}, show() {} });
  t.after(() => manager.dispose());
  const [production, development] = folders.map((folder) => manager.forProject(folder.uri));
  return {
    ...runtime, runtime, manager, production, development, folders, configs, versions, notices,
    globalDir, legacy, trackInterpreter: module.exports.trackInterpreter,
    updateTerminalEnv: module.exports.updateTerminalEnv,
    PluginService: module.exports.PluginService,
    change(index) {
      changed.fire({ affectsConfiguration: (_key, resource) => resource?.toString() === folders[index].uri.toString() });
    },
    hideEditor() {
      vscode.window.activeTextEditor = undefined;
      editor.fire(undefined);
    },
    select(index) {
      vscode.window.activeTextEditor = { document: { uri: uri(path.join(folders[index].uri.fsPath, 'script.py')) } };
      editor.fire(vscode.window.activeTextEditor);
    },
    age(project) {
      const marker = actual.readMarker(project.environmentDir);
      fs.writeFileSync(actual.markerPath(project.environmentDir), JSON.stringify({ ...marker, checkedAt: 0 }));
    },
  };
}

test('project venvs have separate Core selections and leave the legacy venv untouched', async (t) => {
  const f = fixture(t);
  f.configs.get(f.folders[0].uri.toString())['pynecore.version'] = '6.11.1';
  await f.production.setup();
  await f.development.setup();
  assert.equal(f.production.state.verify.pynecoreVersion, '6.11.1');
  assert.equal(f.development.state.verify.pynecoreVersion, '6.11.2');
  assert.notEqual(f.production.state.pythonBin, f.development.state.pythonBin);
  assert.equal(f.installs[0].storageDir, f.installs[1].storageDir);
  assert.equal(fs.readFileSync(f.legacy, 'utf8'), 'legacy environment');
  assert.equal(fs.readFileSync(path.join(f.production.environmentDir, '.gitignore'), 'utf8'), '*\n');
});

test('resource lookup selects the script project and editor changes select the menu project', async (t) => {
  const f = fixture(t);
  assert.equal(f.manager.forResource(uri(path.join(f.folders[1].uri.fsPath, 'script.py'))), f.development);
  await f.production.setup();
  await f.development.setup();
  f.select(1);
  assert.equal(f.manager.forResource(), f.development);
  assert.equal(f.production.forProject(f.folders[1].uri), f.development);
});

test('a fixed Core never automatically upgrades; an empty selection follows latest', async (t) => {
  const f = fixture(t);
  f.configs.get(f.folders[0].uri.toString())['pynecore.version'] = '6.11.1';
  await f.production.setup();
  await f.development.setup();
  f.age(f.production); f.age(f.development);
  f.runtime.latest = '6.12.0';
  await f.production.autoUpdateCheck();
  await f.development.autoUpdateCheck();
  assert.equal(f.installs.length, 3);
  assert.equal(f.production.state.verify.pynecoreVersion, '6.11.1');
  assert.equal(f.development.state.verify.pynecoreVersion, '6.12.0');
  await f.development.autoUpdateCheck();
  assert.equal(f.installs.length, 3);
});

test('an offline update keeps the existing working environment and stays quiet', async (t) => {
  const f = fixture(t);
  await f.development.setup();
  f.age(f.development);
  f.runtime.fail = true;
  const notices = f.notices.length;
  await f.development.autoUpdateCheck();
  assert.equal(f.development.state.kind, 'ready');
  assert.equal(f.notices.length, notices);
  await f.development.autoUpdateCheck();
  assert.equal(f.installs.length, 2);
});

test('a running interpreter defers automatic and manual package changes', async (t) => {
  const f = fixture(t);
  await f.development.setup();
  f.age(f.development);
  const child = new EventEmitter();
  f.trackInterpreter(child, f.development.state.pythonBin);
  await f.development.autoUpdateCheck();
  await f.development.setup({ recreate: true });
  await assert.rejects(f.development.installPackages(['a-plugin'], 'Install'), /in use/);
  assert.equal(f.installs.length, 1);
  child.emit('close', 0);
  await f.development.autoUpdateCheck();
  assert.equal(f.installs.length, 2);
});

test('fixed selection changes can downgrade and clearing it re-enables automatic updates', async (t) => {
  const f = fixture(t);
  await f.production.setup();
  const config = f.configs.get(f.folders[0].uri.toString());
  config['pynecore.version'] = '6.11.1';
  assert.equal((await f.production.check()).cause, 'outdated');
  await f.production.setup();
  assert.equal(f.production.state.verify.pynecoreVersion, '6.11.1');
  config['pynecore.version'] = '';
  await f.production.setup();
  assert.equal(f.production.state.verify.pynecoreVersion, '6.11.2');
});

test('unsupported and malformed versions cannot reach the installer', async (t) => {
  const f = fixture(t);
  for (const version of ['6.11.0', '6.12.0rc1', '6.11.1 --index-url https://example.com']) {
    f.configs.get(f.folders[0].uri.toString())['pynecore.version'] = version;
    await f.production.setup();
    assert.equal(f.production.state.kind, 'error');
  }
  assert.equal(f.installs.length, 0);
});

test('plugin operations preserve the installed Core and captured project despite focus changes', async (t) => {
  const f = fixture(t);
  await f.production.setup();
  f.select(1);
  await f.production.installPackages(['a-plugin==1.0.0'], 'Install');
  assert.equal(f.packages[0].pythonBin, f.production.state.pythonBin);
  assert.equal(f.packages[0].pynecoreVersion, '6.11.2');
});

test('external interpreters are checked against the project selection without installing', async (t) => {
  const f = fixture(t);
  const config = f.configs.get(f.folders[0].uri.toString());
  config.venvPath = path.relative(f.folders[0].uri.fsPath, path.join(f.globalDir, 'venv'));
  const python = actual.venvPythonPath(path.join(f.globalDir, 'venv'));
  fs.mkdirSync(path.dirname(python), { recursive: true });
  fs.writeFileSync(python, 'external interpreter');
  f.versions.set(python, '6.11.2');
  config['pynecore.version'] = '6.11.1';
  await f.production.setup();
  assert.equal(f.production.state.kind, 'error');
  assert.equal(f.installs.length, 0);
  config['pynecore.version'] = '';
  assert.equal((await f.production.check()).kind, 'ready');
});

test('manual changes cannot silently violate a fixed selection', async (t) => {
  const f = fixture(t);
  f.configs.get(f.folders[0].uri.toString())['pynecore.version'] = '6.11.1';
  await f.production.setup();
  f.versions.set(f.production.state.pythonBin, '6.12.0');
  const state = await f.production.check();
  assert.equal(state.kind, 'needs-setup');
  assert.match(state.reason, /selects PyneCore 6.11.1/);
});

test('removing one project environment retains shared Python, legacy venv and the other project', async (t) => {
  const f = fixture(t);
  await f.production.setup(); await f.development.setup();
  fs.mkdirSync(path.join(f.globalDir, 'python'));
  const components = await actual.removableComponents(f.globalDir, {
    projectDir: f.production.environmentDir,
    pineLsRoot: path.join(f.globalDir, 'absent-ls'),
    cliWorkdir: path.join(f.production.environmentDir, 'cli-workdir'),
  });
  assert.equal(components.length, 1);
  await actual.removePaths(components[0].paths, () => {});
  assert.ok(fs.existsSync(path.join(f.globalDir, 'python')));
  assert.ok(fs.existsSync(f.legacy));
  assert.ok(fs.existsSync(f.development.state.pythonBin));
});

test('terminal activation is scoped to each project and stale global activation is cleared', async (t) => {
  const f = fixture(t);
  for (const folder of f.folders) {
    f.configs.get(folder.uri.toString()).workdir = '.';
    actual.ensurePyrightConfig(folder.uri.fsPath);
  }
  await f.production.setup(); await f.development.setup();
  const scopes = new Map();
  const collection = () => ({
    values: new Map(),
    clear() { this.values.clear(); },
    replace(name, value) { this.values.set(name, value); },
    prepend(name, value) { this.values.set(name, value); },
  });
  const global = collection();
  global.values.set('PATH', '/legacy/bin');
  global.getScoped = ({ workspaceFolder }) => {
    const key = workspaceFolder.uri.toString();
    if (!scopes.has(key)) scopes.set(key, collection());
    return scopes.get(key);
  };
  f.updateTerminalEnv({ environmentVariableCollection: global }, f.manager);
  assert.equal(global.values.size, 0);
  for (const folder of f.folders) {
    const values = scopes.get(folder.uri.toString()).values;
    assert.equal(values.get('VIRTUAL_ENV'), path.join(folder.uri.fsPath, '.pyneide', 'venv'));
    assert.equal(values.get('PYNE_WORK_DIR'), folder.uri.fsPath);
  }
  fs.rmSync(actual.managedVenvDir(f.production.environmentDir), { recursive: true });
  await f.production.check();
  f.updateTerminalEnv({ environmentVariableCollection: global }, f.manager);
  assert.equal(scopes.get(f.folders[0].uri.toString()).values.has('PATH'), false);
  assert.equal(scopes.get(f.folders[1].uri.toString()).values.has('PATH'), true);
});

test('plugin bookkeeping migrates legacy records once and stays separate between projects', async (t) => {
  const f = fixture(t);
  for (const folder of f.folders) {
    f.configs.get(folder.uri.toString()).workdir = '.';
    actual.ensurePyrightConfig(folder.uri.fsPath);
  }
  const records = new Map([['pyneide.plugins.managed', [{ package: 'legacy-plugin', version: '1.2.3' }]]]);
  const context = { globalState: {
    get: (key) => records.get(key),
    update: async (key, value) => records.set(key, value),
  } };
  const plugins = new f.PluginService(context, f.manager, {}, { appendLine() {} });
  t.after(() => plugins.dispose());
  const production = plugins.forResource(f.folders[0].uri);
  const development = plugins.forResource(f.folders[1].uri);
  assert.equal(production.managedPlugins()[0].package, 'legacy-plugin');
  assert.equal(development.managedPlugins()[0].package, 'legacy-plugin');
  const key = 'pyneide.plugins.managed:' + f.folders[0].uri.toString();
  records.set(key, []);
  assert.equal(production.managedPlugins().length, 0);
  assert.equal(development.managedPlugins().length, 1);
  assert.equal(records.get('pyneide.plugins.managed').length, 1);
});

test('scripts outside all project folders do not borrow another project environment', async (t) => {
  const f = fixture(t);
  const python = await f.manager.ensureReady('Run', uri(path.join(f.globalDir, 'outside.py')));
  assert.equal(python, undefined);
  assert.equal(f.installs.length, 0);
});

test('an older asynchronous check cannot overwrite a new project selection', async (t) => {
  const f = fixture(t);
  f.configs.get(f.folders[0].uri.toString())['pynecore.version'] = '6.11.1';
  await f.production.setup();
  const original = f.runtime.verify;
  let release;
  f.runtime.verify = async (python) => {
    const result = await original(python);
    await new Promise((resolve) => { release = resolve; });
    return result;
  };
  const olderCheck = f.production.check();
  await new Promise((resolve) => setImmediate(resolve));
  f.configs.get(f.folders[0].uri.toString())['pynecore.version'] = '6.12.0';
  assert.equal((await f.production.check()).cause, 'outdated');
  release();
  await olderCheck;
  assert.equal(f.production.state.cause, 'outdated');
});

test('changing a project version setting applies it only to its existing environment', async (t) => {
  const f = fixture(t);
  await f.production.setup(); await f.development.setup();
  f.select(1);
  f.configs.get(f.folders[0].uri.toString())['pynecore.version'] = '6.11.1';
  f.change(0);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.production.state.verify.pynecoreVersion, '6.11.1');
  assert.equal(f.development.state.verify.pynecoreVersion, '6.11.2');
  assert.equal(f.installs.length, 3);
});

test('opening a panel retains the project selected when the extension activated', (t) => {
  const f = fixture(t, 1);
  assert.equal(f.manager.forResource(), f.development);
  f.hideEditor();
  assert.equal(f.manager.forResource(), f.development);
});
