import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import ts from 'typescript';
import { Analyzer } from '../../packages/core/src/analyzer/Analyzer';
import type { DependencyGraph } from '../../packages/core/src/analyzer/types';
import { createFastProgram } from '../../packages/core/tests/fastProgram';

const pluginRequire = createRequire(path.join(process.cwd(), 'packages/unplugin/package.json'));

interface EsbuildFile {
  text: string;
}

interface EsbuildResult {
  outputFiles?: EsbuildFile[];
}

interface EsbuildTransform {
  transformSync: (code: string, options: { loader: 'ts'; format: 'esm'; target: 'es2022' }) => { code: string };
}

interface EsbuildPlugin {
  name: string;
  setup: (build: object) => void;
}

interface RollupChunk {
  code?: string;
}

interface RollupBundle {
  generate: (options: { format: 'cjs' }) => Promise<{ output: RollupChunk[] }>;
  close: () => Promise<void>;
}

interface Bundlers {
  esbuild: {
    build: (options: {
      absWorkingDir: string;
      entryPoints: string[];
      bundle: boolean;
      write: boolean;
      format: 'cjs';
      platform: 'node';
      define: Record<string, string>;
      plugins: EsbuildPlugin[];
    }) => Promise<EsbuildResult>;
  };
  rollup: {
    rollup: (options: { input: string; plugins: object[]; onwarn: () => void }) => Promise<RollupBundle>;
  };
  neoSyringePlugin: {
    esbuild: (options: { project: string }) => EsbuildPlugin;
    rollup: (options: { project: string }) => object;
  };
}

const loaded = pluginRequire('./dist/index.cjs') as { neoSyringePlugin: Bundlers['neoSyringePlugin'] };
const bundlers = loaded.neoSyringePlugin;
const esbuild = pluginRequire('esbuild') as Bundlers['esbuild'] & EsbuildTransform;
const rollup = pluginRequire('rollup') as Bundlers['rollup'];

const dirs: string[] = [];

function projectDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 't16-elagage-'));
  dirs.push(dir);
  return dir;
}

function writeProject(dir: string, files: Record<string, string>): void {
  for (const [name, text] of Object.entries(files)) {
    const full = path.join(dir, name);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, text);
  }
  const syringe = path.join(process.cwd(), 'packages/neosyringe').replace(/\\/g, '/');
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
}

async function bundle(kind: 'esbuild' | 'rollup', dir: string, entry: string): Promise<string> {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  const project = path.join(dir, 'tsconfig.json');
  try {
    if (kind === 'esbuild') {
      const result = await esbuild.build({
        absWorkingDir: dir,
        entryPoints: [entry],
        bundle: true,
        write: false,
        format: 'cjs',
        platform: 'node',
        define: { 'process.env.NODE_ENV': '"production"' },
        plugins: [bundlers.esbuild({ project })],
      });
      return result.outputFiles?.[0]?.text ?? '';
    }
    const built = await rollup.rollup({
      input: path.join(dir, entry),
      plugins: [
        bundlers.rollup({ project }),
        {
          name: 't16-typescript',
          resolveId(source: string, importer: string | undefined) {
            if (source === '@djodjonx/neosyringe') return '\0t16-neosyringe';
            if (!importer || !source.startsWith('.')) return null;
            const base = path.resolve(path.dirname(importer), source);
            if (existsSync(base)) return base;
            if (existsSync(`${base}.ts`)) return `${base}.ts`;
            return null;
          },
          load(id: string) {
            if (id !== '\0t16-neosyringe') return null;
            return [
              'export function defineBuilderConfig(config) { return config; }',
              'export function definePartialConfig(config) { return config; }',
              'export function useInterface() { return {}; }',
              'export function declareContainerTokens() { return {}; }',
            ].join('\n');
          },
          transform(code: string, id: string) {
            if (!id.endsWith('.ts')) return null;
            return { code: esbuild.transformSync(code, { loader: 'ts', format: 'esm', target: 'es2022' }).code };
          },
        },
      ],
      onwarn() {},
    });
    try {
      const generated = await built.generate({ format: 'cjs' });
      return generated.output.map((chunk) => chunk.code ?? '').join('\n');
    } finally {
      await built.close();
    }
  } finally {
    if (previous === undefined) Reflect.deleteProperty(process.env, 'NODE_ENV');
    else process.env.NODE_ENV = previous;
  }
}

