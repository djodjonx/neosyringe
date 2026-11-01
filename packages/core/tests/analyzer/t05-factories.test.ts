import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import * as ts from 'typescript';
import { Analyzer } from '../../src/analyzer/Analyzer';
import { GraphValidator } from '../../src/generator/GraphValidator';
import type { AnalysisError, DependencyGraph } from '../../src/analyzer/types';

const ROOT = path.join(process.cwd(), 't05-virtual');
const MISSING_FILE = path.join(ROOT, 'missing.ts');
const CYCLE_FILE = path.join(ROOT, 'cycle.ts');
const REQUIRED_FILE = path.join(ROOT, 'required.ts');
const ASYNC_FILE = path.join(ROOT, 'async.ts');
const RETURN_FILE = path.join(ROOT, 'return.ts');
const CAPTURED_FILE = path.join(ROOT, 'captured.ts');
const BAD_ENTRY_FILE = path.join(ROOT, 'bad-entry.ts');
const FACTORY_TYPED_FILE = path.join(ROOT, 'factory-typed.ts');
const REFERENCED_FILE = path.join(ROOT, 'referenced.ts');
const SELF_FILE = path.join(ROOT, 'self.ts');

const STUB = `
  import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';
  function defineBuilderConfig(config: any) { return config; }
  function useInterface<T>(): any { return null; }
`;

