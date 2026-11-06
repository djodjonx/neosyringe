import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { executeFixture } from './helpers/execute-fixture';
import { executeCompatible } from './helpers/t20-compat';

// T20 NS009 NS010 NS015 NS016 NS017: the published examples and guides must say what the build does.
// Needs a fresh `pnpm build` (executeFixture checks it). Nothing here reads a clock.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const examplesDir = path.join(repoRoot, 'examples/new-api');
const docsDir = path.join(repoRoot, 'docs');
const cli = path.join(repoRoot, 'packages/cli/dist/index.mjs');
const pluginRequire = createRequire(path.join(repoRoot, 'packages/unplugin/package.json'));

interface BuildOptions {
  validation?: 'strict' | 'compatible';
  testOverrides?: boolean;
}

const WITH_TEST_API: BuildOptions = { validation: 'strict', testOverrides: true };
const STRICT: BuildOptions = { validation: 'strict' };
const COMPATIBLE_USAGE: BuildOptions = { validation: 'compatible' };

const scratch: string[] = [];

function scratchDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}

function example(file: string): string {
  return readFileSync(path.join(examplesDir, file), 'utf8');
}

function guideText(relative: string): string {
  const full = path.join(docsDir, relative);
  expect(existsSync(full), `missing ${path.join('docs', relative)}`).toBe(true);
  return existsSync(full) ? readFileSync(full, 'utf8') : '';
}

async function runExample(file: string, options: BuildOptions): Promise<unknown> {
  const outcome = await executeFixture(example(file), options);
  expect(outcome, `${file}: ${JSON.stringify(outcome)}`).toMatchObject({ phase: 'ok' });
  return outcome.phase === 'ok' ? outcome.value : undefined;
}

function fencedBlocks(markdown: string): string[] {
  return [...markdown.matchAll(/```[^\n]*\n([\s\S]*?)```/g)].map((match) => match[1] ?? '');
}

function markdownFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.vitepress' || entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...markdownFiles(full));
    else if (entry.name.endsWith('.md')) found.push(full);
  }
  return found;
}

function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...sourceFiles(full));
    else if (entry.name.endsWith('.ts')) found.push(full);
  }
  return found;
}

function typecheck(dir: string, expectFile?: string): { status: number | null; output: string } {
  const args = [path.join(repoRoot, 'scripts/ci/consumer-types.mjs'), dir];
  if (expectFile !== undefined) args.push('--expect-file', expectFile);
  const result = spawnSync(process.execPath, args, { cwd: repoRoot, encoding: 'utf8' });
  return { status: result.status, output: `${result.stdout}\n${result.stderr}` };
}

function writeConsumer(dir: string, files: Record<string, string>): void {
  const syringe = path.join(repoRoot, 'packages/neosyringe').replace(/\\/g, '/');
  for (const [name, text] of Object.entries(files)) writeFileSync(path.join(dir, name), text);
  writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify({
    compilerOptions: {
      strict: true,
      target: 'ES2022',
      module: 'ESNext',
      moduleResolution: 'bundler',
      noEmit: true,
      skipLibCheck: true,
      baseUrl: '.',
      paths: { '@djodjonx/neosyringe': [syringe] },
    },
    files: Object.keys(files).filter((name) => name.endsWith('.ts')),
  }));
}

interface EsbuildBundle {
  build: (options: {
    absWorkingDir: string;
    entryPoints: string[];
    bundle: boolean;
    write: boolean;
    format: 'cjs';
    platform: 'node';
    define: Record<string, string>;
    plugins: { name: string; setup: (build: object) => void }[];
  }) => Promise<{ outputFiles?: { text: string }[] }>;
}

interface PluginBundle {
  neoSyringePlugin: { esbuild: (options: { project: string }) => { name: string; setup: (build: object) => void } };
}

/** Bundles `source` as app.ts with the real esbuild plugin, production mode. Returns the JavaScript text. */
async function bundle(source: string): Promise<string> {
  const dir = scratchDir('t20-bundle-');
  const syringe = path.join(repoRoot, 'packages/neosyringe').replace(/\\/g, '/');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'app.ts'), source);
  writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify({
    compilerOptions: {
      target: 'ES2022',
      module: 'ESNext',
      moduleResolution: 'bundler',
      strict: true,
      baseUrl: '.',
      paths: { '@djodjonx/neosyringe': [syringe] },
    },
    include: ['**/*.ts'],
  }));
  const plugin = pluginRequire('./dist/index.cjs') as PluginBundle;
  const esbuild = pluginRequire('esbuild') as EsbuildBundle;
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    const result = await esbuild.build({
      absWorkingDir: dir,
      entryPoints: ['app.ts'],
      bundle: true,
      write: false,
      format: 'cjs',
      platform: 'node',
      define: { 'process.env.NODE_ENV': '"production"' },
      plugins: [plugin.neoSyringePlugin.esbuild({ project: path.join(dir, 'tsconfig.json') })],
    });
    return result.outputFiles?.[0]?.text ?? '';
  } finally {
    if (previous === undefined) Reflect.deleteProperty(process.env, 'NODE_ENV');
    else process.env.NODE_ENV = previous;
  }
}

async function runBundle(code: string): Promise<unknown> {
  const record: { exports: { run?: () => unknown } } = { exports: {} };
  const execute = new Function('module', 'exports', 'require', code) as (
    module: typeof record,
    exports: typeof record.exports,
    require: (id: string) => unknown,
  ) => void;
  execute(record, record.exports, (id: string) => {
    throw new Error(`unexpected require ${id}`);
  });
  const run = record.exports.run;
  if (typeof run !== 'function') throw new Error('bundle did not export run');
  return run();
}

interface CliReport {
  ok: boolean;
  errors: { code?: string; message: string }[];
}

function cliCodes(dir: string): string[] {
  const result = spawnSync(process.execPath, [cli, '--json'], { cwd: dir, encoding: 'utf8' });
  const report = JSON.parse(result.stdout) as CliReport;
  expect(report.ok, result.stdout).toBe(false);
  return report.errors.map((error) => error.code ?? '');
}

