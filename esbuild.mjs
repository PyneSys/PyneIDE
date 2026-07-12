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
  });

  if (watch) {
    await ctx.watch();
    console.log('esbuild: watching...');
  } else {
    await ctx.rebuild();
    await ctx.dispose();
  }
}
