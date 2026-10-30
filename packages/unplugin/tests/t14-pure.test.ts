import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

// The plugin imports @djodjonx/neosyringe-core from dist. These tests follow src
// so a mutation of Generator.ts is visible without a rebuild.
vi.mock('@djodjonx/neosyringe-core/generator', () => import('../../core/src/generator/index'));
vi.mock('@djodjonx/neosyringe-core/analyzer', () => import('../../core/src/analyzer/index'));
vi.mock('@djodjonx/neosyringe-core/context', () => import('../../core/src/TSContext'));
import * as esbuild from 'esbuild';
import { rollup, type Plugin, type RollupBuild } from 'rollup';
import ts from 'typescript';
import type { PluginConfig } from 'ts-patch';
import { TSContext } from '@djodjonx/neosyringe-core/context';
import { neoSyringePlugin } from '../src/index';
import neoSyringeTransformer from '../src/transformer';

// Real esbuild, Rollup and TypeScript program builds are slower on CI under
// coverage (measured up to 6.8 s). Scoped to this file; the worker resets it.
vi.setConfig({ testTimeout: 30_000 });

const SENTINEL = 'UNUSED_DEPENDENCY_SENTINEL_t14';

afterAll(() => {
  vi.resetConfig();
});

const dirs: string[] = [];

afterEach(() => {
  TSContext.reset();
  Reflect.deleteProperty(globalThis, '__t14Loads');
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function repoRoot(): string {
  let dir = path.resolve(process.cwd());
  while (!existsSync(path.join(dir, 'pnpm-workspace.yaml'))) {
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error('racine du dépôt introuvable');
    dir = parent;
  }
  return dir;
}

function runtimePath(): string {
  return path.join(repoRoot(), 'packages/neosyringe/dist/index.mjs');
}

interface BundleProof {
  esbuildMin: string;
  esbuildRaw: string;
  rollupMin: string;
  rollupRaw: string;
  esbuildRun: unknown;
  rollupRun: unknown;
  entry: string;
}

function writeFixture(
  entrySource: string,
  unusedSource?: string,
  sideEffects?: false,
): { dir: string; entry: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 't14-pure-'));
  dirs.push(dir);
  const manifest: { type: 'module'; sideEffects?: false } = { type: 'module' };
  if (sideEffects === false) manifest.sideEffects = false;
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify(manifest));
  writeFileSync(
    path.join(dir, 'used.ts'),
    'export class Used { read(): string { return \'used-ok\'; } }\n',
  );
  writeFileSync(
    path.join(dir, 'large-dependency.ts'),
    `export const payload = ${JSON.stringify(SENTINEL)};\n`,
  );
  writeFileSync(
    path.join(dir, 'unused.ts'),
    unusedSource ??
      "import { payload } from './large-dependency';\nexport class Unused { read(): string { return payload; } }\n",
  );
  const entry = path.join(dir, 'entry.ts');
  writeFileSync(entry, entrySource);
  return { dir, entry };
}

async function importRun(file: string): Promise<unknown> {
  const loaded = await import(pathToFileURL(file).href) as { run: () => unknown };
  return loaded.run();
}

async function minifyBundle(code: string): Promise<string> {
  const transformed = await esbuild.transform(code, {
    target: 'es2022',
    format: 'esm',
    minify: true,
    legalComments: 'none',
    treeShaking: false,
  });
  return transformed.code;
}

