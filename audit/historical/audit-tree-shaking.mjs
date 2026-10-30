import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync, brotliCompressSync, constants } from 'node:zlib';
import { pathToFileURL } from 'node:url';
import * as esbuild from './node_modules/.pnpm/esbuild@0.27.2/node_modules/esbuild/lib/main.js';
import { rollup } from './node_modules/.pnpm/rollup@4.55.2/node_modules/rollup/dist/es/rollup.js';
import { neoSyringePlugin } from './packages/unplugin/dist/index.mjs';

// Scratch experiment only. No library source is modified.
process.env.NODE_ENV = 'production';
const root = process.cwd();
const out = path.join(root, '.audit-tree-shaking');
mkdirSync(out, { recursive: true });
const runtime = path.join(root, 'packages/neosyringe/dist/index.mjs');
const payload = 'UNUSED_DEPENDENCY_SENTINEL_' + Array.from({ length: 256 }, (_, i) => createHash('sha256').update(`neosyringe-audit-${i}`).digest('hex')).join('');
const marker = `import { defineBuilderConfig } from '@djodjonx/neosyringe';\n`;
const imports = `import { Used } from './used';\nimport { Unused } from './unused';\n`;
const both = `const c = defineBuilderConfig({ injections: [{ token: Used }, { token: Unused }] });\n`;
const one = `const c = defineBuilderConfig({ injections: [{ token: Used }] });\n`;
const run = `export const run = () => c.resolve(Used).read();\n`;
const unusedBody = marker + imports + both + `export const run = () => 'used-ok';\n`;
const twoBody = marker + imports + one + `const other = defineBuilderConfig({ injections: [{ token: Unused }] });\n` + run;
const partialBody = `import { defineBuilderConfig, definePartialConfig } from '@djodjonx/neosyringe';\n` + imports + `const partial = definePartialConfig({ injections: [{ token: Used }, { token: Unused }] });\nconst c = defineBuilderConfig({ extends: [partial] });\n`;
const cases = [
  { name: 'manual', source: `import { Used } from './used';\nconst service = new Used();\nexport const run = () => service.read();\n` },
  { name: 'used_only', source: marker + `import { Used } from './used';\n` + one + run },
  { name: 'unused_registered', source: marker + imports + both + run },
  { name: 'unused_container', source: unusedBody },
  { name: 'two_containers', source: twoBody },
  { name: 'pure_unused_container', source: unusedBody, pure: true },
  { name: 'pure_two_containers', source: twoBody, pure: true },
  { name: 'pure_unused_registered', source: marker + imports + both + run, pure: true },
  { name: 'sideeffects_false_registered', source: marker + imports + both + run, sideEffects: false },
  { name: 'pure_unused_side_effect', source: unusedBody, pure: true, moduleEffect: true },
  { name: 'default_unused_registered', source: marker + `import { Used } from './used';\nimport Unused from './unused';\n` + both + run, defaultExport: true },
  { name: 'barrel_unused_registered', source: marker + `import { Used, Unused } from './barrel';\n` + both + run },
  { name: 'barrel_used_only', source: marker + `import { Used } from './barrel';\n` + one + run },
  { name: 'partial_unused_registered', source: partialBody + run },
  { name: 'partial_unused_container', source: partialBody + `export const run = () => 'used-ok';\n` },
  { name: 'pure_partial_unused_container', source: partialBody + `export const run = () => 'used-ok';\n`, pure: true },
  { name: 'pure_both_partial_unused_container', source: partialBody + `export const run = () => 'used-ok';\n`, pure: true, purePartial: true },
  { name: 'interface_unused_registered', source: `import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';\n` + imports + `interface IUsed { read(): string }\ninterface IUnused { read(): string }\nconst c = defineBuilderConfig({ injections: [{ token: useInterface<IUsed>(), provider: Used }, { token: useInterface<IUnused>(), provider: Unused }] });\nexport const run = () => c.resolve(useInterface<IUsed>()).read();\n` },
];

