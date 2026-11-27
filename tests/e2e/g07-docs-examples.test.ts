import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertNoUnsafeTypes } from '../../scripts/ci/lib/no-unsafe-types.mjs';
import { executeFixture } from './helpers/execute-fixture';

// G07 stage G: the compiled examples of the new API run, typecheck without a user cast, and the guides say what the
// build does. Needs a fresh `pnpm build` (executeFixture checks it). Nothing here reads a clock.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const examplesDir = path.join(repoRoot, 'examples/new-api');
const docsDir = path.join(repoRoot, 'docs');
const expectedFile = path.join(repoRoot, 'tests/e2e/fixtures/g07-examples.expected.json');
const pluginRequire = createRequire(path.join(repoRoot, 'packages/unplugin/package.json'));

// One name per example file. scripts/ci/consumer-dist.mjs reads the same names from the expected file.
const EXAMPLES = ['resolve-many', 'scope-inputs', 'alias', 'signal', 'disposal', 'usage-recipes'] as const;

// Page, example file, region the page includes: every include of the six examples, none left unchecked.
const INCLUDES = [
  ['guide/basic-usage.md', 'resolve-many.ts', 'container'],
  ['guide/basic-usage.md', 'resolve-many.ts', 'resolve-many'],
  ['guide/states-and-ownership.md', 'scope-inputs.ts', 'container'],
  ['guide/states-and-ownership.md', 'scope-inputs.ts', 'scopes'],
  ['guide/aliases.md', 'alias.ts', 'container'],
  ['guide/aliases.md', 'alias.ts', 'reads'],
  ['guide/async-factories.md', 'signal.ts', 'container'],
  ['guide/async-factories.md', 'signal.ts', 'cancel'],
  ['guide/disposable.md', 'disposal.ts', 'container'],
  ['guide/disposable.md', 'disposal.ts', 'destroy'],
] as const;

const scratch: string[] = [];

function scratchDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}

function examplePath(name: string): string {
  return path.join(examplesDir, `${name}.ts`);
}

function exampleText(name: string): string {
  const full = examplePath(name);
  expect(existsSync(full), `missing examples/new-api/${name}.ts`).toBe(true);
  return existsSync(full) ? readFileSync(full, 'utf8') : '';
}

function textOf(file: string): string {
  expect(existsSync(file), `missing ${path.relative(repoRoot, file)}`).toBe(true);
  return existsSync(file) ? readFileSync(file, 'utf8') : '';
}

function expectedValues(): Record<string, unknown> {
  return JSON.parse(textOf(expectedFile)) as Record<string, unknown>;
}

function fencedBlocks(markdown: string): string[] {
  return [...markdown.matchAll(/```[^\n]*\n([\s\S]*?)```/g)].map((match) => match[1] ?? '');
}

function markdownFiles(dir: string, skip: readonly string[] = []): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.vitepress' || entry.name === 'node_modules' || skip.includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...markdownFiles(full, skip));
    else if (entry.name.endsWith('.md')) found.push(full);
  }
  return found;
}

/** Cast and assertion nodes of a source, `as const` excepted: a consumer example has none. */
function userCasts(source: string, name: string): string[] {
  const file = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isAsExpression(node) && !(ts.isTypeReferenceNode(node.type) && node.type.typeName.getText(file) === 'const')) {
      found.push(`as at ${node.getStart(file)}`);
    }
    if (ts.isTypeAssertionExpression(node)) found.push(`assertion at ${node.getStart(file)}`);
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

function typecheck(dir: string): { status: number | null; output: string } {
  const result = spawnSync(process.execPath, [path.join(repoRoot, 'scripts/ci/consumer-types.mjs'), dir], { cwd: repoRoot, encoding: 'utf8' });
  return { status: result.status, output: `${result.stdout}\n${result.stderr}` };
}

