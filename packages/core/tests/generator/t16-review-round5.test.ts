import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as ts from 'typescript';
import { hasText, textAt, virtualResolved } from '../helpers/tsPath';
import { Analyzer } from '../../src/analyzer/Analyzer';
import type { DependencyGraph } from '../../src/analyzer/types';
import { Generator } from '../../src/generator/Generator';
import { createFastProgram, warmLibCache } from '../fastProgram';

const ROOT = '/virtual/t16-r5';

const STUB = `
  import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';
  function defineBuilderConfig(config: any) { return config; }
  function useInterface<T>(): any { return null; }
`;

function source(body: string): string {
  return `${STUB}\n${body}\n`;
}

const LIB = path.join(ROOT, 'lib.d.ts');
const DECLARED = path.join(ROOT, 'declared.ts');
const MIXIN = path.join(ROOT, 'mixin-host.ts');
const COMPUTED = path.join(ROOT, 'computed-host.ts');
const DECORATED = path.join(ROOT, 'decorated-host.ts');
const DEFINITION = path.join(ROOT, 'definition.ts');

const files = new Map<string, string>([
  [LIB, `
    export declare class LibHeavy { payload: string; }
    export declare const libMarker: number;
  `],
  [DECLARED, source(`
    import { LibHeavy } from './lib';
    interface DeclRoot { ok: number }
    const root = useInterface<DeclRoot>();
    export const declared = defineBuilderConfig({
      name: 'Declared',
      optimization: { mode: 'closed', roots: [root] },
      injections: [
        { token: root, useFactory: true, dependencies: [], provider: () => ({ ok: 1 }) },
        { token: LibHeavy, provider: LibHeavy },
      ],
    });
  `)],
  [MIXIN, `
    function mixin(base: new () => object): new () => object { return base; }
    export class MixinHost extends mixin(Object) {
      constructor() {}
    }
  `],
  [COMPUTED, `
    function side(): string { return 'm'; }
    export class ComputedHost {
      [side()](): number { return 1; }
    }
  `],
  [DECORATED, `
    function mark(_target: unknown, _key: string | undefined, _index: number): void {}
    export class DecoratedHost {
      constructor(@mark _value?: number) {}
    }
  `],
  [DEFINITION, source(`
    import { MixinHost } from './mixin-host';
    import { ComputedHost } from './computed-host';
    import { DecoratedHost } from './decorated-host';
    interface DefRoot { ok: number }
    const root = useInterface<DefRoot>();
    export const definition = defineBuilderConfig({
      name: 'Definition',
      optimization: { mode: 'closed', roots: [root] },
      injections: [
        { token: root, useFactory: true, dependencies: [], provider: () => ({ ok: 1 }) },
        { token: MixinHost, provider: MixinHost },
        { token: ComputedHost, provider: ComputedHost },
        { token: DecoratedHost, provider: DecoratedHost },
      ],
    });
  `)],
]);

interface RuntimeContainer {
  initialize: () => Promise<void>;
  resolve: (token: string) => unknown;
  destroy: () => Promise<void>;
}

interface Loads {
  declaration: number;
  mixin: number;
  computed: number;
  decorated: number;
}

const opened: RuntimeContainer[] = [];

function programFrom(sources: Map<string, string>): ts.Program {
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Node10,
    experimentalDecorators: true,
    strict: true,
    noImplicitAny: false,
  };
  const host = ts.createCompilerHost(options);
  const read = host.getSourceFile.bind(host);
  const exists = host.fileExists.bind(host);
  const readFile = host.readFile.bind(host);
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreateNewSourceFile) => {
    const text = textAt(sources, fileName);
    if (text !== undefined) return ts.createSourceFile(fileName, text, languageVersion, true);
    return read(fileName, languageVersion, onError, shouldCreateNewSourceFile);
  };
  host.fileExists = (fileName) => hasText(sources, fileName) || exists(fileName);
  host.readFile = (fileName) => textAt(sources, fileName) ?? readFile(fileName);
  host.resolveModuleNames = (moduleNames, containingFile) => moduleNames.map((moduleName) => {
    const candidate = virtualResolved(sources, containingFile, moduleName, ['.ts', '.d.ts']);
    if (candidate !== undefined) {
      const extension = candidate.endsWith('.d.ts') ? ts.Extension.Dts : ts.Extension.Ts;
      return { resolvedFileName: candidate, extension, isExternalLibraryImport: false };
    }
    return ts.resolveModuleName(moduleName, containingFile, options, host).resolvedModule;
  });
  return createFastProgram([...sources.keys()], options, host);
}

