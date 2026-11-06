import path from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import * as ts from 'typescript';
import { Analyzer } from '../../src/analyzer/Analyzer';
import { ConfigCollector } from '../../src/analyzer/collectors/ConfigCollector';
import { toStableDiagnostic } from '../../src/analyzer/errors/stableDiagnostic';
import type { AnalysisError, DependencyGraph } from '../../src/analyzer/types';
import { Generator } from '../../src/generator/Generator';
import { createFastProgram, warmLibCache } from '../fastProgram';

const FILE = path.join(process.cwd(), 'disposable-transient-capture.ts');
const CODE = 'NEO_DISPOSABLE_TRANSIENT_CAPTURED';

const STUB = '/virtual/neo-syringe-stub.ts';

const STUB_SOURCE = `
export type InterfaceToken<T> = { __brand: 'InterfaceToken'; __type: T };
export type PropertyToken<T, C = unknown> = {
  __brand: 'PropertyToken';
  __type: T;
  __class: C;
  __name: string;
};
export function defineBuilderConfig<C>(config: C): C { return config; }
export function definePartialConfig<C>(config: C): C { return config; }
export function useInterface<T>(): InterfaceToken<T> { return null as unknown as InterfaceToken<T>; }
export function useProperty<T, C>(targetClass: C, name: string): PropertyToken<T, C> {
  return null as unknown as PropertyToken<T, C>;
}
`;

