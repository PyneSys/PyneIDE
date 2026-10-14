/** A pending nonmodal sign-in prompt must not retain a compile/run request. */
import assert from 'node:assert/strict';
import esbuild from 'esbuild';

const result = await esbuild.build({
  stdin: { contents: `export { AuthService } from './src/api/auth';
    export { controls } from 'vscode';`, resolveDir: process.cwd(), loader: 'ts' },
  bundle: true, platform: 'node', format: 'cjs', write: false,
  plugins: [{ name: 'vscode-stub', setup(build) {
    build.onResolve({ filter: /^vscode$/ }, () => ({ path: 'vscode', namespace: 'stub' }));
    build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: `
      export const controls = { prompts: 0, resolve: undefined };
      export const workspace = {};
      export const commands = {};
      export const ProgressLocation = {};
      export class ThemeIcon {}
      export const Uri = { parse: value => value };
      export const env = { openExternal: async () => {} };
      export const window = {
        showInformationMessage: () => { controls.prompts++; return new Promise(resolve => controls.resolve = resolve); },
        showErrorMessage: () => { throw new Error('Unexpected sign-in error'); },
      };
    `, loader: 'js' }));
  } }],
});
const module = { exports: {} };
new Function('require', 'module', 'exports', result.outputFiles[0].text)(
  (await import('node:module')).createRequire(import.meta.url), module, module.exports
);
const { AuthService, controls } = module.exports;
const auth = new AuthService({ secrets: { get: async () => undefined } }, { appendLine() {} });
let signedIn = 0;
auth.signIn = async () => { signedIn++; return true; };
assert.equal(await auth.requireClient(), undefined);
assert.equal(await auth.requireClient(), undefined);
assert.equal(controls.prompts, 1, 'pending prompt should not be duplicated');
assert.equal(signedIn, 0, 'unanswered prompt must not sign in');
controls.resolve('Sign In');
await new Promise(resolve => setImmediate(resolve));
assert.equal(signedIn, 1);
assert.equal(await auth.requireClient(), undefined);
assert.equal(controls.prompts, 2, 'a finished prompt may be offered again');
controls.resolve(undefined);
await new Promise(resolve => setImmediate(resolve));
assert.equal(signedIn, 1, 'dismissal must not sign in');
auth.client = async () => ({ authenticated: true });
assert.deepEqual(await auth.requireClient(), { authenticated: true });
assert.equal(controls.prompts, 2, 'authenticated commands must not prompt');
console.log('AUTH PROMPT SMOKE OK: immediate abort, deduplication, sign-in, dismissal, stored key');
