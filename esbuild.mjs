import esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const watch = process.argv.includes('--watch');
const smoke = process.argv.includes('--smoke');
const smokePinels = process.argv.includes('--smoke-pinels');
const smokePyright = process.argv.includes('--smoke-pyright');

const common = {
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  sourcemap: true,
};

/**
 * Ship the pyright language server inside the VSIX: node_modules is
 * .vscodeignore'd, so the needed runtime files are copied under dist/pyright
 * (the CLI bundle and source maps are left out). Skipped when dist already
 * holds the same pyright version.
 */
function copyPyright() {
  const require = createRequire(import.meta.url);
  const srcRoot = path.dirname(require.resolve('pyright/package.json'));
  const outRoot = path.resolve('dist/pyright');
  const version = JSON.parse(fs.readFileSync(path.join(srcRoot, 'package.json'), 'utf8')).version;
  try {
    const existing = JSON.parse(fs.readFileSync(path.join(outRoot, 'package.json'), 'utf8'));
    if (existing.version === version) return;
  } catch {
    // Missing or unreadable — copy below.
  }
  fs.rmSync(outRoot, { recursive: true, force: true });
  for (const entry of ['package.json', 'LICENSE.txt', 'langserver.index.js']) {
    fs.cpSync(path.join(srcRoot, entry), path.join(outRoot, entry));
  }
  fs.cpSync(path.join(srcRoot, 'dist'), path.join(outRoot, 'dist'), {
    recursive: true,
    filter: (src) => !src.endsWith('.map') && !src.endsWith(`${path.sep}pyright.js`),
  });
  console.log(`esbuild: bundled pyright ${version} into dist/pyright`);
}

const watchMarkerPlugin = {
  name: 'watch-marker',
  setup(build) {
    build.onStart(() => console.log('[watch] build started'));
    build.onEnd((result) => {
      for (const { text, location } of result.errors) {
        console.error(`[ERROR] ${text}`);
        if (location) console.error(`    ${location.file}:${location.line}:${location.column}:`);
      }
      console.log('[watch] build finished');
    });
  },
};

if (smoke) {
  await esbuild.build({
    ...common,
    entryPoints: ['test/smoke/envSmoke.ts'],
    outfile: 'dist/env-smoke.js',
    minify: false,
  });
} else if (smokePinels) {
  await esbuild.build({
    ...common,
    entryPoints: ['test/smoke/pineLsSmoke.ts'],
    outfile: 'dist/pinels-smoke.js',
    minify: false,
  });
} else if (smokePyright) {
  copyPyright();
  await esbuild.build({
    ...common,
    entryPoints: ['test/smoke/pyrightSmoke.ts'],
    outfile: 'dist/pyright-smoke.js',
    minify: false,
  });
} else {
  copyPyright();

  const ctx = await esbuild.context({
    ...common,
    entryPoints: ['src/extension.ts'],
    outfile: 'dist/extension.js',
    external: ['vscode'],
    minify: !watch,
    plugins: watch ? [watchMarkerPlugin] : [],
  });

  // Chart webview bundle: browser code (klinecharts inlined), no vscode API.
  const webviewCtx = await esbuild.context({
    ...common,
    entryPoints: ['src/chart/webview/main.ts'],
    outfile: 'dist/chart-webview.js',
    format: 'iife',
    platform: 'browser',
    target: 'es2020',
    minify: !watch,
    plugins: watch ? [watchMarkerPlugin] : [],
  });

  // OHLCV table webview bundle: browser code, no vscode API.
  const tableCtx = await esbuild.context({
    ...common,
    entryPoints: ['src/data/webview/table.ts'],
    outfile: 'dist/ohlcv-table.js',
    format: 'iife',
    platform: 'browser',
    target: 'es2020',
    minify: !watch,
    plugins: watch ? [watchMarkerPlugin] : [],
  });

  if (watch) {
    await ctx.watch();
    await webviewCtx.watch();
    await tableCtx.watch();
    console.log('esbuild: watching...');
  } else {
    await ctx.rebuild();
    await webviewCtx.rebuild();
    await tableCtx.rebuild();
    await ctx.dispose();
    await webviewCtx.dispose();
    await tableCtx.dispose();
  }
}