const SOURCE = `
import { defineBuilderConfig, definePartialConfig, useInterface } from '@djodjonx/neosyringe';
import { defineBuilderConfig as build } from '@djodjonx/neosyringe';
import * as neo from '@djodjonx/neosyringe';

class Only {}
export const quiet = defineBuilderConfig({
  name: 'Quiet',
  injections: [{ token: Only }],
});

class P1Conn { dispose(): void {} }
class P1Svc { constructor(readonly conn: P1Conn) {} }
export const p1 = defineBuilderConfig({
  name: 'P1Box',
  injections: [
    { token: P1Conn, lifecycle: 'transient' },
    { token: P1Svc },
  ],
});

class Plain { ping(): number { return 1; } }
class PlainSvc { constructor(readonly plain: Plain) {} }
export const plainBox = defineBuilderConfig({
  name: 'PlainBox',
  injections: [
    { token: Plain, lifecycle: 'transient' },
    { token: PlainSvc },
  ],
});

class TConn { dispose(): void {} }
class TSvc { constructor(readonly conn: TConn) {} }
export const transientBox = defineBuilderConfig({
  name: 'TransientBox',
  injections: [
    { token: TConn, lifecycle: 'transient' },
    { token: TSvc, lifecycle: 'transient' },
  ],
});

class ScopedConn { dispose(): void {} }
class ScopedSvc { constructor(readonly conn: ScopedConn) {} }
export const scopedBox = defineBuilderConfig({
  name: 'ScopedBox',
  injections: [
    { token: ScopedConn, lifecycle: 'transient' },
    { token: ScopedSvc, lifecycle: 'transient', scoped: true },
  ],
});

class ScopedSingleConn { dispose(): void {} }
class ScopedSingleSvc { constructor(readonly conn: ScopedSingleConn) {} }
export const scopedSingle = defineBuilderConfig({
  name: 'ScopedSingle',
  injections: [
    { token: ScopedSingleConn, lifecycle: 'transient' },
    { token: ScopedSingleSvc, scoped: true },
  ],
});

class ChainLeaf { dispose(): void {} }
class ChainMid { constructor(readonly leaf: ChainLeaf) {} }
class ChainRoot { constructor(readonly mid: ChainMid) {} }
export const chainBox = defineBuilderConfig({
  name: 'ChainBox',
  injections: [
    { token: ChainLeaf, lifecycle: 'transient' },
    { token: ChainMid, lifecycle: 'transient' },
    { token: ChainRoot },
  ],
});

class ParentLeak { dispose(): void {} }
class ChildSvc { constructor(readonly leak: ParentLeak) {} }
export const leakParent = defineBuilderConfig({
  name: 'LeakParent',
  injections: [{ token: ParentLeak, lifecycle: 'transient' }],
});
export const leakChild = defineBuilderConfig({
  name: 'LeakChild',
  useContainer: leakParent,
  injections: [{ token: ChildSvc }],
});

class ParentHeld { dispose(): void {} }
class ChildOk { constructor(readonly held: ParentHeld) {} }
export const heldParent = defineBuilderConfig({
  name: 'HeldParent',
  injections: [{ token: ParentHeld }],
});
export const heldChild = defineBuilderConfig({
  name: 'HeldChild',
  useContainer: heldParent,
  injections: [{ token: ChildOk }],
});

class PartConn { dispose(): void {} }
class PartSvc { constructor(readonly conn: PartConn) {} }
export const sharedPart = definePartialConfig({
  injections: [
    { token: PartConn, lifecycle: 'transient' },
    { token: PartSvc },
  ],
});
export const partA = defineBuilderConfig({
  name: 'PartA',
  extends: [sharedPart],
  injections: [],
});
export const partB = defineBuilderConfig({
  name: 'PartB',
  extends: [sharedPart],
  injections: [],
});

interface P8Conn { dispose(): void }
interface P8Svc { conn: P8Conn }
const p8Conn = useInterface<P8Conn>();
const p8Svc = useInterface<P8Svc>();
export const p8 = defineBuilderConfig({
  name: 'P8Box',
  injections: [
    {
      token: p8Conn,
      useFactory: true,
      dependencies: [],
      lifecycle: 'transient',
      provider: () => ({ dispose() {} }),
    },
    {
      token: p8Svc,
      useFactory: true,
      dependencies: [p8Conn],
      provider: (context) => ({ conn: context.resolve(p8Conn) }),
    },
  ],
});

interface P8All { dispose(): void }
interface P8Bag { items: P8All[] }
const p8All = useInterface<P8All>();
const p8Bag = useInterface<P8Bag>();
export const p8AllBox = defineBuilderConfig({
  name: 'P8AllBox',
  injections: [
    {
      token: p8All,
      multi: true,
      useFactory: true,
      dependencies: [],
      lifecycle: 'transient',
      provider: () => ({ dispose() {} }),
    },
    {
      token: p8Bag,
      useFactory: true,
      dependencies: [{ all: p8All }],
      provider: (context) => ({ items: context.resolveAll(p8All) }),
    },
  ],
});

class AsyncConn { async dispose(): Promise<void> {} }
class AsyncSvc { constructor(readonly conn: AsyncConn) {} }
export const asyncBox = defineBuilderConfig({
  name: 'AsyncBox',
  injections: [
    { token: AsyncConn, lifecycle: 'transient' },
    { token: AsyncSvc },
  ],
});

class StringConn { dispose: string = 'no'; }
class StringSvc { constructor(readonly conn: StringConn) {} }
export const stringBox = defineBuilderConfig({
  name: 'StringBox',
  injections: [
    { token: StringConn, lifecycle: 'transient' },
    { token: StringSvc },
  ],
});

class TwoA { dispose(): void {} }
class TwoB { dispose(): void {} }
class TwoSvc { constructor(readonly a: TwoA, readonly b: TwoB) {} }
export const twoBox = defineBuilderConfig({
  name: 'TwoBox',
  injections: [
    { token: TwoA, lifecycle: 'transient' },
    { token: TwoB, lifecycle: 'transient' },
    { token: TwoSvc },
  ],
});

class DiaLeaf { dispose(): void {} }
class DiaA { constructor(readonly leaf: DiaLeaf) {} }
class DiaB { constructor(readonly leaf: DiaLeaf) {} }
class DiaRoot { constructor(readonly a: DiaA, readonly b: DiaB) {} }
export const diaBox = defineBuilderConfig({
  name: 'DiaBox',
  injections: [
    { token: DiaLeaf, lifecycle: 'transient' },
    { token: DiaA, lifecycle: 'transient' },
    { token: DiaB, lifecycle: 'transient' },
    { token: DiaRoot },
  ],
});

class AnyConn { dispose(): void {} }
class AnySvc { constructor(readonly conn: AnyConn) {} }
export const anyClass = defineBuilderConfig({
  name: 'AnyClass',
  injections: [
    {
      token: AnyConn,
      useFactory: true,
      dependencies: [],
      lifecycle: 'transient',
      provider: (): any => ({ dispose() {} }),
    },
    { token: AnySvc },
  ],
});

interface FaceConn { dispose(): void }
interface FaceSvc { conn: FaceConn }
const faceConn = useInterface<FaceConn>();
const faceSvc = useInterface<FaceSvc>();
export const faceBox = defineBuilderConfig({
  name: 'FaceBox',
  injections: [
    {
      token: faceConn,
      useFactory: true,
      dependencies: [],
      lifecycle: 'transient',
      provider: (): any => null,
    },
    {
      token: faceSvc,
      useFactory: true,
      dependencies: [faceConn],
      provider: (context) => ({ conn: context.resolve(faceConn) }),
    },
  ],
});

interface PlainTok { ping(): number }
interface PlainHost { item: PlainTok }
class RetDisp { dispose(): void {} }
const plainTok = useInterface<PlainTok>();
const plainHost = useInterface<PlainHost>();
export const retBox = defineBuilderConfig({
  name: 'RetBox',
  injections: [
    {
      token: plainTok,
      useFactory: true,
      dependencies: [],
      lifecycle: 'transient',
      provider: (): RetDisp => new RetDisp(),
    },
    {
      token: plainHost,
      useFactory: true,
      dependencies: [plainTok],
      provider: (context) => ({ item: context.resolve(plainTok) }),
    },
  ],
});

class StaticOnly { static dispose(): void {} }
class StaticSvc { constructor(readonly item: StaticOnly) {} }
export const staticBox = defineBuilderConfig({
  name: 'StaticBox',
  injections: [
    {
      token: StaticOnly,
      useFactory: true,
      dependencies: [],
      lifecycle: 'transient',
      provider: (): any => ({}),
    },
    { token: StaticSvc },
  ],
});

class OptConn { dispose(): void {} }
class OptSvc { constructor(readonly conn?: OptConn) {} }
export const optBox = defineBuilderConfig({
  name: 'OptBox',
  injections: [
    { token: OptConn, lifecycle: 'transient' },
    { token: OptSvc },
  ],
});

interface BorrowedFace { dispose(): void }
interface BorrowedHost { item: BorrowedFace }
const borrowedFace = useInterface<BorrowedFace>();
const borrowedHost = useInterface<BorrowedHost>();
export const borrowedBox = defineBuilderConfig({
  name: 'BorrowedBox',
  injections: [
    {
      token: borrowedFace,
      useFactory: true,
      dependencies: [],
      lifecycle: 'transient',
      ownership: 'borrowed',
      provider: () => ({ dispose() {} }),
    },
    {
      token: borrowedHost,
      useFactory: true,
      dependencies: [borrowedFace],
      provider: (context) => ({ item: context.resolve(borrowedFace) }),
    },
  ],
});

class AliasConn { dispose(): void {} }
class AliasSvc { constructor(readonly conn: AliasConn) {} }
export const aliasBox = build({
  name: 'AliasBox',
  injections: [
    { token: AliasConn, lifecycle: 'transient' },
    { token: AliasSvc },
  ],
});
export const neoBox = neo.defineBuilderConfig({
  name: 'NeoBox',
  injections: [
    { token: AliasConn, lifecycle: 'transient' },
    { token: AliasSvc },
  ],
});

class CycA { constructor(readonly other: CycB) {} }
class CycB { constructor(readonly other: CycA) {} }
class CycRoot { constructor(readonly first: CycA) {} }
export const cycBox = defineBuilderConfig({
  name: 'CycBox',
  injections: [
    { token: CycA, lifecycle: 'transient' },
    { token: CycB, lifecycle: 'transient' },
    { token: CycRoot },
  ],
});

class ShadowPlain { ping(): number { return 1; } }
class ShadowNeed { constructor(readonly item: ShadowPlain) {} }
export const shadowPlainParent = defineBuilderConfig({
  name: 'ShadowPlainParent',
  injections: [{
    token: ShadowPlain,
    useFactory: true,
    dependencies: [],
    lifecycle: 'transient',
    provider: () => ({ dispose() {}, ping() { return 1; } }),
  }],
});
export const shadowPlainChild = defineBuilderConfig({
  name: 'ShadowPlainChild',
  useContainer: shadowPlainParent,
  injections: [
    { token: ShadowPlain },
    { token: ShadowNeed },
  ],
});

class ShadowDisp { dispose(): void {} }
class ShadowNeedDisp { constructor(readonly item: ShadowDisp) {} }
export const shadowDispParent = defineBuilderConfig({
  name: 'ShadowDispParent',
  injections: [{ token: ShadowDisp, lifecycle: 'transient' }],
});
export const shadowDispChild = defineBuilderConfig({
  name: 'ShadowDispChild',
  useContainer: shadowDispParent,
  injections: [
    { token: ShadowDisp },
    { token: ShadowNeedDisp },
  ],
});

class ChainPLeaf { dispose(): void {} }
class ChainPMid { constructor(readonly leaf: ChainPLeaf) {} }
class ChainPUse { constructor(readonly mid: ChainPMid) {} }
export const chainPParent = defineBuilderConfig({
  name: 'ChainPParent',
  injections: [
    { token: ChainPLeaf, lifecycle: 'transient' },
    { token: ChainPMid, lifecycle: 'transient' },
  ],
});
export const chainPChild = defineBuilderConfig({
  name: 'ChainPChild',
  useContainer: chainPParent,
  injections: [{ token: ChainPUse }],
});

class Q1Captured { dispose(): void {} }
class Q1Local { constructor(readonly captured: Q1Captured) {} }
class Q1Use { constructor(readonly local: Q1Local) {} }
export const q1Parent = defineBuilderConfig({
  name: 'Q1Parent',
  injections: [{ token: Q1Captured, lifecycle: 'transient' }],
});
export const q1Child = defineBuilderConfig({
  name: 'Q1Child',
  useContainer: q1Parent,
  injections: [
    { token: Q1Local, lifecycle: 'transient' },
    { token: Q1Use },
  ],
});

class Q1Plain { ping(): number { return 1; } }
class Q1LocalOk { constructor(readonly plain: Q1Plain) {} }
class Q1UseOk { constructor(readonly local: Q1LocalOk) {} }
export const q1PlainParent = defineBuilderConfig({
  name: 'Q1PlainParent',
  injections: [{ token: Q1Plain, lifecycle: 'transient' }],
});
export const q1PlainChild = defineBuilderConfig({
  name: 'Q1PlainChild',
  useContainer: q1PlainParent,
  injections: [
    { token: Q1LocalOk, lifecycle: 'transient' },
    { token: Q1UseOk },
  ],
});

class Q2Leak { dispose(): void {} }
class Q2Use { constructor(readonly leak: Q2Leak) {} }
export const q2Grand = defineBuilderConfig({
  name: 'Q2Grand',
  injections: [{ token: Q2Leak, lifecycle: 'transient' }],
});
export const q2Parent = defineBuilderConfig({
  name: 'Q2Parent',
  useContainer: q2Grand,
  injections: [],
});
export const q2Child = defineBuilderConfig({
  name: 'Q2Child',
  useContainer: q2Parent,
  injections: [{ token: Q2Use }],
});

class Q2Held { dispose(): void {} }
class Q2Ok { constructor(readonly held: Q2Held) {} }
export const q2HeldGrand = defineBuilderConfig({
  name: 'Q2HeldGrand',
  injections: [{ token: Q2Held }],
});
export const q2HeldParent = defineBuilderConfig({
  name: 'Q2HeldParent',
  useContainer: q2HeldGrand,
  injections: [],
});
export const q2HeldChild = defineBuilderConfig({
  name: 'Q2HeldChild',
  useContainer: q2HeldParent,
  injections: [{ token: Q2Ok }],
});

interface Q3Item { dispose(): void }
interface Q3Bag { items: Q3Item[] }
const q3Item = useInterface<Q3Item>();
const q3Bag = useInterface<Q3Bag>();
export const q3Parent = defineBuilderConfig({
  name: 'Q3Parent',
  injections: [{
    token: q3Item,
    multi: true,
    useFactory: true,
    dependencies: [],
    lifecycle: 'transient',
    provider: () => ({ dispose() {} }),
  }],
});
export const q3Child = defineBuilderConfig({
  name: 'Q3Child',
  useContainer: q3Parent,
  injections: [{
    token: q3Bag,
    useFactory: true,
    dependencies: [{ all: q3Item }],
    provider: (context) => ({ items: context.resolveAll(q3Item) }),
  }],
});

interface Q3Plain { ping(): number }
interface Q3PlainBag { items: Q3Plain[] }
const q3Plain = useInterface<Q3Plain>();
const q3PlainBag = useInterface<Q3PlainBag>();
export const q3PlainParent = defineBuilderConfig({
  name: 'Q3PlainParent',
  injections: [{
    token: q3Plain,
    multi: true,
    useFactory: true,
    dependencies: [],
    lifecycle: 'transient',
    provider: () => ({ ping() { return 1; } }),
  }],
});
export const q3PlainChild = defineBuilderConfig({
  name: 'Q3PlainChild',
  useContainer: q3PlainParent,
  injections: [{
    token: q3PlainBag,
    useFactory: true,
    dependencies: [{ all: q3Plain }],
    provider: (context) => ({ items: context.resolveAll(q3Plain) }),
  }],
});

class Q4Private { dispose(): void {} }
class Q4Root { constructor(readonly hidden: Q4Private) {} }
class Q4Use { constructor(readonly root: Q4Root) {} }
export const q4Parent = defineBuilderConfig({
  name: 'Q4Parent',
  optimization: { mode: 'closed', roots: [Q4Root] },
  injections: [
    { token: Q4Private, lifecycle: 'transient' },
    { token: Q4Root, lifecycle: 'transient' },
  ],
});
export const q4Child = defineBuilderConfig({
  name: 'Q4Child',
  useContainer: q4Parent,
  injections: [{ token: Q4Use }],
});
`;

