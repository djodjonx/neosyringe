#!/usr/bin/env node
// scripts/measure-t17-size.mjs
// Size of the generated container for one fixed graph, per emitter and profile.
// Run from the repo root after a fresh `pnpm build`: node scripts/measure-t17-size.mjs
// Not a test: it reads the built packages/core dist (stale if not rebuilt) and prints a table.
// full and minimal do not offer the same features (events, overrides): never read
// the minimal row as a free speed-up of the full rows. ADR007, "Comparaisons".
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const coreRequire = createRequire(resolve(root, 'packages/core/package.json'));
const unpluginRequire = createRequire(resolve(root, 'packages/unplugin/package.json'));
const ts = coreRequire('typescript');
const esbuild = unpluginRequire('esbuild');

const { Analyzer } = await import(pathToFileURL(resolve(root, 'packages/core/dist/analyzer/index.mjs')).href);
const { Generator } = await import(pathToFileURL(resolve(root, 'packages/core/dist/generator/index.mjs')).href);

const FIXTURE = resolve(root, 'virtual-t17-size/fixture.ts');
const PROVIDERS = 12;

/** Fixed graph: a chain of factories, three multi contributions, one async singleton. No clock, no random. */
function fixtureSource() {
  const lines = [
    "import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';",
    'function defineBuilderConfig(config: any) { return config; }',
    'function useInterface<T>(): any { return null; }',
  ];
  for (let index = 0; index < PROVIDERS; index += 1) {
    lines.push(`interface Port${index} { n: number }`, `const port${index} = useInterface<Port${index}>();`);
  }
  lines.push('interface Plugin { n: number }', 'const plugin = useInterface<Plugin>();');
  lines.push('interface Boot { ready: boolean }', 'const boot = useInterface<Boot>();');
  lines.push('export const sizeFixture = defineBuilderConfig({', "  name: 'SizeFixture',", '  injections: [');
  for (let index = 0; index < PROVIDERS; index += 1) {
    const dependency = index === 0 ? '[]' : `[port${index - 1}]`;
    const body = index === 0 ? `{ n: ${index} }` : `{ n: ctx.resolve(port${index - 1}).n + 1 }`;
    lines.push(`    { token: port${index}, useFactory: true, dependencies: ${dependency}, provider: (ctx) => (${body}) },`);
  }
  for (let index = 0; index < 3; index += 1) {
    lines.push(`    { token: plugin, multi: true, useFactory: true, dependencies: [], provider: () => ({ n: ${index} }) },`);
  }
  lines.push('    { token: boot, useFactory: true, dependencies: [], provider: async () => ({ ready: true }) },');
  lines.push('  ],', '});');
  return lines.join('\n');
}

function analyze() {
  const options = { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, strict: true, noImplicitAny: false };
  const host = ts.createCompilerHost(options);
  const read = host.getSourceFile.bind(host);
  const exists = host.fileExists.bind(host);
  const text = fixtureSource();
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreate) => (
    fileName === FIXTURE ? ts.createSourceFile(fileName, text, languageVersion, true) : read(fileName, languageVersion, onError, shouldCreate)
  );
  host.fileExists = (fileName) => fileName === FIXTURE || exists(fileName);
  host.resolveModuleNames = (names, containing) => names.map((name) => ts.resolveModuleName(name, containing, options, host).resolvedModule);
  const program = ts.createProgram([FIXTURE], options, host);
  const graphs = new Analyzer(program).extractAll();
  if (graphs.length !== 1) throw new Error(`expected one container, got ${graphs.length}`);
  return graphs[0];
}

function measure(graph, label, emitter, profile) {
  const sized = { ...graph, runtimeProfile: profile };
  const source = new Generator(sized, false, undefined, false, false, emitter).generate();
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const minified = esbuild.transformSync(js, { minify: true, format: 'esm', target: 'es2022' }).code;
  return { label, raw: Buffer.byteLength(js), minified: Buffer.byteLength(minified) };
}

const graph = analyze();
const rows = [
  measure(graph, 'reference-full', 'reference', 'full'),
  measure(graph, 'optimized-full', 'optimized', 'full'),
  measure(graph, 'optimized-minimal', 'optimized', 'minimal'),
];

const pad = (value, width) => String(value).padStart(width);
const signed = (value) => (value > 0 ? `+${value}` : String(value));
const base = rows[0];
console.log('reads packages/core/dist: it must come from a fresh `pnpm build`, a stale dist measures old code.');
console.log(`graph: ${PROVIDERS} chained factories, 3 multi contributions, 1 async singleton (open mode, debug off, testOverrides off)`);
console.log(`${'variant'.padEnd(20)}${pad('raw bytes', 12)}${pad('minified bytes', 16)}${pad('raw vs ref', 12)}${pad('min vs ref', 12)}`);
for (const row of rows) {
  const delta = row === base ? ['-', '-'] : [signed(row.raw - base.raw), signed(row.minified - base.minified)];
  console.log(`${row.label.padEnd(20)}${pad(row.raw, 12)}${pad(row.minified, 16)}${pad(delta[0], 12)}${pad(delta[1], 12)}`);
}
console.log('minimal drops on/override/clearOverrides: compare it with the full rows as a different feature set.');
