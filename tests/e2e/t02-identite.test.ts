import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import ts from 'typescript';
import { executeFixture } from './helpers/execute-fixture';

const REPO_FIXTURE = `
import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';

interface User { id: string }
interface Order { id: string }
interface Repo<T> { get(): T }

class UserRepo implements Repo<User> {
  get(): User { return { id: 'user' }; }
}
class OrderRepo implements Repo<Order> {
  get(): Order { return { id: 'order' }; }
}

export const c = defineBuilderConfig({
  injections: [
    { token: useInterface<Repo<User>>(), provider: UserRepo },
    { token: useInterface<Repo<Order>>(), provider: OrderRepo },
  ],
});

export function run() {
  return {
    user: c.resolve(useInterface<Repo<User>>()).get().id,
    order: c.resolve(useInterface<Repo<Order>>()).get().id,
  };
}
`;

interface PluginModule {
  neoSyringePlugin: { vite: () => { transform: (code: string, id: string) => unknown; buildEnd: () => void } };
}

interface CoreModule {
  TSContext: { reset: () => void };
}

function outputText(output: unknown, source: string): string {
  if (typeof output === 'string') return output;
  if (output && typeof output === 'object' && 'code' in output && typeof output.code === 'string') {
    return output.code;
  }
  return source;
}

function tokenIds(source: string, name: string): string[] {
  return [...source.matchAll(new RegExp(`${name}_[0-9a-f]{8}`, 'g'))].map((match) => match[0]);
}

function propertyIds(source: string, className: string, param: string): string[] {
  return [...source.matchAll(new RegExp(`PropertyToken:${className}\\.${param}_[0-9a-f]{8}`, 'g'))].map((match) => match[0]);
}