function programFrom(source: string): ts.Program {
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
    noImplicitAny: false,
  };
  const host = ts.createCompilerHost(options);
  const read = host.getSourceFile.bind(host);
  const exists = host.fileExists.bind(host);
  const readFile = host.readFile.bind(host);
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreateNewSourceFile) => {
    if (fileName === FILE) return ts.createSourceFile(fileName, source, languageVersion, true);
    if (fileName === STUB) return ts.createSourceFile(fileName, STUB_SOURCE, languageVersion, true);
    return read(fileName, languageVersion, onError, shouldCreateNewSourceFile);
  };
  host.fileExists = (fileName) => fileName === FILE || fileName === STUB || exists(fileName);
  host.readFile = (fileName) => {
    if (fileName === STUB) return STUB_SOURCE;
    if (fileName === FILE) return source;
    return readFile(fileName);
  };
  const resolved = {
    resolvedFileName: STUB,
    extension: ts.Extension.Ts,
    isExternalLibraryImport: false,
  };
  host.resolveModuleNameLiterals = (literals) => literals.map((literal) => ({
    resolvedModule: literal.text === '@djodjonx/neosyringe' ? resolved : undefined,
  }));
  return createFastProgram([FILE], options, host);
}

function lineOf(needle: string): number {
  const index = SOURCE.indexOf(needle);
  if (index < 0) throw new Error(`missing ${needle}`);
  return SOURCE.slice(0, index).split('\n').length;
}