async function bundleFixture(
  entrySource: string,
  unusedSource?: string,
  sideEffects?: false,
): Promise<BundleProof> {
  const { dir, entry } = writeFixture(entrySource, unusedSource, sideEffects);
  const runtime = runtimePath();
  const alias = { '@djodjonx/neosyringe': runtime };

  // One plugin build. Minify is a text transform: it does not create a program.
  const built = await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    format: 'esm',
    target: 'es2022',
    platform: 'browser',
    treeShaking: true,
    legalComments: 'none',
    define: { 'process.env.NODE_ENV': '"production"' },
    alias,
    logLevel: 'silent',
    minify: false,
    plugins: [neoSyringePlugin.esbuild({ debug: false })],
  });
  const output = built.outputFiles?.[0];
  if (!output) throw new Error('esbuild n\'a pas émis de fichier');
  const esbuildRaw = output.text;
  const esbuildMin = await minifyBundle(esbuildRaw);
  const esbuildFile = path.join(dir, 'esbuild.mjs');
  writeFileSync(esbuildFile, esbuildMin);
  Reflect.set(globalThis, '__t14Loads', 0);
  const esbuildRun = await importRun(esbuildFile);

  const resolution: Plugin = {
    name: 'fixture-resolution',
    resolveId(source, importer) {
      if (source === '@djodjonx/neosyringe') return runtime;
      if (!source.startsWith('.') || !importer) return null;
      const absolute = path.resolve(path.dirname(importer), source);
      const found = [absolute, `${absolute}.ts`, `${absolute}.mjs`].find((candidate) => existsSync(candidate));
      if (!found) return null;
      if (sideEffects === false && found.startsWith(dir + path.sep)) {
        return { id: found, moduleSideEffects: false };
      }
      return found;
    },
  };
  const stripTypes: Plugin = {
    name: 'fixture-typescript',
    async transform(source, id) {
      if (!id.endsWith('.ts')) return null;
      const transformed = await esbuild.transform(source, {
        loader: 'ts',
        target: 'es2022',
        format: 'esm',
        legalComments: 'inline',
        define: { 'process.env.NODE_ENV': '"production"' },
      });
      return { code: transformed.code, map: null };
    },
  };

  let rollupRaw = '';
  let rollupMin = '';
  let rollupBuild: RollupBuild | undefined;
  try {
    rollupBuild = await rollup({
      input: entry,
      plugins: [resolution, neoSyringePlugin.rollup({ debug: false }), stripTypes],
      treeshake: true,
      onwarn(warning) {
        if (warning.code !== 'SOURCEMAP_BROKEN') throw new Error(warning.message);
      },
    });
    const generated = await rollupBuild.generate({ format: 'esm' });
    const chunk = generated.output[0];
    if (!chunk || chunk.type !== 'chunk') throw new Error('Rollup n\'a pas émis un chunk');
    rollupRaw = chunk.code;
    rollupMin = await minifyBundle(rollupRaw);
  } finally {
    await rollupBuild?.close();
  }

  const rollupFile = path.join(dir, 'rollup.mjs');
  writeFileSync(rollupFile, rollupMin);
  Reflect.set(globalThis, '__t14Loads', 0);
  const rollupRun = await importRun(rollupFile);

  return {
    esbuildMin,
    esbuildRaw,
    rollupMin,
    rollupRaw,
    esbuildRun,
    rollupRun,
    entry,
  };
}

function expectSentinelAbsent(proof: BundleProof): void {
  const texts = [proof.esbuildMin, proof.esbuildRaw, proof.rollupMin, proof.rollupRaw];
  expect(texts.length).toBeGreaterThan(0);
  for (const text of texts) expect(text).not.toContain(SENTINEL);
}

function neoContainerClasses(source: string): string[] {
  return [...new Set(source.match(/NeoContainer_[0-9a-f]{8}/g) ?? [])];
}

function parseErrorCount(source: string): number {
  const parsed = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
    reportDiagnostics: true,
  });
  return parsed.diagnostics?.length ?? 0;
}

function pluginText(file: string): string {
  const plugin = neoSyringePlugin.vite({ debug: false });
  const source = readFileSync(file, 'utf8');
  // @ts-expect-error unplugin hook is callable in tests
  const output = plugin.transform(source, file) as string | { code?: string } | null | undefined;
  const hook = plugin as { buildEnd: () => void };
  hook.buildEnd();
  if (typeof output === 'string') return output;
  if (output && typeof output.code === 'string') return output.code;
  return source;
}

let cachedFixtureOptions: ts.CompilerOptions | undefined;

function fixtureCompilerOptions(): ts.CompilerOptions {
  if (cachedFixtureOptions) return cachedFixtureOptions;
  const configPath = ts.findConfigFile(repoRoot(), ts.sys.fileExists, 'tsconfig.json');
  if (!configPath) throw new Error('tsconfig.json introuvable');
  const read = ts.readConfigFile(configPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, repoRoot());
  // The transformer's own programs re-parse every default lib. These fixtures
  // only need the repo paths, so the DOM lib is skipped.
  cachedFixtureOptions = { ...parsed.options, noLib: true, types: [] };
  return cachedFixtureOptions;
}

function transformerText(file: string): string {
  const program = ts.createProgram([file], fixtureCompilerOptions());
  const config: PluginConfig = {};
  const next = neoSyringeTransformer(program, undefined, config, { ts });
  return next.getSourceFile(file)?.text ?? '';
}

const moduleLoadEntry = `import { defineBuilderConfig } from '@djodjonx/neosyringe';
import { Unused } from './unused';
const unusedContainer = defineBuilderConfig({ injections: [{ token: Unused }] });
export function run(): number {
  return globalThis['__t14Loads'] ?? 0;
}
`;

const moduleLoadUnused = `import { payload } from './large-dependency';
globalThis['__t14Loads'] = (globalThis['__t14Loads'] ?? 0) + 1;
export class Unused { read(): string { return payload; } }
`;

const useInterfaceEntry = `import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';

interface Port { read(): string }
class Adapter implements Port { read(): string { return 'used-ok'; } }

export const c = defineBuilderConfig({
  injections: [{ token: useInterface<Port>(), provider: Adapter }],
});

export function run(): string {
  return c.resolve(useInterface<Port>()).read();
}
`;

