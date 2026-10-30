import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import * as ts from 'typescript';
import { Analyzer } from '../../src/analyzer/Analyzer';
import { DependencyAnalyzer } from '../../src/analyzer/validators/DependencyAnalyzer';
import { resolveConstructorSignature } from '../../src/analyzer/shared/registrationGraph';
import { TokenResolverService } from '../../src/analyzer/shared/TokenResolverService';
import type { AnalysisError, DependencyEdge, DependencyGraph, DependencyNode } from '../../src/analyzer/types';

const ROOT = path.join(process.cwd(), 't04-virtual');
const DIAG_FILE = path.join(ROOT, 'diag.ts');
const FILE_A = path.join(ROOT, 'a.ts');
const FILE_B = path.join(ROOT, 'b.ts');
const EDGES_FILE = path.join(ROOT, 'edges.ts');
const MISSING_FILE = path.join(ROOT, 'missing.ts');
const CYCLE_FILE = path.join(ROOT, 'cycle.ts');
const MULTI_FILE = path.join(ROOT, 'multi.ts');
const BORROW_FILE = path.join(ROOT, 'borrow.ts');
const SIG_FILE = path.join(ROOT, 'signature.ts');
const DESTRUCTURE_FILE = path.join(ROOT, 'destructure.ts');
const PROPERTY_FILE = path.join(ROOT, 'property.ts');
const PARTIAL_FILE = path.join(ROOT, 'partial-edges.ts');
const UNION_FILE = path.join(ROOT, 'union.ts');
const BARE_FILE = path.join(ROOT, 'bare.ts');

const STUB = `
  import { defineBuilderConfig, definePartialConfig, useInterface } from '@djodjonx/neosyringe';
  function defineBuilderConfig(config: any) { return config; }
  function definePartialConfig(config: any) { return config; }
  function useInterface<T>(): any { return null; }
`;

const STUB_PROP = `
  import { defineBuilderConfig, definePartialConfig, useInterface, useProperty } from '@djodjonx/neosyringe';
  function defineBuilderConfig(config: any) { return config; }
  function definePartialConfig(config: any) { return config; }
  function useInterface<T>(): any { return null; }
  function useProperty<T>(..._args: any[]): any { return null; }
`;

