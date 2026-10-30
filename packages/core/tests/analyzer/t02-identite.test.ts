import { createHash } from 'node:crypto';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as ts from 'typescript';
import { Analyzer } from '../../src/analyzer/Analyzer';
import { NeoTokenError } from '../../src/analyzer/errors/NeoTokenError';
import { GraphValidator } from '../../src/generator/GraphValidator';
import { HashUtils } from '../../src/analyzer/shared/HashUtils';
import { TokenResolverService } from '../../src/analyzer/shared/TokenResolverService';
import { TOKEN_DESCRIPTOR_SCHEMA, canonicalDescriptor, canonicalParts } from '../../src/analyzer/shared/tokenDescriptor';
import { TSContext } from '../../src/TSContext';

const USER_FILE = path.join(process.cwd(), 't02-virtual/user.ts');
const REEXPORT_FILE = path.join(process.cwd(), 't02-virtual/reexport.ts');
const ALIAS_FILE = path.join(process.cwd(), 't02-virtual/alias.ts');
const GENERICS_FILE = path.join(process.cwd(), 't02-virtual/generics.ts');
const PORT_A_FILE = path.join(process.cwd(), 't02-virtual/port-a.ts');
const PORT_B_FILE = path.join(process.cwd(), 't02-virtual/port-b.ts');
const UNSUPPORTED_FILE = path.join(process.cwd(), 't02-virtual/unsupported.ts');
const BOX_FILE = path.join(process.cwd(), 't02-virtual/box.ts');
const PROJ_A = '/a/proj/src/port.ts';
const PROJ_B = '/b/other/proj/src/port.ts';
const SIBLING = '/a/sibling/extra.ts';
const MERGE_B_FILE = path.join(process.cwd(), 't02-virtual/merge-b.ts');
const MERGE_A_FILE = path.join(process.cwd(), 't02-virtual/merge-a.ts');
const SCOPE_FILE = path.join(process.cwd(), 't02-virtual/scope.ts');
const PKG_WIDGET_FILE = '/t02-nm/node_modules/acme/index.d.ts';

const PORT_SOURCE = `
export interface Port { id: string }
export const port: Port = null!;
`;