function patchPure(code, fixture) {
  const annotated = code.replace(/\bnew (NeoContainer_[A-Za-z0-9_]+)\(/g, '/* @__PURE__ */ new $1(');
  return fixture.purePartial ? annotated.replace(/\bdefinePartialConfig\(/g, '/* @__PURE__ */ definePartialConfig(') : annotated;
}
const rows = [];
for (const fixture of cases) {
  const dir = path.join(out, fixture.name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'entry.ts'), fixture.source);
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ type: 'module', ...(fixture.sideEffects === false ? { sideEffects: false } : {}) }, null, 2));
  writeFileSync(path.join(dir, 'used.ts'), `export class Used { read() { return 'used-ok'; } }\n`);
  writeFileSync(path.join(dir, 'large-dependency.ts'), `export const payload = ${JSON.stringify(payload)};\n`);
  writeFileSync(path.join(dir, 'unused.ts'), `import { payload } from './large-dependency';\n${fixture.moduleEffect ? "globalThis.__neoModuleEffect = (globalThis.__neoModuleEffect || 0) + 1;\n" : ''}${fixture.defaultExport ? 'export default' : 'export'} class Unused { constructor() { globalThis.__neoUnusedConstructed = (globalThis.__neoUnusedConstructed || 0) + 1; } read() { return payload; } }\n`);
  writeFileSync(path.join(dir, 'barrel.ts'), `export { Used } from './used';\nexport { Unused } from './unused';\n`);
  // Save the plugin output separately for inspecting the cause of retention.
  const rawPlugin = neoSyringePlugin.vite({ debug: false });
  try {
    const transformed = rawPlugin.transform(fixture.source, path.join(dir, 'entry.ts'));
    rawPlugin.buildEnd();
    const code = typeof transformed === 'string' ? transformed : transformed?.code ?? fixture.source;
    writeFileSync(path.join(dir, 'generated.ts'), fixture.pure ? patchPure(code, fixture) : code);
  } catch (error) { rows.push({ name: fixture.name, phase: 'transform', error: error.message }); continue; }

  for (const bundler of ['esbuild', 'rollup']) {
    try {
      let code, raw, metadata;
      if (bundler === 'esbuild') {
        let plugin = neoSyringePlugin.esbuild({ debug: false });
        if (fixture.pure) {
          // Use the exact transformed output with one experimental annotation change.
          // This does not patch the repository's generator implementation.
          plugin = { name: 'experimental-pure-container', setup(build) { build.onLoad({ filter: /entry\.ts$/ }, () => ({ contents: readFileSync(path.join(dir, 'generated.ts'), 'utf8'), loader: 'ts', resolveDir: dir })); } };
        }
        const config = { entryPoints: [path.join(dir, 'entry.ts')], bundle: true, write: false, format: 'esm', target: 'es2022', platform: 'browser', treeShaking: true, legalComments: 'none', define: { 'process.env.NODE_ENV': '"production"' }, alias: { '@djodjonx/neosyringe': runtime }, plugins: [plugin], metafile: true, logLevel: 'silent' };
        const build = await esbuild.build({ ...config, minify: true });
        code = build.outputFiles[0].text;
        metadata = build.metafile;
        const unminified = await esbuild.build({ ...config, plugins: fixture.pure ? [plugin] : [neoSyringePlugin.esbuild({ debug: false })], minify: false });
        raw = unminified.outputFiles[0].text;
      } else {
        const resolution = { name: 'fixture-resolution', resolveId(source, importer) {
          if (source === '@djodjonx/neosyringe') return runtime;
          if (!source.startsWith('.') || !importer) return null;
          const absolute = path.resolve(path.dirname(importer), source);
          const found = [absolute, absolute + '.ts', absolute + '.mjs'].find(x => existsSync(x));
          if (!found) return null;
          // Model package-aware resolution only for the dedicated metadata experiment.
          return { id: found, ...(fixture.sideEffects === false && found.startsWith(dir + path.sep) ? { moduleSideEffects: false } : {}) };
        } };
        const stripTypes = { name: 'fixture-typescript', async transform(source, id) {
          if (!id.endsWith('.ts')) return null;
          const transformed = await esbuild.transform(fixture.pure ? patchPure(source, fixture) : source, { loader: 'ts', target: 'es2022', format: 'esm', define: { 'process.env.NODE_ENV': '"production"' }, legalComments: 'inline' });
          return { code: transformed.code, map: null };
        } };
        const build = await rollup({ input: path.join(dir, 'entry.ts'), plugins: [resolution, neoSyringePlugin.rollup({ debug: false }), stripTypes], treeshake: true, onwarn(warning) { if (warning.code !== 'SOURCEMAP_BROKEN') throw new Error(warning.message); } });
        const result = await build.generate({ format: 'esm' });
        if (result.output.length !== 1 || result.output[0].type !== 'chunk') throw new Error('Expected one JavaScript chunk');
        raw = result.output[0].code;
        metadata = result.output[0].modules;
        code = (await esbuild.transform(raw, { target: 'es2022', format: 'esm', minify: true, legalComments: 'none', treeShaking: false })).code;
        await build.close();
      }
      const file = path.join(dir, `${bundler}.mjs`);
      writeFileSync(file, code);
      writeFileSync(path.join(dir, `${bundler}-unminified.mjs`), raw);
      writeFileSync(path.join(dir, `${bundler}-metadata.json`), JSON.stringify(metadata, null, 2));
      globalThis.__neoUnusedConstructed = 0;
      globalThis.__neoModuleEffect = 0;
      const module = await import(pathToFileURL(file).href);
      const result = await module.run();
      if (result !== 'used-ok') throw new Error(`Wrong runtime result: ${result}`);
      const row = { name: fixture.name, bundler, rawBytes: Buffer.byteLength(raw), minBytes: Buffer.byteLength(code), gzipBytes: gzipSync(code, { level: 9 }).length, brotliBytes: brotliCompressSync(code, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }).length, unusedPayloadRetained: code.includes('UNUSED_DEPENDENCY_SENTINEL_'), rawPayloadRetained: raw.includes('UNUSED_DEPENDENCY_SENTINEL_'), unusedConstructed: globalThis.__neoUnusedConstructed, moduleEffects: globalThis.__neoModuleEffect, runtime: result };
      rows.push(row);
      console.log(JSON.stringify(row));
    } catch (error) { const row = { name: fixture.name, bundler, error: error.stack }; rows.push(row); console.log(JSON.stringify(row)); }
  }
}
writeFileSync(path.join(out, 'results.json'), JSON.stringify({ commit: 'b2d0033ca3ff139fd50f1c74160d7de2939f64a2', node: process.version, esbuild: esbuild.version, rollup: '4.55.2', payloadBytes: Buffer.byteLength(payload), compression: { gzipLevel: 9, brotliQuality: 11 }, rows }, null, 2));
const retainedBoth = new Set(['unused_registered', 'pure_unused_registered', 'sideeffects_false_registered', 'default_unused_registered', 'barrel_unused_registered', 'partial_unused_registered', 'interface_unused_registered']);
const retainedEsbuildOnly = new Set(['unused_container', 'two_containers', 'partial_unused_container', 'pure_partial_unused_container']);
for (const row of rows) {
  if (row.error) throw new Error(`Build/runtime failure in ${row.name}: ${row.error}`);
  const expectedRetained = retainedBoth.has(row.name) || (row.bundler === 'esbuild' && retainedEsbuildOnly.has(row.name));
  if (row.unusedPayloadRetained !== expectedRetained || row.rawPayloadRetained !== expectedRetained) throw new Error(`Unexpected retention in ${row.name}/${row.bundler}`);
  if (row.unusedConstructed !== 0) throw new Error(`Unexpected provider creation in ${row.name}/${row.bundler}`);
  if (row.moduleEffects !== Number(row.name === 'pure_unused_side_effect')) throw new Error(`Wrong module side effect in ${row.name}/${row.bundler}`);
}
if (rows.length !== cases.length * 2) throw new Error('Incomplete build matrix');
console.log(`Verified ${rows.length} fixture/bundler combinations, with runtime results and retention assertions.`);
