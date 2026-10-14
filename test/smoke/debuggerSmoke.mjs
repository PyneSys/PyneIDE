/** Bundle the adapter with a VS Code event shim; debugpy and the bridge stay real. */
import esbuild from 'esbuild';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const buildOnly = process.argv[2] === '--build-only';
const output = buildOnly ? process.argv[3] : path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pyne-dap-')), 'smoke.cjs');
if (!output) throw new Error('Expected bundle output path');
await esbuild.build({
  entryPoints: ['test/smoke/debuggerSmoke.ts'], bundle: true, platform: 'node', format: 'cjs', outfile: output,
  plugins: [{ name: 'vscode-events', setup(build) {
    build.onResolve({ filter: /^vscode$/ }, () => ({ path: 'vscode', namespace: 'shim' }));
    build.onLoad({ filter: /.*/, namespace: 'shim' }, () => ({ contents: `
      const { EventEmitter } = require('node:events');
      exports.EventEmitter = class {
        emitter = new EventEmitter();
        event = listener => { this.emitter.on('message', listener); return { dispose: () => this.emitter.off('message', listener) }; };
        fire(message) { this.emitter.emit('message', message); }
        dispose() { this.emitter.removeAllListeners(); }
      };
    `, loader: 'js' }));
  } }],
});
if (!buildOnly) {
  try {
    const result = spawnSync(process.execPath, [output, ...process.argv.slice(2)], { stdio: 'inherit' });
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
  } finally { fs.rmSync(path.dirname(output), { recursive: true, force: true }); }
}
