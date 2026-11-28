import { beforeAll, describe, expect, it } from 'vitest';
import * as ts from 'typescript';
import { Analyzer } from '../../src/analyzer/Analyzer';
import { DependencyAnalyzer } from '../../src/analyzer/validators/DependencyAnalyzer';
import { CycleValidator } from '../../src/analyzer/validators/CycleValidator';
import { TokenResolverService } from '../../src/analyzer/shared/TokenResolverService';
import type {
  ConfigGraph,
  DependencyGraph,
  DependencyNode,
  InjectionInfo,
  ServiceDefinition,
} from '../../src/analyzer/types';
import { TSContext } from '../../src/TSContext';
import { cycleEdges, type CycleMember } from '../../src/generator/cycleSearch';
import { GraphValidator } from '../../src/generator/GraphValidator';
import { createFastProgram, warmLibCache } from '../fastProgram';

const STUB_NAME = '/virtual/t13-stub.ts';
const STUB_TEXT = 'export function defineBuilderConfig<T>(config: T): T { return config; }\n';

let dependencyAnalyzer: DependencyAnalyzer;

beforeAll(() => {
  warmLibCache();
  const options: ts.CompilerOptions = {
    strict: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
  };
  const program = createFastProgram([], options);
  const checker = program.getTypeChecker();
  dependencyAnalyzer = new DependencyAnalyzer(checker, new TokenResolverService(checker));
});

function anchor(): { sourceFile: ts.SourceFile; call: ts.CallExpression } {
  const sourceFile = ts.createSourceFile(
    'synthetic.ts',
    'declare function defineBuilderConfig(config: unknown): unknown;\ndefineBuilderConfig({});\n',
    ts.ScriptTarget.ES2022,
    true,
  );
  let call: ts.CallExpression | undefined;
  const visit = (node: ts.Node): void => {
    if (call) return;
    if (ts.isCallExpression(node)) call = node;
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  if (!call) throw new Error('missing call');
  return { sourceFile, call };
}

function factory(id: string, deps: readonly string[], node: ts.Node): ServiceDefinition {
  return {
    tokenId: id,
    registrationNode: node,
    registrationId: id,
    type: 'factory',
    lifecycle: 'singleton',
    factoryDependencies: deps.map((tokenId) => ({
      tokenId,
      all: false,
      source: tokenId,
      containerId: 'synthetic',
    })),
  };
}

function chainGraphs(size: number, loop: boolean): { graph: DependencyGraph; config: ConfigGraph } {
  const { sourceFile, call } = anchor();
  const nodes = new Map<string, DependencyNode>();
  const localInjections = new Map<string, InjectionInfo>();
  for (let index = 0; index < size; index += 1) {
    const id = `S${index}`;
    const deps: string[] = [];
    if (index + 1 < size) deps.push(`S${index + 1}`);
    else if (loop) deps.push('S0');
    const definition = factory(id, deps, call);
    nodes.set(id, { service: definition, dependencies: deps });
    localInjections.set(id, {
      __kind: 'info',
      definition,
      node: call,
      tokenText: id,
      isScoped: false,
      isMulti: false,
    });
  }
  const graph: DependencyGraph = {
    containerId: 'synthetic',
    nodes,
    roots: [],
    sourceFileName: sourceFile.fileName,
  };
  const config: ConfigGraph = {
    containerId: 'synthetic',
    name: 'synthetic',
    type: 'builder',
    sourceFile,
    node: call,
    localInjections,
    duplicates: [],
    extendsRefs: [],
    useContainerRef: null,
  };
  return { graph, config };
}

interface Checked {
  thrown: string;
  graphCycles: number;
  analyzerCycles: number;
  graphMessage: string;
  analyzerMessage: string;
  graphFile: string;
  analyzerFile: string;
  graphCodes: string[];
  graphTokenId: string;
  graphStart: number;
  graphText: string;
  analyzerStart: number;
  analyzerText: string;
}

function checkPair(graph: DependencyGraph, config: ConfigGraph): Checked {
  const empty: Checked = {
    thrown: '',
    graphCycles: 0,
    analyzerCycles: 0,
    graphMessage: '',
    analyzerMessage: '',
    graphFile: '',
    analyzerFile: '',
    graphCodes: [],
    graphTokenId: '',
    graphStart: -1,
    graphText: '',
    analyzerStart: -1,
    analyzerText: '',
  };
  try {
    const validated = new GraphValidator().validateAll(graph);
    const graphCycle = validated.errors.find((error) => error.code === 'NEO_CYCLE');
    const analyzed = new CycleValidator(dependencyAnalyzer).validate(config, { allConfigs: new Map() });
    const analyzerCycle = analyzed.find((error) => error.code === 'NEO_CYCLE');
    return {
      thrown: '',
      graphCycles: validated.errors.filter((error) => error.code === 'NEO_CYCLE').length,
      analyzerCycles: analyzed.filter((error) => error.code === 'NEO_CYCLE').length,
      graphMessage: graphCycle?.message ?? '',
      analyzerMessage: analyzerCycle?.message ?? '',
      graphFile: graphCycle?.sourceFile.fileName ?? '',
      analyzerFile: analyzerCycle?.sourceFile.fileName ?? '',
      graphCodes: validated.errors.map((error) => error.code ?? error.type),
      graphTokenId: graphCycle?.tokenId ?? '',
      graphStart: graphCycle?.node.getStart() ?? -1,
      graphText: graphCycle?.node.getText() ?? '',
      analyzerStart: analyzerCycle?.node.getStart() ?? -1,
      analyzerText: analyzerCycle?.node.getText() ?? '',
    };
  } catch (error) {
    const name = error instanceof Error ? error.name : 'Error';
    const message = error instanceof Error ? error.message : String(error);
    return { ...empty, thrown: `${name}: ${message}` };
  }
}

const syntheticCache = new Map<string, Checked>();

function synthetic(size: number, loop: boolean): Checked {
  const key = `${size}:${loop}`;
  const hit = syntheticCache.get(key);
  if (hit) return hit;
  const built = chainGraphs(size, loop);
  const checked = checkPair(built.graph, built.config);
  syntheticCache.set(key, checked);
  return checked;
}

function programOf(fileName: string, source: string): ts.Program {
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    strict: true,
    noImplicitAny: false,
  };
  const sources = new Map<string, string>([[fileName, source], [STUB_NAME, STUB_TEXT]]);
  const host = ts.createCompilerHost(options);
  const read = host.getSourceFile.bind(host);
  const exists = host.fileExists.bind(host);
  host.getSourceFile = (name, languageVersion, onError, shouldCreateNewSourceFile) => {
    const text = sources.get(name);
    if (text !== undefined) return ts.createSourceFile(name, text, languageVersion, true);
    return read(name, languageVersion, onError, shouldCreateNewSourceFile);
  };
  host.fileExists = (name) => sources.has(name) || exists(name);
  host.resolveModuleNames = (names, containing) => names.map((name) => {
    if (name === '@djodjonx/neosyringe') {
      return { resolvedFileName: STUB_NAME, extension: ts.Extension.Ts, isExternalLibraryImport: false };
    }
    return ts.resolveModuleName(name, containing, options, host).resolvedModule;
  });
  return createFastProgram([fileName], options, host);
}

