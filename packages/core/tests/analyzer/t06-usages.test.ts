import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as ts from 'typescript';
import { sameFile, tsPath } from '../helpers/tsPath';
import { Analyzer } from '../../src/analyzer/Analyzer';
import type { AnalysisError, ConfigGraph } from '../../src/analyzer/types';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const ROOT = path.join(process.cwd(), 't06-virtual');

const TOKENS = path.join(ROOT, 'tokens.ts');
const A01_A = path.join(ROOT, 'a01-a.ts');
const A01_B = path.join(ROOT, 'a01-b.ts');
const A02_PARENT = path.join(ROOT, 'a02-parent.ts');
const A02_CHILD = path.join(ROOT, 'a02-child.ts');
const A02_EXTENDS = path.join(ROOT, 'a02-extends.ts');
const A02_LEGACY = path.join(ROOT, 'a02-legacy.ts');
const A03_REG = path.join(ROOT, 'a03-reg.ts');
const A03_USE = path.join(ROOT, 'a03-use.ts');
const A04 = path.join(ROOT, 'a04.ts');
const A05 = path.join(ROOT, 'a05.ts');
const A05_IMPORT = path.join(ROOT, 'a05-import.ts');
const A06 = path.join(ROOT, 'a06.ts');
const A06_PARENT = path.join(ROOT, 'a06-parent.ts');
const F1_FOREIGN = path.join(ROOT, 'f1-foreign.ts');
const F2_PARENT = path.join(ROOT, 'f2-parent.ts');
const F2_PART = path.join(ROOT, 'f2-part.ts');
const F2_JS_CHILD = path.join(ROOT, 'f2-js-child.ts');
const F2_JS_EXTENDS = path.join(ROOT, 'f2-js-extends.ts');
const F2_ALIAS_CHILD = path.join(ROOT, 'f2-alias-child.ts');
const F2_ALIAS_EXTENDS = path.join(ROOT, 'f2-alias-extends.ts');
const F6_LET = path.join(ROOT, 'f6-let.ts');
const F7_DEF = path.join(ROOT, 'f7-def.ts');
const F7_USE = path.join(ROOT, 'f7-use.ts');
const F7_ID = path.join(ROOT, 'f7-id.ts');
const F7_ID_USE = path.join(ROOT, 'f7-id-use.ts');
const P5_SCOPE = path.join(ROOT, 'p5-scope.ts');

const IMPORTS = `import { defineBuilderConfig, definePartialConfig, declareContainerTokens, useInterface, type Container, type FactoryContext } from '@djodjonx/neosyringe';`;

