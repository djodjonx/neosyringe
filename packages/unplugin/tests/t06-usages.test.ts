import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('@djodjonx/neosyringe-core/generator', () => import('../../core/src/generator/index'));
vi.mock('@djodjonx/neosyringe-core/analyzer', () => import('../../core/src/analyzer/index'));
vi.mock('@djodjonx/neosyringe-core/context', () => import('../../core/src/TSContext'));

import * as ts from 'typescript';
import { Analyzer } from '@djodjonx/neosyringe-core/analyzer';
import { TSContext } from '@djodjonx/neosyringe-core/context';
import { neoSyringePlugin } from '../src/index';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const dirs: string[] = [];
const sharedDirs: string[] = [];

afterEach(() => {
  TSContext.reset();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

afterAll(() => {
  for (const dir of sharedDirs) rmSync(dir, { recursive: true, force: true });
});

type PluginHooks = {
  transform: (code: string, id: string) => unknown;
  buildEnd: () => void;
};

function hooks(validation?: 'strict' | 'compatible'): PluginHooks {
  const plugin = neoSyringePlugin.vite({ project: 'tsconfig.json', validation });
  if (Array.isArray(plugin) || typeof plugin.transform !== 'function' || typeof plugin.buildEnd !== 'function') {
    throw new Error('hooks transform et buildEnd attendus');
  }
  return plugin as PluginHooks;
}

function writeProject(files: Record<string, string>, track = true): string {
  const dir = mkdtempSync(path.join(tmpdir(), 't06-'));
  if (track) dirs.push(dir);
  else sharedDirs.push(dir);
  const config = {
    compilerOptions: {
      target: 'ES2020',
      module: 'ESNext',
      moduleResolution: 'bundler',
      strict: true,
      skipLibCheck: true,
      baseUrl: REPO,
      paths: { '@djodjonx/neosyringe': ['packages/neosyringe/src/index.ts'] },
    },
  };
  writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify(config));
  for (const [name, text] of Object.entries(files)) {
    writeFileSync(path.join(dir, name), text);
  }
  return dir;
}

function thrownMessage(buildEnd: () => void): string {
  try {
    buildEnd();
    return '';
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

const TOKENS = `
  export interface IFoo { id: number }
  export interface IBar { id: number }
  export interface IUnused { id: number }
`;

const CONTAINER_A = `
  import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';
  import { IFoo } from './tokens';
  class FooImpl implements IFoo { id = 1 }
  export const containerA = defineBuilderConfig({
    injections: [{ token: useInterface<IFoo>(), provider: FooImpl }],
  });
`;

const CONTAINER_B = `
  import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';
  import { IFoo, IBar } from './tokens';
  class BarImpl implements IBar { id = 2 }
  export const containerB = defineBuilderConfig({
    injections: [{ token: useInterface<IBar>(), provider: BarImpl }],
  });
  containerB.resolve(useInterface<IFoo>());
  containerB.resolve(useInterface<IBar>());
`;

const PARENT = `
  import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';
  import { IFoo } from './tokens';
  class FooImpl implements IFoo { id = 1 }
  export const parent = defineBuilderConfig({
    injections: [{ token: useInterface<IFoo>(), provider: FooImpl }],
  });
`;

const CHILD = `
  import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';
  import { parent } from './parent';
  import { IFoo } from './tokens';
  export const child = defineBuilderConfig({
    useContainer: parent,
    injections: [],
  });
  child.resolve(useInterface<IFoo>());
`;

const FAIL_A = `
  import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';
  import { IFoo } from './tokens';
  export const left = defineBuilderConfig({ injections: [] });
  left.resolve(useInterface<IFoo>());
`;

const FAIL_B = `
  import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';
  import { IBar } from './tokens';
  export const right = defineBuilderConfig({ injections: [] });
  right.resolve(useInterface<IBar>());
`;

const ORDERED_FILES: Record<string, string> = {
  'fail-a.ts': FAIL_A,
  'fail-b.ts': FAIL_B,
  'parent.ts': PARENT,
  'child.ts': CHILD,
};

const F5_SOURCE = `
  import { defineBuilderConfig, useInterface, type Container } from '@djodjonx/neosyringe';
  import { IFoo } from './tokens';
  export const containerB = defineBuilderConfig({ injections: [] });
  function getContainer(): Container { return containerB; }
  getContainer().resolve(useInterface<IFoo>());
`;

function programOf(dir: string, names: string[]): ts.Program {
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
    skipLibCheck: true,
    baseUrl: REPO,
    paths: { '@djodjonx/neosyringe': ['packages/neosyringe/src/index.ts'] },
  };
  return ts.createProgram(names.map((name) => path.join(dir, name)), options);
}

describe('T06 plugin usages', () => {
  let orderedDir = '';
  let orderedPlugin: PluginHooks | undefined;
  let f5Dir = '';
  let strictF5: PluginHooks | undefined;
  let compatibleF5: PluginHooks | undefined;

  beforeAll(() => {
    orderedDir = writeProject({ 'tokens.ts': TOKENS, ...ORDERED_FILES }, false);
    f5Dir = writeProject({ 'tokens.ts': TOKENS, 'f5.ts': F5_SOURCE }, false);
    orderedPlugin = hooks();
    strictF5 = hooks('strict');
    compatibleF5 = hooks('compatible');
  });

  function runOrder(names: string[]): string {
    const plugin = orderedPlugin;
    if (!plugin) throw new Error('ordered plugin missing');
    const previous = process.cwd();
    process.chdir(orderedDir);
    try {
      for (const name of names) plugin.transform(ORDERED_FILES[name]!, path.join(orderedDir, name));
      return thrownMessage(plugin.buildEnd);
    } finally {
      process.chdir(previous);
    }
  }

  it('T06-A01 token in A resolved in independent B', () => {
    const dir = writeProject({ 'tokens.ts': TOKENS, 'a.ts': CONTAINER_A, 'b.ts': CONTAINER_B });
    const previous = process.cwd();
    process.chdir(dir);
    try {
      const { transform, buildEnd } = hooks();
      transform(CONTAINER_A, path.join(dir, 'a.ts'));
      transform(CONTAINER_B, path.join(dir, 'b.ts'));
      expect(thrownMessage(buildEnd)).toContain("NEO_MISSING_PROVIDER: 'IFoo' is not in container");
    } finally {
      process.chdir(previous);
    }
  });

  it('T06-A04 exported token without resolve', () => {
    const source = `
      import { useInterface } from '@djodjonx/neosyringe';
      import { IUnused } from './tokens';
      export const T = useInterface<IUnused>();
    `;
    const dir = writeProject({ 'tokens.ts': TOKENS, 'token.ts': source });
    const previous = process.cwd();
    process.chdir(dir);
    try {
      const { transform, buildEnd } = hooks();
      transform(source, path.join(dir, 'token.ts'));
      expect(thrownMessage(buildEnd)).toBe('');
    } finally {
      process.chdir(previous);
    }
  });

  it('T06-A05 alias and unknown target', () => {
    const source = `
      import { defineBuilderConfig, useInterface, type Container } from '@djodjonx/neosyringe';
      import { IFoo, IBar } from './tokens';
      class BarImpl implements IBar { id = 2 }
      export const containerB = defineBuilderConfig({
        injections: [{ token: useInterface<IBar>(), provider: BarImpl }],
      });
      const c = containerB;
      c.resolve(useInterface<IFoo>());
      function getContainer(): Container { return containerB; }
      getContainer().resolve(useInterface<IFoo>());
      const unrelated = { resolve(token: unknown): unknown { return token; } };
      unrelated.resolve(useInterface<IFoo>());
    `;
    const dir = writeProject({ 'tokens.ts': TOKENS, 'a05.ts': source });
    const previous = process.cwd();
    process.chdir(dir);
    try {
      const strict = hooks('strict');
      strict.transform(source, path.join(dir, 'a05.ts'));
      const strictMessage = thrownMessage(strict.buildEnd);
      expect(strictMessage).toContain('NEO_MISSING_PROVIDER:');
      expect(strictMessage).toContain('NEO_UNKNOWN_CONTAINER:');

      const compatible = hooks('compatible');
      compatible.transform(source, path.join(dir, 'a05.ts'));
      const compatibleMessage = thrownMessage(compatible.buildEnd);
      expect(compatibleMessage).toContain('NEO_MISSING_PROVIDER:');
      expect(compatibleMessage).not.toContain('NEO_UNKNOWN_CONTAINER:');
    } finally {
      process.chdir(previous);
    }
  });

  it('T06-P7 transform order (failing files)', () => {
    const forward = runOrder(['fail-a.ts', 'fail-b.ts']);
    const reverse = runOrder(['fail-b.ts', 'fail-a.ts']);
    expect(forward).toContain("NEO_MISSING_PROVIDER: 'IFoo' is not in container");
    expect(forward).toContain("NEO_MISSING_PROVIDER: 'IBar' is not in container");
    expect(forward).toBe(reverse);
  });

  it('T06-P7 transform order (valid parent and child)', () => {
    const forward = runOrder(['parent.ts', 'child.ts']);
    const reverse = runOrder(['child.ts', 'parent.ts']);
    expect(forward).toBe('');
    expect(reverse).toBe('');
  });

  it('T06-P8 analyzer and build diagnostics match', () => {
    const dir = writeProject({ 'tokens.ts': TOKENS, 'a.ts': CONTAINER_A, 'b.ts': CONTAINER_B });
    const previous = process.cwd();
    process.chdir(dir);
    try {
      const { transform, buildEnd } = hooks();
      transform(CONTAINER_A, path.join(dir, 'a.ts'));
      transform(CONTAINER_B, path.join(dir, 'b.ts'));
      const message = thrownMessage(buildEnd);
      const analyzer = new Analyzer(programOf(dir, ['a.ts', 'b.ts', 'tokens.ts']));
      const errors = analyzer.extractForFile(path.join(dir, 'b.ts')).errors.filter(
        (error) => error.code === 'NEO_MISSING_PROVIDER' && error.message.startsWith('NEO_MISSING_PROVIDER: '),
      );
      expect(errors).toHaveLength(1);
      expect(errors[0]?.code).toBe('NEO_MISSING_PROVIDER');
      expect(message).toContain(errors[0]?.message);
    } finally {
      process.chdir(previous);
    }
  });

  it('T06-A06 resolveAll on single or absent does not fail the build', () => {
    const source = `
      import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';
      import { IFoo, IBar, IUnused } from './tokens';
      class FooImpl implements IFoo { id = 1 }
      class BarA implements IBar { id = 2 }
      class BarB implements IBar { id = 3 }
      export const box = defineBuilderConfig({
        injections: [
          { token: useInterface<IFoo>(), provider: FooImpl },
          { token: useInterface<IBar>(), provider: BarA, multi: true },
          { token: useInterface<IBar>(), provider: BarB, multi: true },
        ],
      });
      box.resolveAll(useInterface<IFoo>());
      box.resolveAll(useInterface<IUnused>());
      box.resolveAll(useInterface<IBar>());
      box.resolve(useInterface<IBar>());
    `;
    const dir = writeProject({ 'tokens.ts': TOKENS, 'a06.ts': source });
    const previous = process.cwd();
    process.chdir(dir);
    try {
      const { transform, buildEnd } = hooks();
      transform(source, path.join(dir, 'a06.ts'));
      const message = thrownMessage(buildEnd);
      expect(message).not.toContain("NEO_MISSING_PROVIDER: 'IFoo'");
      expect(message).not.toContain("NEO_MISSING_PROVIDER: 'IUnused'");
      expect(message).toContain('NEO_MULTI_REQUIRES_RESOLVE_ALL');
      expect(message).toContain("'IBar' is multi; use resolveAll");
    } finally {
      process.chdir(previous);
    }
  });

  it('T06-F5 strict throws', () => {
    const plugin = strictF5;
    if (!plugin) throw new Error('strict plugin missing');
    const previous = process.cwd();
    process.chdir(f5Dir);
    try {
      plugin.transform(F5_SOURCE, path.join(f5Dir, 'f5.ts'));
      const strictMessage = thrownMessage(plugin.buildEnd);
      expect(strictMessage).toContain('NEO_UNKNOWN_CONTAINER');
      expect(strictMessage).toMatch(/:\d+:\d+/);
    } finally {
      process.chdir(previous);
    }
  });

  it('T06-F5 compatible warns through console.warn', () => {
    const plugin = compatibleF5;
    if (!plugin) throw new Error('compatible plugin missing');
    const previous = process.cwd();
    process.chdir(f5Dir);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      plugin.transform(F5_SOURCE, path.join(f5Dir, 'f5.ts'));
      expect(thrownMessage(plugin.buildEnd)).toBe('');
      const warned = warn.mock.calls.map((call) => call.map(String).join(' ')).join('\n');
      expect(warned).toContain('NEO_UNKNOWN_CONTAINER');
      expect(warned).toMatch(/:\d+:\d+/);
    } finally {
      warn.mockRestore();
      process.chdir(previous);
    }
  });

  it('T06-F5 compatible warns through the plugin context this.warn', () => {
    const plugin = compatibleF5;
    if (!plugin) throw new Error('compatible plugin missing');
    const previous = process.cwd();
    process.chdir(f5Dir);
    try {
      const seen: string[] = [];
      plugin.transform(F5_SOURCE, path.join(f5Dir, 'f5.ts'));
      plugin.buildEnd.call({ warn: (message: string) => { seen.push(message); } });
      expect(seen.join('\n')).toContain('NEO_UNKNOWN_CONTAINER');
      expect(seen.join('\n')).toMatch(/:\d+:\d+/);
    } finally {
      process.chdir(previous);
    }
  });

  it('T06-W13 declaration changed between plugin runs is re-read', () => {
    const firstApp = `
      import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';
      import { IFoo } from './types';
      export const box = defineBuilderConfig({ injections: [] });
      box.resolve(useInterface<IFoo>());
    `;
    const secondApp = `
      import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';
      import { IBar } from './types';
      export const box = defineBuilderConfig({ injections: [] });
      box.resolve(useInterface<IBar>());
    `;
    const dir = writeProject({
      'types.d.ts': 'export interface IFoo { id: number }\n',
      'app.ts': firstApp,
    });
    const previous = process.cwd();
    process.chdir(dir);
    try {
      const first = hooks();
      first.transform(firstApp, path.join(dir, 'app.ts'));
      expect(thrownMessage(first.buildEnd)).toContain("NEO_MISSING_PROVIDER: 'IFoo' is not in container");

      writeFileSync(path.join(dir, 'types.d.ts'), 'export interface IFoo { id: number }\nexport interface IBar { id: number }\n');
      writeFileSync(path.join(dir, 'app.ts'), secondApp);
      const second = hooks();
      second.transform(secondApp, path.join(dir, 'app.ts'));
      expect(thrownMessage(second.buildEnd)).toContain("NEO_MISSING_PROVIDER: 'IBar' is not in container");
    } finally {
      process.chdir(previous);
    }
  });

  it('T06-F8 explicit generic resolve without a NeoSyringe import', () => {
    const anchor = `
      import { defineBuilderConfig } from '@djodjonx/neosyringe';
      export const containerB = defineBuilderConfig({ injections: [] });
    `;
    const caller = `
      import type { Container } from '@djodjonx/neosyringe';
      class Foo {}
      declare function get(): Container;
      get().resolve<Foo>(Foo);
    `;
    const dir = writeProject({ 'anchor.ts': anchor, 'caller.ts': caller });
    const previous = process.cwd();
    process.chdir(dir);
    try {
      const { transform, buildEnd } = hooks();
      transform(anchor, path.join(dir, 'anchor.ts'));
      transform(caller, path.join(dir, 'caller.ts'));
      const message = thrownMessage(buildEnd);
      expect(message).toContain('NEO_UNKNOWN_CONTAINER');
      expect(message).toMatch(/caller\.ts:\d+:\d+/);
    } finally {
      process.chdir(previous);
    }
  });
});