function chainSource(size: number, loop: boolean): string {
  const classes: string[] = [];
  for (let index = 0; index < size; index += 1) {
    const next = index + 1 < size ? `S${index + 1}` : loop ? 'S0' : '';
    const ctor = next === '' ? '' : `constructor(public d0: ${next}) {}`;
    classes.push(`class S${index} { value = ${index}; ${ctor} }`);
  }
  const injections = Array.from({ length: size }, (_, index) => `{ token: S${index} }`).join(', ');
  return `
    import { defineBuilderConfig } from '@djodjonx/neosyringe';
    ${classes.join('\n    ')}
    export const box = defineBuilderConfig({
      name: 'Deep',
      injections: [${injections}],
    });
  `;
}

interface RealChecked extends Checked {
  analyzerCount: number;
}

const realCache = new Map<string, RealChecked>();

function realChain(size: number, loop: boolean): RealChecked {
  const key = `${size}:${loop}`;
  const hit = realCache.get(key);
  if (hit) return hit;
  const fileName = `/virtual/t13-deep-${size}-${loop ? 'loop' : 'line'}.ts`;
  const failed: RealChecked = {
    thrown: '',
    graphCycles: 0,
    analyzerCycles: 0,
    graphMessage: '',
    analyzerMessage: '',
    graphFile: '',
    analyzerFile: '',
    graphCodes: [],
    graphTokenId: '',
    graphStart: -1,
    graphText: '',
    analyzerStart: -1,
    analyzerText: '',
    analyzerCount: 0,
  };
  try {
    const analyzer = new Analyzer(programOf(fileName, chainSource(size, loop)));
    const graphs = analyzer.extractAll();
    const graph = graphs[0];
    if (!graph) throw new Error('missing graph');
    const validated = new GraphValidator().validateAll(graph);
    const graphCycle = validated.errors.find((error) => error.code === 'NEO_CYCLE');
    const errors = analyzer.extractAllErrors();
    const analyzerCycles = errors.filter((error) => error.code === 'NEO_CYCLE');
    const result: RealChecked = {
      thrown: '',
      graphCycles: validated.errors.filter((error) => error.code === 'NEO_CYCLE').length,
      analyzerCycles: analyzerCycles.length,
      graphMessage: graphCycle?.message ?? '',
      analyzerMessage: analyzerCycles[0]?.message ?? '',
      graphFile: graphCycle?.sourceFile.fileName ?? graph.sourceFileName ?? '',
      analyzerFile: analyzerCycles[0]?.sourceFile.fileName ?? '',
      graphCodes: validated.errors.map((error) => error.code ?? error.type),
      graphTokenId: graphCycle?.tokenId ?? '',
      graphStart: graphCycle?.node.getStart() ?? -1,
      graphText: graphCycle?.node.getText() ?? '',
      analyzerStart: analyzerCycles[0]?.node.getStart() ?? -1,
      analyzerText: analyzerCycles[0]?.node.getText() ?? '',
      analyzerCount: analyzerCycles.length,
    };
    realCache.set(key, result);
    return result;
  } catch (error) {
    const name = error instanceof Error ? error.name : 'Error';
    const message = error instanceof Error ? error.message : String(error);
    const result = { ...failed, thrown: `${name}: ${message}` };
    realCache.set(key, result);
    return result;
  }
}