const files = new Map<string, string>([
  [DIAG_FILE, `
    ${STUB}
    class UntypedDep {}
    class UntypedHost {
      constructor(public labeled: UntypedDep, unlabeled) {}
    }
    class RestDep {}
    class RestHost {
      constructor(public first: RestDep, ...rest: RestDep[]) {}
    }
    const MixinValue: any = null;
    class MixinHost extends MixinValue {}
    export const diagContainer = defineBuilderConfig({
      injections: [
        { token: UntypedDep },
        { token: UntypedHost },
        { token: RestDep },
        { token: RestHost },
        { token: MixinHost },
      ],
    });
  `],
  [FILE_A, `
    ${STUB}
    class ServiceA {}
    export const c = defineBuilderConfig({
      name: 'App',
      injections: [{ token: ServiceA }],
    });
  `],
  [FILE_B, `
    ${STUB}
    class ServiceB {}
    export const c = defineBuilderConfig({
      name: 'App',
      injections: [{ token: ServiceB }],
    });
  `],
  [EDGES_FILE, `
    ${STUB}
    class EdgeLogger { log(): void {} }
    class EdgeBase {
      constructor(public logger: EdgeLogger) {}
    }
    class EdgeDerived extends EdgeBase {}
    export const edgeContainer = defineBuilderConfig({
      injections: [
        { token: EdgeLogger },
        { token: EdgeDerived },
      ],
    });
  `],
  [MISSING_FILE, `
    ${STUB}
    class MissingLogger { ping(): void {} }
    class MissingBase {
      constructor(public logger: MissingLogger) {}
    }
    class MissingDerived extends MissingBase {}
    export const missingContainer = defineBuilderConfig({
      injections: [{ token: MissingDerived }],
    });
  `],
  [CYCLE_FILE, `
    ${STUB}
    class CycleBase {
      constructor(public dep: CycleDerived) {}
    }
    class CycleDerived extends CycleBase {}
    export const cycleContainer = defineBuilderConfig({
      injections: [
        { token: CycleBase },
        { token: CycleDerived },
      ],
    });
  `],
  [MULTI_FILE, `
    ${STUB}
    interface MultiPort { id: number }
    class MultiOne implements MultiPort { id = 1; }
    class MultiTwo implements MultiPort { id = 2; }
    export const multiContainer = defineBuilderConfig({
      injections: [
        { token: useInterface<MultiPort>(), provider: MultiOne, multi: true },
        { token: useInterface<MultiPort>(), provider: MultiTwo, multi: true },
      ],
    });
  `],
  [BORROW_FILE, `
    ${STUB}
    class ParentSvc {}
    export const parentC = defineBuilderConfig({
      name: 'ParentApp',
      injections: [{ token: ParentSvc }],
    });
    class ChildSvc {}
    export const childC = defineBuilderConfig({
      name: 'ChildApp',
      useContainer: parentC,
      injections: [{ token: ChildSvc }],
    });
  `],
  [SIG_FILE, `
    class SigLogger { id = 1; }
    class SigBase {
      constructor(public logger: SigLogger) {}
    }
  `],
  [DESTRUCTURE_FILE, `
    ${STUB}
    class DestructLogger { readonly a = 1; }
    class DestructHost {
      constructor({ a }: DestructLogger) { void a; }
    }
    export const destructContainer = defineBuilderConfig({
      injections: [
        { token: DestructLogger },
        { token: DestructHost },
      ],
    });
  `],
  [PROPERTY_FILE, `
    ${STUB_PROP}
    class PropertySvc {
      constructor(public url) {}
    }
    export const propertyContainer = defineBuilderConfig({
      injections: [
        { token: useProperty<string>(PropertySvc, 'url'), provider: () => 'https://local' },
        { token: PropertySvc },
      ],
    });
  `],
  [PARTIAL_FILE, `
    ${STUB_PROP}
    interface PartialPort { id: number }
    class PartialPortImpl implements PartialPort { id = 7; }
    class PartialSvc {
      constructor(public url: string, public port: PartialPort) {}
    }
    const partialEdges = definePartialConfig({
      injections: [
        { token: useProperty<string>(PartialSvc, 'url'), provider: () => 'https://partial' },
        { token: useInterface<PartialPort>(), provider: PartialPortImpl, multi: true },
      ],
    });
    export const partialHost = defineBuilderConfig({
      extends: [partialEdges],
      injections: [{ token: PartialSvc }],
    });
  `],
  [UNION_FILE, `
    ${STUB}
    class OptA { readonly id = 1; }
    class OptB { readonly id = 2; }
    class OptFlag {
      constructor(public flag?: boolean) {}
    }
    class OptUnion {
      constructor(public value?: OptA | OptB) {}
    }
    class OptUnionBase {
      constructor(public value?: OptA | OptB) {}
    }
    class OptUnionDerived extends OptUnionBase {}
    export const unionContainer = defineBuilderConfig({
      injections: [
        { token: OptA },
        { token: OptFlag },
        { token: OptUnion },
        { token: OptUnionDerived },
      ],
    });
  `],
  [BARE_FILE, `
    ${STUB}
    class BareDep { readonly id = 4; }
    class BareOpts {
      constructor(private opts = { retries: 3 }, public dep: BareDep) {}
    }
    class BareOptional {
      constructor(public x?, public dep: BareDep) {}
    }
    export const bareContainer = defineBuilderConfig({
      injections: [
        { token: BareDep },
        { token: BareOpts },
        { token: BareOptional },
      ],
    });
  `],
]);

function createProgram(sources: Map<string, string>): ts.Program {
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.ESNext,
    strict: true,
    noImplicitAny: false,
  };
  const host = ts.createCompilerHost(options);
  const originalGetSourceFile = host.getSourceFile.bind(host);
  const originalFileExists = host.fileExists.bind(host);
  host.getSourceFile = (fileName, languageVersion) => {
    const text = sources.get(fileName);
    if (text !== undefined) return ts.createSourceFile(fileName, text, languageVersion, true);
    return originalGetSourceFile(fileName, languageVersion);
  };
  host.fileExists = (fileName) => sources.has(fileName) || originalFileExists(fileName);
  return ts.createProgram([...sources.keys()], options, host);
}