function tokenId(graph: DependencyGraph, name: string): string {
  const found = [...graph.nodes.keys()].find((id) => id.includes(name));
  if (!found) throw new Error(`missing token ${name}`);
  return found;
}

function named(map: Map<string, DependencyGraph>, name: string): DependencyGraph {
  for (const graph of map.values()) {
    if (graph.containerId === name) return graph;
  }
  throw new Error(`missing graph ${name}`);
}

function unreachableIn(graph: DependencyGraph, fileName: string): number {
  let count = 0;
  for (const node of graph.nodes.values()) {
    const declared = node.service.implementationSymbol?.declarations?.[0]?.getSourceFile().fileName;
    if (declared !== fileName) continue;
    const id = node.service.registrationId ?? node.service.tokenId;
    if (graph.retention?.get(id)?.kind === 'unreachable') count += 1;
  }
  return count;
}

function execute(graph: DependencyGraph, loads: Loads): { container: RuntimeContainer; code: string } {
  const generator = new Generator(graph, true);
  const tsCode = `${generator.generate()}\nexport const container = ${generator.generateInstantiation()};`;
  const jsCode = ts.transpileModule(tsCode, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const moduleRecord: { exports: { container?: RuntimeContainer } } = { exports: {} };
  const run = new Function('module', 'exports', 'require', jsCode) as (
    module: typeof moduleRecord,
    exports: typeof moduleRecord.exports,
    require: (id: string) => unknown,
  ) => void;
  run(moduleRecord, moduleRecord.exports, (id: string) => {
    if (id.includes('lib.d') || id.endsWith('/lib.d') || id.endsWith('\\lib.d')) loads.declaration += 1;
    if (id.includes('mixin-host')) loads.mixin += 1;
    if (id.includes('computed-host')) loads.computed += 1;
    if (id.includes('decorated-host')) loads.decorated += 1;
    return {};
  });
  const container = moduleRecord.exports.container;
  if (!container) throw new Error(`generated module did not export container for ${graph.containerId}`);
  opened.push(container);
  return { container, code: tsCode };
}

describe('T16 review round 5', () => {
  let graphs: Map<string, DependencyGraph>;

  beforeAll(() => {
    warmLibCache();
    const program = programFrom(files);
    graphs = new Map();
    for (const graph of new Analyzer(program).extractAll()) {
      graphs.set(graph.sourceFileName ?? graph.containerId, graph);
    }
  });

  afterEach(async () => {
    const pending = opened.splice(0);
    for (const container of pending) {
      await container.destroy();
    }
  });

  it('T16 declaration file has no load import', () => {
    const graph = named(graphs, 'Declared');
    expect(unreachableIn(graph, LIB)).toBe(1);
    const loads: Loads = { declaration: 0, mixin: 0, computed: 0, decorated: 0 };
    const { container, code } = execute(graph, loads);
    const importLines = code.split('\n').filter((line) => line.includes('import'));
    expect(importLines.some((line) => /['"][^'"]*\.d(?:\.ts)?['"]/.test(line))).toBe(false);
    expect(loads.declaration).toBe(0);
    expect(container.resolve(tokenId(graph, 'DeclRoot'))).toEqual({ ok: 1 });
  });

  it('T16 class definition effect', () => {
    const graph = named(graphs, 'Definition');
    expect(unreachableIn(graph, MIXIN)).toBe(1);
    expect(unreachableIn(graph, COMPUTED)).toBe(1);
    expect(unreachableIn(graph, DECORATED)).toBe(1);
    const loads: Loads = { declaration: 0, mixin: 0, computed: 0, decorated: 0 };
    const { container } = execute(graph, loads);
    expect(loads.mixin).toBe(1);
    expect(loads.computed).toBe(1);
    expect(loads.decorated).toBe(1);
    expect(container.resolve(tokenId(graph, 'DefRoot'))).toEqual({ ok: 1 });
  });
});