/** 1-based `line:column` of a node, as the editor shows it. */
function place(node: ts.Node, sourceFile: ts.SourceFile): string {
  const at = sourceFile.getLineAndCharacterOfPosition(node.getStart());
  return `${at.line + 1}:${at.character + 1}`;
}

interface Reported {
  message: string;
  place: string;
  text: string;
  tokenId?: string;
}

/** Both validators on one program, as the plugin runs them. */
function cycleReports(fileName: string, source: string): { graph: Reported[]; modular: Reported[] } {
  const analyzer = new Analyzer(programOf(fileName, source));
  const graph = analyzer.extractAll()[0];
  if (!graph) throw new Error('missing graph');
  const graphErrors = new GraphValidator().validateAll(graph).errors.filter((error) => error.code === 'NEO_CYCLE');
  const modularErrors = analyzer.extractAllErrors().filter((error) => error.code === 'NEO_CYCLE');
  return {
    graph: graphErrors.map((error) => ({
      message: error.message,
      place: place(error.node, error.sourceFile),
      text: error.node.getText().slice(0, 40),
      tokenId: error.tokenId,
    })),
    modular: modularErrors.map((error) => ({
      message: error.message,
      place: place(error.node, error.sourceFile),
      text: error.node.getText().slice(0, 40),
    })),
  };
}

const ANCHOR_AB = `
      import { defineBuilderConfig } from '@djodjonx/neosyringe';
      class ClassA { constructor(private b: ClassB) {} }
      class ClassB { constructor(private a: ClassA) {} }
      export const box = defineBuilderConfig({
        name: 'ClassCycle',
        injections: [{ token: ClassA }, { token: ClassB }],
      });
    `;

const ANCHOR_ABC = `
      import { defineBuilderConfig } from '@djodjonx/neosyringe';
      class A { constructor(private b: B) {} }
      class B { constructor(private c: C) {} }
      class C { constructor(private a: A, private b: B) {} }
      export const box = defineBuilderConfig({
        name: 'Tri',
        injections: [{ token: A }, { token: B }, { token: C }],
      });
    `;

const MULTI_BACK = `
      import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';
      interface CycleA { seen: number }
      interface CycleM { n: number }
      const cycleA = useInterface<CycleA>();
      const cycleM = useInterface<CycleM>();
      export const box = defineBuilderConfig({
        name: 'MultiBack',
        injections: [
          { token: cycleA, useFactory: true, dependencies: [{ all: cycleM }], provider: (ctx) => ({ seen: ctx.resolveAll(cycleM).length }) },
          { token: cycleM, useFactory: true, multi: true, dependencies: [cycleA], provider: () => ({ n: 1 }) },
          { token: cycleM, useFactory: true, multi: true, dependencies: [cycleA], provider: () => ({ n: 2 }) },
        ],
      });
    `;

