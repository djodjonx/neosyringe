import * as esbuild from 'esbuild';

const isWatch = process.argv.includes('--watch');

const extensionConfig = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  platform: 'node',
  format: 'cjs',
  external: ['vscode'],
  sourcemap: true,
  logLevel: 'info',
};

// Browser bundle: cytoscape + dagre + cytoscape-dagre for the WebView
const cytoscapeConfig = {
  entryPoints: ['src/cytoscape-bundle.js'],
  bundle: true,
  outfile: 'media/cytoscape.js',
  platform: 'browser',
  format: 'iife',
  minify: true,
  logLevel: 'info',
};

if (isWatch) {
  const ctx = await esbuild.context(extensionConfig);
  await ctx.watch();
  console.log('Watching...');
} else {
  await Promise.all([
    esbuild.build(extensionConfig),
    esbuild.build(cytoscapeConfig),
  ]);
}