describe('T20 documentation examples', () => {
  beforeAll(() => {
    expect(existsSync(cli), `missing ${cli}; run pnpm build`).toBe(true);
  });

  afterAll(() => {
    for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
    scratch.length = 0;
  });

  it('T20-A01 every examples/new-api file typechecks against the built packages', () => {
    const files = readdirSync(examplesDir).filter((name) => name.endsWith('.ts')).sort();
    expect(files).toEqual([
      'async.ts',
      'closed-parent.ts',
      'closed.ts',
      'factories.ts',
      'migration-after.ts',
      'migration-before.ts',
      'mock.ts',
      'profiles.ts',
      'scopes.ts',
    ]);
    const dir = scratchDir('t20-types-');
    writeConsumer(dir, Object.fromEntries(files.map((name) => [name, example(name)])));
    const result = typecheck(dir);
    expect(result.status, result.output).toBe(0);
  });

  it('T20-A01 every snippet a guide includes is a file of examples/new-api', () => {
    const included: string[] = [];
    for (const file of markdownFiles(docsDir)) {
      for (const match of readFileSync(file, 'utf8').matchAll(/^<<<\s+@\/\.\.\/examples\/new-api\/([\w.-]+)/gm)) {
        included.push(match[1] ?? '');
      }
    }
    expect(included.length).toBeGreaterThan(0);
    const missing = included.filter((name) => !existsSync(path.join(examplesDir, name)));
    expect(missing).toEqual([]);
  });

  it('T20-A01 factories example: every factory shape the guides show builds and returns its value', async () => {
    const value = await runExample('factories.ts', STRICT);
    expect(value).toEqual({
      arrow: 'http://localhost',
      withDependencies: 'client for http://localhost via console',
      namedFunction: 'connected to db://main',
      existingInstance: 'prebuilt',
      properties: 'https://api.example.com 5000 3',
      transient: ['request-1', 'request-2'],
      typedFactory: 'http://localhost logs through console',
      allDependency: ['auth', 'log'],
      combined: 'console http://localhost 5000',
    });
  });

  it('T20-A01 the pages that show a factory include it from examples/new-api/factories.ts and keep none inline', () => {
    const pages = [
      'guide/injection-types.md',
      'guide/basic-usage.md',
      'guide/lifecycle.md',
      'guide/states-and-ownership.md',
      'api/configuration.md',
      'api/functions.md',
      'api/types.md',
    ];
    const inline: string[] = [];
    const missing: string[] = [];
    for (const page of pages) {
      const text = guideText(page);
      if (!text.includes('<<< @/../examples/new-api/factories.ts#')) missing.push(page);
      fencedBlocks(text).forEach((block) => {
        if (/useFactory:\s*true/.test(block)) inline.push(`${page}: ${block.split('\n').find((line) => /useFactory/.test(line))?.trim() ?? ''}`);
      });
    }
    expect(missing).toEqual([]);
    expect(inline).toEqual([]);
    const regions = [...readFileSync(path.join(examplesDir, 'factories.ts'), 'utf8').matchAll(/\/\/ #region ([\w-]+)/g)].map((match) => match[1] ?? '');
    const used = new Set<string>();
    for (const page of pages) {
      for (const match of guideText(page).matchAll(/factories\.ts#([\w-]+)/g)) used.add(match[1] ?? '');
    }
    expect([...used].filter((name) => !regions.includes(name))).toEqual([]);
  });

  it('T20-A01 the minimal profile does not offer override: the type says so', () => {
    const dir = scratchDir('t20-negative-');
    writeConsumer(dir, {
      'consumer.ts': [
        "import { defineBuilderConfig } from '@djodjonx/neosyringe';",
        'class Counter {}',
        "const lean = defineBuilderConfig({ runtime: { profile: 'minimal' }, injections: [{ token: Counter }] });",
        'lean.override(Counter, () => new Counter());',
        '',
      ].join('\n'),
      'expected-diagnostic.txt': "Property 'override' does not exist on type 'CoreContainer'",
    });
    const result = typecheck(dir, 'expected-diagnostic.txt');
    expect(result.status, result.output).toBe(0);
  });

  it('T20-A02 mock example: the consumer sees the mock, the parent-owned consumer keeps the real dependency', async () => {
    const value = await runExample('mock.ts', WITH_TEST_API);
    expect(value).toEqual({
      fromChild: 'fake',
      fromParent: 'real',
      seen: ['real', 'fake', 'real'],
      consumerRebuilt: true,
    });
  });

  it('T20-A02 the guides show the consumer assertion, not only resolve(Logger)', () => {
    const scoped = guideText('guide/scoped-injections.md');
    expect(scoped).toContain('<<< @/../examples/new-api/mock.ts');
    expect(scoped).toContain('parent-owned');
    expect(scoped).not.toContain('// UserService uses mocked dependencies');
    const why = guideText('guide/why-neo-syringe.md');
    expect(why).toContain('<<< @/../examples/new-api/mock.ts');
    expect(why).not.toContain('const userService = testContainer.resolve(UserService);');
  });

  it('T20-A03 async example: resolve before initialize fails with NEO_NOT_INITIALIZED, then works', async () => {
    const value = await runExample('async.ts', STRICT);
    expect(value).toMatchObject({
      endpoint: '/api',
      closed: true,
      disposed: 1,
    });
    const { beforeInit, afterDestroy } = value as { beforeInit: string; afterDestroy: string };
    expect(beforeInit.startsWith('NEO_NOT_INITIALIZED')).toBe(true);
    expect(afterDestroy.startsWith('NEO_CONTAINER_DESTROYED')).toBe(true);
  });

  it('T20-A03 no guide calls override or clearOverrides without await', () => {
    const offenders: string[] = [];
    for (const file of [path.join(repoRoot, 'README.md'), ...markdownFiles(docsDir)]) {
      const relative = path.relative(repoRoot, file);
      for (const block of fencedBlocks(readFileSync(file, 'utf8'))) {
        for (const line of block.split('\n')) {
          if (/\w\.(override|clearOverrides)\(/.test(line) && !/\bawait\b/.test(line)) offenders.push(`${relative}: ${line.trim()}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('T20-A03 the async guide initializes before the first resolve of each snippet', () => {
    const text = guideText('guide/async-factories.md');
    const blocks = fencedBlocks(text).filter((block) => /\.initialize\(/.test(block) && /\.resolve\(/.test(block));
    expect(blocks.length).toBeGreaterThan(0);
    const early = blocks.filter((block) => block.search(/\.resolve\(/) < block.search(/\.initialize\(/));
    expect(early).toEqual([]);
    expect(text).toContain('<<< @/../examples/new-api/async.ts');
  });

  it('T20-A04 closed example: unreachable provider absent, effect kept once, eager started once', async () => {
    const closedCode = await bundle(example('closed.ts'));
    expect(closedCode).not.toContain('NEO_T20_SENTINEL_UNREACHABLE');
    expect(closedCode).toContain('NEO_T20_SENTINEL_BANNER');
    expect(await runBundle(closedCode)).toEqual({ names: ['auth', 'log'], workerStarts: 1, bannerStamps: 1 });
  });

  it('T20-A04 the same container left open keeps every registration', async () => {
    const closed = "optimization: { mode: 'closed', roots: [pipeline], eager: [worker] },";
    const open = example('closed.ts').replace(closed, "optimization: { mode: 'open' },");
    expect(open).not.toBe(example('closed.ts'));
    const openCode = await bundle(open);
    expect(openCode).toContain('NEO_T20_SENTINEL_UNREACHABLE');
    expect(await runBundle(openCode)).toEqual({ names: ['auth', 'log'], workerStarts: 1, bannerStamps: 1 });
  });

  it('T20-A04 an open parent stays a boundary: its registrations stay, the closed child is pruned', async () => {
    const code = await bundle(example('closed-parent.ts'));
    expect(code).toContain('NEO_T20_SENTINEL_PARENT_ONLY');
    expect(code).not.toContain('NEO_T20_SENTINEL_CHILD_ONLY');
    expect(await runBundle(code)).toBe('eu');
  });

  it('T20-A04 the closed-mode guide does not promise to prune an open container', () => {
    const text = guideText('guide/closed-mode.md');
    expect(text).toContain('An open container keeps every registration');
    expect(text).not.toMatch(/removes? (the )?unused (registrations|providers)/i);
    expect(text).not.toMatch(/automatically (removes|prunes)/i);
    expect(text).toContain('<<< @/../examples/new-api/closed.ts');
    expect(text).toContain('<<< @/../examples/new-api/closed-parent.ts');
  });

  it('T20-NS015 no page promises zero overhead or a zero-byte runtime', () => {
    const offenders: string[] = [];
    const files = [path.join(repoRoot, 'README.md'), ...markdownFiles(docsDir), path.join(docsDir, '.vitepress/config.ts')];
    for (const file of files) {
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, index) => {
        if (/zero[- ](runtime )?overhead|~?\b0\s?KB\b|no runtime overhead|zero DI library/i.test(line)) {
          offenders.push(`${path.relative(repoRoot, file)}:${index + 1}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });

  it('T20-NS015 the profiles guide cites the measurement command, its date and its feature sets', () => {
    const text = guideText('guide/profiles.md');
    expect(text).toContain('node scripts/measure-t17-size.mjs');
    expect(text).toContain('2026-11-06');
    expect(text).toMatch(/different feature set/i);
  });

  it('T20-A05 build diagnostics carry the announced code', () => {
    const header = [
      "import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';",
      'function defineBuilderConfig(config: any) { return config; }',
      'function useInterface<T>(): any { return null; }',
      '',
    ].join('\n');
    const dir = scratchDir('t20-cli-');
    mkdirSync(path.join(dir, 'src'), { recursive: true });
    writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify({
      compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', strict: true, noEmit: true, lib: ['ES5'], types: [], skipLibCheck: true },
      include: ['src/**/*.ts'],
    }));
    const sources: Record<string, string> = {
      'factory-deps.ts': `${header}
        interface FdA { n: number }
        export const fd = defineBuilderConfig({ name: 'FactoryDeps', injections: [
          { token: useInterface<FdA>(), useFactory: true, provider: () => ({ n: 1 }) },
        ] });`,
      'async-transient.ts': `${header}
        interface AtA { n: number }
        export const at = defineBuilderConfig({ name: 'AsyncTransient', injections: [
          { token: useInterface<AtA>(), useFactory: true, dependencies: [], lifecycle: 'transient', provider: async () => ({ n: 1 }) },
        ] });`,
      'root-not-exported.ts': `${header}
        interface RnA { n: number } interface RnB { n: number }
        const rnA = useInterface<RnA>(); const rnB = useInterface<RnB>();
        export const rn = defineBuilderConfig({ name: 'RootNotExported', optimization: { mode: 'closed', roots: [rnB] }, injections: [
          { token: rnA, useFactory: true, dependencies: [], provider: () => ({ n: 1 }) },
          { token: rnB, useFactory: true, dependencies: [rnA], provider: (context: any) => ({ n: context.resolve(rnA).n }) },
        ] });
        rn.resolve(rnA);`,
      'config-unsupported.ts': `${header}
        class CuA {}
        declare function pickProfile(): 'full' | 'minimal';
        export const cu = defineBuilderConfig({ name: 'ConfigUnsupported', runtime: { profile: pickProfile() }, injections: [{ token: CuA }] });`,
      'multi-resolve.ts': `${header}
        interface MrA { n: number }
        const mrA = useInterface<MrA>();
        export const mr = defineBuilderConfig({ name: 'MultiResolve', injections: [
          { token: mrA, multi: true, useFactory: true, dependencies: [], provider: () => ({ n: 1 }) },
        ] });
        mr.resolve(mrA);`,
    };
    for (const [name, text] of Object.entries(sources)) writeFileSync(path.join(dir, 'src', name), text);
    const codes = cliCodes(dir);
    expect(codes).toEqual(expect.arrayContaining([
      'NEO_FACTORY_DEPENDENCIES_REQUIRED',
      'NEO_ASYNC_TRANSIENT',
      'NEO_ROOT_NOT_EXPORTED',
      'NEO_CONFIG_UNSUPPORTED',
      'NEO_MULTI_REQUIRES_RESOLVE_ALL',
    ]));
  });

  it('T20-A05 closed mode with validation compatible is refused with NEO_CLOSED_REQUIRES_STRICT', async () => {
    const source = [
      "import { defineBuilderConfig } from '@djodjonx/neosyringe';",
      'class Only {}',
      "export const c = defineBuilderConfig({ name: 'ClosedCompat', optimization: { mode: 'closed', roots: [Only] }, injections: [{ token: Only }] });",
      '',
    ].join('\n');
    const outcome = await executeCompatible(source, false);
    expect(outcome.phase).toBe('build');
    if (outcome.phase === 'build') expect(outcome.errors.join('\n')).toContain('NEO_CLOSED_REQUIRES_STRICT');
  });

  it('T20-A05 runtime refusals carry the announced code', async () => {
    const source = [
      "import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';",
      'interface Plugin { n: number }',
      'const plugin = useInterface<Plugin>();',
      "export const c = defineBuilderConfig({ name: 'Refusals', injections: [",
      '  { token: plugin, multi: true, useFactory: true, dependencies: [], provider: () => ({ n: 1 }) },',
      '] });',
      'function codeOf(error: unknown): string { return (error as { code?: string }).code ?? String(error); }',
      'export async function run() {',
      '  const out: Record<string, string> = {};',
      "  try { await c.override(plugin, () => ({ n: 2 })); } catch (error) { out.override = codeOf(error); }",
      '  return out;',
      '}',
      '',
    ].join('\n');
    const withoutTestApi = await executeFixture(source, STRICT);
    expect(withoutTestApi).toMatchObject({ phase: 'ok', value: { override: 'NEO_TEST_API_DISABLED' } });
    const withTestApi = await executeFixture(source, WITH_TEST_API);
    expect(withTestApi).toMatchObject({ phase: 'ok', value: { override: 'NEO_OVERRIDE_MULTI_UNSUPPORTED' } });
  });

  it('T20-A05 testOverrides is refused at build when NODE_ENV is production', async () => {
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const outcome = await executeFixture(example('mock.ts'), WITH_TEST_API);
      expect(outcome.phase).toBe('build');
      if (outcome.phase === 'build') expect(outcome.diagnostic).toContain('NEO_TEST_API_DISABLED');
    } finally {
      if (previous === undefined) Reflect.deleteProperty(process.env, 'NODE_ENV');
      else process.env.NODE_ENV = previous;
    }
  });

  it('T20-A05 the minimal profile has no override and no on at run time', async () => {
    const value = await runExample('profiles.ts', STRICT);
    expect(value).toEqual({
      sameInstance: true,
      fullHasOverride: 'function',
      fullHasOn: 'function',
      minimalHasOverride: 'undefined',
      minimalHasOn: 'undefined',
    });
  });

  it('T20 scopes example: isolated caches, owned connection closed once per scope, terminal destroy', async () => {
    const outcome = await executeFixture(example('scopes.ts'), COMPATIBLE_USAGE);
    expect(outcome).toMatchObject({ phase: 'ok' });
    if (outcome.phase !== 'ok') return;
    const value = outcome.value as { afterDestroy: string };
    expect(value).toMatchObject({
      isolated: true,
      stable: true,
      closedAfterFirst: 1,
      closedAfterSecondCall: 1,
      closedTotal: 2,
    });
    expect(value.afterDestroy.startsWith('NEO_CONTAINER_DESTROYED')).toBe(true);
  });

  it('T20 strict build reports resolve on a createScope() result as NEO_UNKNOWN_CONTAINER', async () => {
    const outcome = await executeFixture(example('scopes.ts'), STRICT);
    expect(outcome.phase).toBe('build');
    if (outcome.phase === 'build') expect(outcome.diagnostic).toContain('NEO_UNKNOWN_CONTAINER');
    const guide = guideText('guide/states-and-ownership.md');
    expect(guide).toContain('NEO_UNKNOWN_CONTAINER');
    expect(guide).toContain('<<< @/../examples/new-api/scopes.ts');
  });

  it('T20 error reference lists only codes the packages emit, with the plugin option that does not reach the transform', () => {
    const text = guideText('api/errors.md');
    const listed = new Set([...text.matchAll(/`(NEO_[A-Z_]+)`/g)].map((match) => match[1] ?? ''));
    expect(listed.size).toBeGreaterThan(15);
    const emitted = new Set<string>();
    for (const pkg of ['core', 'unplugin', 'cli', 'lsp', 'neosyringe']) {
      const srcDir = path.join(repoRoot, 'packages', pkg, 'src');
      if (!existsSync(srcDir)) continue;
      for (const file of sourceFiles(srcDir)) {
        for (const match of readFileSync(file, 'utf8').matchAll(/NEO_[A-Z_]+/g)) emitted.add(match[0]);
      }
    }
    const unknown = [...listed].filter((code) => !emitted.has(code));
    expect(unknown).toEqual([]);
    expect(text).toMatch(/NEO_IMPORT_UNRESOLVED[^\n]*(not emitted|not raised|reserved)/i);
  });
});

const HEADER = "import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';\n";

function codeOfError(): string {
  return 'function codeOf(error: unknown): string { return (error as { code?: string }).code ?? String(error); }';
}

async function runInline(body: string, options: BuildOptions): Promise<unknown> {
  const outcome = await executeFixture(`${HEADER}${codeOfError()}\n${body}`, options);
  expect(outcome, JSON.stringify(outcome)).toMatchObject({ phase: 'ok' });
  return outcome.phase === 'ok' ? outcome.value : undefined;
}

describe('T20 states and ownership', () => {
  it('a rejected initialize keeps its error, resolve is NEO_CONTAINER_FAILED, destroy then ends it', async () => {
    const value = await runInline(`
      interface V { n: number }
      const v = useInterface<V>();
      export const c = defineBuilderConfig({ name: 'Failing', injections: [
        { token: v, useFactory: true, dependencies: [], provider: async () => { throw new Error('boom'); } },
      ] });
      export async function run() {
        const out: Record<string, string> = {};
        try { await c.initialize(); } catch (error) { out.first = (error as Error).message; }
        try { await c.initialize(); } catch (error) { out.again = (error as Error).message; }
        try { c.resolve(v); } catch (error) { out.resolve = codeOf(error); }
        await c.destroy();
        try { c.resolve(v); } catch (error) { out.destroyed = codeOf(error); }
        return out;
      }`, STRICT);
    expect(value).toEqual({ first: 'boom', again: 'boom', resolve: 'NEO_CONTAINER_FAILED', destroyed: 'NEO_CONTAINER_DESTROYED' });
  });

  it('a factory may resolve only what it declares, and only while it runs', async () => {
    const value = await runInline(`
      interface A { n: number } interface B { n: number } interface L { late: () => number }
      const a = useInterface<A>(); const b = useInterface<B>(); const l = useInterface<L>();
      function helper(context: { resolve: (token: unknown) => unknown }, token: unknown): unknown { return context.resolve(token); }
      export const c = defineBuilderConfig({ name: 'Declared', injections: [
        { token: a, useFactory: true, dependencies: [], provider: () => ({ n: 1 }) },
        { token: b, useFactory: true, dependencies: [], provider: (context) => ({ n: (helper(context as never, a) as A).n }) },
        { token: l, useFactory: true, dependencies: [a], provider: (context) => ({ late: () => context.resolve(a).n }) },
      ] });
      export function run() {
        const out: Record<string, string> = {};
        try { c.resolve(b); } catch (error) { out.undeclared = codeOf(error); }
        const held = c.resolve(l);
        try { held.late(); } catch (error) { out.expired = codeOf(error); }
        return out;
      }`, STRICT);
    expect(value).toEqual({ undeclared: 'NEO_UNDECLARED_FACTORY_DEP', expired: 'NEO_FACTORY_CONTEXT_EXPIRED' });
  });

  it('borrowed values and borrowed factory results are not disposed, an owned class is', async () => {
    const value = await runInline(`
      interface V { dispose(): void }
      interface W { dispose(): void }
      class Owned { static closed = 0; dispose(): void { Owned.closed += 1; } }
      const v = useInterface<V>(); const w = useInterface<W>();
      let borrowedCloses = 0;
      const shared = { dispose() { borrowedCloses += 1; } };
      export const c = defineBuilderConfig({ name: 'Owners', injections: [
        { token: v, useValue: { dispose() { borrowedCloses += 1; } } },
        { token: w, useFactory: true, dependencies: [], ownership: 'borrowed', provider: () => shared },
        { token: Owned },
      ] });
      export async function run() {
        c.resolve(v); c.resolve(w); c.resolve(Owned);
        await c.destroy();
        return { borrowedCloses, owned: Owned.closed };
      }`, STRICT);
    expect(value).toEqual({ borrowedCloses: 0, owned: 1 });
  });

  it('useValue cannot be declared owned: NEO_CONFIG_UNSUPPORTED', async () => {
    const outcome = await executeFixture(`${HEADER}
      interface V { n: number }
      const v = useInterface<V>();
      export const c = defineBuilderConfig({ name: 'OwnedValue', injections: [{ token: v, useValue: { n: 1 }, ownership: 'owned' }] });
      export function run() { return c.resolve(v).n; }`, STRICT);
    expect(outcome.phase).toBe('build');
    if (outcome.phase === 'build') expect(outcome.diagnostic).toContain('NEO_CONFIG_UNSUPPORTED');
  });

  it('a disposable transient injected into a singleton is built, not refused, and not closed', async () => {
    const value = await runInline(`
      class Conn { static closed = 0; dispose(): void { Conn.closed += 1; } }
      class Svc { constructor(readonly conn: Conn) {} }
      export const c = defineBuilderConfig({ name: 'Transient', injections: [{ token: Conn, lifecycle: 'transient' }, { token: Svc }] });
      export async function run() {
        const svc = c.resolve(Svc);
        await c.destroy();
        return { built: svc.conn instanceof Conn, closed: Conn.closed };
      }`, STRICT);
    expect(value).toEqual({ built: true, closed: 0 });
  });

  it('a child that needs a destroyed parent throws NEO_SCOPE_PARENT_DESTROYED, cached services included', async () => {
    const value = await runInline(`
      class Logger { name(): string { return 'p'; } }
      class Child { constructor(readonly logger: Logger) {} }
      export const parent = defineBuilderConfig({ name: 'P', injections: [{ token: Logger }] });
      export const child = defineBuilderConfig({ name: 'C', useContainer: parent, injections: [
        { token: Child, useFactory: true, dependencies: [Logger], provider: (context) => new Child(context.resolve(Logger)) },
      ] });
      export async function run() {
        const out: Record<string, unknown> = {};
        out.sameLogger = child.resolve(Child).logger === parent.resolve(Logger);
        await parent.destroy();
        try { child.resolve(Logger); } catch (error) { out.delegated = codeOf(error); }
        try { child.resolve(Child); } catch (error) { out.cached = codeOf(error); }
        return out;
      }`, STRICT);
    expect(value).toEqual({ sameLogger: true, delegated: 'NEO_SCOPE_PARENT_DESTROYED', cached: 'NEO_SCOPE_PARENT_DESTROYED' });
  });

  it('scopes share a useValue by reference, evaluate it once, and cannot be created after destroy', async () => {
    const value = await runInline(`
      interface V { n: number }
      const v = useInterface<V>();
      let evaluations = 0;
      function make(): V { evaluations += 1; return { n: evaluations }; }
      export const c = defineBuilderConfig({ name: 'Shared', injections: [{ token: v, useValue: make() }] });
      export async function run() {
        const first = c.createScope();
        const second = c.createScope();
        const same = first.resolve(v) === second.resolve(v);
        await c.destroy();
        let afterDestroy = 'no error';
        try { c.createScope(); } catch (error) { afterDestroy = codeOf(error); }
        return { same, evaluations, afterDestroy };
      }`, COMPATIBLE_USAGE);
    expect(value).toEqual({ same: true, evaluations: 1, afterDestroy: 'NEO_CONTAINER_DESTROYED' });
  });

  it('a child of an async parent: resolve before initialize fails, child.initialize() readies the parent too', async () => {
    const value = await runInline(`
      interface Db { ready: boolean }
      const db = useInterface<Db>();
      class Repo { constructor(readonly db: Db) {} }
      export const parent = defineBuilderConfig({ name: 'AsyncParent', injections: [
        { token: db, useFactory: true, dependencies: [], provider: async () => ({ ready: true }) },
      ] });
      export const child = defineBuilderConfig({ name: 'SyncChild', useContainer: parent, injections: [
        { token: Repo, useFactory: true, dependencies: [db], provider: (context) => new Repo(context.resolve(db)) },
      ] });
      export async function run() {
        let early = 'no error';
        try { child.resolve(Repo); } catch (error) { early = codeOf(error); }
        await child.initialize();
        return { early, ready: child.resolve(Repo).db.ready };
      }`, STRICT);
    expect(value).toEqual({ early: 'NEO_NOT_INITIALIZED', ready: true });
  });

  it('concurrent initialize calls run a factory once; an override of an async token needs initialize again', async () => {
    const value = await runInline(`
      interface Db { id: string }
      const db = useInterface<Db>();
      let starts = 0;
      export const c = defineBuilderConfig({ name: 'AsyncOverride', injections: [
        { token: db, useFactory: true, dependencies: [], provider: async () => { starts += 1; return { id: 'real' }; } },
      ] });
      export async function run() {
        await Promise.all([c.initialize(), c.initialize()]);
        const out: Record<string, unknown> = { starts, real: c.resolve(db).id };
        await c.override(db, () => ({ id: 'fake' }));
        await c.initialize();
        out.fake = c.resolve(db).id;
        await c.clearOverrides();
        await c.initialize();
        out.restored = c.resolve(db).id;
        out.startsAfterRestore = starts;
        return out;
      }`, WITH_TEST_API);
    expect(value).toEqual({ starts: 1, real: 'real', fake: 'fake', restored: 'real', startsAfterRestore: 2 });
  });

  it('on(resolve) fires for cache hits and stops after unsubscribe', async () => {
    const value = await runInline(`
      class Logger {}
      class Other {}
      export const c = defineBuilderConfig({ name: 'Events', injections: [{ token: Logger }, { token: Other }] });
      export function run() {
        const seen: string[] = [];
        const off = c.on('resolve', (_token, instance) => { seen.push((instance as object).constructor.name); });
        c.resolve(Logger); c.resolve(Logger); c.resolve(Other);
        off();
        c.resolve(Other);
        return seen;
      }`, STRICT);
    expect(value).toEqual(['Logger', 'Logger', 'Other']);
  });
});

const ATTEMPT = `async function attempt(action: () => unknown): Promise<string> {
  try { await action(); return 'no error'; } catch (error) { return codeOf(error); }
}`;

describe('T20 failed initialize, busy states, captured containers, closed overrides', () => {
  function failing(secondDispose: string): string {
    return `
    const order: string[] = [];
    class First { dispose(): void { order.push('First'); } }
    class Second { constructor(readonly first: First) {} dispose(): void { order.push('Second'); ${secondDispose} } }
    interface Late { n: number }
    const late = useInterface<Late>();
    export const c = defineBuilderConfig({ name: 'Rollback', injections: [
      { token: First },
      { token: Second },
      { token: late, useFactory: true, dependencies: [Second], provider: async (context) => { context.resolve(Second); throw new Error('boom'); } },
    ] });`;
  }

  it('a failed initialize disposes the instances it built in reverse order and rejects with the factory error itself', async () => {
    const value = await runInline(`${failing('')}
      ${ATTEMPT}
      export async function run() {
        let first: unknown;
        let again: unknown;
        try { await c.initialize(); } catch (error) { first = error; }
        try { await c.initialize(); } catch (error) { again = error; }
        const out = {
          order: [...order],
          message: (first as Error).message,
          hasCause: 'cause' in (first as object),
          hasCleanupErrors: 'cleanupErrors' in (first as object),
          sameErrorAgain: first === again,
          resolve: await attempt(() => c.resolve(late)),
          createScope: await attempt(() => c.createScope()),
        };
        await c.destroy();
        return out;
      }`, STRICT);
    expect(value).toEqual({
      order: ['Second', 'First'],
      message: 'boom',
      hasCause: false,
      hasCleanupErrors: false,
      sameErrorAgain: true,
      resolve: 'NEO_CONTAINER_FAILED',
      createScope: 'NEO_CONTAINER_FAILED',
    });
  });

  it('when a dispose throws during the rollback, initialize rejects with a wrapper that has cause and cleanupErrors', async () => {
    const value = await runInline(`${failing("throw new Error('cleanup-failed');")}
      export async function run() {
        let first: unknown;
        let again: unknown;
        try { await c.initialize(); } catch (error) { first = error; }
        try { await c.initialize(); } catch (error) { again = error; }
        const wrapper = first as Error & { cause?: Error; cleanupErrors?: Error[] };
        const out = {
          order: [...order],
          message: wrapper.message,
          cause: wrapper.cause?.message,
          cleanupErrors: (wrapper.cleanupErrors ?? []).map((error) => error.message),
          sameErrorAgain: first === again,
        };
        await c.destroy();
        return out;
      }`, STRICT);
    expect(value).toEqual({
      order: ['Second', 'First'],
      message: 'boom',
      cause: 'boom',
      cleanupErrors: ['cleanup-failed'],
      sameErrorAgain: true,
    });
  });

  it('a root that never ran initialize still gives scopes after a scope failed; the failed container does not', async () => {
    const value = await runInline(`
      interface Late { n: number }
      const late = useInterface<Late>();
      let attempts = 0;
      export const root = defineBuilderConfig({ name: 'RetryRoot', injections: [
        { token: late, useFactory: true, dependencies: [], provider: async () => { attempts += 1; if (attempts === 1) throw new Error('first attempt'); return { n: attempts }; } },
      ] });
      ${ATTEMPT}
      export async function run() {
        const failed = root.createScope();
        const out: Record<string, unknown> = {};
        out.failed = await attempt(() => failed.initialize());
        out.failedScopeResolve = await attempt(() => failed.resolve(late));
        out.failedScopeCreateScope = await attempt(() => failed.createScope());
        const retry = root.createScope();
        await retry.initialize();
        out.retry = retry.resolve(late).n;
        await failed.destroy();
        await retry.destroy();
        await root.destroy();
        return out;
      }`, COMPATIBLE_USAGE);
    expect(value).toEqual({
      failed: 'Error: first attempt',
      failedScopeResolve: 'NEO_CONTAINER_FAILED',
      failedScopeCreateScope: 'NEO_CONTAINER_FAILED',
      retry: 2,
    });
  });

  it('during a reconfiguration every other operation of the container is refused with NEO_CONTAINER_BUSY', async () => {
    const value = await runInline(`
      interface Db { id: string; dispose(): Promise<void> }
      const db = useInterface<Db>();
      class Res { async dispose(): Promise<void> { await Promise.resolve(); } }
      export const asyncC = defineBuilderConfig({ name: 'BusyAsync', injections: [
        { token: db, useFactory: true, dependencies: [], provider: async () => ({ id: 'real', dispose: async () => { await Promise.resolve(); } }) },
      ] });
      export const syncC = defineBuilderConfig({ name: 'BusySync', injections: [{ token: Res }] });
      // Every call starts in the same tick, while the reconfiguration is still closing the old instance.
      function probe(action: () => unknown): Promise<string> {
        try { return Promise.resolve(action()).then(() => 'no error', (error) => codeOf(error)); } catch (error) { return Promise.resolve(codeOf(error)); }
      }
      export async function run() {
        await asyncC.initialize();
        asyncC.resolve(db);
        const asyncPending = asyncC.override(db, () => ({ id: 'fake', dispose: async () => {} }));
        const asyncDuring = await Promise.all([
          probe(() => asyncC.resolve(db)),
          probe(() => asyncC.initialize()),
          probe(() => asyncC.destroy()),
          probe(() => asyncC.createScope()),
          probe(() => asyncC.override(db, () => ({ id: 'other', dispose: async () => {} }))),
          probe(() => asyncC.clearOverrides()),
        ]);
        await asyncPending;
        await asyncC.destroy();

        syncC.resolve(Res);
        const syncPending = syncC.override(Res, () => new Res());
        const syncDuring = await Promise.all([
          probe(() => syncC.resolve(Res)),
          probe(() => syncC.initialize()),
          probe(() => syncC.destroy()),
          probe(() => syncC.createScope()),
          probe(() => syncC.override(Res, () => new Res())),
          probe(() => syncC.clearOverrides()),
        ]);
        await syncPending;
        await syncC.destroy();
        return { asyncDuring, syncDuring };
      }`, WITH_TEST_API);
    // resolve, initialize, destroy, createScope, override, clearOverrides
    const busy = Array(6).fill('NEO_CONTAINER_BUSY');
    expect(value).toEqual({ asyncDuring: busy, syncDuring: busy });
  });

  it('while initialize is still running override, clearOverrides and createScope are BUSY and resolve is NOT_INITIALIZED', async () => {
    const value = await runInline(`
      interface Db { id: string }
      const db = useInterface<Db>();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      export const c = defineBuilderConfig({ name: 'BusyInit', injections: [
        { token: db, useFactory: true, dependencies: [], provider: async () => { await gate; return { id: 'real' }; } },
      ] });
      ${ATTEMPT}
      export async function run() {
        const starting = c.initialize();
        const during = {
          resolve: await attempt(() => c.resolve(db)),
          override: await attempt(() => c.override(db, () => ({ id: 'fake' }))),
          clearOverrides: await attempt(() => c.clearOverrides()),
          createScope: await attempt(() => c.createScope()),
        };
        release();
        await starting;
        await c.destroy();
        return during;
      }`, WITH_TEST_API);
    expect(value).toEqual({
      resolve: 'NEO_NOT_INITIALIZED',
      override: 'NEO_CONTAINER_BUSY',
      clearOverrides: 'NEO_CONTAINER_BUSY',
      createScope: 'NEO_CONTAINER_BUSY',
    });
  });

  it('a factory that resolves a captured container directly fails the build with NEO_UNDECLARED_FACTORY_DEP', async () => {
    const outcome = await executeFixture(`${HEADER}
      class Dep { value = 1; }
      export const other = defineBuilderConfig({ name: 'Other', injections: [{ token: Dep }] });
      interface V { n: number }
      const v = useInterface<V>();
      export const c = defineBuilderConfig({ name: 'Direct', injections: [
        { token: v, useFactory: true, dependencies: [], provider: () => ({ n: other.resolve(Dep).value }) },
      ] });
      export async function run() { const n = c.resolve(v).n; await c.destroy(); await other.destroy(); return n; }`, STRICT);
    expect(outcome.phase).toBe('build');
    if (outcome.phase === 'build') {
      expect(outcome.diagnostic).toContain('NEO_UNDECLARED_FACTORY_DEP');
      expect(outcome.diagnostic).toContain('resolves a captured container instead of its context');
    }
  });

  it('a captured container reached through a helper is not seen by the build', async () => {
    const value = await runInline(`
      class Dep { value = 1; }
      export const other = defineBuilderConfig({ name: 'Other', injections: [{ token: Dep }] });
      function viaHelper(): Dep { return other.resolve(Dep); }
      interface V { n: number }
      const v = useInterface<V>();
      export const c = defineBuilderConfig({ name: 'Indirect', injections: [
        { token: v, useFactory: true, dependencies: [], provider: () => ({ n: viaHelper().value }) },
      ] });
      export async function run() { const n = c.resolve(v).n; await c.destroy(); await other.destroy(); return n; }`, STRICT);
    expect(value).toBe(1);
  });

  it('a missing constructor dependency is reported with the real message, not an invented one', async () => {
    const outcome = await executeFixture(`${HEADER}
      interface ILogger { log(message: string): void }
      class UserService { constructor(readonly logger: ILogger) {} }
      export const c = defineBuilderConfig({ name: 'Missing', injections: [{ token: UserService }] });
      export function run() { return c.resolve(UserService); }`, STRICT);
    expect(outcome.phase).toBe('build');
    if (outcome.phase === 'build') {
      expect(outcome.diagnostic).toContain("Missing injection: 'ILogger' required by 'UserService' is not registered.");
    }
  });

  it('in a closed container override accepts a token that is not a root, and one that was pruned', async () => {
    const value = await runInline(`
      class Database { label(): string { return 'real'; } }
      class FakeDatabase extends Database { label(): string { return 'fake'; } }
      class Report { constructor(readonly db: Database) {} summary(): string { return this.db.label(); } }
      class Unused { label(): string { return 'unused'; } }
      export const c = defineBuilderConfig({
        name: 'ClosedOverride',
        optimization: { mode: 'closed', roots: [Report] },
        injections: [{ token: Database }, { token: Report }, { token: Unused }],
      });
      ${ATTEMPT}
      export async function run() {
        const nonRoot = await attempt(() => c.override(Database, () => new FakeDatabase()));
        const seen = c.resolve(Report).summary();
        const pruned = await attempt(() => c.override(Unused, () => new Unused()));
        await c.clearOverrides();
        const restored = c.resolve(Report).summary();
        await c.destroy();
        return { nonRoot, seen, pruned, restored };
      }`, WITH_TEST_API);
    expect(value).toEqual({ nonRoot: 'no error', seen: 'fake', pruned: 'no error', restored: 'real' });
  });
});

describe('T20 guide claims that round 1 got wrong', () => {
  it('the failure rules name the rollback, the wrapper, and createScope() on a failed container', () => {
    for (const page of ['guide/async-factories.md', 'guide/states-and-ownership.md']) {
      const text = guideText(page);
      expect(text, page).toContain('cleanupErrors');
      expect(text, page).toContain('`createScope()` throws `NEO_CONTAINER_FAILED`');
      expect(text, page).toContain('reverse order');
      expect(text, page).not.toMatch(/create a new scope with/i);
      expect(text, page).not.toMatch(/To try again, create a new scope/i);
      expect(text, page).not.toContain('rejection is the factory\'s own error');
    }
  });

  it('the missing provider example quotes the message the build prints', () => {
    const text = guideText('guide/why-neo-syringe.md');
    expect(text).toContain("Missing injection: 'ILogger' required by 'UserService' is not registered.");
    expect(text).not.toContain('is required by UserService and is not registered');
  });

  it('the factory rules say a direct resolve on a captured container fails the build, and only indirect access is out of reach', () => {
    const states = guideText('guide/states-and-ownership.md');
    expect(states).toMatch(/captured container[^\n]*`NEO_UNDECLARED_FACTORY_DEP`|`NEO_UNDECLARED_FACTORY_DEP`[^\n]*captured container/);
    expect(states).toMatch(/helper/);
    expect(states).not.toContain('is outside what the analysis can see');
    const errors = guideText('api/errors.md');
    expect(errors).toMatch(/NEO_UNDECLARED_FACTORY_DEP[^\n]*captured container/);
  });

  it('no page, except the sourced alternatives page, states how other DI libraries work', () => {
    const offenders: string[] = [];
    const files = [path.join(repoRoot, 'README.md'), ...markdownFiles(docsDir)].filter((file) => !file.endsWith('alternatives.md'));
    for (const file of files) {
      readFileSync(file, 'utf8').split('\n').forEach((line, index) => {
        if (/(inversify|tsyringe|awilix|nestjs)/i.test(line) && /(decorator|reflect-metadata|erased|erasure|runtime resolution|work the same|all work)/i.test(line)) {
          offenders.push(`${path.relative(repoRoot, file)}:${index + 1}`);
        }
      });
    }
    expect(offenders).toEqual([]);
    const what = guideText('guide/what-is-neo-syringe.md');
    expect(what).not.toContain('Traditional DI containers (InversifyJS, tsyringe, Awilix)');
    expect(guideText('index.md')).not.toContain('Traditional DI containers like InversifyJS and tsyringe');
  });

  it('a closed container is documented as accepting override of a token that is not a root', () => {
    const text = guideText('guide/closed-mode.md');
    expect(text).toMatch(/override\(\)[^\n]*not a root[^\n]*accept/i);
    expect(text).toMatch(/unlike the plan|differs from the plan|the plan (for the next major )?asked for a refusal/i);
  });

  it('the busy row of the error reference and the state table list what the source refuses', () => {
    const errors = guideText('api/errors.md');
    const row = errors.split('\n').find((line) => line.includes('`NEO_CONTAINER_BUSY`')) ?? '';
    expect(row).toContain('`resolve`, `initialize`, `destroy`, `createScope`, `override` and `clearOverrides` during a reconfiguration');
    expect(row).toContain('`override`, `clearOverrides` and `createScope` also while `initialize()` is running');
    expect(guideText('guide/states-and-ownership.md')).not.toContain('Not checked here');
  });

  it('the alternatives page cites where the undeclared token boundary is reported', () => {
    const text = guideText('guide/alternatives.md');
    expect(text).not.toContain('generator/tokensManifest.ts:251');
    expect(text).toContain('packages/core/src/analyzer/shared/tokensManifest.ts:66');
    expect(text).toContain('packages/core/src/analyzer/collectors/ConfigCollector.ts:433');
  });

  it('the migration table does not tell you to create a scope after destroy', () => {
    const text = guideText('guide/migration.md');
    const row = text.split('\n').find((line) => line.includes('createScope')) ?? '';
    expect(row).not.toContain('Create a new scope');
    expect(row).toContain('keep alive');
  });
});