describe('G07 compiled examples', () => {
  beforeAll(() => {
    expect(existsSync(path.join(repoRoot, 'packages/cli/dist/index.mjs')), 'run pnpm build').toBe(true);
  });

  afterAll(() => {
    for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
    scratch.length = 0;
  });

  it('G07-P9 the expected file names exactly the six examples', () => {
    expect(Object.keys(expectedValues()).sort()).toEqual([...EXAMPLES].sort());
  });

  it.each(EXAMPLES)('G07-P9 %s typechecks against the built package, with no user cast', (name) => {
    const text = exampleText(name);
    const dir = scratchDir(`g07-types-${name}-`);
    const syringe = path.join(repoRoot, 'packages/neosyringe').replace(/\\/g, '/');
    writeFileSync(path.join(dir, `${name}.ts`), text);
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
      files: [`${name}.ts`],
    }));

    expect(() => assertNoUnsafeTypes(ts, text, `${name}.ts`)).not.toThrow();
    expect(userCasts(text, `${name}.ts`)).toEqual([]);
    const result = typecheck(dir);
    expect(result.status, result.output).toBe(0);
  });

  it.each(EXAMPLES)('G07-P9 %s builds in strict mode and returns the pinned value', async (name) => {
    const expected = expectedValues()[name];
    const outcome = await executeFixture(exampleText(name), { validation: 'strict' });

    expect(outcome, `${name}: ${JSON.stringify(outcome)}`).toMatchObject({ phase: 'ok' });
    expect(outcome.phase === 'ok' ? outcome.value : undefined).toEqual(expected);
  });
});

