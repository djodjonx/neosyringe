import { afterEach, describe, expect, it } from 'vitest';
import * as ts from 'typescript';
import { Analyzer } from '../../src/analyzer/Analyzer';
import { Generator } from '../../src/generator/Generator';
import {
  copyFromSnapshot,
  generatedCopy,
  render,
  snapshotOfFiles,
  type Part,
} from '../../src/generator/fragments';
import type { DependencyGraph, DependencyNode, SourceOrigin, SourceRewrite } from '../../src/analyzer/types';
import { createVirtualProgram } from '../helpers/createVirtualProgram';

/** The type a generated factory declaration carries: the user text is assigned to it, so it is checked against it. */
const FACTORY_TYPE = '(context: { readonly signal: NeoContainerSignal; resolve<T>(token: unknown): T; resolveAll<T>(token: unknown): T[]; resolveMany<const T extends readonly __NeoToken<unknown>[]>(tokens: T): __NeoValues<T>; resolveMany<const T extends readonly (__NeoToken<unknown> | string)[]>(tokens: T): { -readonly [K in keyof T]: T[K] extends infer E ? E extends string ? unknown : E extends __NeoToken<infer V> ? V : never : never } }) => unknown';

interface RuntimeContainer {
  resolve: (token: unknown) => unknown;
  destroy: () => Promise<void>;
}

const opened: RuntimeContainer[] = [];

afterEach(async () => {
  for (const container of opened.splice(0)) await container.destroy().catch(() => undefined);
});