const pureNew = '/* @__PURE__ */ new NeoContainer';

const bothContainers = `import { defineBuilderConfig } from '@djodjonx/neosyringe';
import { Used } from './used';
import { Unused } from './unused';
const c = defineBuilderConfig({ injections: [{ token: Used }, { token: Unused }] });
`;

describe('T14 pure containers and partials', () => {
  it('T14-P1-unused-container', async () => {
    const proof = await bundleFixture(`${bothContainers}export const run = () => 'used-ok';\n`);
    expect(proof.esbuildRun).toBe('used-ok');
    expect(proof.rollupRun).toBe('used-ok');
    expectSentinelAbsent(proof);
    expect(proof.esbuildRaw).not.toContain('NeoContainer_');
    expect(proof.rollupRaw).not.toContain('NeoContainer_');
  });

  it('T14-P2-two-containers', async () => {
    const proof = await bundleFixture(`import { defineBuilderConfig } from '@djodjonx/neosyringe';
import { Used } from './used';
import { Unused } from './unused';
const c = defineBuilderConfig({ injections: [{ token: Used }] });
const other = defineBuilderConfig({ injections: [{ token: Unused }] });
export const run = () => c.resolve(Used).read();
`);
    expect(proof.esbuildRun).toBe('used-ok');
    expect(proof.rollupRun).toBe('used-ok');
    expectSentinelAbsent(proof);
    expect(neoContainerClasses(proof.esbuildRaw)).toHaveLength(1);
    expect(neoContainerClasses(proof.rollupRaw)).toHaveLength(1);
  });

  it('T14-P3-unused-partial', async () => {
    const proof = await bundleFixture(`import { defineBuilderConfig, definePartialConfig } from '@djodjonx/neosyringe';
import { Used } from './used';
import { Unused } from './unused';
const partial = definePartialConfig({ injections: [{ token: Used }, { token: Unused }] });
const c = defineBuilderConfig({ extends: [partial] });
export const run = () => 'used-ok';
`);
    expect(proof.esbuildRun).toBe('used-ok');
    expect(proof.rollupRun).toBe('used-ok');
    expectSentinelAbsent(proof);
    expect(proof.esbuildRaw).not.toContain('NeoContainer_');
    expect(proof.rollupRaw).not.toContain('NeoContainer_');
    const transformed = pluginText(proof.entry);
    expect(transformed).toContain('/* @__PURE__ */ definePartialConfig(');
    expect(transformed).toContain(pureNew);
  });

  it('T14-P4-open-unused-provider', async () => {
    const proof = await bundleFixture(`${bothContainers}export const run = () => c.resolve(Used).read();\n`);
    expect(proof.esbuildRun).toBe('used-ok');
    expect(proof.rollupRun).toBe('used-ok');
    expect(proof.esbuildMin).toContain(SENTINEL);
    expect(proof.esbuildRaw).toContain(SENTINEL);
    expect(proof.rollupMin).toContain(SENTINEL);
    expect(proof.rollupRaw).toContain(SENTINEL);
  });

  it('T14-P5-module-load', async () => {
    const proof = await bundleFixture(moduleLoadEntry, moduleLoadUnused);
    // The module effect runs once. The payload stays only if the unused container is kept.
    expect(proof.esbuildRun).toBe(1);
    expect(proof.rollupRun).toBe(1);
    expectSentinelAbsent(proof);
  });

  it('T14-P5-module-load-sideeffects-false', async () => {
    const proof = await bundleFixture(moduleLoadEntry, moduleLoadUnused, false);
    expect(proof.esbuildRun).toBe(0);
    expect(proof.rollupRun).toBe(0);
  });

  it('T14-P5-use-value', async () => {
    const proof = await bundleFixture(`import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';

interface Box { value: number }

let calls = 0;
function effectfulCall(): Box {
  calls += 1;
  return { value: calls };
}

export const c = defineBuilderConfig({
  injections: [{ token: useInterface<Box>(), useValue: effectfulCall() }],
});

export function run(): number {
  c.resolve(useInterface<Box>());
  c.resolve(useInterface<Box>());
  return calls;
}
`);
    expect(proof.esbuildRun).toBe(1);
    expect(proof.rollupRun).toBe(1);
  });

  it('T14-P5-partial-argument', async () => {
    const proof = await bundleFixture(`import { definePartialConfig } from '@djodjonx/neosyringe';

let calls = 0;
function effectful(): { injections: never[] } {
  calls += 1;
  return { injections: [] };
}

definePartialConfig(effectful());
export function run(): number { return calls; }
`);
    expect(proof.esbuildRun).toBe(1);
    expect(proof.rollupRun).toBe(1);
  });

  it('T14-P6-local-homonym', async () => {
    const source = `import { defineBuilderConfig } from '@djodjonx/neosyringe';
import { Used } from './used';

let calls = 0;
function definePartialConfig(value: { ok: boolean }): { ok: boolean } {
  calls += 1;
  return value;
}

const partial = definePartialConfig({ ok: true });
export const c = defineBuilderConfig({ injections: [{ token: Used }] });
export function run(): number {
  c.resolve(Used);
  return calls;
}
`;
    const proof = await bundleFixture(source);
    const transformed = pluginText(proof.entry);
    expect(transformed).not.toMatch(/\/\* @__PURE__ \*\/\s*definePartialConfig\(/);
    expect(proof.esbuildRun).toBe(1);
    expect(proof.rollupRun).toBe(1);
  });

  it('T14-P7a-plugin-use-interface', () => {
    const { entry } = writeFixture(useInterfaceEntry);
    expect(pluginText(entry)).toContain(pureNew);
  });

  it('T14-P7b-transformer', () => {
    const { entry } = writeFixture(useInterfaceEntry);
    expect(transformerText(entry)).toContain(pureNew);
  });

  it('T14-P7c-transpile-module', () => {
    const { entry } = writeFixture(useInterfaceEntry);
    const transpiled = ts.transpileModule(pluginText(entry), {
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2020,
        removeComments: false,
      },
    }).outputText;
    expect(transpiled).toContain(pureNew);
  });

  it('T14-P9-chained-effect', async () => {
    const proof = await bundleFixture(`import { definePartialConfig } from '@djodjonx/neosyringe';

let calls = 0;
definePartialConfig({ injections: [0] }).injections.forEach(() => {
  calls += 1;
});
export function run(): number {
  return calls;
}
`);
    expect(proof.esbuildRun).toBe(1);
    expect(proof.rollupRun).toBe(1);
  });

  it('T14-P9-chain-shapes', () => {
    const source = `import { definePartialConfig } from '@djodjonx/neosyringe';

export const prop = definePartialConfig({ injections: [] }).injections;
export const elem = definePartialConfig({ injections: [] })['injections'];
export const nonNull = definePartialConfig({ injections: [] })!.injections;
export const tagged = definePartialConfig({ injections: [] })\`x\`;
export const called = definePartialConfig({ injections: [] })();
export const plain = definePartialConfig({ injections: [] });
`;
    const expected = `import { definePartialConfig } from '@djodjonx/neosyringe';

export const prop = definePartialConfig({ injections: [] }).injections;
export const elem = definePartialConfig({ injections: [] })['injections'];
export const nonNull = definePartialConfig({ injections: [] })!.injections;
export const tagged = definePartialConfig({ injections: [] })\`x\`;
export const called = definePartialConfig({ injections: [] })();
export const plain = /* @__PURE__ */ definePartialConfig({ injections: [] });
`;
    const { entry } = writeFixture(source);
    expect(pluginText(entry)).toBe(expected);
    expect(transformerText(entry)).toBe(expected);
  });

  it('T14-P10-alias-namespace-default', () => {
    const source = `import * as neo from '@djodjonx/neosyringe';
import { definePartialConfig as dp } from '@djodjonx/neosyringe';

export const namespaced = neo.definePartialConfig({ injections: [] });
export const aliased = dp({ injections: [] });
export default dp({ injections: [] });
`;
    const expected = `import * as neo from '@djodjonx/neosyringe';
import { definePartialConfig as dp } from '@djodjonx/neosyringe';

export const namespaced = /* @__PURE__ */ neo.definePartialConfig({ injections: [] });
export const aliased = /* @__PURE__ */ dp({ injections: [] });
export default /* @__PURE__ */ dp({ injections: [] });
`;
    const { entry } = writeFixture(source);
    expect(pluginText(entry)).toBe(expected);
    expect(transformerText(entry)).toBe(expected);
  });

  it('T14-P11-partial-inside-splice', () => {
    const source = `import { defineBuilderConfig, definePartialConfig } from '@djodjonx/neosyringe';
import { Used } from './used';
const c = defineBuilderConfig({
  injections: [{ token: Used }],
  extends: [definePartialConfig({ injections: [] })],
});
`;
    const { entry } = writeFixture(source);
    const pluginOut = pluginText(entry);
    const transformerOut = transformerText(entry);
    expect(pluginOut).not.toMatch(/definePartialConfig\(/);
    expect(transformerOut).not.toMatch(/definePartialConfig\(/);
    expect(pluginOut).toContain(pureNew);
    expect(transformerOut).toContain(pureNew);
    expect(parseErrorCount(pluginOut)).toBe(0);
    expect(parseErrorCount(transformerOut)).toBe(0);
  });
});