function classDecl(program: ts.Program, fileName: string, className: string): ts.ClassDeclaration {
  const source = program.getSourceFile(fileName);
  const found = source?.statements.find(
    (statement) => ts.isClassDeclaration(statement) && statement.name?.text === className,
  );
  if (!found || !ts.isClassDeclaration(found)) {
    throw new Error(`missing class ${className} in ${fileName}`);
  }
  return found;
}

function implNames(graph: DependencyGraph): string[] {
  return [...graph.nodes.values()]
    .map((node) => node.service.implementationSymbol?.getName() ?? '')
    .filter((name) => name !== '')
    .sort();
}

function serviceNode(graph: DependencyGraph, className: string): DependencyNode | undefined {
  return [...graph.nodes.values()].find(
    (node) => node.service.implementationSymbol?.getName() === className,
  );
}

function builderDefinition(analyzer: Analyzer, fileName: string, className: string) {
  const modular = analyzer.extractForFile(fileName);
  const config = [...modular.configs.values()].find(
    (item) => item.sourceFile.fileName === fileName && item.type === 'builder',
  );
  const info = [...(config?.localInjections.values() ?? [])].find(
    (item) => item.definition.implementationSymbol?.getName() === className,
  );
  return { modular, definition: info?.definition };
}

function constructorOf(program: ts.Program, fileName: string, className: string): ts.ConstructorDeclaration {
  const declaration = classDecl(program, fileName, className);
  const constructor = declaration.members.find((member) => ts.isConstructorDeclaration(member));
  if (!constructor || !ts.isConstructorDeclaration(constructor)) {
    throw new Error(`missing constructor ${className}`);
  }
  return constructor;
}

function unsupported(errors: readonly AnalysisError[], className: string, fragment: string): AnalysisError | undefined {
  return errors.find((error) =>
    error.type === 'unsupported'
    && error.code === 'NEO_CONFIG_UNSUPPORTED'
    && error.message.includes(`'${className}'`)
    && error.message.includes(fragment),
  );
}

