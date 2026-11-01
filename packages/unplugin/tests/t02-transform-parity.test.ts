import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import ts from 'typescript';
import { Analyzer, NeoTokenError } from '@djodjonx/neosyringe-core/analyzer';
import { TSContext } from '@djodjonx/neosyringe-core/context';
import { collectUseSiteEdits, type SourceEdit, type UsedTokenEntry } from '../src/useInterfaceTransform';

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
        { token: useProperty<string>(LeftApi, 'secret'), dependencies: [], provider: () => 'alpha' },
        { token: useProperty<string>(RightApi, 'secret'), dependencies: [], provider: () => 'beta' },
        { token: LeftApi },
        { token: RightApi },
      ],
    });
  `,
};

function ids(source: string, pattern: RegExp): string[] {
  return [...source.matchAll(pattern)].map((match) => match[0]);
}

function applyEdits(code: string, edits: readonly SourceEdit[]): string {
  let result = code;
  for (const edit of [...edits].sort((a, b) => b.start - a.start)) {
    result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
  }
  return result;
}

// These fixtures only need the NeoSyringe markers. Default options parse lib.d.ts
// on every createProgram. One host caches those source files, and each program
// is built from the previous one.
const memoryFiles = new Map<string, string>();
const sourceCache = new Map<string, ts.SourceFile>();
let sharedHost: ts.CompilerHost | undefined;
let previousProgram: ts.Program | undefined;

const NEO_STUB = [
  'export function defineBuilderConfig(config: object): object { return config; }',
  'export function useInterface<T>(): T { return null!; }',
  'export function useProperty<T>(type: unknown, name: string): T { return null!; }',
  '',
].join('\n');

function remember(fileName: string, text: string): void {
  const key = path.normalize(fileName);
  if (memoryFiles.get(key) !== text) sourceCache.delete(key);
  memoryFiles.set(key, text);
}

function textOf(fileName: string): string | undefined {
  return memoryFiles.get(path.normalize(fileName));
}

function hostFor(options: ts.CompilerOptions): ts.CompilerHost {
  if (sharedHost) return sharedHost;
  const host = ts.createCompilerHost(options);
  const readSource = host.getSourceFile.bind(host);
  const readFile = host.readFile.bind(host);
  const fileExists = host.fileExists.bind(host);
  host.fileExists = (fileName) => textOf(fileName) !== undefined || fileExists(fileName);
  host.readFile = (fileName) => textOf(fileName) ?? readFile(fileName);
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreateNewSourceFile) => {
    const key = path.normalize(fileName);
    const text = textOf(fileName);
    if (!shouldCreateNewSourceFile) {
      const hit = sourceCache.get(key);
      if (hit && (text === undefined || hit.text === text)) return hit;
    }
    const created = text !== undefined
      ? ts.createSourceFile(fileName, text, languageVersion, true)
      : readSource(fileName, languageVersion, onError, shouldCreateNewSourceFile);
    if (created && !shouldCreateNewSourceFile) sourceCache.set(path.normalize(created.fileName), created);
    return created;
  };
  sharedHost = host;
  return host;
}

function programFor(rootNames: readonly string[], options: ts.CompilerOptions): ts.Program {
  const program = ts.createProgram([...rootNames], options, hostFor(options), previousProgram);
  previousProgram = program;
  return program;
}

function editsOf(
  code: string,
  fileName: string,
  options: ts.CompilerOptions,
  usedTokens?: Map<string, UsedTokenEntry>,
  hash?: (value: string) => string,
): SourceEdit[] {
  remember(fileName, code);
  const program = programFor([fileName], options);
  const sourceFile = program.getSourceFile(fileName);
  if (!sourceFile) throw new Error(`fichier absent du programme: ${fileName}`);
  return collectUseSiteEdits(sourceFile, program.getTypeChecker(), usedTokens, hash ? { hash } : undefined);
}

describe('T02 parité du transform', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 't02-parity-'));
  const stubName = path.join(dir, 'neo-stub.ts');
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
    noLib: true,
    types: [],
    baseUrl: dir,
    paths: {
      '@djodjonx/neosyringe': ['./neo-stub.ts'],
    },
  };
  let transformed = '';
  let graphIds: string[] = [];

  beforeAll(() => {
    TSContext.projectRoot = dir;
    writeFileSync(stubName, NEO_STUB);
    remember(stubName, NEO_STUB);
    const roots: string[] = [];
    for (const [name, source] of Object.entries(FILES)) {
      const fileName = path.join(dir, name);
      writeFileSync(fileName, source);
      remember(fileName, source);
      roots.push(fileName);
    }
    const program = programFor(roots, options);
    const analyzer = new Analyzer(program);
    graphIds = [...analyzer.extract().nodes.keys()];
    const appName = path.join(dir, 'app.ts');
    const appFile = program.getSourceFile(appName);
    transformed = appFile
      ? applyEdits(FILES['app.ts'], collectUseSiteEdits(appFile, program.getTypeChecker()))
      : FILES['app.ts'];
  });

  afterAll(() => {
    TSContext.reset();
    rmSync(dir, { recursive: true, force: true });
    memoryFiles.clear();
    sourceCache.clear();
    sharedHost = undefined;
    previousProgram = undefined;
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
    const leftCode = sourceOf('a: string');
    const left = applyEdits(leftCode, editsOf(leftCode, leftId, options, usedTokens, hash.hash));
    expect(left).toMatch(/Port_[0-9a-f]{8}/);
    let thrown: unknown;
    try {
      const rightCode = sourceOf('b: number');
      editsOf(rightCode, rightId, options, usedTokens, hash.hash);
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
      const again = sourceOf('a: string');
      editsOf(again, leftId, options, usedTokens, hash.hash);
    }).not.toThrow();
  });
});
