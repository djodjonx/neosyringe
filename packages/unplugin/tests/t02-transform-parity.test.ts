import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import ts from 'typescript';
import { Analyzer, NeoTokenError } from '@djodjonx/neosyringe-core/analyzer';
import { TSContext } from '@djodjonx/neosyringe-core/context';
import { transformUseInterfaceCalls, type UsedTokenEntry } from '../src/useInterfaceTransform';

const FILES: Record<string, string> = {
  'types.ts': `
    export interface User { id: string }
    export interface Order { id: string }
    export interface Repo<T> { get(): T }
  `,
  'left-port.ts': `
    export interface Port { id: string }
  `,
  'right-port.ts': `
    export interface Port { id: string }
  `,
  'api-left.ts': `
    export class Api {
      constructor(public secret: string) {}
    }
  `,
  'api-right.ts': `
    export class Api {
      constructor(public secret: string) {}
    }
  `,
  'app.ts': `
    import { defineBuilderConfig, useInterface, useProperty } from '@djodjonx/neosyringe';
    function defineBuilderConfig(config: { injections: unknown[] }) { return config; }
    function useInterface<T>(): T { return null!; }
    function useProperty<T>(type: unknown, name: string): T { return null!; }
    import type { Repo, User, Order } from './types';
    import type { Port as LeftPort } from './left-port';
    import type { Port as RightPort } from './right-port';
    import { Api as LeftApi } from './api-left';
    import { Api as RightApi } from './api-right';
    class UserRepo implements Repo<User> { get(): User { return { id: 'user' }; } }
    class OrderRepo implements Repo<Order> { get(): Order { return { id: 'order' }; } }
    class LeftPortImpl implements LeftPort { id = 'left'; }
    class RightPortImpl implements RightPort { id = 'right'; }
    export const c = defineBuilderConfig({
      injections: [
        { token: useInterface<Repo<User>>(), provider: UserRepo },
        { token: useInterface<Repo<Order>>(), provider: OrderRepo },
        { token: useInterface<LeftPort>(), provider: LeftPortImpl },
        { token: useInterface<RightPort>(), provider: RightPortImpl },
        { token: useProperty<string>(LeftApi, 'secret'), provider: () => 'alpha' },
        { token: useProperty<string>(RightApi, 'secret'), provider: () => 'beta' },
        { token: LeftApi },
        { token: RightApi },
      ],
    });
  `,
};

function ids(source: string, pattern: RegExp): string[] {
  return [...source.matchAll(pattern)].map((match) => match[0]);
}

describe('T02 parité du transform', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 't02-parity-'));
  let transformed = '';
  let graphIds: string[] = [];

  beforeAll(() => {
    TSContext.projectRoot = dir;
    const options: ts.CompilerOptions = {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      strict: true,
    };
    const sources = new Map<string, string>();
    for (const [name, source] of Object.entries(FILES)) {
      const fileName = path.join(dir, name);
      writeFileSync(fileName, source);
      sources.set(fileName, source);
    }
    const host = ts.createCompilerHost(options);
    const original = host.getSourceFile.bind(host);
    host.fileExists = (fileName) => sources.has(fileName) || ts.sys.fileExists(fileName);
    host.readFile = (fileName) => sources.get(fileName) ?? ts.sys.readFile(fileName);
    host.getSourceFile = (fileName, languageVersion, onError, shouldCreate) => {
      const text = sources.get(fileName);
      if (text !== undefined) return ts.createSourceFile(fileName, text, languageVersion, true);
      return original(fileName, languageVersion, onError, shouldCreate);
    };
    const program = ts.createProgram([...sources.keys()], options, host);
    const analyzer = new Analyzer(program);
    graphIds = [...analyzer.extract().nodes.keys()];
    const appName = path.join(dir, 'app.ts');
    transformed = transformUseInterfaceCalls(FILES['app.ts'], appName, options) ?? FILES['app.ts'];
  });

  afterAll(() => {
    TSContext.reset();
    rmSync(dir, { recursive: true, force: true });
  });

  it('T02-parity les ids du transform sont ceux de l’analyseur', () => {
    const repoIds = ids(transformed, /Repo_[0-9a-f]{8}/g);
    const portIds = ids(transformed, /Port_[0-9a-f]{8}/g);
    const propertyIds = ids(transformed, /PropertyToken:Api\.secret_[0-9a-f]{8}/g);
    expect(new Set(repoIds).size).toBe(2);
    expect(new Set(portIds).size).toBe(2);
    expect(new Set(propertyIds).size).toBe(2);
    for (const id of [...repoIds, ...portIds, ...propertyIds]) {
      expect(graphIds).toContain(id);
    }
  });

  it('T02-P23 une collision de hash entre fichiers lève NEO_TOKEN_COLLISION', () => {
    const options: ts.CompilerOptions = {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      strict: true,
    };
    const hash = { hash: () => 'aaaaaaaa' };
    const sourceOf = (field: string): string => `
      import { useInterface } from '@djodjonx/neosyringe';
      export interface Port { ${field} }
      function useInterface<T>(): T { return null!; }
      export const token = useInterface<Port>();
    `;
    const leftId = path.join(dir, 'left-collision.ts');
    const rightId = path.join(dir, 'right-collision.ts');
    const usedTokens = new Map<string, UsedTokenEntry>();
    const left = transformUseInterfaceCalls(sourceOf('a: string'), leftId, options, usedTokens, hash);
    expect(left).toMatch(/Port_[0-9a-f]{8}/);
    let thrown: unknown;
    try {
      transformUseInterfaceCalls(sourceOf('b: number'), rightId, options, usedTokens, hash);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(NeoTokenError);
    expect((thrown as NeoTokenError).code).toBe('NEO_TOKEN_COLLISION');
    const message = (thrown as Error).message;
    const stored = [...usedTokens.values()][0]?.descriptor;
    expect(message).toContain(stored);
    expect(message).toContain(' <> ');
    const next = message.split(' <> ')[1];
    expect(next).not.toBe(stored);
    expect(stored).toContain('left-collision.ts');
    expect(next).toContain('right-collision.ts');
    expect(() => {
      transformUseInterfaceCalls(sourceOf('a: string'), leftId, options, usedTokens, hash);
    }).not.toThrow();
  });
});