describe('T04 graphe et constructeurs', () => {
  let program: ts.Program;
  let analyzer: Analyzer;

  beforeAll(() => {
    program = createProgram(files);
    analyzer = new Analyzer(program);
  });

  it('T04-A04 diagnostic', () => {
    const graph = analyzer.extract();
    const fileErrors = analyzer.extractForFile(DIAG_FILE).errors;
    const cases = [
      ['UntypedHost', "parameter 'unlabeled'"],
      ['RestHost', 'is a rest parameter'],
      ['MixinHost', 'extends an unresolved mixin'],
    ] as const;
    for (const [className, fragment] of cases) {
      expect(unsupported(graph.errors ?? [], className, fragment)?.message ?? '').toContain(className);
      expect(unsupported(fileErrors, className, fragment)?.message ?? '').toContain(className);
    }
  });

  it('T04-A06 deux fichiers', () => {
    const graphs = analyzer.extractAll();
    const graphA = graphs.find((graph) => graph.sourceFileName === FILE_A);
    const graphB = graphs.find((graph) => graph.sourceFileName === FILE_B);
    expect(graphA).toBeDefined();
    expect(graphB).toBeDefined();
    expect(graphA?.containerId).toBe('App');
    expect(graphB?.containerId).toBe('App');
    expect(graphA?.containerKey).toEqual(expect.any(String));
    expect(graphA?.containerKey).not.toBe(graphB?.containerKey);
    expect(graphA?.containerKey).not.toBe('App');
    expect(graphA?.containerKey?.includes(graphA.sourceFileName ?? 'ABSOLUTE')).toBe(false);
    expect(implNames(graphA!)).toEqual(['ServiceA']);
    expect(implNames(graphB!)).toEqual(['ServiceB']);
  });

  it('T04-A07 mêmes arêtes', () => {
    const graph = analyzer.extract();
    const derived = [...graph.nodes.values()].find(
      (node) => node.service.implementationSymbol?.getName() === 'EdgeDerived',
    );
    const modular = analyzer.extractForFile(EDGES_FILE);
    const config = [...modular.configs.values()].find((item) => item.sourceFile.fileName === EDGES_FILE);
    const info = [...(config?.localInjections.values() ?? [])].find(
      (item) => item.definition.implementationSymbol?.getName() === 'EdgeDerived',
    );
    expect(info).toBeDefined();
    const checker = program.getTypeChecker();
    const fromAnalyzer = new DependencyAnalyzer(checker, new TokenResolverService(checker)).edgesFor(
      info!.definition,
    );
    expect(derived?.service.dependencyEdges?.[0]?.origin).toBe('inherited');
    expect(derived?.service.dependencyEdges).toEqual(info?.definition.dependencyEdges);
    expect(derived?.service.dependencyEdges).toEqual(fromAnalyzer);
    expect(derived?.dependencies).toEqual(derived?.service.dependencyEdges?.map((edge) => edge.tokenId));
    expect(derived?.service.dependencyEdges?.map((edge) => edge.paramIndex)).toEqual([0]);
    expect(derived?.service.dependencyEdges?.[0]?.tokenId).toContain('EdgeLogger');
  });

  it('T04-P09 validateurs', () => {
    const missing = analyzer.extractForFile(MISSING_FILE);
    const cycle = analyzer.extractForFile(CYCLE_FILE);
    expect(missing.errors.some((error) =>
      error.type === 'missing' && error.message.includes('MissingLogger'),
    )).toBe(true);
    expect(cycle.errors.some((error) => error.type === 'cycle')).toBe(true);
  });

  it('T04-P10 signature', () => {
    const checker = program.getTypeChecker();
    const tokens = new TokenResolverService(checker);
    const baseDecl = classDecl(program, SIG_FILE, 'SigBase');
    const loggerDecl = classDecl(program, SIG_FILE, 'SigLogger');
    const expected = tokens.getTypeId(checker.getTypeAtLocation(loggerDecl.name!));
    const signature = resolveConstructorSignature(checker, tokens, baseDecl, new Set());
    expect(signature.diagnostics).toEqual([]);
    expect(signature.edges).toHaveLength(1);
    expect(signature.edges[0]).toMatchObject({
      tokenId: expected,
      paramIndex: 0,
      optional: false,
      multi: false,
      origin: 'declared',
    });
  });

  it('T04-P11 registrationId', () => {
    const read = () => {
      const graph = analyzer.extract();
      const entry = [...(graph.multiNodes ?? new Map()).entries()].find(([tokenId]) =>
        tokenId.startsWith('MultiPort_'),
      );
      return {
        tokenId: entry?.[0],
        ids: entry?.[1].map((node: DependencyNode) => node.service.registrationId),
      };
    };
    const first = read();
    const second = read();
    expect(first.ids).toHaveLength(2);
    expect(first.ids?.[0]).not.toBe(first.ids?.[1]);
    expect(first.ids).toEqual(second.ids);
    expect(first.ids?.[0]).not.toBe(first.tokenId);
  });

  it('T04-W2 containerKey emprunté', () => {
    const graphs = analyzer.extractAll();
    const parent = graphs.find((graph) => graph.sourceFileName === BORROW_FILE && graph.containerId === 'ParentApp');
    const child = graphs.find((graph) => graph.sourceFileName === BORROW_FILE && graph.containerId === 'ChildApp');
    expect(child?.borrowedRegistrations?.length ?? 0).toBeGreaterThan(0);
    expect(child?.borrowedRegistrations?.[0]?.containerId).toBe(parent?.containerKey);
    expect(child?.borrowedRegistrations?.[0]?.containerId).not.toBe(parent?.containerId);
    expect(child?.borrowedRegistrations?.[0]?.tokenId).toContain('ParentSvc');
  });

  it('T04-P12 les deux chemins', () => {
    const read = (load: () => DependencyEdge[] | undefined) => {
      try {
        const edges = load();
        return { message: '', optional: edges?.[0]?.optional ?? null, depIndex: edges?.[1]?.paramIndex ?? null };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { message, optional: null, depIndex: null };
      }
    };
    const legacy = read(() => serviceNode(analyzer.extract(), 'BareOpts')?.service.dependencyEdges);
    const modular = read(() => builderDefinition(analyzer, BARE_FILE, 'BareOpts').definition?.dependencyEdges);
    const optional = read(() => serviceNode(analyzer.extract(), 'BareOptional')?.service.dependencyEdges);
    expect(legacy).toEqual({ message: '', optional: true, depIndex: 1 });
    expect(modular).toEqual({ message: '', optional: true, depIndex: 1 });
    expect(optional).toEqual({ message: '', optional: true, depIndex: 1 });
  });

  it('T04-P13 paramètre déstructuré', () => {
    const graph = analyzer.extract();
    const node = serviceNode(graph, 'DestructHost');
    const { modular, definition } = builderDefinition(analyzer, DESTRUCTURE_FILE, 'DestructHost');
    expect(unsupported(graph.errors ?? [], 'DestructHost', 'no type annotation')).toBeUndefined();
    expect(unsupported(modular.errors, 'DestructHost', 'no type annotation')).toBeUndefined();
    expect(node?.service.dependencyEdges?.[0]?.tokenId).toContain('DestructLogger');
    expect(definition?.dependencyEdges).toEqual(node?.service.dependencyEdges);
  });

  it('T04-P14 jeton de propriété sans annotation', () => {
    const graph = analyzer.extract();
    const node = serviceNode(graph, 'PropertySvc');
    const { modular, definition } = builderDefinition(analyzer, PROPERTY_FILE, 'PropertySvc');
    expect(unsupported(graph.errors ?? [], 'PropertySvc', 'no type annotation')).toBeUndefined();
    expect(unsupported(modular.errors, 'PropertySvc', 'no type annotation')).toBeUndefined();
    expect(node?.service.dependencyEdges?.[0]?.tokenId).toMatch(/^PropertyToken:PropertySvc\.url_[0-9a-f]{8}$/);
    expect(definition?.dependencyEdges).toEqual(node?.service.dependencyEdges);
  });

  it('T04-P15 mêmes arêtes partial', () => {
    const graph = analyzer.extract();
    const node = serviceNode(graph, 'PartialSvc');
    const { definition } = builderDefinition(analyzer, PARTIAL_FILE, 'PartialSvc');
    const legacy = node?.service.dependencyEdges;
    expect(legacy).toEqual(definition?.dependencyEdges);
    expect(legacy?.[0]?.tokenId).toMatch(/^PropertyToken:PartialSvc\.url_[0-9a-f]{8}$/);
    expect(legacy?.[1]?.multi).toBe(true);
    expect(legacy?.[0]?.multi).toBe(false);
    expect(legacy?.map((edge) => edge.paramIndex)).toEqual([0, 1]);
  });

  it('T04-P16 union sans undefined', () => {
    const checker = program.getTypeChecker();
    const tokens = new TokenResolverService(checker);
    const flagParam = constructorOf(program, UNION_FILE, 'OptFlag').parameters[0];
    const unionParam = constructorOf(program, UNION_FILE, 'OptUnion').parameters[0];
    const inheritedParam = constructorOf(program, UNION_FILE, 'OptUnionBase').parameters[0];
    const expectedFlag = tokens.getTypeId(checker.getTypeFromTypeNode(flagParam.type!));
    const expectedUnion = tokens.getTypeId(checker.getTypeFromTypeNode(unionParam.type!));
    const expectedInherited = tokens.getTypeId(checker.getTypeFromTypeNode(inheritedParam.type!));
    const graph = analyzer.extract();
    const flag = serviceNode(graph, 'OptFlag')?.service.dependencyEdges?.[0];
    const union = serviceNode(graph, 'OptUnion')?.service.dependencyEdges?.[0];
    const inherited = serviceNode(graph, 'OptUnionDerived')?.service.dependencyEdges?.[0];
    const { definition } = builderDefinition(analyzer, UNION_FILE, 'OptFlag');
    expect(flag?.tokenId).toBe(expectedFlag);
    expect(flag?.tokenId.startsWith('boolean_')).toBe(true);
    expect(union?.tokenId).toBe(expectedUnion);
    expect(inherited?.tokenId).toBe(expectedInherited);
    expect(inherited?.origin).toBe('inherited');
    expect(definition?.dependencyEdges?.[0]?.tokenId).toBe(expectedFlag);
  });
});