describe('G07 guides', () => {
  it.each(INCLUDES)('G07-P11 %s includes %s#%s from the example, not a copy', (page, file, region) => {
    const text = textOf(path.join(docsDir, page));
    const source = exampleText(file.replace(/\.ts$/, ''));

    expect(text).toContain(`<<< @/../examples/new-api/${file}#${region}`);
    expect(source).toContain(`// #region ${region}`);
    expect(source).toContain(`// #endregion ${region}`);
  });

  it('G07-P11 the guides include no region of these examples beyond the rows above', () => {
    const found: string[] = [];
    for (const file of markdownFiles(docsDir, ['benchmarks'])) {
      const page = path.relative(docsDir, file).split(path.sep).join('/');
      for (const match of textOf(file).matchAll(/<<< @\/\.\.\/examples\/new-api\/(resolve-many|scope-inputs|alias|signal|disposal|usage-recipes)\.ts#([\w-]+)/g)) {
        found.push(`${page} ${match[1]}.ts#${match[2]}`);
      }
    }

    expect(found.sort()).toEqual(INCLUDES.map(([page, file, region]) => `${page} ${file}#${region}`).sort());
  });

  it('G07-P11 the guides state the full / minimal difference and that an async scope must be initialized', () => {
    const profiles = textOf(path.join(docsDir, 'guide/profiles.md'));
    const states = textOf(path.join(docsDir, 'guide/states-and-ownership.md'));
    const asyncGuide = textOf(path.join(docsDir, 'guide/async-factories.md'));

    expect(profiles).toMatch(/\| `minimal` \(opt-in\) \| `CoreContainer` \|/);
    expect(profiles).toMatch(/`override`, `overrideMany` and `on` are \*\*absent from the minimal type\*\*/);
    expect(states).toMatch(/await scope\.initialize\(\);\s+\/\/ only needed when the graph has async work/);
    expect(states).toContain('NEO_NOT_INITIALIZED');
    expect(asyncGuide).toMatch(/needs `await child\.initialize\(\)` too/);
  });

  it('G07-P12 no page promises real-time, instant, blazing, zero-cost or negligible behaviour', () => {
    const files = [
      path.join(repoRoot, 'README.md'),
      ...markdownFiles(docsDir, ['benchmarks']),
      ...readdirSync(path.join(repoRoot, 'packages'), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => path.join(repoRoot, 'packages', entry.name, 'README.md'))
        .filter((file) => existsSync(file)),
    ];
    const offenders: string[] = [];
    for (const file of files) {
      readFileSync(file, 'utf8').split('\n').forEach((line, index) => {
        if (/real-?time|\binstant(ly)?\b|blazing|zero-cost|negligible/i.test(line)) {
          offenders.push(`${path.relative(repoRoot, file)}:${index + 1}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });

  it('G07-P12 a time figure outside the benchmark pages and the profiles guide cites a benchmark page', () => {
    const files = [
      path.join(repoRoot, 'README.md'),
      ...markdownFiles(path.join(docsDir, 'guide')).filter((file) => !file.endsWith('profiles.md')),
      ...markdownFiles(path.join(docsDir, 'api')),
      path.join(docsDir, 'index.md'),
    ];
    const offenders: string[] = [];
    for (const file of files) {
      readFileSync(file, 'utf8').split('\n').forEach((line, index) => {
        if (/\b\d+(\.\d+)? ?(ms|µs|us)\b/.test(line) && !/benchmarks\//.test(line)) {
          offenders.push(`${path.relative(repoRoot, file)}:${index + 1}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });

  it('G07-P12 the IDE pages link the measured metrics instead of promising latency', () => {
    const ide = textOf(path.join(docsDir, 'guide/ide-plugin.md'));
    const index = textOf(path.join(docsDir, 'index.md'));

    expect(ide).toContain('benchmarks/G04-incremental-session');
    expect(index).toContain('same analysis as the build');
  });
});

describe('G07 immediate corrections', () => {
  it('G07-P13 the webpack snippets call neoSyringePlugin.webpack, which is what the built package exports', () => {
    const plugin: { webpack?: unknown; neoSyringePlugin?: { webpack?: unknown } } = pluginRequire('./dist/index.cjs');
    const pages = [path.join(repoRoot, 'README.md'), path.join(docsDir, 'guide/getting-started.md')];

    expect(plugin.webpack).toBeUndefined();
    expect(typeof plugin.neoSyringePlugin?.webpack).toBe('function');
    for (const page of pages) {
      const webpackBlocks = fencedBlocks(textOf(page)).filter((block) => /\.webpack\(/.test(block));
      expect(webpackBlocks.length, path.relative(repoRoot, page)).toBeGreaterThan(0);
      for (const block of webpackBlocks) {
        expect(block, path.relative(repoRoot, page)).toContain('neoSyringePlugin.webpack(');
        expect(block, path.relative(repoRoot, page)).not.toMatch(/require\(['"]@djodjonx\/neosyringe-plugin['"]\)\.webpack/);
      }
    }
  });

  it('G07-P13 every inline useFactory in USAGE.md lists its dependencies', () => {
    const usage = textOf(path.join(repoRoot, 'packages/neosyringe/USAGE.md'));
    const offenders = usage.split('\n').flatMap((line, index) => (
      /useFactory: true/.test(line) && !/dependencies/.test(line) ? [`USAGE.md:${index + 1}`] : []
    ));

    expect(offenders).toEqual([]);
  });

  it('G07-P13 the debug option is documented as off by default, as DebugConfig decides', () => {
    const generator: { resolveDebugFlag: (explicit: boolean | undefined) => boolean } = pluginRequire('@djodjonx/neosyringe-core/generator');
    const declaration = textOf(path.join(repoRoot, 'packages/unplugin/dist/index.d.mts'));
    const debugEnd = declaration.indexOf('debug?: boolean');
    const debugDoc = declaration.slice(declaration.lastIndexOf('/**', debugEnd), debugEnd);
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = 'development';
    try {
      expect(generator.resolveDebugFlag(undefined)).toBe(false);
    } finally {
      if (previous === undefined) Reflect.deleteProperty(process.env, 'NODE_ENV');
      else process.env.NODE_ENV = previous;
    }
    expect(debugDoc).not.toMatch(/Defaults to `true`/);
    expect(debugDoc).toMatch(/Defaults to `false`/);
  });
});
