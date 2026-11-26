import { afterEach, describe, expect, it } from 'vitest';
import * as ts from 'typescript';
import { Analyzer } from '../../src/analyzer/Analyzer';
import { Generator } from '../../src/generator/Generator';
import { generateFactories, resolveConstructorArgs } from '../../src/generator/FactoryEmitter';
import type { DependencyGraph, DependencyNode, FactoryDependency, RetentionReason } from '../../src/analyzer/types';
import { createVirtualProgram } from '../helpers/createVirtualProgram';
import { captureRoot, memoryProgram } from '../helpers/memoryModules';

/** The type a generated factory declaration carries: the user text is assigned to it, so it is checked against it. */
/** The context type a factory is written against, with the names of the two `resolveMany` aliases. */
function factoryTypeWith(token: string, values: string): string {
  return `(context: { resolve<T>(token: unknown): T; resolveAll<T>(token: unknown): T[]; resolveMany<const T extends readonly ${token}<unknown>[]>(tokens: T): ${values}<T>; resolveMany<const T extends readonly (${token}<unknown> | string)[]>(tokens: T): { -readonly [K in keyof T]: T[K] extends infer E ? E extends string ? unknown : E extends ${token}<infer V> ? V : never : never } }) => unknown`;
}

const FACTORY_TYPE = factoryTypeWith('__NeoToken', '__NeoValues');

interface RuntimeContainer {
  resolve: (token: unknown) => unknown;
  resolveAll: (token: unknown) => unknown[];
  destroy: () => Promise<void>;
}

const opened: RuntimeContainer[] = [];

afterEach(async () => {
  for (const container of opened.splice(0)) await container.destroy().catch(() => undefined);
});

