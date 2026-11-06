const { createRequire } = require('node:module');
const path = require('node:path');

// Webpack does not parse TypeScript. The plugin transform is enforce 'pre'
// (packages/unplugin/src/index.ts:97), so this loader runs after it.
// Same esbuild call as tests/e2e/t16-elagage.test.ts:137.
const pluginRequire = createRequire(path.join(__dirname, '../../../packages/unplugin/package.json'));
const esbuild = pluginRequire('esbuild');

function esbuildTsLoader(source) {
  const result = esbuild.transformSync(source, { loader: 'ts', format: 'esm', target: 'es2022' });
  return result.code;
}

module.exports = esbuildTsLoader;