function loadRun(code: string): () => unknown {
  const moduleRecord: { exports: { run?: () => unknown } } = { exports: {} };
  const execute = new Function('module', 'exports', 'require', code) as (
    module: typeof moduleRecord,
    exports: typeof moduleRecord.exports,
    require: (id: string) => unknown,
  ) => void;
  execute(moduleRecord, moduleRecord.exports, (id: string) => {
    throw new Error(`unexpected require ${id}`);
  });
  const run = moduleRecord.exports.run;
  if (typeof run !== 'function') throw new Error('bundle did not export run');
  return run;
}

const STUB = `
  import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';
  function defineBuilderConfig(config: any) { return config; }
  function useInterface<T>(): any { return null; }
`;

function openGraphs(): DependencyGraph[] {
  const root = '/virtual/t16-e2e-open';
  const absent = path.join(root, 'absent.ts');
  const explicit = path.join(root, 'explicit.ts');
  const body = (mode: string) => `
    interface OpenRoot { ok: number }
    interface OpenHeavy { n: number }
    const root = useInterface<OpenRoot>();
    const heavy = useInterface<OpenHeavy>();
    export const container = defineBuilderConfig({
      name: 'OpenBundle',
      ${mode}
      injections: [
        { token: root, useFactory: true, dependencies: [], provider: () => ({ ok: 1 }) },
        { token: heavy, useFactory: true, dependencies: [], provider: () => ({ n: 9 }) },
      ],
    });
  `;
  const sources = new Map<string, string>([
    [absent, `${STUB}\n${body('')}\n`],
    [explicit, `${STUB}\n${body("optimization: { mode: 'open' },")}\n`],
  ]);
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    strict: true,
    noImplicitAny: false,
  };
  const host = ts.createCompilerHost(options);
  const read = host.getSourceFile.bind(host);
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreateNewSourceFile) => {
    const text = sources.get(fileName);
    if (text !== undefined) return ts.createSourceFile(fileName, text, languageVersion, true);
    return read(fileName, languageVersion, onError, shouldCreateNewSourceFile);
  };
  host.fileExists = (fileName) => sources.has(fileName) || ts.sys.fileExists(fileName);
  const program = createFastProgram([...sources.keys()], options, host);
  return new Analyzer(program).extractAll();
}

const USEFUL = `
export class Useful {
  ok(): number { return 1; }
}
`;
const HEAVY = `
export class Heavy {
  payload(): string { return 'NEO_T16_SENTINEL_HEAVY'; }
}
`;

function closedApp(optimization: string): string {
  return `
import { defineBuilderConfig } from '@djodjonx/neosyringe';
import { Useful } from './useful';
import { Heavy } from './heavy';
export const container = defineBuilderConfig({
  name: 'ClosedBundle',
  ${optimization}
  injections: [
    { token: Useful, provider: Useful },
    { token: Heavy, provider: Heavy },
  ],
});
export function run(): number {
  return container.resolve(Useful).ok();
}
`;
}