describe('T02 e2e identité', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 't02-identite-'));
  const transformed = new Map<string, string>();

  beforeAll(async () => {
    const layout: Record<string, string> = {
      'types.ts': `
        export interface User { id: string }
        export interface Order { id: string }
        export interface Repo<T> { get(): T }
        export interface Port { id: string }
      `,
      'user-repo.ts': `
        import type { Repo, User } from './types';
        export class UserRepo implements Repo<User> {
          static constructed = 0;
          constructor() { UserRepo.constructed += 1; }
          get(): User { return { id: 'user' }; }
        }
      `,
      'a.ts': `
        import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';
        import type { Repo, User } from './types';
        import { UserRepo } from './user-repo';
        export const c = defineBuilderConfig({
          injections: [{ token: useInterface<Repo<User>>(), provider: UserRepo }],
        });
        export function fromA() {
          return c.resolve(useInterface<Repo<User>>());
        }
      `,
      'b.ts': `
        import { useInterface } from '@djodjonx/neosyringe';
        import type { Repo, User } from './types';
        import { c, fromA } from './a';
        import { UserRepo } from './user-repo';
        export function run() {
          const left = fromA();
          const right = c.resolve(useInterface<Repo<User>>());
          return { same: left === right, constructed: UserRepo.constructed, id: right.get().id };
        }
      `,
      'ports-a.ts': `
        import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';
        export interface Port { id: string }
        class PortA implements Port { id = 'a'; }
        export const c = defineBuilderConfig({
          injections: [{ token: useInterface<Port>(), provider: PortA }],
        });
        export function run() {
          return c.resolve(useInterface<Port>()).id;
        }
      `,
      'ports-b.ts': `
        import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';
        export interface Port { id: string }
        class PortB implements Port { id = 'b'; }
        export const c = defineBuilderConfig({
          injections: [{ token: useInterface<Port>(), provider: PortB }],
        });
        export function run() {
          return c.resolve(useInterface<Port>()).id;
        }
      `,
      'api-left.ts': `
        import { defineBuilderConfig, useProperty } from '@djodjonx/neosyringe';
        export class Api {
          constructor(public secret: string) {}
        }
        export const c = defineBuilderConfig({
          injections: [
            { token: useProperty<string>(Api, 'secret'), provider: () => 'alpha' },
            { token: Api },
          ],
        });
        export function run() {
          return c.resolve(Api).secret;
        }
      `,
      'api-right.ts': `
        import { defineBuilderConfig, useProperty } from '@djodjonx/neosyringe';
        export class Api {
          constructor(public secret: string) {}
        }
        export const c = defineBuilderConfig({
          injections: [
            { token: useProperty<string>(Api, 'secret'), provider: () => 'beta' },
            { token: Api },
          ],
        });
        export function run() {
          return c.resolve(Api).secret;
        }
      `,
      'service-left.ts': `
        import { defineBuilderConfig } from '@djodjonx/neosyringe';
        export class Service { tag = 'left'; }
        export const c = defineBuilderConfig({
          injections: [{ token: Service }],
        });
        export function run() {
          return c.resolve(Service).tag;
        }
      `,
      'service-right.ts': `
        import { defineBuilderConfig } from '@djodjonx/neosyringe';
        export class Service { tag = 'right'; }
        export const c = defineBuilderConfig({
          injections: [{ token: Service }],
        });
        export function run() {
          return c.resolve(Service).tag;
        }
      `,
    };
    for (const [name, source] of Object.entries(layout)) {
      writeFileSync(path.join(dir, name), source);
    }

    const pluginModule = await import('../../packages/unplugin/dist/index.mjs') as PluginModule;
    const plugin = pluginModule.neoSyringePlugin.vite();
    for (const name of Object.keys(layout)) {
      const id = path.join(dir, name);
      const source = layout[name];
      transformed.set(name, outputText(plugin.transform(source, id), source));
    }
    plugin.buildEnd();
  });

  afterAll(async () => {
    const coreModule = await import('../../packages/core/dist/TSContext.mjs') as CoreModule;
    coreModule.TSContext.reset();
    rmSync(dir, { recursive: true, force: true });
  });

  function load(entry: string): Record<string, unknown> {
    const requireFromPackage = createRequire(
      pathToFileURL(path.join(process.cwd(), 'packages/neosyringe/package.json')).href,
    );
    const cache = new Map<string, Record<string, unknown>>();
    const loadFile = (fileName: string): Record<string, unknown> => {
      const cached = cache.get(fileName);
      if (cached) return cached;
      const source = transformed.get(fileName);
      if (source === undefined) throw new Error(`module absent: ${fileName}`);
      const javascript = ts.transpileModule(source, {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
      }).outputText;
      const exportsObject: Record<string, unknown> = {};
      const execute = new Function('exports', 'require', javascript) as (
        exportsObject: Record<string, unknown>,
        requireImpl: (specifier: string) => unknown,
      ) => void;
      execute(exportsObject, (specifier) => {
        if (specifier === '@djodjonx/neosyringe' || specifier.startsWith('@djodjonx/')) {
          return requireFromPackage(specifier);
        }
        if (specifier.startsWith('.')) {
          const base = path.resolve(dir, path.dirname(fileName), specifier);
          const relative = path.relative(dir, base);
          const withTs = relative.endsWith('.ts') ? relative : `${relative}.ts`;
          return loadFile(withTs);
        }
        return requireFromPackage(specifier);
      });
      cache.set(fileName, exportsObject);
      return exportsObject;
    };
    return loadFile(entry);
  }

  it('T02-A01 Repo<User> et Repo<Order> renvoient chacun leur valeur', async () => {
    const outcome = await executeFixture(REPO_FIXTURE);
    expect(outcome.phase).toBe('ok');
    if (outcome.phase !== 'ok') return;
    expect(outcome.value).toEqual({ user: 'user', order: 'order' });
  });

  it('T02-A02 deux fichiers qui demandent Repo<User> partagent le singleton', () => {
    const idsA = tokenIds(transformed.get('a.ts') ?? '', 'Repo');
    const idsB = tokenIds(transformed.get('b.ts') ?? '', 'Repo');
    expect(idsA.length).toBeGreaterThan(0);
    expect(new Set([...idsA, ...idsB]).size).toBe(1);
    const loaded = load('b.ts');
    const run = loaded.run as () => { same: boolean; constructed: number; id: string };
    const value = run();
    expect(value).toEqual({ same: true, constructed: 1, id: 'user' });
  });

  it('T02-A03 deux interfaces Port homonymes restent distinctes', () => {
    const left = [...new Set(tokenIds(transformed.get('ports-a.ts') ?? '', 'Port'))];
    const right = [...new Set(tokenIds(transformed.get('ports-b.ts') ?? '', 'Port'))];
    expect(left).toHaveLength(1);
    expect(right).toHaveLength(1);
    expect(left[0]).not.toBe(right[0]);
    const runA = load('ports-a.ts').run as () => string;
    const runB = load('ports-b.ts').run as () => string;
    expect(runA()).toBe('a');
    expect(runB()).toBe('b');
  });

  it('T02-A05 deux classes Api ne partagent pas le PropertyToken secret', () => {
    const leftIds = [...new Set(propertyIds(transformed.get('api-left.ts') ?? '', 'Api', 'secret'))];
    const rightIds = [...new Set(propertyIds(transformed.get('api-right.ts') ?? '', 'Api', 'secret'))];
    expect(leftIds).toHaveLength(1);
    expect(rightIds).toHaveLength(1);
    expect(leftIds[0]).not.toBe(rightIds[0]);
    const runLeft = load('api-left.ts').run as () => string;
    const runRight = load('api-right.ts').run as () => string;
    expect(runLeft()).toBe('alpha');
    expect(runRight()).toBe('beta');
  });

  it('T02 classes Service homonymes restent deux instances', () => {
    const left = [...new Set(tokenIds(transformed.get('service-left.ts') ?? '', 'Service'))];
    const right = [...new Set(tokenIds(transformed.get('service-right.ts') ?? '', 'Service'))];
    expect(left).toHaveLength(1);
    expect(right).toHaveLength(1);
    expect(left[0]).not.toBe(right[0]);
    const runLeft = load('service-left.ts').run as () => string;
    const runRight = load('service-right.ts').run as () => string;
    expect(runLeft()).toBe('left');
    expect(runRight()).toBe('right');
  });
});