const files = new Map<string, string>([
  [TOKENS, `
    export interface IFoo { id: number }
    export interface IBar { id: number }
    export interface IExt { id: number }
    export interface IMulti { id: number }
    export interface ISingle { id: number }
    export interface ILegacy { id: number }
    export interface IUnused { id: number }
  `],
  [A01_A, `
    ${IMPORTS}
    import { IFoo } from './tokens';
    class FooImpl implements IFoo { id = 1 }
    export const containerA = defineBuilderConfig({
      injections: [{ token: useInterface<IFoo>(), provider: FooImpl }],
    });
  `],
  [A01_B, `
    ${IMPORTS}
    import { IFoo, IBar } from './tokens';
    class BarImpl implements IBar { id = 2 }
    export const containerB = defineBuilderConfig({
      injections: [{ token: useInterface<IBar>(), provider: BarImpl }],
    });
    containerB.resolve(useInterface<IFoo>());
    containerB.resolve(useInterface<IBar>());
  `],
  [A02_PARENT, `
    ${IMPORTS}
    import { IFoo } from './tokens';
    class FooImpl implements IFoo { id = 1 }
    export const parent = defineBuilderConfig({
      injections: [{ token: useInterface<IFoo>(), provider: FooImpl }],
    });
  `],
  [A02_CHILD, `
    ${IMPORTS}
    import { parent } from './a02-parent';
    import { IFoo } from './tokens';
    export const child = defineBuilderConfig({
      useContainer: parent,
      injections: [],
    });
    child.resolve(useInterface<IFoo>());
  `],
  [A02_EXTENDS, `
    ${IMPORTS}
    import { IExt } from './tokens';
    class ExtImpl implements IExt { id = 3 }
    export const part = definePartialConfig({
      injections: [{ token: useInterface<IExt>(), provider: ExtImpl }],
    });
    export const host = defineBuilderConfig({
      extends: [part],
      injections: [],
    });
    host.resolve(useInterface<IExt>());
  `],
  [A02_LEGACY, `
    ${IMPORTS}
    import { ILegacy } from './tokens';
    const legacy = declareContainerTokens<{ ILegacy: ILegacy }>({});
    export const legacyHost = defineBuilderConfig({
      useContainer: legacy,
      injections: [],
    });
    legacyHost.resolve(useInterface<ILegacy>());
  `],
  [A03_REG, `
    ${IMPORTS}
    import { IFoo } from './tokens';
    class FooImpl implements IFoo { id = 1 }
    export const container = defineBuilderConfig({
      injections: [{ token: useInterface<IFoo>(), provider: FooImpl }],
    });
  `],
  [A03_USE, `
    ${IMPORTS}
    import { IFoo, IBar } from './tokens';
    class BarImpl implements IBar { id = 2 }
    export const container = defineBuilderConfig({
      injections: [{ token: useInterface<IBar>(), provider: BarImpl }],
    });
    container.resolve(useInterface<IFoo>());
  `],
  [A04, `
    ${IMPORTS}
    import { IUnused } from './tokens';
    export const T = useInterface<IUnused>();
  `],
  [A05, `
    ${IMPORTS}
    import { IFoo, IBar } from './tokens';
    class BarImpl implements IBar { id = 2 }
    export const containerB = defineBuilderConfig({
      injections: [{ token: useInterface<IBar>(), provider: BarImpl }],
    });
    const c = containerB;
    c.resolve(useInterface<IFoo>());
    const same = true ? containerB : containerB;
    same.resolve(useInterface<IFoo>());
    function getContainer(): Container { return containerB; }
    getContainer().resolve(useInterface<IFoo>());
    function take(box: Container) { box.resolve(useInterface<IFoo>()); }
    const unrelated = { resolve(token: unknown): unknown { return token; } };
    unrelated.resolve(useInterface<IFoo>());
    const loose: any = {};
    loose.resolve(useInterface<IFoo>());
    Promise.resolve(useInterface<IFoo>());
    function fromFactory(context: FactoryContext) { return context.resolve(useInterface<IFoo>()); }
    void take;
    void fromFactory;
  `],
  [A05_IMPORT, `
    ${IMPORTS}
    import { containerB } from './a05';
    import { IFoo } from './tokens';
    containerB.resolve(useInterface<IFoo>());
  `],
  [A06, `
    ${IMPORTS}
    import { IMulti, ISingle, IUnused } from './tokens';
    class MultiA implements IMulti { id = 1 }
    class MultiB implements IMulti { id = 2 }
    class SingleImpl implements ISingle { id = 3 }
    export const box = defineBuilderConfig({
      injections: [
        { token: useInterface<IMulti>(), provider: MultiA, multi: true },
        { token: useInterface<IMulti>(), provider: MultiB, multi: true },
        { token: useInterface<ISingle>(), provider: SingleImpl },
      ],
    });
    box.resolve(useInterface<IMulti>());
    box.resolveAll(useInterface<ISingle>());
    box.resolveAll(useInterface<IUnused>());
    box.resolveAll(useInterface<IMulti>());
    box.resolve(useInterface<ISingle>());
  `],
  [A06_PARENT, `
    ${IMPORTS}
    import { parentMulti } from './a06-parent-def';
    import { IMulti } from './tokens';
    export const childMulti = defineBuilderConfig({
      useContainer: parentMulti,
      injections: [],
    });
    childMulti.resolveAll(useInterface<IMulti>());
    childMulti.resolve(useInterface<IMulti>());
  `],
  [path.join(ROOT, 'a06-parent-def.ts'), `
    ${IMPORTS}
    import { IMulti } from './tokens';
    class MultiA implements IMulti { id = 1 }
    class MultiB implements IMulti { id = 2 }
    export const parentMulti = defineBuilderConfig({
      injections: [
        { token: useInterface<IMulti>(), provider: MultiA, multi: true },
        { token: useInterface<IMulti>(), provider: MultiB, multi: true },
      ],
    });
  `],
  [F1_FOREIGN, `
    interface Container { resolve<T>(x: unknown): T }
    declare const ioc: Container;
    class Svc {}
    ioc.resolve(Svc);
  `],
  [F2_PARENT, `
    ${IMPORTS}
    import { IFoo } from './tokens';
    class FooImpl implements IFoo { id = 1 }
    export const parent = defineBuilderConfig({
      injections: [{ token: useInterface<IFoo>(), provider: FooImpl }],
    });
  `],
  [F2_PART, `
    ${IMPORTS}
    import { IExt } from './tokens';
    class ExtImpl implements IExt { id = 3 }
    export const part = definePartialConfig({
      injections: [{ token: useInterface<IExt>(), provider: ExtImpl }],
    });
  `],
  [F2_JS_CHILD, `
    ${IMPORTS}
    import { parent } from './f2-parent.js';
    import { IFoo, IBar } from './tokens';
    export const child = defineBuilderConfig({
      useContainer: parent,
      injections: [],
    });
    child.resolve(useInterface<IFoo>());
    child.resolve(useInterface<IBar>());
  `],
  [F2_JS_EXTENDS, `
    ${IMPORTS}
    import { part } from './f2-part.js';
    import { IExt, IBar } from './tokens';
    export const host = defineBuilderConfig({
      extends: [part],
      injections: [],
    });
    host.resolve(useInterface<IExt>());
    host.resolve(useInterface<IBar>());
  `],
  [F2_ALIAS_CHILD, `
    ${IMPORTS}
    import { parent } from '@t06/parent';
    import { IFoo, IBar } from './tokens';
    export const child = defineBuilderConfig({
      useContainer: parent,
      injections: [],
    });
    child.resolve(useInterface<IFoo>());
    child.resolve(useInterface<IBar>());
  `],
  [F2_ALIAS_EXTENDS, `
    ${IMPORTS}
    import { part } from '@t06/part';
    import { IExt, IBar } from './tokens';
    export const host = defineBuilderConfig({
      extends: [part],
      injections: [],
    });
    host.resolve(useInterface<IExt>());
    host.resolve(useInterface<IBar>());
  `],
  [F6_LET, `
    ${IMPORTS}
    import { IFoo } from './tokens';
    class FooImpl implements IFoo { id = 1 }
    export const full = defineBuilderConfig({
      injections: [{ token: useInterface<IFoo>(), provider: FooImpl }],
    });
    export const empty = defineBuilderConfig({ injections: [] });
    let c = full;
    c = empty;
    c.resolve(useInterface<IFoo>());
    let stable = full;
    stable.resolve(useInterface<IFoo>());
  `],
  [F7_DEF, `
    ${IMPORTS}
    import { IFoo } from './tokens';
    class FooImpl implements IFoo { id = 1 }
    export default defineBuilderConfig({
      injections: [{ token: useInterface<IFoo>(), provider: FooImpl }],
    });
  `],
  [F7_USE, `
    ${IMPORTS}
    import d from './f7-def';
    import { IFoo, IBar } from './tokens';
    d.resolve(useInterface<IFoo>());
    d.resolve(useInterface<IBar>());
  `],
  [F7_ID, `
    ${IMPORTS}
    import { IFoo } from './tokens';
    class FooImpl implements IFoo { id = 1 }
    const named = defineBuilderConfig({
      injections: [{ token: useInterface<IFoo>(), provider: FooImpl }],
    });
    export default named;
  `],
  [F7_ID_USE, `
    ${IMPORTS}
    import d from './f7-id';
    import { IFoo, IBar } from './tokens';
    d.resolve(useInterface<IFoo>());
    d.resolve(useInterface<IBar>());
  `],
  [P5_SCOPE, `
    ${IMPORTS}
    class ForeignScope { createScope(): this { return this; } }
    class Missing {}
    export const container = defineBuilderConfig({ injections: [] });
    const box: ForeignScope = container as unknown as ForeignScope;
    box.createScope().resolve(Missing);
    new ForeignScope().createScope().resolve(Missing);
  `],
]);

