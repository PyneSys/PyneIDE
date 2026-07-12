import esbuild from 'esbuild';

const watch = process.argv.includes('--watch');
const smoke = process.argv.includes('--smoke');

const common = {
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  sourcemap: true,
};

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
} else {
  const ctx = await esbuild.context({
    ...common,
    entryPoints: ['src/extension.ts'],
    outfile: 'dist/extension.js',
    external: ['vscode'],
    minify: !watch,
    plugins: watch ? [watchMarkerPlugin] : [],
  });

  if (watch) {
    await ctx.watch();
    console.log('esbuild: watching...');
  } else {
    await ctx.rebuild();
    await ctx.dispose();
  }
}