describe('T16 elagage', () => {
  afterAll(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    dirs.length = 0;
  });

  it('T16-A01 esbuild', async () => {
    const dir = projectDir();
    writeProject(dir, {
      'useful.ts': USEFUL,
      'heavy.ts': HEAVY,
      'app.ts': closedApp("optimization: { mode: 'closed', roots: [Useful] },"),
    });
    const code = await bundle('esbuild', dir, 'app.ts');
    expect(loadRun(code)()).toBe(1);
    expect(code).not.toContain('NEO_T16_SENTINEL_HEAVY');
  });

  it('T16-A01 rollup', async () => {
    const dir = projectDir();
    writeProject(dir, {
      'useful.ts': USEFUL,
      'heavy.ts': HEAVY,
      'app.ts': closedApp("optimization: { mode: 'closed', roots: [Useful] },"),
    });
    const code = await bundle('rollup', dir, 'app.ts');
    expect(loadRun(code)()).toBe(1);
    expect(code).not.toContain('NEO_T16_SENTINEL_HEAVY');
  });

  it('T16-A02 open keeps provider', async () => {
    const graphs = openGraphs();
    const reasons = graphs.flatMap((graph) => [...(graph.retention?.values() ?? [])]);
    expect(reasons.length).toBeGreaterThan(0);
    expect(reasons.every((reason) => reason.kind === 'parent-boundary')).toBe(true);
    for (const optimization of ['', "optimization: { mode: 'open' },"]) {
      const dir = projectDir();
      writeProject(dir, {
        'useful.ts': USEFUL,
        'heavy.ts': HEAVY,
        'app.ts': closedApp(optimization),
      });
      const code = await bundle('esbuild', dir, 'app.ts');
      expect(loadRun(code)()).toBe(1);
      expect(code).toContain('NEO_T16_SENTINEL_HEAVY');
    }
  });

  it('T16-A07 open parent', async () => {
    const dir = projectDir();
    writeProject(dir, {
      'parent-heavy.ts': `export class ParentHeavy { tag(): string { return 'NEO_T16_PARENT_HEAVY'; } }`,
      'child-heavy.ts': `export class ChildHeavy { tag(): string { return 'NEO_T16_CHILD_HEAVY'; } }`,
      'useful.ts': `export class UsefulParent { n(): number { return 3; } }`,
      'parent.ts': `
        import { defineBuilderConfig } from '@djodjonx/neosyringe';
        import { UsefulParent } from './useful';
        import { ParentHeavy } from './parent-heavy';
        export const parent = defineBuilderConfig({
          name: 'OpenParent',
          injections: [
            { token: UsefulParent, provider: UsefulParent },
            { token: ParentHeavy, provider: ParentHeavy },
          ],
        });
      `,
      'child.ts': `
        import { defineBuilderConfig } from '@djodjonx/neosyringe';
        import { parent } from './parent';
        import { UsefulParent } from './useful';
        import { ChildHeavy } from './child-heavy';
        export class ChildRoot { constructor(readonly n: number) {} }
        export const child = defineBuilderConfig({
          name: 'ClosedChild',
          optimization: { mode: 'closed', roots: [ChildRoot] },
          useContainer: parent,
          injections: [
            { token: ChildRoot, useFactory: true, dependencies: [UsefulParent], provider: (ctx) => new ChildRoot(ctx.resolve(UsefulParent).n()) },
            { token: ChildHeavy, provider: ChildHeavy },
          ],
        });
      `,
      'app.ts': `
        import { parent } from './parent';
        import { child, ChildRoot } from './child';
        import { ParentHeavy } from './parent-heavy';
        export function run(): { parent: string; child: number } {
          return { parent: parent.resolve(ParentHeavy).tag(), child: child.resolve(ChildRoot).n };
        }
      `,
    });
    const code = await bundle('esbuild', dir, 'app.ts');
    expect(loadRun(code)()).toEqual({ parent: 'NEO_T16_PARENT_HEAVY', child: 3 });
    expect(code).toContain('NEO_T16_PARENT_HEAVY');
    expect(code).not.toContain('NEO_T16_CHILD_HEAVY');
  });

  it('T16 closed parent exports', async () => {
    const dir = projectDir();
    writeProject(dir, {
      'legacy.ts': `
        export class OpaqueExtra { tag(): string { return 'NEO_T16_OPAQUE_EXTRA'; } }
        export class LegacyHeavy { payload(): string { return 'NEO_T16_LEGACY_HEAVY'; } }
        export const legacyParent = {
          resolve(token: unknown): OpaqueExtra | LegacyHeavy {
            if (typeof token === 'string' && token.startsWith('LegacyHeavy_')) return new LegacyHeavy();
            return new OpaqueExtra();
          },
        };
      `,
      'app.ts': `
        import { defineBuilderConfig, declareContainerTokens } from '@djodjonx/neosyringe';
        import { legacyParent, OpaqueExtra, LegacyHeavy } from './legacy';
        export class Private { hidden(): string { return 'private'; } }
        export class Exported {
          constructor(readonly kept: Private) {}
          id(): number { return this.kept.hidden() === 'private' ? 7 : 0; }
        }
        export class ChildMark { n(): number { return 1; } }
        export class Bound {
          constructor(readonly extra: OpaqueExtra) {}
          tag(): string { return this.extra.tag(); }
        }
        export class HeavyView {
          constructor(readonly heavy: LegacyHeavy) {}
          payload(): string { return this.heavy.payload(); }
        }
        const legacy = declareContainerTokens<{ OpaqueExtra: OpaqueExtra; LegacyHeavy: LegacyHeavy }>(legacyParent);
        export const parent = defineBuilderConfig({
          name: 'ClosedParent',
          optimization: { mode: 'closed', roots: [Exported] },
          injections: [
            { token: Exported, provider: Exported },
            { token: Private, provider: Private },
          ],
        });
        export const child = defineBuilderConfig({
          name: 'ChildOfClosed',
          useContainer: parent,
          injections: [
            { token: ChildMark, provider: ChildMark },
          ],
        });
        export const boundary = defineBuilderConfig({
          name: 'OpaqueBoundary',
          optimization: { mode: 'closed', roots: [Bound, HeavyView] },
          useContainer: legacy,
          injections: [
            { token: Bound, provider: Bound },
            { token: HeavyView, provider: HeavyView },
          ],
        });
        function readCode(error: unknown): string | undefined {
          return error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : undefined;
        }
        export function run(): { code: string | undefined; childCode: string | undefined; leaked: string | undefined; exported: number; boundary: string; heavy: string } {
          let code: string | undefined;
          try {
            // ADR006 line 32: a dynamic call is the runtime guard. A visible resolve fails the build.
            parent['resolve'](Private);
          } catch (error) {
            code = readCode(error);
          }
          let childCode: string | undefined;
          let leaked: string | undefined;
          try {
            leaked = child['resolve'](Private).hidden();
          } catch (error) {
            childCode = readCode(error);
          }
          return {
            code,
            childCode,
            leaked,
            exported: parent.resolve(Exported).id(),
            boundary: boundary.resolve(Bound).tag(),
            heavy: boundary.resolve(HeavyView).payload(),
          };
        }
      `,
    });
    const code = await bundle('esbuild', dir, 'app.ts');
    const value = loadRun(code)() as {
      code: string | undefined;
      childCode: string | undefined;
      leaked: string | undefined;
      exported: number;
      boundary: string;
      heavy: string;
    };
    expect(value.code).toBe('NEO_ROOT_NOT_EXPORTED');
    expect(value.childCode).toBe('NEO_ROOT_NOT_EXPORTED');
    expect(value.leaked).toBeUndefined();
    expect(value.exported).toBe(7);
    expect(value.boundary).toBe('NEO_T16_OPAQUE_EXTRA');
    expect(value.heavy).toBe('NEO_T16_LEGACY_HEAVY');
  });

  it('T16 child private resolve build', async () => {
    const dir = projectDir();
    writeProject(dir, {
      'app.ts': `
        import { defineBuilderConfig } from '@djodjonx/neosyringe';
        export class Private { hidden(): string { return 'private'; } }
        export class Exported {
          constructor(readonly kept: Private) {}
          id(): number { return 1; }
        }
        export class ChildMark { n(): number { return 1; } }
        export const parent = defineBuilderConfig({
          name: 'ClosedParent',
          optimization: { mode: 'closed', roots: [Exported] },
          injections: [
            { token: Exported, provider: Exported },
            { token: Private, provider: Private },
          ],
        });
        export const child = defineBuilderConfig({
          name: 'ChildOfClosed',
          useContainer: parent,
          injections: [
            { token: ChildMark, provider: ChildMark },
          ],
        });
        export function read() {
          return child.resolve(Private);
        }
        export function run(): number {
          return child.resolve(ChildMark).n();
        }
      `,
    });
    let message = 'build succeeded';
    try {
      await bundle('esbuild', dir, 'app.ts');
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain('NEO_ROOT_NOT_EXPORTED');
  });

  it('T16 pruned module effect', async () => {
    const dir = projectDir();
    writeProject(dir, {
      'useful.ts': USEFUL,
      'mark.ts': `
        export const marker = ((globalThis as { __t16Mod?: number }).__t16Mod =
          ((globalThis as { __t16Mod?: number }).__t16Mod ?? 0) + 1);
        export class PrunedEffect {
          tag(): string { return 'NEO_T16_PRUNED_EFFECT'; }
        }
      `,
      'app.ts': `
        import { defineBuilderConfig } from '@djodjonx/neosyringe';
        import { Useful } from './useful';
        import { PrunedEffect } from './mark';
        export const container = defineBuilderConfig({
          name: 'EffectBundle',
          optimization: { mode: 'closed', roots: [Useful] },
          injections: [
            { token: Useful, provider: Useful },
            { token: PrunedEffect, provider: PrunedEffect },
          ],
        });
        export function run(): number {
          container.resolve(Useful).ok();
          return (globalThis as { __t16Mod?: number }).__t16Mod ?? 0;
        }
      `,
    });
    const code = await bundle('esbuild', dir, 'app.ts');
    expect(loadRun(code)()).toBe(1);
  });

  it('T16 private resolve build', async () => {
    const dir = projectDir();
    writeProject(dir, {
      'app.ts': `
        import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';
        interface Shown { ok: number }
        interface Hidden { n: number }
        const shown = useInterface<Shown>();
        const hidden = useInterface<Hidden>();
        export const container = defineBuilderConfig({
          name: 'VisiblePrivate',
          optimization: { mode: 'closed', roots: [shown] },
          injections: [
            { token: shown, useFactory: true, dependencies: [], provider: () => ({ ok: 1 }) },
            { token: hidden, useFactory: true, dependencies: [], provider: () => ({ n: 1 }) },
          ],
        });
        export function read() {
          return container.resolve(hidden);
        }
        export function run(): number {
          return container.resolve(shown).ok;
        }
      `,
    });
    let message = 'build succeeded';
    try {
      await bundle('esbuild', dir, 'app.ts');
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain('NEO_ROOT_NOT_EXPORTED');
  });
});