function load(code: string, bound: Record<string, unknown> = {}): RuntimeContainer {
  const js = ts.transpileModule(code, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const record: { exports: Record<string, RuntimeContainer | undefined> } = { exports: {} };
  const run = new Function('module', 'exports', 'require', ...Object.keys(bound), js) as (
    module: typeof record,
    exports: typeof record.exports,
    require: (id: string) => unknown,
    ...values: unknown[]
  ) => void;
  run(record, record.exports, () => ({}), ...Object.values(bound));
  const container = record.exports.container;
  if (!container) throw new Error('generated module did not export container');
  opened.push(container);
  return container;
}

function registrationNode(): ts.Node {
  return {} as ts.Node;
}

function dep(tokenId: string, all = false): FactoryDependency {
  return { tokenId, all, source: JSON.stringify(tokenId), containerId: 'T23' };
}

function factoryNode(tokenId: string, factorySource: string, deps: FactoryDependency[] = []): DependencyNode {
  return {
    service: {
      tokenId,
      type: 'factory',
      factorySource,
      lifecycle: 'singleton',
      isInterfaceToken: true,
      ownership: 'owned',
      factoryDependencies: deps,
      registrationNode: registrationNode(),
    },
    dependencies: deps.map((item) => item.tokenId),
  };
}

function valueNode(tokenId: string, valueSource: string, extra: Partial<DependencyNode['service']> = {}): DependencyNode {
  return {
    service: {
      tokenId,
      type: 'value',
      valueSource,
      lifecycle: 'singleton',
      isInterfaceToken: true,
      registrationNode: registrationNode(),
      ...extra,
    },
    dependencies: [],
  };
}

function graphOf(
  nodes: Array<[string, DependencyNode]>,
  extra: Partial<DependencyGraph> = {},
): DependencyGraph {
  return {
    containerId: 'T23',
    nodes: new Map(nodes),
    roots: nodes.map(([id]) => id),
    exportedVariableName: 'container',
    variableExportModifier: 'export',
    ...extra,
  };
}

const NAMES_A_HELPER = 'this._resolveInternal( this._resolveAllInternal(';

describe('T23 helpers come from needs, never from text (P1)', () => {
  it.each([
    ['a factory', factoryNode('Local', `() => ({ text: '${NAMES_A_HELPER}' })`)],
    ['a useValue', valueNode('Local', `{ text: '${NAMES_A_HELPER}' }`)],
  ])('T23-P1 user text naming a helper activates none: %s', (_label, node) => {
    const graph = graphOf([['Local', node]], { optimizationMode: 'closed', publicRoots: ['Local'] });
    const code = new Generator(graph, false).generate();
    expect(code).not.toContain('private _resolveInternal<T>(');
    expect(code).not.toContain('private _resolveAllInternal<T>(');
    expect(load(code).resolve('Local')).toEqual({ text: NAMES_A_HELPER });
  });

  it('T23-P1 a factory that reads a parent token declares _resolveInternal and reaches the parent', () => {
    const graph = graphOf(
      [['Consumer', factoryNode('Consumer', '(ctx) => ({ p: ctx.resolve("Parent_1") })', [dep('Parent_1')])]],
      { optimizationMode: 'closed', publicRoots: ['Consumer'], legacyContainers: ['parent'] },
    );
    const code = new Generator(graph, false).generate();
    expect(code).toContain('private _resolveInternal<T>(');
    expect(code).not.toContain('private _resolveAllInternal<T>(');
    const parent = { resolve: (token: unknown) => (token === 'Parent_1' ? 'from-parent' : undefined) };
    expect(load(code, { parent }).resolve('Consumer')).toEqual({ p: 'from-parent' });
  });

  it('T23-P1 a factory that reads a multi token declares _resolveAllInternal and lists it', () => {
    const graph = graphOf(
      [['Consumer', factoryNode(
        'Consumer',
        '(ctx) => ({ items: ctx.resolveAll("Item_1") })',
        [dep('Item_1', true)],
      )]],
      {
        optimizationMode: 'closed',
        publicRoots: ['Consumer'],
        multiNodes: new Map([['Item_1', [
          factoryNode('Item_1', '() => ({ n: 1 })'),
          factoryNode('Item_1', '() => ({ n: 2 })'),
        ]]]),
      },
    );
    const code = new Generator(graph, false).generate();
    expect(code).toContain('private _resolveAllInternal<T>(');
    expect(load(code).resolve('Consumer')).toEqual({ items: [{ n: 1 }, { n: 2 }] });
  });

  it('T23-P1 an open optimized container declares both helpers its public methods call', () => {
    const graph = graphOf([['Local', factoryNode('Local', '() => ({ n: 7 })')]]);
    const code = new Generator(graph, false, undefined, false, false, 'optimized').generate();
    expect(code).toContain('private _resolveInternal<T>(');
    expect(code).toContain('private _resolveAllInternal<T>(');
    expect(load(code).resolve('Local')).toEqual({ n: 7 });
    expect(load(code).resolveAll('Local')).toEqual([]);
  });
});

describe('T23 a hoisted useValue is chosen by a flag, not by the generated name (B2)', () => {
  it('T23-B2 a capture without the read flag is hoisted, whatever its name', () => {
    const graph = graphOf([['Port_1', valueNode('Port_1', '"hoisted-value"', { valueCapture: 'plainName' })]]);
    const code = new Generator(graph, false).generate();
    expect(code).toContain('const plainName = "hoisted-value";');
    expect(load(code).resolve('Port_1')).toBe('hoisted-value');
  });

  it('T23-B2 a capture marked as a read is never hoisted, even when it looks generated', () => {
    const graph = graphOf([[
      'Port_1',
      valueNode('Port_1', '"must-not-be-hoisted"', {
        valueCapture: '__neoCapture_lookalike',
        valueCaptureRead: true,
      }),
    ]]);
    const code = new Generator(graph, false).generate();
    expect(code).not.toContain('const __neoCapture_lookalike');
    const prelude = 'const __neoCapture_lookalike = "read-value";\n';
    expect(load(`${prelude}${code}`).resolve('Port_1')).toBe('read-value');
  });

  it('T23-B2 a pruned capture marked as a read is read once, not hoisted', () => {
    const graph = graphOf(
      [
        ['Port_1', valueNode('Port_1', '"unused"', {
          valueCapture: '__neoCapture_lookalike',
          valueCaptureRead: true,
          registrationId: 'r1',
        })],
        ['Keep_1', factoryNode('Keep_1', '() => ({ keep: true })')],
      ],
      {
        optimizationMode: 'closed',
        publicRoots: ['Keep_1'],
        retention: new Map<string, RetentionReason>([['r1', { kind: 'unreachable' }]]),
      },
    );
    const code = new Generator(graph, false).generate();
    expect(code).toContain('void __neoCapture_lookalike;');
    expect(code).not.toContain('const __neoCapture_lookalike');
    const prelude = 'const __neoCapture_lookalike = "read-value";\n';
    expect(load(`${prelude}${code}`).resolve('Keep_1')).toEqual({ keep: true });
  });
});

const SOURCE = `
  import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';
  function defineBuilderConfig(c: any) { return c; }
  function useInterface<T>(): any { return null; }
  interface Port { n: number }
  interface Other { n: number }
  interface Settings { name: string }
  export const container = defineBuilderConfig({
    injections: [
      { token: useInterface<Settings>(), useValue: { name: 'prod' } },
      { token: useInterface<Port>(), useFactory: true, dependencies: [], provider: () => ({ n: 1 }) },
      { token: useInterface<Other>(), useFactory: true, dependencies: [], provider: () => ({ n: 1 }) },
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

describe('T23 user expressions are copies with a source range (B2)', () => {
  it('T23-B2 the graph carries file, start and length of a provider and of a useValue', () => {
    const graph = analysed();
    const factory = serviceOf(graph, 'Port');
    const value = serviceOf(graph, 'Settings');
    const provider = '() => ({ n: 1 })';
    expect(factory.factoryOrigin).toEqual({
      file: 'container.ts',
      start: SOURCE.indexOf(provider),
      length: provider.length,
    });
    const literal = "{ name: 'prod' }";
    expect(value.valueOrigin).toEqual({
      file: 'container.ts',
      start: SOURCE.indexOf(literal),
      length: literal.length,
    });
  });

  it('T23-P10 generateRendered returns the code of generate() and one copy per user expression', () => {
    const generator = new Generator(analysed(), false);
    const rendered = generator.generateRendered();
    expect(rendered.code).toBe(generator.generate());
    const copied = rendered.copies.map((copy) => ({
      file: copy.sourceFile,
      text: SOURCE.slice(copy.sourceStart, copy.sourceStart + copy.length),
      emitted: rendered.code.slice(copy.generatedStart, copy.generatedStart + copy.length),
    }));
    expect(copied).toHaveLength(3);
    expect(copied.every((copy) => copy.file === 'container.ts' && copy.text === copy.emitted)).toBe(true);
    expect(copied.map((copy) => copy.text).sort()).toEqual([
      '() => ({ n: 1 })',
      '() => ({ n: 1 })',
      "{ name: 'prod' }",
    ]);
  });

  it('T23-B2 the same factory text used twice is two copies of two different ranges', () => {
    const rendered = new Generator(analysed(), false).generateRendered();
    const provider = '() => ({ n: 1 })';
    const first = SOURCE.indexOf(provider);
    const second = SOURCE.indexOf(provider, first + 1);
    const same = rendered.copies.filter(
      (copy) => SOURCE.slice(copy.sourceStart, copy.sourceStart + copy.length) === provider,
    );
    expect(same.map((copy) => copy.sourceStart).sort((a, b) => a - b)).toEqual([first, second]);
    expect(new Set(same.map((copy) => copy.generatedStart)).size).toBe(2);
  });

  it('T23-B2 a factory whose text was rewritten is emitted as generated text, with no copy', () => {
    const graph = analysed();
    const factory = serviceOf(graph, 'Port');
    factory.factorySource = '() => ({ n: 99 })';
    const rendered = new Generator(graph, false).generateRendered();
    expect(rendered.code).toContain(`const userFactory: ${FACTORY_TYPE} = () => ({ n: 99 });`);
    const texts = rendered.copies.map((copy) => SOURCE.slice(copy.sourceStart, copy.sourceStart + copy.length));
    expect(texts).toHaveLength(2);
    expect(texts.sort()).toEqual(['() => ({ n: 1 })', "{ name: 'prod' }"]);
    expect(load(rendered.code).resolve(factory.tokenId)).toEqual({ n: 99 });
  });

  it('T23-B2 a graph built by hand has no origin: its text is emitted and nothing is copied', () => {
    const graph = graphOf([['Local', factoryNode('Local', '() => ({ n: 3 })')]]);
    const rendered = new Generator(graph, false).generateRendered();
    expect(rendered.code).toContain(`const userFactory: ${FACTORY_TYPE} = () => ({ n: 3 });`);
    expect(rendered.copies).toEqual([]);
  });

  it('T23-B2 generating twice gives the same code and the same copies', () => {
    const generator = new Generator(analysed(), false);
    const first = generator.generateRendered();
    const second = generator.generateRendered();
    expect(second.code).toBe(first.code);
    expect(second.copies).toEqual(first.copies);
  });
});

const CLOSED_PARENT = `
  import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';
  function defineBuilderConfig(c: any) { return c; }
  function useInterface<T>(): any { return null; }
  interface ILogger { log(msg: string): void; }
  class ConsoleLogger implements ILogger { log(msg: string) { console.log(msg); } }
  const sharedKernel = defineBuilderConfig({
    injections: [{ token: useInterface<ILogger>(), provider: ConsoleLogger }],
  });
  class UserService { constructor(private logger: ILogger) {} }
  export const child = defineBuilderConfig({
    useContainer: sharedKernel,
    optimization: { mode: 'closed', roots: [UserService] },
    injections: [{ token: UserService }],
  });
`;

describe('T23 a class that reads a parent token asks for the generic resolver (B1)', () => {
  it('T23-P1 a closed class provider with a parent dependency declares _resolveInternal', () => {
    const program = createVirtualProgram('/virtual/t23/closed-parent.ts', CLOSED_PARENT, {});
    const graph = new Analyzer(program).extractAll().find((item) => item.exportedVariableName === 'child');
    if (!graph) throw new Error('missing child graph');
    expect(graph.errors ?? []).toHaveLength(0);
    const code = new Generator(graph, true).generate();
    expect(code).toMatch(/new UserService\(this\._resolveInternal\("ILogger_[a-f0-9]+"\)\)/);
    expect(code).toContain('private _resolveInternal<T>(');
    expect(code).not.toContain('private _resolveAllInternal<T>(');
  });
});

describe('T23 emitters without a copy function emit user text as generated text (B2)', () => {
  it('T23-P10 generateFactories keeps the user text and claims no copy by default', () => {
    const graph = graphOf([['Local', factoryNode('Local', '() => ({ n: 5 })')]]);
    const [created] = generateFactories(graph, ['Local'], () => 'Unused', () => 'Unused');
    expect(created.parts.every((part) => part.kind === 'generated')).toBe(true);
    expect(created.parts.map((part) => (part.kind === 'generated' ? part.text : '')).join(''))
      .toContain(`const userFactory: ${FACTORY_TYPE} = () => ({ n: 5 });`);
    // A declared factory asks for the policy and the lease of its declaration, and nothing else.
    expect(created.needs).toEqual(['factoryPolicy', 'factoryLease']);
  });

  it('T23-P10 a snapshot passed as provenance is the only place copies come from', () => {
    const graph = analysed();
    const empty = { id: 'plugin', files: new Map<string, string>() };
    const generator = new Generator(graph, false, undefined, true, false, undefined, undefined, { snapshot: empty });
    const rendered = generator.generateRendered();
    expect(rendered.copies).toEqual([]);
    expect(rendered.code).toBe(new Generator(graph, false).generate());
    const held = { id: 'plugin', files: new Map([['container.ts', SOURCE]]) };
    const copies = new Generator(graph, false, undefined, true, false, undefined, undefined, { snapshot: held })
      .generateRendered().copies;
    expect(copies).toHaveLength(3);
  });
});

describe('T23 the constructor arguments carry the helpers their text calls (R3, R4)', () => {
  const dependency = (): DependencyGraph => graphOf([
    ['Dep', factoryNode('Dep', '() => 1')],
    ['Local', factoryNode('Local', '() => 2')],
  ]);
  const wire = (hasAsync: boolean, closed: boolean): { text: string; needs: string[] } =>
    resolveConstructorArgs(['Dep'], dependency(), () => 'Unused', () => 'Unused', hasAsync, closed);

  it('T23-R4 an open sync class calls the public resolve and needs no helper', () => {
    expect(wire(false, false)).toEqual({ text: 'this.resolve("Dep")', needs: [] });
  });

  it('T23-R4 a closed class calls _resolveInternal and says so', () => {
    expect(wire(false, true)).toEqual({ text: 'this._resolveInternal("Dep")', needs: ['resolveSingle'] });
  });

  it('T23-R4 an async class calls _resolveInternal and says so', () => {
    expect(wire(true, false)).toEqual({ text: 'this._resolveInternal("Dep")', needs: ['resolveSingle'] });
  });

  it('T23-R4 a direct read of a local token calls no resolver and needs no helper', () => {
    const wired = resolveConstructorArgs(['Dep'], dependency(), () => 'Unused', () => 'Unused', false, true, { notify: false });
    expect(wired.text).not.toContain('Internal');
    expect(wired.needs).toEqual([]);
  });

  it('T23-R3 a dependency nothing registers is `undefined`: no call, no need', () => {
    const wired = resolveConstructorArgs(['Nowhere'], dependency(), () => 'Unused', () => 'Unused', false, true);
    expect(wired).toEqual({ text: 'undefined', needs: [] });
  });

  it('T23-R3 the need is declared by the same value that picks the call: a closed parent read', () => {
    const graph = graphOf([['Local', factoryNode('Local', '() => 2')]], { parentResolvableTokens: new Set(['Parent']) });
    const wired = resolveConstructorArgs(['Parent'], graph, () => 'Unused', () => 'Unused', false, true);
    expect(wired).toEqual({ text: 'this._resolveInternal("Parent")', needs: ['resolveSingle'] });
  });
});

describe('T23 an origin without a source file to read is generated text (R7)', () => {
  it('T23-R7 a hand-built node whose registration node has no source file claims no copy', () => {
    const node = factoryNode('Local', '() => ({ n: 5 })');
    node.service.factoryOrigin = { file: 'container.ts', start: 0, length: 15 };
    const graph = graphOf([['Local', node]]);
    const rendered = new Generator(graph, true).generateRendered();
    expect(rendered.copies).toEqual([]);
    // Inline output suffixes the alias names: read them from the output.
    const token = /^type (__NeoToken\w*)</m.exec(rendered.code)?.[1];
    const values = /^type (__NeoValues\w*)</m.exec(rendered.code)?.[1];
    expect(token, 'token alias declared').toBeDefined();
    expect(values, 'values alias declared').toBeDefined();
    expect(rendered.code).toContain(`const userFactory: ${factoryTypeWith(token ?? '', values ?? '')} = () => ({ n: 5 });`);
    expect(rendered.code).toBe(new Generator(graph, true).generate());
  });
});

describe('T23 a partial capture is a read, a direct useValue is hoisted (B2)', () => {
  it('T23-B2 the graph marks a partial capture as a read and leaves a direct one alone', () => {
    const part = captureRoot('t23-part.ts');
    const host = captureRoot('t23-host.ts');
    const files = new Map<string, string>([
      [part, [
        "import { definePartialConfig, useInterface } from '@djodjonx/neosyringe';",
        'export interface PartPort { id: number }',
        'export const part = definePartialConfig({',
        '  injections: [{ token: useInterface<PartPort>(), useValue: { id: 1 } }],',
        '});',
        '',
      ].join('\n')],
      [host, [
        "import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';",
        "import { part } from './t23-part';",
        'interface Own { id: number }',
        'export const container = defineBuilderConfig({',
        "  name: 'T23Host',",
        '  extends: [part],',
        '  injections: [{ token: useInterface<Own>(), useValue: { id: 2 } }],',
        '});',
        '',
      ].join('\n')],
    ]);
    const analyzer = new Analyzer(memoryProgram(files));
    const graph = analyzer.extractAll().find((item) => item.containerId === 'T23Host');
    if (!graph) throw new Error('missing T23Host');
    const partial = [...analyzer.extractForFile(host).configs.values()]
      .find((config) => config.type === 'partial' && config.name === 'part');
    const modular = [...(partial?.localInjections.values() ?? [])]
      .find((info) => info.definition.tokenId.includes('PartPort'));
    expect(modular?.definition.valueCaptureRead).toBe(true);
    const services = [...graph.nodes.values()].map((node) => node.service);
    const fromPartial = services.find((service) => service.tokenId.includes('PartPort'));
    const direct = services.find((service) => service.tokenId.includes('Own'));
    expect(fromPartial?.valueCapture).toMatch(/\.injections\[0\]\.useValue$/);
    expect(fromPartial?.valueCaptureRead).toBe(true);
    expect(direct?.valueCapture).toMatch(/^__neoCapture_/);
    expect(direct?.valueCaptureRead).toBeUndefined();
  });
});