const files = new Map<string, string>([
  [MISSING_FILE, `
    ${STUB}
    class Missing {}
    interface WidgetFactory { id: number }
    export const missingContainer = defineBuilderConfig({
      name: 'MissingFactory',
      injections: [
        {
          token: useInterface<WidgetFactory>(),
          useFactory: true,
          dependencies: [Missing],
          provider: () => ({ id: 1 }),
        },
      ],
    });
  `],
  [CYCLE_FILE, `
    ${STUB}
    interface A { id: number }
    interface B { id: number }
    const tokenA = useInterface<A>();
    const tokenB = useInterface<B>();
    export const cycleContainer = defineBuilderConfig({
      name: 'CycleFactories',
      injections: [
        { token: tokenA, useFactory: true, dependencies: [tokenB], provider: () => ({ id: 1 }) },
        { token: tokenB, useFactory: true, dependencies: [tokenA], provider: () => ({ id: 2 }) },
      ],
    });
  `],
  [REQUIRED_FILE, `
    ${STUB}
    interface OpaqueFactory { id: number }
    export const opaqueContainer = defineBuilderConfig({
      name: 'OpaqueCase',
      injections: [
        {
          token: useInterface<OpaqueFactory>(),
          useFactory: true,
          provider: () => ({ id: 1 }),
        },
      ],
    });
  `],
  [ASYNC_FILE, `
    ${STUB}
    interface AsyncPort { id: number }
    interface TransientPort { id: number }
    export const asyncContainer = defineBuilderConfig({
      name: 'PromiseFactories',
      injections: [
        {
          token: useInterface<AsyncPort>(),
          useFactory: true,
          dependencies: [],
          provider: () => Promise.resolve({ id: 1 }),
        },
        {
          token: useInterface<TransientPort>(),
          useFactory: true,
          dependencies: [],
          lifecycle: 'transient',
          provider: () => Promise.resolve({ id: 2 }),
        },
      ],
    });
  `],
  [RETURN_FILE, `
    ${STUB}
    interface BadPort { id: number }
    interface GoodPort { id: number }
    export const returnContainer = defineBuilderConfig({
      name: 'ReturnTypes',
      injections: [
        {
          token: useInterface<BadPort>(),
          useFactory: true,
          dependencies: [],
          provider: () => ({ name: 'no' }),
        },
        {
          token: useInterface<GoodPort>(),
          useFactory: true,
          dependencies: [],
          provider: (): PromiseLike<GoodPort> => Promise.resolve({ id: 1 }),
        },
      ],
    });
  `],
  [CAPTURED_FILE, `
    ${STUB}
    class OtherSvc {}
    const other = defineBuilderConfig({
      name: 'OtherBox',
      injections: [{ token: OtherSvc }],
    });
    interface CapturedHost { id: number }
    interface HiddenHost { id: number }
    export const capturedContainer = defineBuilderConfig({
      name: 'CapturedCase',
      injections: [
        {
          token: useInterface<CapturedHost>(),
          useFactory: true,
          dependencies: [],
          provider: (ctx) => {
            other.resolve(OtherSvc);
            return { id: ctx ? 1 : 0 };
          },
        },
        {
          token: useInterface<HiddenHost>(),
          useFactory: true,
          dependencies: [],
          provider: (ctx) => {
            const forward = (api: { resolve: (token: unknown) => unknown }) => api.resolve(ctx);
            return { id: forward.length };
          },
        },
      ],
    });
  `],
  [BAD_ENTRY_FILE, `
    ${STUB}
    interface BadEntry { id: number }
    export const badEntryContainer = defineBuilderConfig({
      name: 'BadEntry',
      injections: [
        {
          token: useInterface<BadEntry>(),
          useFactory: true,
          dependencies: [{}],
          provider: () => ({ id: 1 }),
        },
      ],
    });
  `],
  [FACTORY_TYPED_FILE, `
    ${STUB}
    type Factory<T> = (context: { resolve(token: unknown): unknown }) => T | PromiseLike<T>;
    interface FactoryDb { id: number }
    const makeDb: Factory<FactoryDb> = () => ({ id: 1 });
    export const factoryTypedContainer = defineBuilderConfig({
      name: 'FactoryTyped',
      injections: [
        {
          token: useInterface<FactoryDb>(),
          useFactory: true,
          dependencies: [],
          provider: makeDb,
        },
      ],
    });
  `],
  [REFERENCED_FILE, `
    ${STUB}
    interface DeclaredPort { id: number }
    interface ConstPort { id: number }
    async function loadDeclared(): Promise<DeclaredPort> {
      return { id: 1 };
    }
    const loadConst: () => Promise<ConstPort> = () => Promise.resolve({ id: 2 });
    export const referencedContainer = defineBuilderConfig({
      name: 'ReferencedAsync',
      injections: [
        {
          token: useInterface<DeclaredPort>(),
          useFactory: true,
          dependencies: [],
          lifecycle: 'transient',
          provider: loadDeclared,
        },
        {
          token: useInterface<ConstPort>(),
          useFactory: true,
          dependencies: [],
          lifecycle: 'transient',
          provider: loadConst,
        },
      ],
    });
  `],
  [SELF_FILE, `
    ${STUB}
    interface SelfPort { id: number }
    class SelfSvc {}
    export const selfBox = defineBuilderConfig({
      name: 'SelfCapture',
      injections: [
        { token: SelfSvc },
        {
          token: useInterface<SelfPort>(),
          useFactory: true,
          dependencies: [],
          provider: () => {
            selfBox.resolve(SelfSvc);
            return { id: 1 };
          },
        },
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

function byCode(errors: readonly AnalysisError[], code: string): AnalysisError | undefined {
  return errors.find((error) => error.code === code);
}

function graphNamed(analyzer: Analyzer, name: string): DependencyGraph {
  const graph = analyzer.extractAll().find((item) => item.containerId === name);
  if (!graph) throw new Error(`missing graph ${name}`);
  return graph;
}

describe('T05 factories', () => {
  let program: ts.Program;
  let analyzer: Analyzer;

  beforeAll(() => {
    program = createProgram(files);
    analyzer = new Analyzer(program);
  });

  it('missing factory dep is NEO_MISSING_PROVIDER', () => {
    const modular = byCode(analyzer.extractForFile(MISSING_FILE).errors, 'NEO_MISSING_PROVIDER');
    expect(modular?.code).toBe('NEO_MISSING_PROVIDER');
    expect(modular?.message).toContain("'Missing'");
    expect(modular?.message).toContain('WidgetFactory');

    const legacy = new GraphValidator().validateAll(graphNamed(analyzer, 'MissingFactory'));
    const graphError = legacy.errors.find((error) => error.code === 'NEO_MISSING_PROVIDER');
    expect(graphError?.code).toBe('NEO_MISSING_PROVIDER');
    expect(graphError?.message).toContain("'Missing'");
    expect(graphError?.message).toContain('WidgetFactory');
  });

  it('factory cycle path is A -> B -> A', () => {
    const modular = byCode(analyzer.extractForFile(CYCLE_FILE).errors, 'NEO_CYCLE');
    expect(modular?.code).toBe('NEO_CYCLE');
    expect(modular?.message).toContain('A -> B -> A');

    const legacy = new GraphValidator().validateAll(graphNamed(analyzer, 'CycleFactories'));
    const graphError = legacy.errors.find((error) => error.code === 'NEO_CYCLE');
    expect(graphError?.code).toBe('NEO_CYCLE');
    expect(graphError?.message).toContain('A -> B -> A');
  });

  it('missing dependencies list', () => {
    const strictError = byCode(analyzer.extractForFile(REQUIRED_FILE).errors, 'NEO_FACTORY_DEPENDENCIES_REQUIRED');
    expect(strictError?.code).toBe('NEO_FACTORY_DEPENDENCIES_REQUIRED');
    expect(strictError?.severity).not.toBe('warning');
    expect(strictError?.message).toContain('OpaqueFactory');

    const compatible = new Analyzer(program, { validation: 'compatible' });
    const result = compatible.extractForFile(REQUIRED_FILE);
    const warning = byCode(result.errors, 'NEO_FACTORY_DEPENDENCIES_REQUIRED');
    expect(warning?.severity).toBe('warning');
    expect(warning?.code).toBe('NEO_FACTORY_DEPENDENCIES_REQUIRED');
    expect(warning?.message).toContain('opaque');
    const config = [...result.configs.values()].find(
      (item) => item.sourceFile.fileName === REQUIRED_FILE && item.type === 'builder',
    );
    const service = [...(config?.localInjections.values() ?? [])].find((info) =>
      info.tokenText.includes('OpaqueFactory'),
    );
    expect(service?.definition.opaque).toBe(true);
  });

  it('promise return is async', () => {
    const result = analyzer.extractForFile(ASYNC_FILE);
    const config = [...result.configs.values()].find(
      (item) => item.sourceFile.fileName === ASYNC_FILE && item.type === 'builder',
    );
    const asyncPort = [...(config?.localInjections.values() ?? [])].find((info) =>
      info.tokenText.includes('AsyncPort'),
    );
    expect(asyncPort?.definition.isAsync).toBe(true);

    const transient = byCode(result.errors, 'NEO_ASYNC_TRANSIENT');
    expect(transient?.code).toBe('NEO_ASYNC_TRANSIENT');
    expect(transient?.message).toContain('TransientPort');
  });

  it('wrong return type', () => {
    const result = analyzer.extractForFile(RETURN_FILE);
    const mismatches = result.errors.filter((error) => error.type === 'type-mismatch');
    const bad = mismatches.find((error) => error.message.includes('BadPort'));
    expect(bad?.type).toBe('type-mismatch');
    expect(bad?.message).toContain('BadPort');
    expect(mismatches.some((error) => error.message.includes('GoodPort'))).toBe(false);
  });

  it('resolve on another captured container', () => {
    const escapes = analyzer.extractForFile(CAPTURED_FILE).errors.filter(
      (error) => error.code === 'NEO_UNDECLARED_FACTORY_DEP',
    );
    expect(escapes).toHaveLength(1);
    expect(escapes[0]?.code).toBe('NEO_UNDECLARED_FACTORY_DEP');
    expect(escapes[0]?.message).toContain('NEO_UNDECLARED_FACTORY_DEP');
    expect(escapes[0]?.message).toContain('CapturedHost');
    expect(escapes[0]?.message).not.toContain('HiddenHost');
  });

  it('bad dependencies entry is NEO_CONFIG_UNSUPPORTED', () => {
    const error = byCode(analyzer.extractForFile(BAD_ENTRY_FILE).errors, 'NEO_CONFIG_UNSUPPORTED');
    expect(error?.code).toBe('NEO_CONFIG_UNSUPPORTED');
    expect(error?.message).toContain('not a token or { all: token }');
    expect(error?.message).toContain('BadEntry');
  });

  it('factory typed provider accepts union return', () => {
    const result = analyzer.extractForFile(FACTORY_TYPED_FILE);
    const mismatches = result.errors.filter((error) => error.type === 'type-mismatch');
    const bad = mismatches.find((error) => error.message.includes('FactoryDb'));
    expect(bad?.message).toBeUndefined();
  });

  it('referenced promise function is async', () => {
    const result = analyzer.extractForFile(REFERENCED_FILE);
    const transients = result.errors.filter((error) => error.code === 'NEO_ASYNC_TRANSIENT');
    const messages = transients.map((error) => error.message).join('\n');
    expect(messages).toContain('DeclaredPort');
    expect(messages).toContain('ConstPort');
  });

  it('self capture is NEO_UNDECLARED_FACTORY_DEP', () => {
    const error = byCode(analyzer.extractForFile(SELF_FILE).errors, 'NEO_UNDECLARED_FACTORY_DEP');
    expect(error?.code).toBe('NEO_UNDECLARED_FACTORY_DEP');
    expect(error?.message).toContain('SelfPort');
    expect(error?.message).toContain('resolves a captured container instead of its context');
  });
});