const files = new Map<string, string>([
  [MERGE_B_FILE, `
    export {};
    declare global { interface Mixed { b: number } }
    export const mixedB: Mixed = null!;
  `],
  [MERGE_A_FILE, `
    export {};
    declare global { interface Mixed { a: string } }
    export const mixedA: Mixed = null!;
  `],
  [SCOPE_FILE, `
    export namespace N1 { export interface User { id: string } }
    export namespace N2 { export interface User { name: string } }
    export interface Q { id: string }
    export enum E { Q = 1 }
    export interface Repo<T> { find(): T }
    export interface Pair<A, B> { left: A; right: B }
    export interface A { id: string }
    export interface B { id: string }
    export interface C { id: string }
    export const ns1: Repo<N1.User> = null!;
    export const ns2: Repo<N2.User> = null!;
    export const repoQ: Repo<Q> = null!;
    export const repoEQ: Repo<E.Q> = null!;
    export const cfg1 = { a: 1 };
    export const cfg2 = { b: 'x' };
    export const type1: typeof cfg1 = cfg1;
    export const type2: typeof cfg2 = cfg2;
    export const nest1: Repo<[Pair<A, [B, C]>]> = null!;
    export const nest2: Repo<[Pair<A, [B]>, C]> = null!;
    export const repoDate: Repo<Date> = null!;
    export function localHolder() {
      interface LocalToken { id: string }
      class LocalClass { id = 1; }
      function useInterface<T>(): T { return null!; }
      const localToken: LocalToken = null!;
      const localClass: LocalClass = null!;
      return { token: useInterface<LocalToken>(), classToken: useInterface<LocalClass>() };
    }
  `],
  [PKG_WIDGET_FILE, `
    export interface Widget { id: string }
    export declare const widget: Widget;
  `],
  [USER_FILE, `
    export interface User { id: string }
    export interface Order { id: string }
    export const user: User = null!;
  `],
  [REEXPORT_FILE, `
    export type { User, Order } from './user';
  `],
  [ALIAS_FILE, `
    import { User, Order } from './reexport';
    import { User as U } from './reexport';
    import { User as Direct } from './user';
    type A = User;
    type S = { x: string };
    function useInterface<T>(): T { return null!; }
    export const asAlias = useInterface<A>();
    export const asUser = useInterface<User>();
    export const asRenamed = useInterface<U>();
    export const asDirect = useInterface<Direct>();
    export const asShape = useInterface<S>();
  `],
  [GENERICS_FILE, `
    import { User, Order } from './user';
    export interface Repo<T> { find(): T }
    export interface Node<T> { child: T }
    export const repoUser: Repo<User> = null!;
    export const repoOrder: Repo<Order> = null!;
    export const repoAB: Repo<User | Order> = null!;
    export const repoBA: Repo<Order | User> = null!;
    export const nodeUser: Node<Repo<User>> = null!;
    export const nodeOrder: Node<Repo<Order>> = null!;
    export const asArray: Repo<string[]> = null!;
    export const asTuple: Repo<[string, number]> = null!;
    export const asLiteral: Repo<'id'> = null!;
    export const asLitUnion: Repo<'b' | 'a'> = null!;
    export const asLitUnionRev: Repo<'a' | 'b'> = null!;
  `],
  [PORT_A_FILE, PORT_SOURCE],
  [PORT_B_FILE, PORT_SOURCE],
  [UNSUPPORTED_FILE, `
    export function unbound<T>(value: T): T { return value; }
    export const anyValue: any = 1;
    export const unknownValue: unknown = 1;
    export const anon: { y: string } = { y: 'a' };
    export function conditional<T>(value: T extends string ? number : boolean): T { return value; }
    function useInterface<T>(): T { return null!; }
    export function unboundCall<T>() { return useInterface<T>(); }
    export const asAny = useInterface<any>();
    export const asUnknown = useInterface<unknown>();
    export const asAnon = useInterface<{ y: string }>();
    export function condCall<T>() { return useInterface<T extends string ? number : boolean>(); }
  `],
  [BOX_FILE, `
    import { defineBuilderConfig } from '@djodjonx/neosyringe';
    function defineBuilderConfig(config: { injections: unknown[] }) { return config; }
    export class Box<T> { constructor(public value: string) {} }
    export interface User { id: string }
    export class Consumer { constructor(public box: Box<User>) {} }
    export const c = defineBuilderConfig({
      injections: [{ token: Box }, { token: Consumer }],
    });
  `],
  [PROJ_A, PORT_SOURCE],
  [PROJ_B, PORT_SOURCE],
  [SIBLING, PORT_SOURCE],
]);

let program: ts.Program;
let checker: ts.TypeChecker;

function createProgram(sourceFiles: Map<string, string>): ts.Program {
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
    noEmit: true,
  };
  const host = ts.createCompilerHost(options);
  const originalGetSourceFile = host.getSourceFile.bind(host);
  host.fileExists = (fileName) => sourceFiles.has(fileName) || ts.sys.fileExists(fileName);
  host.readFile = (fileName) => sourceFiles.get(fileName) ?? ts.sys.readFile(fileName);
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreateNewSourceFile) => {
    const text = sourceFiles.get(fileName);
    if (text !== undefined) return ts.createSourceFile(fileName, text, languageVersion, true);
    return originalGetSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile);
  };
  host.resolveModuleNames = (moduleNames, containingFile) => moduleNames.map((moduleName) => {
    if (moduleName.startsWith('.')) {
      const base = path.resolve(path.dirname(containingFile), moduleName);
      const candidate = sourceFiles.has(base) ? base : `${base}.ts`;
      if (sourceFiles.has(candidate)) {
        return {
          resolvedFileName: candidate,
          extension: ts.Extension.Ts,
          isExternalLibraryImport: false,
        };
      }
    }
    return ts.resolveModuleName(moduleName, containingFile, options, host).resolvedModule;
  });
  return ts.createProgram([...sourceFiles.keys()], options, host);
}