const MULTI_SELF = `
      import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';
      interface Plug { n: number }
      const plug = useInterface<Plug>();
      export const box = defineBuilderConfig({
        name: 'MultiSelf',
        injections: [
          { token: plug, useFactory: true, multi: true, dependencies: [plug], provider: () => ({ n: 1 }) },
          { token: plug, useFactory: true, multi: true, dependencies: [plug], provider: () => ({ n: 2 }) },
          { token: plug, useFactory: true, multi: true, dependencies: [], provider: () => ({ n: 3 }) },
        ],
      });
    `;

function idSet(messages: readonly string[]): string[] {
  return messages.map((message) => {
    const path = message.split('detected: ')[1] ?? '';
    return [...new Set(path.split(' -> ').map((part) => part.trim()).filter((part) => part.length > 0))].sort().join(',');
  }).sort();
}

function corpusSource(kind: 'class' | 'factory' | 'all'): string {
  if (kind === 'class') {
    return `
      import { defineBuilderConfig } from '@djodjonx/neosyringe';
      class ClassA { constructor(private b: ClassB) {} }
      class ClassB { constructor(private a: ClassA) {} }
      export const box = defineBuilderConfig({
        name: 'ClassCycle',
        injections: [{ token: ClassA }, { token: ClassB }],
      });
    `;
  }
  if (kind === 'factory') {
    return `
      import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';
      interface FacA { n: number }
      interface FacB { n: number }
      const facA = useInterface<FacA>();
      const facB = useInterface<FacB>();
      export const box = defineBuilderConfig({
        name: 'FactoryCycle',
        injections: [
          { token: facA, useFactory: true, dependencies: [facB], provider: (ctx) => ctx.resolve(facB) },
          { token: facB, useFactory: true, dependencies: [facA], provider: (ctx) => ctx.resolve(facA) },
        ],
      });
    `;
  }
  return `
    import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';
    interface AllHost { n: number }
    interface AllItem { n: number }
    const allHost = useInterface<AllHost>();
    const allItem = useInterface<AllItem>();
    export const box = defineBuilderConfig({
      name: 'AllCycle',
      injections: [
        { token: allHost, useFactory: true, dependencies: [{ all: allItem }], provider: (ctx) => ctx.resolveAll(allItem) },
        { token: allItem, useFactory: true, multi: true, dependencies: [allHost], provider: () => ({ n: 1 }) },
      ],
    });
  `;
}

function corpusIds(kind: 'class' | 'factory' | 'all'): { graph: string[]; modular: string[] } {
  const fileName = `/virtual/t13-${kind}.ts`;
  const analyzer = new Analyzer(programOf(fileName, corpusSource(kind)));
  const graph = analyzer.extractAll()[0];
  if (!graph) throw new Error(`missing ${kind} graph`);
  const validated = new GraphValidator().validateAll(graph);
  const modular = analyzer.extractAllErrors().filter((error) => error.code === 'NEO_CYCLE');
  return {
    graph: idSet(validated.errors.filter((error) => error.code === 'NEO_CYCLE').map((error) => error.message)),
    modular: idSet(modular.map((error) => error.message)),
  };
}