function createProgram(sources: Map<string, string>): ts.Program {
  mkdirSync(ROOT, { recursive: true });
  for (const [fileName, text] of sources) writeFileSync(fileName, text);
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
    skipLibCheck: true,
    noEmit: true,
    baseUrl: REPO,
    paths: {
      '@djodjonx/neosyringe': ['packages/neosyringe/src/index.ts'],
      '@t06/parent': [path.relative(REPO, F2_PARENT).split(path.sep).join('/')],
      '@t06/part': [path.relative(REPO, F2_PART).split(path.sep).join('/')],
    },
  };
  return ts.createProgram([...sources.keys()], options);
}

function usageErrors(errors: readonly AnalysisError[]): AnalysisError[] {
  return errors.filter((error) =>
    error.code === 'NEO_UNKNOWN_CONTAINER'
    || error.code === 'NEO_MULTI_REQUIRES_RESOLVE_ALL'
    || (error.code === 'NEO_MISSING_PROVIDER' && error.message.startsWith('NEO_MISSING_PROVIDER: ')),
  );
}

function configNamed(configs: Map<string, ConfigGraph>, name: string): ConfigGraph {
  const config = [...configs.values()].find((item) => item.name === name);
  if (!config) throw new Error(`missing config ${name}`);
  return config;
}