function sourceOf(fileName: string): ts.SourceFile {
  const sourceFile = program.getSourceFile(fileName);
  if (!sourceFile) throw new Error(`fichier absent: ${fileName}`);
  return sourceFile;
}

function callWithType(fileName: string, typeText: string): ts.CallExpression {
  let found: ts.CallExpression | undefined;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (
      ts.isCallExpression(node)
      && node.typeArguments?.[0]
      && node.typeArguments[0].getText() === typeText
    ) {
      found = node;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceOf(fileName));
  if (!found) throw new Error(`appel absent: ${typeText}`);
  return found;
}

function variableType(fileName: string, name: string): ts.Type {
  let declaration: ts.VariableDeclaration | undefined;
  const visit = (node: ts.Node): void => {
    if (declaration) return;
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) {
      declaration = node;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceOf(fileName));
  if (!declaration?.type) throw new Error(`variable absente: ${name}`);
  return checker.getTypeFromTypeNode(declaration.type);
}

function parameterType(fileName: string, className: string, index: number): ts.Type {
  let parameter: ts.ParameterDeclaration | undefined;
  const visit = (node: ts.Node): void => {
    if (parameter) return;
    if (ts.isClassDeclaration(node) && node.name?.text === className) {
      const ctor = node.members.find(ts.isConstructorDeclaration);
      parameter = ctor?.parameters[index];
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceOf(fileName));
  if (!parameter?.type) throw new Error(`paramètre absent: ${className}`);
  return checker.getTypeFromTypeNode(parameter.type);
}

function classValueType(fileName: string, className: string): ts.Type {
  let nameNode: ts.Identifier | undefined;
  const visit = (node: ts.Node): void => {
    if (nameNode) return;
    if (
      ts.isPropertyAssignment(node)
      && node.name.getText() === 'token'
      && ts.isIdentifier(node.initializer)
      && node.initializer.text === className
    ) {
      nameNode = node.initializer;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceOf(fileName));
  if (!nameNode) throw new Error(`token de classe absent: ${className}`);
  return checker.getTypeAtLocation(nameNode);
}

function functionParameterType(fileName: string, functionName: string): ts.Type {
  let parameter: ts.ParameterDeclaration | undefined;
  const visit = (node: ts.Node): void => {
    if (parameter) return;
    if (
      ts.isFunctionDeclaration(node)
      && node.name?.text === functionName
      && node.parameters[0]?.type
    ) {
      parameter = node.parameters[0];
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceOf(fileName));
  if (!parameter?.type) throw new Error(`fonction absente: ${functionName}`);
  return checker.getTypeFromTypeNode(parameter.type);
}

describe('T02 identité des tokens', () => {
  beforeAll(() => {
    program = createProgram(files);
    checker = program.getTypeChecker();
  });

  afterAll(() => {
    TSContext.reset();
  });

  it('T02-A04 alias, import renommé et réexport gardent l’identité', () => {
    const service = new TokenResolverService(checker);
    const userId = service.extractInterfaceTokenId(callWithType(ALIAS_FILE, 'User'));
    const aliasId = service.extractInterfaceTokenId(callWithType(ALIAS_FILE, 'A'));
    const renamedId = service.extractInterfaceTokenId(callWithType(ALIAS_FILE, 'U'));
    const directId = service.extractInterfaceTokenId(callWithType(ALIAS_FILE, 'Direct'));
    const shapeId = service.extractInterfaceTokenId(callWithType(ALIAS_FILE, 'S'));
    expect(aliasId).toBe(userId);
    expect(renamedId).toBe(userId);
    expect(directId).toBe(userId);
    expect(shapeId).not.toBe(userId);
  });

  it('T02-A06 une fonction de hash qui collisionne lève NEO_TOKEN_COLLISION', () => {
    const service = new TokenResolverService(checker, undefined, { hash: () => 'aaaaaaaa' });
    const portA = variableType(PORT_A_FILE, 'port');
    const portB = variableType(PORT_B_FILE, 'port');
    service.getTypeId(portA);
    try {
      service.getTypeId(portB);
      expect.fail('collision attendue');
    } catch (error) {
      expect(error).toBeInstanceOf(NeoTokenError);
      expect((error as NeoTokenError).code).toBe('NEO_TOKEN_COLLISION');
      expect((error as Error).message).toMatch(/NEO_TOKEN_COLLISION: .*port-a\.ts.* <> .*port-b\.ts/);
    }
  });

  it('T02-A07a les formes non canonisables lèvent NEO_TOKEN_UNSUPPORTED', () => {
    const service = new TokenResolverService(checker);
    const cases: Array<[ts.Type, ts.CallExpression, string]> = [
      [functionParameterType(UNSUPPORTED_FILE, 'unbound'), callWithType(UNSUPPORTED_FILE, 'T'), 'unbound-type-parameter'],
      [variableType(UNSUPPORTED_FILE, 'anyValue'), callWithType(UNSUPPORTED_FILE, 'any'), 'any'],
      [variableType(UNSUPPORTED_FILE, 'unknownValue'), callWithType(UNSUPPORTED_FILE, 'unknown'), 'unknown'],
      [variableType(UNSUPPORTED_FILE, 'anon'), callWithType(UNSUPPORTED_FILE, '{ y: string }'), 'anonymous-object'],
      [functionParameterType(UNSUPPORTED_FILE, 'conditional'), callWithType(UNSUPPORTED_FILE, 'T extends string ? number : boolean'), 'conditional'],
    ];
    const assertReason = (run: () => unknown, reason: string): void => {
      try {
        run();
      } catch (error) {
        expect(error).toBeInstanceOf(NeoTokenError);
        expect((error as NeoTokenError).code).toBe('NEO_TOKEN_UNSUPPORTED');
        expect((error as Error).message).toBe(`NEO_TOKEN_UNSUPPORTED: ${reason}`);
        return;
      }
      expect.fail(reason);
    };
    for (const [type, call, reason] of cases) {
      assertReason(() => service.getTypeId(type), reason);
      assertReason(() => service.extractInterfaceTokenId(call), reason);
      assertReason(() => canonicalParts(checker, type), reason);
      assertReason(() => service.describeType(type), reason);
    }
  });

  it('T02-A07b le même agencement sous deux projectRoot donne les mêmes ids', () => {
    const typeA = variableType(PROJ_A, 'port');
    const typeB = variableType(PROJ_B, 'port');
    const sibling = variableType(SIBLING, 'port');
    TSContext.projectRoot = '/a/proj';
    let idA = '';
    try {
      idA = new TokenResolverService(checker).getTypeId(typeA);
    } finally {
      TSContext.reset();
    }
    TSContext.projectRoot = '/b/other/proj';
    let idB = '';
    try {
      idB = new TokenResolverService(checker).getTypeId(typeB);
    } finally {
      TSContext.reset();
    }
    expect(idA).toBe(idB);
    expect(idA).toMatch(/^Port_[0-9a-f]{8}$/);
    TSContext.projectRoot = '/a/proj';
    try {
      const siblingService = new TokenResolverService(checker);
      expect(() => siblingService.getTypeId(sibling)).not.toThrow();
      expect(canonicalDescriptor(checker, sibling)).toContain('../sibling/');
    } finally {
      TSContext.reset();
    }
  });

  it('T02-generics arguments, unions, tableaux, tuples et littéraux', () => {
    const service = new TokenResolverService(checker);
    const repoUser = service.getTypeId(variableType(GENERICS_FILE, 'repoUser'));
    const repoOrder = service.getTypeId(variableType(GENERICS_FILE, 'repoOrder'));
    const repoAB = service.getTypeId(variableType(GENERICS_FILE, 'repoAB'));
    const repoBA = service.getTypeId(variableType(GENERICS_FILE, 'repoBA'));
    const nodeUser = service.getTypeId(variableType(GENERICS_FILE, 'nodeUser'));
    const nodeOrder = service.getTypeId(variableType(GENERICS_FILE, 'nodeOrder'));
    const asArray = service.getTypeId(variableType(GENERICS_FILE, 'asArray'));
    const asTuple = service.getTypeId(variableType(GENERICS_FILE, 'asTuple'));
    const asLiteral = service.getTypeId(variableType(GENERICS_FILE, 'asLiteral'));
    expect(repoUser).not.toBe(repoOrder);
    expect(repoAB).toBe(repoBA);
    expect(nodeUser).not.toBe(nodeOrder);
    expect(asArray).not.toBe(asTuple);
    expect(asArray).not.toBe(asLiteral);
    expect(asTuple).not.toBe(asLiteral);
    expect(new Set([repoUser, repoAB, nodeUser, asArray, asTuple, asLiteral]).size).toBe(6);
    const literal = canonicalDescriptor(checker, variableType(GENERICS_FILE, 'asLitUnion'));
    const reversed = canonicalDescriptor(checker, variableType(GENERICS_FILE, 'asLitUnionRev'));
    expect(literal).toBe(reversed);
    const aAt = literal.indexOf('lit|string|a');
    const bAt = literal.indexOf('lit|string|b');
    expect(aAt).toBeGreaterThan(-1);
    expect(aAt).toBeLessThan(bAt);
  });

  it('T02-A07 classe générique enregistrée sans arguments ne satisfait pas Box<User>', () => {
    const analyzer = new Analyzer(program);
    const graph = analyzer.extract();
    const service = new TokenResolverService(checker);
    const classId = service.getTypeIdFromConstructor(classValueType(BOX_FILE, 'Box'));
    const paramId = service.getTypeId(parameterType(BOX_FILE, 'Consumer', 0));
    expect(classId).not.toBe(paramId);
    const validator = new GraphValidator();
    expect(() => validator.validate(graph)).toThrow(/Missing injection/);
  });

  it('T02 constructeur any ou nom non résolu lève NEO_TOKEN_UNSUPPORTED', () => {
    const header = `import { defineBuilderConfig } from '@djodjonx/neosyringe';\n`;
    const sources = [
      `
        ${header}
        export class TakesAny { constructor(public value: any) {} }
        export const c = defineBuilderConfig({ injections: [{ token: TakesAny }] });
      `,
      `
        ${header}
        export class TakesMissing { constructor(public value: MissingName) {} }
        export const c = defineBuilderConfig({ injections: [{ token: TakesMissing }] });
      `,
    ];
    for (const source of sources) {
      const fileName = path.join(process.cwd(), 't02-virtual/ctor-param.ts');
      const local = createProgram(new Map([[fileName, source]]));
      const analyzer = new Analyzer(local);
      const thrown: unknown[] = [];
      try {
        analyzer.extract();
      } catch (error) {
        thrown.push(error);
      }
      try {
        analyzer.extractForFile(fileName);
      } catch (error) {
        thrown.push(error);
      }
      expect(thrown).toHaveLength(2);
      for (const error of thrown) {
        expect(error).toBeInstanceOf(NeoTokenError);
        expect((error as NeoTokenError).code).toBe('NEO_TOKEN_UNSUPPORTED');
      }
    }
  });

  it('T02-P14 Repo<N1.User> et Repo<N2.User> sont distincts', () => {
    const service = new TokenResolverService(checker);
    const ns1 = service.getTypeId(variableType(SCOPE_FILE, 'ns1'));
    const ns2 = service.getTypeId(variableType(SCOPE_FILE, 'ns2'));
    expect(ns1).not.toBe(ns2);
  });

  it('T02-P15 Repo<Q> et Repo<E.Q> sont distincts', () => {
    const service = new TokenResolverService(checker);
    const repoQ = service.getTypeId(variableType(SCOPE_FILE, 'repoQ'));
    const repoEQ = service.getTypeId(variableType(SCOPE_FILE, 'repoEQ'));
    expect(repoQ).not.toBe(repoEQ);
  });

  it('T02-P16 une déclaration locale lève NEO_TOKEN_UNSUPPORTED', () => {
    const service = new TokenResolverService(checker);
    const cases: Array<[ts.Type, ts.CallExpression]> = [
      [variableType(SCOPE_FILE, 'localToken'), callWithType(SCOPE_FILE, 'LocalToken')],
      [variableType(SCOPE_FILE, 'localClass'), callWithType(SCOPE_FILE, 'LocalClass')],
    ];
    for (const [type, call] of cases) {
      expect(() => service.getTypeId(type)).toThrow('NEO_TOKEN_UNSUPPORTED: local-declaration');
      expect(() => service.extractInterfaceTokenId(call)).toThrow('NEO_TOKEN_UNSUPPORTED: local-declaration');
    }
  });

  it('T02-P17 deux typeof objet lèvent NEO_TOKEN_UNSUPPORTED', () => {
    const service = new TokenResolverService(checker);
    expect(() => service.getTypeId(variableType(SCOPE_FILE, 'type1'))).toThrow('NEO_TOKEN_UNSUPPORTED: anonymous-object');
    expect(() => service.getTypeId(variableType(SCOPE_FILE, 'type2'))).toThrow('NEO_TOKEN_UNSUPPORTED: anonymous-object');
  });

  it('T02-P18 les tuples imbriqués Repo ne partagent pas un id', () => {
    const service = new TokenResolverService(checker);
    const nest1 = service.getTypeId(variableType(SCOPE_FILE, 'nest1'));
    const nest2 = service.getTypeId(variableType(SCOPE_FILE, 'nest2'));
    expect(nest1).not.toBe(nest2);
  });

  it('T02-P19 Repo<Date> porte une origine lib stable', () => {
    const type = variableType(SCOPE_FILE, 'repoDate');
    TSContext.projectRoot = '/proj-a';
    let text = '';
    let idA = '';
    try {
      const service = new TokenResolverService(checker);
      text = service.describeType(type);
      idA = service.getTypeId(type);
    } finally {
      TSContext.reset();
    }
    TSContext.projectRoot = '/proj-b';
    let idB = '';
    try {
      idB = new TokenResolverService(checker).getTypeId(type);
    } finally {
      TSContext.reset();
    }
    expect(text).toMatch(/\|lib\/lib\.[^|]+\|/);
    expect(idA).toBe(idB);
  });

  it('T02-P20 une déclaration node_modules porte une origine pkg stable', () => {
    const type = variableType(PKG_WIDGET_FILE, 'widget');
    TSContext.projectRoot = '/proj-a';
    let text = '';
    let idA = '';
    try {
      const service = new TokenResolverService(checker);
      text = service.describeType(type);
      idA = service.getTypeId(type);
    } finally {
      TSContext.reset();
    }
    TSContext.projectRoot = '/proj-b';
    let idB = '';
    try {
      idB = new TokenResolverService(checker).getTypeId(type);
    } finally {
      TSContext.reset();
    }
    expect(text).toContain('|pkg/acme/index.d.ts|');
    expect(idA).toBe(idB);
  });

  it('T02-W10 la déclaration fusionnée choisit la plus petite origine', () => {
    const text = canonicalDescriptor(checker, variableType(MERGE_B_FILE, 'mixedB'));
    expect(program.getRootFileNames().indexOf(MERGE_B_FILE)).toBeLessThan(program.getRootFileNames().indexOf(MERGE_A_FILE));
    expect(text).toContain('merge-a.ts');
    expect(text).not.toContain('merge-b.ts');
  });

  it('T02-schema le descripteur commence par v1', () => {
    const type = variableType(USER_FILE, 'user');
    const text = canonicalDescriptor(checker, type);
    expect(TOKEN_DESCRIPTOR_SCHEMA).toBe('v1');
    expect(text.startsWith(`${TOKEN_DESCRIPTOR_SCHEMA}|named|`)).toBe(true);
    expect(text).toContain('|User|');
    expect(new TokenResolverService(checker).describeType(type)).toBe(text);
  });

  it('T02-hash-descriptor', () => {
    const text = 'v1|prim|string';
    const expected = createHash('md5').update(text).digest('hex').slice(0, 8);
    expect(HashUtils.hashDescriptor(text)).toBe(expected);
  });
});