describe('t13 deep graph', () => {
  it('P20 chain 5000 and 50000 has no cycle', () => {
    const real = realChain(5000, false);
    expect(real.thrown).toBe('');
    expect(real.graphCycles).toBe(0);
    expect(real.analyzerCycles).toBe(0);
    const wide = synthetic(50000, false);
    expect(wide.thrown).toBe('');
    expect(wide.graphCycles).toBe(0);
    expect(wide.analyzerCycles).toBe(0);
  }, 180_000);

  it('P21 final back-edge is one cycle', () => {
    const ring = (size: number): string => {
      const names = Array.from({ length: size }, (_, index) => `S${index}`);
      return `Circular dependency detected: ${[...names, 'S0'].join(' -> ')}`;
    };
    const real = realChain(5000, true);
    expect(real.thrown).toBe('');
    expect(real.graphCycles).toBe(1);
    expect(real.analyzerCycles).toBe(1);
    expect(real.graphMessage).toBe(ring(5000));
    expect(real.analyzerMessage).toBe(ring(5000));
    expect(real.graphFile).toContain('deep-5000-loop.ts');
    expect(real.analyzerFile).toContain('deep-5000-loop.ts');
    // The anchor is the back-edge source S4999, not the start of the ring.
    const source = chainSource(5000, true);
    const anchorText = '{ token: S4999 }';
    expect(real.graphText).toBe(anchorText);
    expect(real.analyzerText).toBe(anchorText);
    expect(real.graphStart).toBe(source.lastIndexOf(anchorText));
    expect(real.analyzerStart).toBe(source.lastIndexOf(anchorText));
    expect(real.graphTokenId).toMatch(/^S4999_[0-9a-f]+$/);
    const wide = synthetic(50000, true);
    expect(wide.thrown).toBe('');
    expect(wide.graphCycles).toBe(1);
    expect(wide.analyzerCycles).toBe(1);
    expect(wide.graphMessage).toBe(ring(50000));
    expect(wide.analyzerMessage).toBe(ring(50000));
    expect(wide.graphTokenId).toBe('S49999');
    expect(wide.graphFile).toContain('synthetic.ts');
    expect(wide.analyzerFile).toContain('synthetic.ts');
  }, 180_000);

  it('P22 GraphValidator 5000 and 50000 with and without the back-edge', () => {
    expect(realChain(5000, false).thrown).toBe('');
    expect(realChain(5000, false).graphCycles).toBe(0);
    expect(realChain(5000, true).thrown).toBe('');
    expect(realChain(5000, true).graphCycles).toBe(1);
    expect(synthetic(50000, false).thrown).toBe('');
    expect(synthetic(50000, false).graphCycles).toBe(0);
    expect(synthetic(50000, true).thrown).toBe('');
    expect(synthetic(50000, true).graphCycles).toBe(1);
  }, 180_000);

  it('P23 A to multi M to A', () => {
    const fileName = '/virtual/t13-anchor-multiAM.ts';
    const analyzer = new Analyzer(programOf(fileName, MULTI_BACK));
    const graph = analyzer.extractAll()[0];
    if (!graph) throw new Error('missing multi graph');
    const multi = [...(graph.multiNodes?.values() ?? [])][0]?.[0];
    const tokenId = multi?.service.tokenId ?? '';
    expect(multi?.service.registrationId).toBeTruthy();
    expect(multi?.service.registrationId).not.toBe(tokenId);

    // Counts and anchors measured on 1934d9c for CycleValidator: one error on each M contribution.
    const message = 'Circular dependency detected: CycleA -> CycleM -> CycleA';
    const reports = cycleReports(fileName, MULTI_BACK);
    expect(reports.modular).toEqual([
      { message, place: '11:11', text: '{ token: cycleM, useFactory: true, multi' },
      { message, place: '12:11', text: '{ token: cycleM, useFactory: true, multi' },
    ]);
    // GraphValidator did not walk multi nodes on 1934d9c. It now reports one cycle, on the first M contribution.
    expect(reports.graph).toHaveLength(1);
    expect(reports.graph[0]).toMatchObject({ message, place: '11:11', text: '{ token: cycleM, useFactory: true, multi' });
    expect(reports.graph[0]?.tokenId).toMatch(/^CycleM_[0-9a-f]+$/);

    // A multi token that needs itself, with 3 contributions and the third outside the cycle.
    const selfName = '/virtual/t13-anchor-multiSelf3.ts';
    const self = cycleReports(selfName, MULTI_SELF);
    const selfMessage = 'Circular dependency detected: Plug -> Plug';
    const selfText = '{ token: plug, useFactory: true, multi: ';
    expect(self.modular).toEqual([
      { message: selfMessage, place: '8:11', text: selfText },
      { message: selfMessage, place: '9:11', text: selfText },
      { message: selfMessage, place: '10:11', text: selfText },
    ]);
    expect(self.graph.map((report) => ({ message: report.message, place: report.place, text: report.text }))).toEqual([
      { message: selfMessage, place: '8:11', text: selfText },
      { message: selfMessage, place: '9:11', text: selfText },
    ]);
  });

  it('W5 GraphValidator anchors a cycle on the back-edge source', () => {
    // Values measured on 1934d9c: node, position and tokenId of the last node of the path.
    // A tokenId hashes the file path relative to the project root (declarationOrigin), and the root
    // falls back to process.cwd(). The root is pinned so the hashes do not depend on the checkout depth.
    const [ab, abc] = TSContext.runWithProjectRoot('/virtual', () => [
      cycleReports('/virtual/t13-anchor-ab.ts', ANCHOR_AB),
      cycleReports('/virtual/t13-anchor-abc.ts', ANCHOR_ABC),
    ]);
    expect(ab?.graph).toEqual([
      {
        message: 'Circular dependency detected: ClassA -> ClassB -> ClassA',
        place: '7:41',
        text: '{ token: ClassB }',
        tokenId: 'ClassB_4f284aa5',
      },
    ]);
    expect(abc?.graph).toEqual([
      { message: 'Circular dependency detected: A -> B -> C -> A', place: '8:50', text: '{ token: C }', tokenId: 'C_5736a453' },
      { message: 'Circular dependency detected: B -> C -> B', place: '8:50', text: '{ token: C }', tokenId: 'C_5736a453' },
    ]);
  });

  it('W6 CycleValidator anchors a cycle on the back-edge source', () => {
    // Values measured on 1934d9c. Same programs as W5. AnalysisError has no tokenId.
    const ab = cycleReports('/virtual/t13-anchor-ab.ts', ANCHOR_AB);
    expect(ab.modular).toEqual([
      { message: 'Circular dependency detected: ClassA -> ClassB -> ClassA', place: '7:41', text: '{ token: ClassB }' },
    ]);
    const abc = cycleReports('/virtual/t13-anchor-abc.ts', ANCHOR_ABC);
    expect(abc.modular).toEqual([
      { message: 'Circular dependency detected: A -> B -> C -> A', place: '8:50', text: '{ token: C }' },
      { message: 'Circular dependency detected: B -> C -> B', place: '8:50', text: '{ token: C }' },
    ]);
  });

  it('P24 5000 ring through the analyzer', () => {
    const real = realChain(5000, true);
    expect(real.thrown).toBe('');
    expect(real.analyzerCount).toBe(1);
    expect(real.analyzerMessage.startsWith('Circular dependency detected:')).toBe(true);
  }, 180_000);

  it('P25 missing target is not a node', () => {
    const { sourceFile, call } = anchor();
    // Two members need the same missing token. A node made from it would close
    // Missing -> Wants -> Missing on a real member, so it must not exist.
    const nodes = new Map<string, DependencyNode>();
    const localInjections = new Map<string, InjectionInfo>();
    for (const id of ['Needs', 'Wants']) {
      const definition = factory(id, ['Missing'], call);
      nodes.set(id, { service: definition, dependencies: ['Missing'] });
      localInjections.set(id, {
        __kind: 'info',
        definition,
        node: call,
        tokenText: id,
        isScoped: false,
        isMulti: false,
      });
    }
    const graph: DependencyGraph = {
      containerId: 'synthetic',
      nodes,
      roots: [],
      sourceFileName: sourceFile.fileName,
    };
    const config: ConfigGraph = {
      containerId: 'synthetic',
      name: 'synthetic',
      type: 'builder',
      sourceFile,
      node: call,
      localInjections,
      duplicates: [],
      extendsRefs: [],
      useContainerRef: null,
    };
    const checked = checkPair(graph, config);
    expect(checked.thrown).toBe('');
    expect(checked.graphCycles).toBe(0);
    expect(checked.analyzerCycles).toBe(0);
    expect(checked.graphCodes).toEqual(['NEO_MISSING_PROVIDER', 'NEO_MISSING_PROVIDER']);
    expect(checked.graphMessage).not.toContain('Missing');
  });

  it('W4 a repeated dependency is one edge per contribution, in registration order', () => {
    const count = 400;
    const members: CycleMember[] = [
      { id: 'host', tokenId: 'Host', dependencies: ['Item', 'Other', 'Item'] },
      { id: 'again', tokenId: 'Host', dependencies: ['Item'] },
    ];
    for (let index = 0; index < count; index += 1) {
      members.push({ id: `item-${index}`, tokenId: 'Item', dependencies: [] });
    }
    members.push({ id: 'other-0', tokenId: 'Other', dependencies: [] });
    const edges = cycleEdges(members);
    const items = Array.from({ length: count }, (_, index) => `item-${index}`);
    expect(edges.get('host')).toEqual([...items, 'other-0']);
    expect(edges.get('again')).toEqual(items);
  });

  it('P32 both validators report the same cycles', () => {
    for (const kind of ['class', 'factory', 'all'] as const) {
      const ids = corpusIds(kind);
      expect(ids.graph, kind).toEqual(ids.modular);
      expect(ids.graph, kind).not.toEqual([]);
    }
  });
});