function load(code: string): RuntimeContainer {
  const js = ts.transpileModule(code, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const record: { exports: Record<string, RuntimeContainer | undefined> } = { exports: {} };
  const run = new Function('module', 'exports', 'require', js) as (
    module: typeof record,
    exports: typeof record.exports,
    require: (id: string) => unknown,
  ) => void;
  run(record, record.exports, () => ({}));
  const container = record.exports.container;
  if (!container) throw new Error('generated module did not export container');
  opened.push(container);
  return container;
}

const SOURCE = `
  import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';
  function defineBuilderConfig(c: any) { return c; }
  function useInterface<T>(): any { return null; }
  interface Port { n: number }
  interface Settings { name: string }
  export const container = defineBuilderConfig({
    injections: [
      { token: useInterface<Settings>(), useValue: { name: 'prod' } },
      { token: useInterface<Port>(), useFactory: true, dependencies: [], provider: () => ({ n: 1 }) },
    ],
  });
`;

function analysed(): DependencyGraph {
  const graph = new Analyzer(createVirtualProgram('container.ts', SOURCE, {})).extract();
  expect(graph.errors ?? []).toHaveLength(0);
  return graph;
}

function serviceOf(graph: DependencyGraph, name: string): DependencyNode['service'] {
  const found = [...graph.nodes.values()].find((node) => node.service.tokenId.includes(name));
  if (!found) throw new Error(`missing ${name}`);
  return found.service;
}

/** The rewrite of the first `find` inside `within`, as absolute offsets of SOURCE. */
function rewriteOf(within: string, find: string, text: string): SourceRewrite {
  const base = SOURCE.indexOf(within);
  const at = base + within.indexOf(find);
  return { start: at, end: at + find.length, text };
}

const notTheValue = (text: string): boolean => text !== "{ name: 'prod' }";

function copiedTexts(copies: readonly { sourceStart: number; length: number }[]): string[] {
  return copies.map((copy) => SOURCE.slice(copy.sourceStart, copy.sourceStart + copy.length));
}

describe('T23-S2 a rewrite is data on the graph: the text around it is still a copy', () => {
  it('T23-S2-P5 a factory with a rewrite renders as source parts around a generated part', () => {
    const graph = analysed();
    const factory = serviceOf(graph, 'Port');
    factory.factoryRewrites = [rewriteOf('() => ({ n: 1 })', '1', '99')];
    const rendered = new Generator(graph, false).generateRendered();
    expect(rendered.code).toContain(`const userFactory: ${FACTORY_TYPE} = () => ({ n: 99 });`);
    expect(copiedTexts(rendered.copies).filter(notTheValue)).toEqual(['() => ({ n: ', ' })']);
    expect(rendered.copies.map((copy) => rendered.code.slice(copy.generatedStart, copy.generatedStart + copy.length)))
      .toContain('() => ({ n: ');
    expect(load(rendered.code).resolve(factory.tokenId)).toEqual({ n: 99 });
  });

  it('T23-S2-P5 the original text stays on the graph, the rewrite is not written into it', () => {
    const graph = analysed();
    const factory = serviceOf(graph, 'Port');
    factory.factoryRewrites = [rewriteOf('() => ({ n: 1 })', '1', '99')];
    new Generator(graph, false).generateRendered();
    expect(factory.factorySource).toBe('() => ({ n: 1 })');
  });

  it('T23-S2-P5 a useValue with a rewrite renders as source parts around a generated part', () => {
    const graph = analysed();
    const value = serviceOf(graph, 'Settings');
    value.valueRewrites = [rewriteOf("{ name: 'prod' }", "'prod'", "'dev'")];
    const rendered = new Generator(graph, false).generateRendered();
    expect(rendered.code).toContain("{ name: 'dev' }");
    expect(rendered.code).not.toContain("'prod'");
    expect(copiedTexts(rendered.copies).filter((text) => !text.includes('=>'))).toEqual(['{ name: ', ' }']);
    expect(load(rendered.code).resolve(value.tokenId)).toEqual({ name: 'dev' });
  });

  it('T23-S2-P5 two rewrites in one factory leave three source parts', () => {
    const graph = analysed();
    const factory = serviceOf(graph, 'Port');
    factory.factoryRewrites = [rewriteOf('() => ({ n: 1 })', '()', '(a)'), rewriteOf('() => ({ n: 1 })', '1', '7')];
    const rendered = new Generator(graph, false).generateRendered();
    expect(rendered.code).toContain(`const userFactory: ${FACTORY_TYPE} = (a) => ({ n: 7 });`);
    expect(copiedTexts(rendered.copies).filter(notTheValue)).toEqual([' => ({ n: ', ' })']);
  });

  it('T23-S2-P5 a graph without a snapshot applies the rewrite as text and claims no copy', () => {
    const origin: SourceOrigin = { file: 'hand.ts', start: 10, length: 12 };
    const graph: DependencyGraph = {
      containerId: 'T23',
      nodes: new Map([['Local', {
        service: {
          tokenId: 'Local',
          type: 'factory',
          factorySource: '() => ({ n:1})',
          factoryOrigin: { ...origin, length: 14 },
          factoryRewrites: [{ start: 21, end: 22, text: '5' }],
          lifecycle: 'singleton',
          isInterfaceToken: true,
          registrationNode: {} as ts.Node,
        },
        dependencies: [],
      } satisfies DependencyNode]]),
      roots: ['Local'],
      exportedVariableName: 'container',
      variableExportModifier: 'export',
    };
    const rendered = new Generator(graph, false).generateRendered();
    expect(rendered.code).toContain(`const userFactory: ${FACTORY_TYPE} = () => ({ n:5});`);
    expect(rendered.copies).toEqual([]);
  });
});

describe('T23-S2 a useValue read without a capture applies its rewrite too', () => {
  it('T23-S2-P5 a hand-built useValue with an origin and a rewrite is emitted with the rewrite and no copy', () => {
    const graph: DependencyGraph = {
      containerId: 'T23',
      nodes: new Map([['Local', {
        service: {
          tokenId: 'Local',
          type: 'value',
          valueSource: '{ a: 1 }',
          valueOrigin: { file: 'hand.ts', start: 4, length: 8 },
          valueRewrites: [{ start: 9, end: 10, text: '5' }],
          lifecycle: 'singleton',
          isInterfaceToken: true,
          registrationNode: {} as ts.Node,
        },
        dependencies: [],
      } satisfies DependencyNode]]),
      roots: ['Local'],
      exportedVariableName: 'container',
      variableExportModifier: 'export',
    };
    const rendered = new Generator(graph, false).generateRendered();
    expect(rendered.code).toContain('{ a: 5 }');
    expect(rendered.code).not.toContain('{ a: 1 }');
    expect(rendered.copies).toEqual([]);
    expect(load(rendered.code).resolve('Local')).toEqual({ a: 5 });
  });
});

describe('T23-S2 copyFromSnapshot splits a copy at its rewrites', () => {
  const FILE = 'f.ts';
  const TEXT = 'aaa(BBB)ccc';
  const origin: SourceOrigin = { file: FILE, start: 3, length: 5 };
  const snapshot = snapshotOfFiles(new Map([[FILE, TEXT]]));
  const split = (rewrites: readonly SourceRewrite[]): { code: string; copies: readonly string[] } => {
    const parts = copyFromSnapshot(snapshot)('(BBB)', origin, rewrites);
    const rendered = render(parts, snapshot);
    return {
      code: rendered.code,
      copies: rendered.copies.map((copy) => TEXT.slice(copy.sourceStart, copy.sourceStart + copy.length)),
    };
  };

  it('T23-S2-P5 a rewrite in the middle', () => {
    expect(split([{ start: 4, end: 7, text: '"X"' }])).toEqual({ code: '("X")', copies: ['(', ')'] });
  });

  it('T23-S2-P5 a rewrite at the first character leaves no empty source part', () => {
    const parts = copyFromSnapshot(snapshot)('(BBB)', origin, [{ start: 3, end: 4, text: '[' }]);
    expect(parts.every((part) => part.kind === 'generated' || part.length > 0)).toBe(true);
    expect(split([{ start: 3, end: 4, text: '[' }])).toEqual({ code: '[BBB)', copies: ['BBB)'] });
  });

  it('T23-S2-P5 a rewrite at the last character', () => {
    expect(split([{ start: 7, end: 8, text: ']' }])).toEqual({ code: '(BBB]', copies: ['(BBB'] });
  });

  it('T23-S2-P5 a rewrite of the whole range leaves no copy', () => {
    expect(split([{ start: 3, end: 8, text: 'Z' }])).toEqual({ code: 'Z', copies: [] });
  });

  it('T23-S2-P5 an insertion (start = end) splits the copy and removes nothing', () => {
    expect(split([{ start: 4, end: 4, text: '/*p*/' }])).toEqual({ code: '(/*p*/BBB)', copies: ['(', 'BBB)'] });
  });

  it('T23-S2-P5 rewrites are applied in the order of their position, whatever the order given', () => {
    const rewrites = [{ start: 7, end: 8, text: ']' }, { start: 3, end: 4, text: '[' }];
    expect(split(rewrites)).toEqual({ code: '[BBB]', copies: ['BBB'] });
  });

  it('T23-S2-P5 a rewrite that starts inside the previous one is skipped', () => {
    const rewrites = [{ start: 4, end: 6, text: 'X' }, { start: 5, end: 7, text: 'Y' }];
    expect(split(rewrites)).toEqual({ code: '(XB)', copies: ['(', 'B)'] });
  });

  it('T23-S2-P5 a rewrite outside the range of the copy is ignored', () => {
    const rewrites = [{ start: 0, end: 2, text: 'Q' }, { start: 9, end: 10, text: 'Q' }];
    expect(split(rewrites)).toEqual({ code: '(BBB)', copies: ['(BBB)'] });
  });

  it('T23-S2-P5 text the snapshot does not hold is generated text with the rewrite applied, no copy', () => {
    const other = snapshotOfFiles(new Map([[FILE, 'aaa(CCC)ccc']]));
    const parts: readonly Part[] = copyFromSnapshot(other)('(BBB)', origin, [{ start: 4, end: 7, text: '"X"' }]);
    expect(render(parts, other)).toEqual({ code: '("X")', copies: [] });
  });

  it('T23-S2-P5 generatedCopy applies the rewrite as text and never claims a copy', () => {
    const parts = generatedCopy('(BBB)', origin, [{ start: 4, end: 7, text: '"X"' }]);
    expect(parts).toEqual([{ kind: 'generated', text: '("X")' }]);
  });
});

describe('T23-S2 the snapshot a caller passes is the one the parts are cut from and rendered with (S1 R5)', () => {
  it('T23-S2-R5 a file only the passed snapshot holds is copied from it', () => {
    const graph = analysed();
    const factory = serviceOf(graph, 'Port');
    const origin = factory.factoryOrigin;
    if (!origin) throw new Error('missing origin');
    const moved: DependencyGraph = {
      ...graph,
      nodes: new Map([...graph.nodes].map(([id, node]) => [id, node.service === factory
        ? {
          ...node,
          service: { ...node.service, factoryOrigin: { ...origin, file: 'elsewhere.ts' }, registrationNode: {} as ts.Node },
        }
        : node])),
    };
    const alone = new Generator(moved, false).generateRendered();
    expect(copiedTexts(alone.copies)).not.toContain('() => ({ n: 1 })');
    const held = snapshotOfFiles(new Map([['elsewhere.ts', SOURCE]]));
    const passed = new Generator(moved, false, undefined, true, false, undefined, undefined, { snapshot: held })
      .generateRendered();
    expect(passed.copies.filter((copy) => copy.sourceFile === 'elsewhere.ts').map((copy) => copy.length))
      .toEqual(['() => ({ n: 1 })'.length]);
    expect(passed.code).toBe(alone.code);
  });

  it('T23-S2-R5 parts cut from one snapshot are refused by the render of another', () => {
    const first = snapshotOfFiles(new Map([['f.ts', 'one two']]));
    const second = snapshotOfFiles(new Map([['f.ts', 'one twi']]));
    expect(second.id).not.toBe(first.id);
    const parts = copyFromSnapshot(first)('two', { file: 'f.ts', start: 4, length: 3 });
    expect(render(parts, first).code).toBe('two');
    expect(() => render(parts, second)).toThrow('stale source snapshot');
  });

  it('T23-S2-R5 a passed snapshot whose text moved copies nothing, and the code is unchanged', () => {
    const graph = analysed();
    const moved = snapshotOfFiles(new Map([['container.ts', `// moved\n${SOURCE}`]]));
    const rendered = new Generator(graph, false, undefined, true, false, undefined, undefined, { snapshot: moved })
      .generateRendered();
    expect(rendered.copies).toEqual([]);
    expect(rendered.code).toBe(new Generator(graph, false).generate());
  });
});