describe('T06 usages par conteneur', () => {
  let program: ts.Program;
  let analyzer: Analyzer;

  beforeAll(() => {
    program = createProgram(files);
    analyzer = new Analyzer(program);
  });

  afterAll(() => {
    rmSync(ROOT, { recursive: true, force: true });
  });

  it('T06-A01 token in A resolved in independent B', () => {
    const result = analyzer.extractForFile(A01_B);
    const again = analyzer.extractForFile(A01_B);
    const missing = usageErrors(result.errors).filter((error) => error.message.includes("'IFoo'"));
    const bar = usageErrors(result.errors).filter((error) => error.message.includes("'IBar'"));
    const containerB = configNamed(result.configs, 'containerB');

    expect(missing).toHaveLength(1);
    expect(missing[0]?.code).toBe('NEO_MISSING_PROVIDER');
    expect(missing[0]?.message).toBe(
      `NEO_MISSING_PROVIDER: 'IFoo' is not in container '${containerB.containerKey}'`,
    );
    expect(missing[0]?.containerId).toBe(containerB.containerKey);
    expect(tsPath(missing[0]?.sourceFile.fileName ?? '')).toBe(tsPath(A01_B));
    expect(missing[0]?.node.getText()).toContain('containerB.resolve');
    expect(bar).toHaveLength(0);
    expect(usageErrors(analyzer.extractForFile(A01_A).errors)).toHaveLength(0);
    expect(usageErrors(again.errors).map((error) => error.message)).toEqual(
      usageErrors(result.errors).map((error) => error.message),
    );
  });

  it('T06-A02 parent token resolves in B', () => {
    expect(usageErrors(analyzer.extractForFile(A02_CHILD).errors)).toHaveLength(0);
    expect(usageErrors(analyzer.extractForFile(A02_EXTENDS).errors)).toHaveLength(0);
    expect(usageErrors(analyzer.extractForFile(A02_LEGACY).errors)).toHaveLength(0);
  });

  it('T06-A03 same variable name in two modules', () => {
    const used = analyzer.extractForFile(A03_USE);
    const registered = analyzer.extractForFile(A03_REG);
    const missing = usageErrors(used.errors);
    const useKey = [...used.configs.values()].find(
      (config) => config.name === 'container' && sameFile(config.sourceFile.fileName, A03_USE),
    )?.containerKey;
    const regKey = [...registered.configs.values()].find(
      (config) => config.name === 'container' && sameFile(config.sourceFile.fileName, A03_REG),
    )?.containerKey;

    expect(missing).toHaveLength(1);
    expect(missing[0]?.code).toBe('NEO_MISSING_PROVIDER');
    expect(missing[0]?.containerId).toBe(useKey);
    expect(missing[0]?.containerId).not.toBe(regKey);
    expect(tsPath(missing[0]?.sourceFile.fileName ?? '')).toBe(tsPath(A03_USE));
    expect(usageErrors(registered.errors)).toHaveLength(0);
  });

  it('T06-A04 exported token without resolve', () => {
    expect(usageErrors(analyzer.extractForFile(A04).errors)).toHaveLength(0);
  });

  it('T06-A05 alias and unknown target', () => {
    const strict = usageErrors(analyzer.extractForFile(A05).errors);
    const imported = usageErrors(analyzer.extractForFile(A05_IMPORT).errors);
    const containerB = [...analyzer.extractForFile(A05).configs.values()].find(
      (config) => config.name === 'containerB' && sameFile(config.sourceFile.fileName, A05),
    );
    if (!containerB) throw new Error('missing config containerB');
    const alias = strict.find((error) => error.node.getText().startsWith('c.resolve'));
    const followed = strict.find((error) => error.node.getText().startsWith('same.resolve'));
    const computed = strict.find((error) => error.node.getText().includes('getContainer()'));
    const parameter = strict.find((error) => error.node.getText().startsWith('box.resolve'));
    const unrelated = strict.find((error) => error.node.getText().includes('unrelated.resolve'));
    const loose = strict.find((error) => error.node.getText().includes('loose.resolve'));
    const promise = strict.find((error) => error.node.getText().startsWith('Promise.resolve'));
    const factory = strict.find((error) => error.node.getText().includes('context.resolve'));

    expect(alias?.code).toBe('NEO_MISSING_PROVIDER');
    expect(alias?.containerId).toBe(containerB.containerKey);
    expect(alias?.message).toBe(
      `NEO_MISSING_PROVIDER: 'IFoo' is not in container '${containerB.containerKey}'`,
    );
    expect(followed?.code).toBe('NEO_MISSING_PROVIDER');
    expect(followed?.containerId).toBe(containerB.containerKey);
    expect(imported).toHaveLength(1);
    expect(imported[0]?.code).toBe('NEO_MISSING_PROVIDER');
    expect(imported[0]?.containerId).toBe(containerB.containerKey);
    expect(computed?.code).toBe('NEO_UNKNOWN_CONTAINER');
    expect(computed?.severity).toBe('error');
    expect(computed?.message).toBe('NEO_UNKNOWN_CONTAINER: resolve receiver is not a known container');
    expect(parameter?.code).toBe('NEO_UNKNOWN_CONTAINER');
    expect(parameter?.severity).toBe('error');
    expect(unrelated).toBeUndefined();
    expect(loose).toBeUndefined();
    expect(promise).toBeUndefined();
    expect(factory).toBeUndefined();

    const compatible = new Analyzer(program, { validation: 'compatible' });
    const warnings = usageErrors(compatible.extractForFile(A05).errors).filter(
      (error) => error.code === 'NEO_UNKNOWN_CONTAINER',
    );
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings.every((error) => error.severity === 'warning')).toBe(true);
  });

  it('T06-A06 resolve and resolveAll', () => {
    const errors = usageErrors(analyzer.extractForFile(A06).errors);
    const multiResolve = errors.find((error) => error.node.getText().startsWith('box.resolve('));
    const singleAll = errors.find((error) => error.node.getText().includes('resolveAll(useInterface<ISingle>'));
    const multiAll = errors.find((error) => error.node.getText().includes('resolveAll(useInterface<IMulti>'));
    const singleResolve = errors.find((error) => error.node.getText().includes('box.resolve(useInterface<ISingle>'));

    const absentAll = errors.find((error) => error.node.getText().includes('resolveAll(useInterface<IUnused>'));

    expect(multiResolve?.code).toBe('NEO_MULTI_REQUIRES_RESOLVE_ALL');
    expect(multiResolve?.message).toBe("NEO_MULTI_REQUIRES_RESOLVE_ALL: 'IMulti' is multi; use resolveAll");
    expect(singleAll).toBeUndefined();
    expect(absentAll).toBeUndefined();
    expect(multiAll).toBeUndefined();
    expect(singleResolve).toBeUndefined();

    // Parent resolveAll delegation is a runtime concern of another task.
    // The parent multi stays in the multi set so resolve still reports it.
    const parent = usageErrors(analyzer.extractForFile(A06_PARENT).errors);
    const parentAll = parent.find((error) => error.node.getText().includes('resolveAll'));
    const parentOne = parent.find((error) => error.node.getText().startsWith('childMulti.resolve('));
    expect(parentAll).toBeUndefined();
    expect(parentOne?.code).toBe('NEO_MULTI_REQUIRES_RESOLVE_ALL');
  });

  it('T06-F1 foreign Container type', () => {
    expect(usageErrors(analyzer.extractForFile(F1_FOREIGN).errors)).toHaveLength(0);
  });

  it('T06-F2 js specifier and path alias', () => {
    const cases = [F2_JS_CHILD, F2_JS_EXTENDS, F2_ALIAS_CHILD, F2_ALIAS_EXTENDS];
    for (const fileName of cases) {
      const errors = usageErrors(analyzer.extractForFile(fileName).errors);
      const kept = errors.find((error) =>
        error.node.getText().includes('IFoo') || error.node.getText().includes('IExt'),
      );
      const missing = errors.find((error) => error.node.getText().includes('IBar'));
      expect(kept).toBeUndefined();
      expect(missing?.code).toBe('NEO_MISSING_PROVIDER');
    }
  });

  it('T06-F6 reassigned let is unknown', () => {
    const errors = usageErrors(analyzer.extractForFile(F6_LET).errors);
    const reassigned = errors.find((error) => error.node.getText().startsWith('c.resolve'));
    const stable = errors.find((error) => error.node.getText().startsWith('stable.resolve'));
    expect(reassigned?.code).toBe('NEO_UNKNOWN_CONTAINER');
    expect(reassigned?.severity).toBe('error');
    expect(stable).toBeUndefined();
  });

  it('T06-F7 default export container', () => {
    const direct = usageErrors(analyzer.extractForFile(F7_USE).errors);
    const viaId = usageErrors(analyzer.extractForFile(F7_ID_USE).errors);
    const present = direct.find((error) => error.node.getText().includes('IFoo'));
    const absent = direct.find((error) => error.node.getText().includes('IBar'));
    const presentId = viaId.find((error) => error.node.getText().includes('IFoo'));
    const absentId = viaId.find((error) => error.node.getText().includes('IBar'));
    expect(present).toBeUndefined();
    expect(absent?.code).toBe('NEO_MISSING_PROVIDER');
    expect(presentId).toBeUndefined();
    expect(absentId?.code).toBe('NEO_MISSING_PROVIDER');
  });

  it('a user class with method createScope() is ignored', () => {
    const errors = usageErrors(analyzer.extractForFile(P5_SCOPE).errors);
    const box = errors.find((error) => error.node.getText().startsWith('box.createScope'));
    const constructed = errors.find((error) => error.node.getText().includes('new ForeignScope()'));
    expect(box).toBeUndefined();
    expect(constructed).toBeUndefined();
  });
});