function captured(errors: readonly AnalysisError[] | undefined): AnalysisError[] {
  return (errors ?? []).filter((error) => error.code === CODE);
}

function named(graphs: readonly DependencyGraph[], name: string): DependencyGraph {
  const found = graphs.find((graph) => graph.containerName === name);
  if (!found) throw new Error(`missing graph ${name}`);
  return found;
}

describe('DisposableTransientCapture', () => {
  let program: ts.Program;

  beforeAll(() => {
    warmLibCache();
    program = programFrom(SOURCE);
  });

  it('P1 strict class singleton captures a disposable class transient', () => {
    const analyzer = new Analyzer(program);
    const graph = named(analyzer.extractAll(), 'P1Box');
    const fromAll = captured(graph.errors);
    expect(fromAll).toHaveLength(1);
    const error = fromAll[0];
    if (!error) throw new Error('missing capture');
    expect(error.code).toBe(CODE);
    expect(error.severity).toBe('error');
    expect(error.message).toContain("container 'P1Box'");
    expect(error.message).toContain("singleton 'P1Svc'");
    expect(error.message).toContain("disposable transient 'P1Conn'");
    const stable = toStableDiagnostic(error);
    expect(stable.file.endsWith('disposable-transient-capture.ts')).toBe(true);
    expect(stable.line).toBe(lineOf('{ token: P1Svc }'));

    const fromFile = captured(analyzer.extractForFile(FILE).errors).filter((item) => item.message.includes("container 'P1Box'"));
    expect(fromFile).toHaveLength(1);
    const fileError = fromFile[0];
    if (!fileError) throw new Error('missing file capture');
    expect(toStableDiagnostic(fileError).line).toBe(stable.line);
  });

  it('P2 a non-disposable transient in a singleton is silent', () => {
    const graph = named(new Analyzer(program).extractAll(), 'PlainBox');
    expect(captured(graph.errors)).toHaveLength(0);
  });

  it('P3 a disposable transient in a transient consumer is silent', () => {
    const graph = named(new Analyzer(program).extractAll(), 'TransientBox');
    expect(captured(graph.errors)).toHaveLength(0);
  });

  it('P4 a scoped singleton is refused', () => {
    const graph = named(new Analyzer(program).extractAll(), 'ScopedSingle');
    expect(captured(graph.errors)).toHaveLength(1);
  });

  it('P4b a scoped transient consumer is silent', () => {
    const graph = named(new Analyzer(program).extractAll(), 'ScopedBox');
    expect(captured(graph.errors)).toHaveLength(0);
  });

  it('P5 three-token chain', () => {
    const graph = named(new Analyzer(program).extractAll(), 'ChainBox');
    const errors = captured(graph.errors);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.context?.chain).toEqual(['ChainRoot', 'ChainMid', 'ChainLeaf']);
  });

  it('P6 child singleton captures the parent disposable transient', () => {
    const analyzer = new Analyzer(program);
    const child = named(analyzer.extractAll(), 'LeakChild');
    const errors = captured(child.errors);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.containerId).toBe(child.containerKey);
    const modular = captured(analyzer.extractForFile(FILE).errors).filter((error) => error.containerId === child.containerKey);
    expect(modular).toHaveLength(1);
  });

  it('P6 child singleton may use a parent singleton disposable', () => {
    const child = named(new Analyzer(program).extractAll(), 'HeldChild');
    expect(captured(child.errors)).toHaveLength(0);
  });

  it('P7 one partial consumer extended by two builders is one diagnostic', () => {
    const analyzer = new Analyzer(program);
    const graphs = analyzer.extractAll();
    const partA = captured(named(graphs, 'PartA').errors);
    const partB = captured(named(graphs, 'PartB').errors);
    expect(partA).toHaveLength(1);
    expect(partB).toHaveLength(1);
    expect(partA[0]?.node.getStart()).toBe(partB[0]?.node.getStart());
  });

  it('P7b listing paths report the shared partial once', () => {
    const analyzer = new Analyzer(program);
    const fromBatch = captured(analyzer.extractAllErrors()).filter((error) => error.message.includes("singleton 'PartSvc'"));
    const fromFile = captured(analyzer.extractForFile(FILE).errors).filter((error) => error.message.includes("singleton 'PartSvc'"));
    expect(fromBatch).toHaveLength(1);
    expect(fromFile).toHaveLength(1);
  });

  it('P8 singleton factory dependencies token', () => {
    const graph = named(new Analyzer(program).extractAll(), 'P8Box');
    const errors = captured(graph.errors);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain("singleton 'P8Svc'");
    expect(errors[0]?.message).toContain('P8Conn');
  });

  it('P8 singleton factory dependencies all', () => {
    const graph = named(new Analyzer(program).extractAll(), 'P8AllBox');
    const errors = captured(graph.errors);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain("singleton 'P8Bag'");
    expect(errors[0]?.message).toContain('P8All');
  });

  it('P9 compatible warns and still generates', () => {
    const compatible = new Analyzer(program, { validation: 'compatible' });
    const graph = named(compatible.extractAll(), 'P1Box');
    const warning = captured(graph.errors);
    expect(warning).toHaveLength(1);
    expect(warning[0]?.severity).toBe('warning');
    expect(typeof new Generator(graph).generate()).toBe('string');

    const strict = captured(named(new Analyzer(program).extractAll(), 'P1Box').errors);
    expect(strict[0]?.severity).toBe('error');
  });

  it('P10 both paths share code, containerId and file:line', () => {
    const analyzer = new Analyzer(program);
    const graph = named(analyzer.extractAll(), 'P1Box');
    const fromAll = captured(graph.errors)[0];
    const fromExtract = captured(analyzer.extract().errors).find((error) => error.message.includes("container 'P1Box'"));
    const fromFile = captured(analyzer.extractForFile(FILE).errors).find((error) => error.message.includes("container 'P1Box'"));
    expect(fromAll).toBeDefined();
    expect(fromExtract).toBeDefined();
    expect(fromFile).toBeDefined();
    if (!fromAll || !fromExtract || !fromFile) return;
    const all = toStableDiagnostic(fromAll);
    const extracted = toStableDiagnostic(fromExtract);
    const file = toStableDiagnostic(fromFile);
    expect(fromExtract.code).toBe(fromAll.code);
    expect(fromFile.code).toBe(fromAll.code);
    expect(fromExtract.containerId).toBe(graph.containerKey);
    expect(fromAll.containerId).toBe(graph.containerKey);
    expect(fromFile.containerId).toBe(graph.containerKey);
    expect(extracted.line).toBe(all.line);
    expect(file.line).toBe(all.line);
    expect(extracted.file).toBe(all.file);
  });

  it('P11 async dispose is refused', () => {
    const graph = named(new Analyzer(program).extractAll(), 'AsyncBox');
    expect(captured(graph.errors)).toHaveLength(1);
  });

  it('P11 a string dispose is not disposable', () => {
    const graph = named(new Analyzer(program).extractAll(), 'StringBox');
    expect(captured(graph.errors)).toHaveLength(0);
  });

  it('zero transients are silent', () => {
    const graph = named(new Analyzer(program).extractAll(), 'Quiet');
    expect(captured(graph.errors)).toHaveLength(0);
  });

  it('two captures from one consumer are two diagnostics', () => {
    const graph = named(new Analyzer(program).extractAll(), 'TwoBox');
    const errors = captured(graph.errors);
    expect(errors).toHaveLength(2);
    const messages = errors.map((error) => error.message).join('\n');
    expect(messages).toContain('TwoA');
    expect(messages).toContain('TwoB');
    expect(messages).toContain("singleton 'TwoSvc'");
  });

  it('P6 child singleton captures through a parent transient', () => {
    const child = named(new Analyzer(program).extractAll(), 'ChainPChild');
    const errors = captured(child.errors);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.context?.chain).toEqual(['ChainPUse', 'ChainPMid', 'ChainPLeaf']);
  });

  it('P16 a diamond captures one disposable transient', () => {
    const analyzer = new Analyzer(program);
    const fromAll = captured(named(analyzer.extractAll(), 'DiaBox').errors);
    const fromFile = captured(analyzer.extractForFile(FILE).errors).filter((error) => error.message.includes("singleton 'DiaRoot'"));
    expect(fromAll).toHaveLength(1);
    expect(fromFile).toHaveLength(1);
    expect(fromAll[0]?.message).toContain("disposable transient 'DiaLeaf'");
  });

  it('P17a class token with a provider returning any uses the instance type', () => {
    const graph = named(new Analyzer(program).extractAll(), 'AnyClass');
    expect(captured(graph.errors)).toHaveLength(1);
  });

  it('P17b interface token with a provider returning any is refused', () => {
    const graph = named(new Analyzer(program).extractAll(), 'FaceBox');
    const errors = captured(graph.errors);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain('FaceConn');
  });

  it('P17c a disposable return type wins over a non-disposable token', () => {
    const graph = named(new Analyzer(program).extractAll(), 'RetBox');
    expect(captured(graph.errors)).toHaveLength(1);
  });

  it('P17d a class with only a static dispose is silent', () => {
    const graph = named(new Analyzer(program).extractAll(), 'StaticBox');
    expect(captured(graph.errors)).toHaveLength(0);
  });

  it('P18 aliased import and namespace call name the container', () => {
    const analyzer = new Analyzer(program);
    const graphs = analyzer.extractAll();
    const alias = named(graphs, 'AliasBox');
    const aliasErrors = captured(alias.errors);
    expect(aliasErrors).toHaveLength(1);
    expect(aliasErrors[0]?.containerId).toBe(alias.containerKey);
    expect(aliasErrors[0]?.message).toContain("container 'AliasBox'");
    const neoGraph = named(graphs, 'NeoBox');
    const neoErrors = captured(neoGraph.errors);
    expect(neoErrors).toHaveLength(1);
    expect(neoErrors[0]?.containerId).toBe(neoGraph.containerKey);
    expect(neoErrors[0]?.message).toContain("container 'NeoBox'");
  });

  it('P19 an optional constructor parameter of a disposable transient is refused', () => {
    const graph = named(new Analyzer(program).extractAll(), 'OptBox');
    expect(captured(graph.errors)).toHaveLength(1);
  });

  it('P15 a borrowed transient factory stays refused', () => {
    const graph = named(new Analyzer(program).extractAll(), 'BorrowedBox');
    expect(captured(graph.errors)).toHaveLength(1);
  });

  it('W1 a cycle of transients under a singleton terminates', () => {
    const graph = named(new Analyzer(program).extractAll(), 'CycBox');
    expect(captured(graph.errors)).toHaveLength(0);
  });

  it('W2 a local singleton shadows a parent disposable transient', () => {
    const analyzer = new Analyzer(program);
    const graphs = analyzer.extractAll();
    expect(captured(named(graphs, 'ShadowPlainChild').errors)).toHaveLength(0);
    expect(captured(named(graphs, 'ShadowDispChild').errors)).toHaveLength(0);
  });

  it('W3 extractAll does not call ConfigCollector.collect', () => {
    const collect = vi.spyOn(ConfigCollector.prototype, 'collect');
    try {
      const graphs = new Analyzer(program).extractAll();
      expect(collect).not.toHaveBeenCalled();
      expect(captured(named(graphs, 'LeakChild').errors)).toHaveLength(1);
    } finally {
      collect.mockRestore();
    }
  });

  it('Q1 child singleton captures a parent disposable transient through a local transient', () => {
    const graphs = new Analyzer(program).extractAll();
    const child = named(graphs, 'Q1Child');
    const errors = captured(child.errors);
    expect(errors).toHaveLength(1);
    const error = errors[0];
    if (!error) throw new Error('missing capture');
    expect(error.code).toBe(CODE);
    expect(error.containerId).toBe(child.containerKey);
    expect(error.context?.chain).toEqual(['Q1Use', 'Q1Local', 'Q1Captured']);
    expect(captured(named(graphs, 'Q1PlainChild').errors)).toHaveLength(0);
  });

  it('Q2 grandchild singleton captures a grandparent disposable transient', () => {
    const graphs = new Analyzer(program).extractAll();
    const child = named(graphs, 'Q2Child');
    const errors = captured(child.errors);
    expect(errors).toHaveLength(1);
    const error = errors[0];
    if (!error) throw new Error('missing capture');
    expect(error.code).toBe(CODE);
    expect(error.containerId).toBe(child.containerKey);
    expect(error.message).toContain("singleton 'Q2Use'");
    expect(error.message).toContain("disposable transient 'Q2Leak'");
    expect(captured(named(graphs, 'Q2HeldChild').errors)).toHaveLength(0);
  });

  it('Q3 child singleton captures a parent multi disposable transient', () => {
    const graphs = new Analyzer(program).extractAll();
    const child = named(graphs, 'Q3Child');
    const errors = captured(child.errors);
    expect(errors).toHaveLength(1);
    const error = errors[0];
    if (!error) throw new Error('missing capture');
    expect(error.code).toBe(CODE);
    expect(error.containerId).toBe(child.containerKey);
    expect(error.message).toContain("singleton 'Q3Bag'");
    expect(error.message).toContain('Q3Item');
    expect(captured(named(graphs, 'Q3PlainChild').errors)).toHaveLength(0);
  });

  it('Q4 child of a closed parent captures a private disposable transient', () => {
    const graphs = new Analyzer(program).extractAll();
    const child = named(graphs, 'Q4Child');
    const errors = captured(child.errors);
    expect(errors).toHaveLength(1);
    const error = errors[0];
    if (!error) throw new Error('missing capture');
    expect(error.code).toBe(CODE);
    expect(error.containerId).toBe(child.containerKey);
    expect(error.context?.chain).toEqual(['Q4Use', 'Q4Root', 'Q4Private']);
  });
});
