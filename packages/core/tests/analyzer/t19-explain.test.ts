import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as ts from 'typescript';
import { hasText, sameFile, textAt, tsPath } from '../helpers/tsPath';
import { Analyzer } from '../../src/analyzer/Analyzer';
import type { AnalysisError, DependencyGraph } from '../../src/analyzer/types';
import {
  attributeErrors,
  buildRetentionReport,
  containerLookupFor,
  containerLookupOf,
  explainRetention,
  retentionEntries,
  stableCodeOf,
  stableSeverityOf,
  toStableDiagnostic,
} from '../../src/analyzer/errors';
import { createFastProgram, warmLibCache } from '../fastProgram';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const ROOT = '/virtual/t19-explain';
const SECRET = 'SECRET_SENTINEL_t19_9f3a71';

const STUB = `
  import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';
  function defineBuilderConfig(config: any) { return config; }
  function useInterface<T>(): any { return null; }
`;

const REAL = `import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';`;

function source(body: string): string {
  return `${STUB}\n${body}\n`;
}

const DIAMOND = path.join(ROOT, 'diamond.ts');
const CAUSES = path.join(ROOT, 'causes.ts');
const OPEN = path.join(ROOT, 'open.ts');
const ABSENT = path.join(ROOT, 'absent.ts');
const OPAQUE = path.join(ROOT, 'opaque.ts');
const ALPHA = path.join(ROOT, 'alpha.ts');
const BETA = path.join(ROOT, 'beta.ts');
const TWINS = path.join(ROOT, 'twins.ts');
const SUPPLIER = path.join(ROOT, 'supplier.ts');
const NEEDY = path.join(ROOT, 'needy.ts');
const SECRETS = path.join(ROOT, 'secrets.ts');
const MISSING = path.join(ROOT, 'missing.ts');
const DUPLICATE = path.join(ROOT, 'duplicate.ts');
const CYCLE = path.join(ROOT, 'cycle.ts');
const MULTI_CYCLE = path.join(ROOT, 'multi-cycle.ts');
const RESOLVE = path.join(ROOT, 'resolve.ts');
const STRAY_TWO = path.join(ROOT, 'stray-two.ts');
const STRAY_ONE = path.join(ROOT, 'stray-one.ts');

const files = new Map<string, string>([
  [DIAMOND, source(`
    class DiaD {}
    class DiaB { constructor(d: DiaD) {} }
    class DiaC { constructor(d: DiaD) {} }
    class DiaRoot { constructor(b: DiaB, c: DiaC) {} }
    class DiaIdle {}
    export const diamond = defineBuilderConfig({
      name: 'Diamond',
      optimization: { mode: 'closed', roots: [DiaRoot] },
      injections: [
        { token: DiaRoot },
        { token: DiaB },
        { token: DiaC },
        { token: DiaD },
        { token: DiaIdle },
      ],
    });
  `)],
  [CAUSES, source(`
    interface CauseRoot { n: number }
    interface CauseEager { n: number }
    interface CausePart { n: number }
    interface CauseIdle { n: number }
    const root = useInterface<CauseRoot>();
    const eager = useInterface<CauseEager>();
    const part = useInterface<CausePart>();
    const idle = useInterface<CauseIdle>();
    export const causes = defineBuilderConfig({
      name: 'Causes',
      optimization: { mode: 'closed', roots: [root], eager: [eager] },
      injections: [
        { token: root, useFactory: true, dependencies: [{ all: part }], provider: (ctx) => ctx.resolveAll(part) },
        { token: eager, useFactory: true, dependencies: [], provider: () => ({ n: 1 }) },
        { token: part, multi: true, useFactory: true, dependencies: [], provider: () => ({ n: 2 }) },
        { token: part, multi: true, useFactory: true, dependencies: [], provider: () => ({ n: 3 }) },
        { token: idle, useFactory: true, dependencies: [], provider: () => ({ n: 4 }) },
      ],
    });
  `)],
  [OPEN, source(`
    interface OpenOne { n: number }
    interface OpenTwo { n: number }
    const one = useInterface<OpenOne>();
    const two = useInterface<OpenTwo>();
    export const openMode = defineBuilderConfig({
      name: 'OpenMode',
      optimization: { mode: 'open' },
      injections: [
        { token: one, useFactory: true, dependencies: [], provider: () => ({ n: 1 }) },
        { token: two, useFactory: true, dependencies: [one], provider: () => ({ n: 2 }) },
      ],
    });
  `)],
  [ABSENT, source(`
    interface AbsentOne { n: number }
    const one = useInterface<AbsentOne>();
    export const absentMode = defineBuilderConfig({
      name: 'AbsentMode',
      injections: [
        { token: one, useFactory: true, dependencies: [], provider: () => ({ n: 1 }) },
      ],
    });
  `)],
  [OPAQUE, source(`
    interface OpaqueCfg { u: string }
    interface OpaqueHost { u: string }
    const cfg = useInterface<OpaqueCfg>();
    const host = useInterface<OpaqueHost>();
    export const opaqueOpen = defineBuilderConfig({
      name: 'OpaqueOpen',
      injections: [
        { token: cfg, useValue: { u: 'ok' } },
        { token: host, useFactory: true, provider: (ctx) => ctx.resolve(cfg) },
      ],
    });
  `)],
  [ALPHA, source(`
    interface AlphaOnly { n: number }
    const only = useInterface<AlphaOnly>();
    export const alpha = defineBuilderConfig({
      name: 'Alpha',
      optimization: { mode: 'closed', roots: [only] },
      injections: [
        { token: only, useFactory: true, dependencies: [], provider: () => ({ n: 1 }) },
      ],
    });
  `)],
  [BETA, source(`
    interface BetaOnly { n: number }
    const only = useInterface<BetaOnly>();
    export const beta = defineBuilderConfig({
      name: 'Beta',
      optimization: { mode: 'closed', roots: [only] },
      injections: [
        { token: only, useFactory: true, dependencies: [], provider: () => ({ n: 2 }) },
      ],
    });
  `)],
  [TWINS, source(`
    interface TwinOne { n: number }
    interface TwinTwo { n: number }
    const one = useInterface<TwinOne>();
    const two = useInterface<TwinTwo>();
    export const first = defineBuilderConfig({
      name: 'Twin',
      optimization: { mode: 'closed', roots: [one] },
      injections: [
        { token: one, useFactory: true, dependencies: [], provider: () => ({ n: 1 }) },
      ],
    });
    export const second = defineBuilderConfig({
      name: 'Twin',
      optimization: { mode: 'closed', roots: [two] },
      injections: [
        { token: two, useFactory: true, dependencies: [], provider: () => ({ n: 2 }) },
      ],
    });
  `)],
  [SECRETS, source(`
    interface SecretCfg { key: string }
    interface SecretOut { n: number }
    const cfg = useInterface<SecretCfg>();
    const out = useInterface<SecretOut>();
    export const secrets = defineBuilderConfig({
      name: 'Secrets',
      optimization: { mode: 'closed', roots: [out] },
      injections: [
        { token: cfg, useValue: { key: '${SECRET}' } },
        {
          token: out,
          useFactory: true,
          dependencies: [cfg],
          provider: (ctx) => { const text = '${SECRET}_FACTORY'; return { n: text.length + ctx.resolve(cfg).key.length }; },
        },
      ],
    });
  `)],
  [MISSING, source(`
    interface MissingDep { n: number }
    class NeedsMissing { constructor(dep: MissingDep) {} }
    export const missingDep = defineBuilderConfig({
      name: 'MissingDep',
      injections: [{ token: NeedsMissing }],
    });
  `)],
  [DUPLICATE, source(`
    class DupService {}
    export const duplicate = defineBuilderConfig({
      name: 'Duplicate',
      injections: [{ token: DupService }, { token: DupService }],
    });
  `)],
  [CYCLE, source(`
    class CycA { constructor(b: CycB) {} }
    class CycB { constructor(a: CycA) {} }
    export const cycle = defineBuilderConfig({
      name: 'Cycle',
      injections: [{ token: CycA }, { token: CycB }],
    });
  `)],
  [MULTI_CYCLE, source(`
    interface MultiPlug { run(): void }
    class MultiPlugA implements MultiPlug {
      constructor(p: MultiPlug) {}
      run() {}
    }
    export const multiCycle = defineBuilderConfig({
      name: 'MultiCycle',
      injections: [{ token: useInterface<MultiPlug>(), provider: MultiPlugA, multi: true }],
    });
  `)],
  [SUPPLIER, source(`
    export interface NeedyAbsent { n: number }
    export const supplier = defineBuilderConfig({
      name: 'Supplier',
      injections: [{ token: useInterface<NeedyAbsent>(), useFactory: true, dependencies: [], provider: () => ({ n: 1 }) }],
    });
  `)],
  [NEEDY, source(`
    import type { NeedyAbsent } from './supplier';
    class NeedyUser { constructor(dep: NeedyAbsent) {} }
    export const needy = defineBuilderConfig({
      name: 'Needy',
      injections: [{ token: NeedyUser }],
    });
  `)],
  [STRAY_TWO, `
    import { defineBuilderConfig, type Container } from '@djodjonx/neosyringe';
    class StrayOne {}
    export const strayA = defineBuilderConfig({ name: 'StrayA', injections: [{ token: StrayOne }] });
    class StrayTwo {}
    export const strayB = defineBuilderConfig({ name: 'StrayB', injections: [{ token: StrayTwo }] });
    function pickStray(): Container { return strayA; }
    pickStray().resolve(StrayOne);
  `],
  [STRAY_ONE, `
    import { defineBuilderConfig, type Container } from '@djodjonx/neosyringe';
    class LoneService {}
    export const loneBox = defineBuilderConfig({ name: 'Lone', injections: [{ token: LoneService }] });
    function pickLone(): Container { return loneBox; }
    pickLone().resolve(LoneService);
  `],
  [RESOLVE, `
    ${REAL}
    interface ResolvePresent { n: number }
    interface ResolveAbsent { n: number }
    export const resolver = defineBuilderConfig({
      name: 'Resolver',
      injections: [
        { token: useInterface<ResolvePresent>(), useFactory: true, dependencies: [], provider: () => ({ n: 1 }) },
      ],
    });
    resolver.resolve(useInterface<ResolveAbsent>());
  `],
]);

function programFrom(sources: Map<string, string>): ts.Program {
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
    noImplicitAny: false,
    baseUrl: REPO,
    paths: { '@djodjonx/neosyringe': ['packages/neosyringe/src/index.ts'] },
  };
  const host = ts.createCompilerHost(options);
  const read = host.getSourceFile.bind(host);
  const exists = host.fileExists.bind(host);
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreateNewSourceFile) => {
    const text = textAt(sources, fileName);
    if (text !== undefined) return ts.createSourceFile(fileName, text, languageVersion, true);
    return read(fileName, languageVersion, onError, shouldCreateNewSourceFile);
  };
  host.fileExists = (fileName) => hasText(sources, fileName) || exists(fileName);
  const directoryExists = host.directoryExists?.bind(host);
  host.directoryExists = (directory) => sameFile(directory, ROOT) || (directoryExists?.(directory) ?? false);
  return createFastProgram([...sources.keys()], options, host);
}

function byName(graphs: DependencyGraph[], name: string): DependencyGraph {
  const found = graphs.find((graph) => graph.containerId === name || graph.containerName === name);
  if (!found) throw new Error(`missing graph ${name}`);
  return found;
}

function entryFor(graph: DependencyGraph, token: string) {
  const entry = retentionEntries(graph).find((item) => item.token === token);
  if (!entry) throw new Error(`missing entry ${token}`);
  return entry;
}

function keysOf(value: unknown, into: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) keysOf(item, into);
  } else if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      into.add(key);
      keysOf(child, into);
    }
  }
  return into;
}

describe('T19 explain and retention report', () => {
  let program: ts.Program;
  let graphs: DependencyGraph[];
  let compatible: DependencyGraph[];
  let compatibleErrors: AnalysisError[];
  let strictErrors: AnalysisError[];

  beforeAll(() => {
    warmLibCache();
    program = programFrom(files);
    graphs = new Analyzer(program).extractAll();
    const loose = new Analyzer(program, { validation: 'compatible' });
    compatible = loose.extractAll();
    compatibleErrors = loose.extractAllErrors();
    strictErrors = new Analyzer(program).extractAllErrors();
  });

  afterAll(() => {
    graphs = [];
    compatible = [];
    compatibleErrors = [];
    strictErrors = [];
  });

  it('T19-A01 diamond path is stable', () => {
    const graph = byName(graphs, 'Diamond');
    const first = explainRetention([graph], 'DiaD');
    const second = explainRetention([graph], 'DiaD');

    expect(first.results).toHaveLength(1);
    expect(first.results[0]?.found).toBe(true);
    expect(first.results[0]?.cause).toBe('dependency-of');
    expect(first.results[0]?.path).toEqual(['DiaRoot', 'DiaB', 'DiaD']);
    expect(second.results[0]?.path).toEqual(first.results[0]?.path);
    expect(entryFor(graph, 'DiaRoot')).toMatchObject({ cause: 'root', path: ['DiaRoot'] });
    expect(entryFor(graph, 'DiaIdle')).toMatchObject({ cause: 'unreachable', path: [] });
  });

  it('T19-A02 eager and multi causes differ', () => {
    const graph = byName(graphs, 'Causes');
    const eager = explainRetention([graph], 'CauseEager').results[0];
    const parts = retentionEntries(graph).filter((entry) => entry.token === 'CausePart');

    expect(eager?.cause).toBe('eager');
    expect(eager?.path).toEqual(['CauseEager']);
    expect(parts).toHaveLength(2);
    for (const part of parts) {
      expect(part.cause).toBe('multi-contribution-of');
      expect(part.path).toEqual(['CauseRoot', 'CausePart']);
    }
    expect(new Set(parts.map((part) => part.registrationId)).size).toBe(2);
    expect(explainRetention([graph], 'CausePart').results).toHaveLength(2);
  });

  it('T19-A03 open parent has no weight', () => {
    for (const name of ['OpenMode', 'AbsentMode']) {
      const graph = byName(graphs, name);
      const entries = retentionEntries(graph);
      expect(entries.length).toBeGreaterThan(0);
      expect(entries.every((entry) => entry.cause === 'open-parent')).toBe(true);
      expect(entries.some((entry) => entry.cause === 'unreachable')).toBe(false);
    }
    const parsed = JSON.parse(JSON.stringify(buildRetentionReport(graphs)));
    const open = parsed.containers.find((item: { containerName?: string }) => item.containerName === 'OpenMode');
    expect(open.entries.map((entry: { cause: string }) => entry.cause)).toEqual(['open-parent', 'open-parent']);
    const keys = keysOf(parsed);
    for (const forbidden of ['size', 'weight', 'bytes', 'removable']) expect(keys.has(forbidden)).toBe(false);
  });

  it('T19-A04 absent token names the asked container', () => {
    const beta = byName(graphs, 'Beta');
    const alpha = byName(graphs, 'Alpha');
    const result = explainRetention(graphs, 'AlphaOnly', { container: 'Beta' });

    expect(result.schemaVersion).toBe(1);
    expect(result.results).toHaveLength(1);
    expect(result.results[0]).toMatchObject({
      found: false,
      token: 'AlphaOnly',
      containerKey: beta.containerKey,
      containerName: 'Beta',
      sourceFile: BETA,
    });
    expect(result.results[0]?.containerKey).not.toBe(alpha.containerKey);
    expect(explainRetention(graphs, 'AlphaOnly', { container: alpha.containerKey }).results[0]).toMatchObject({
      found: true,
      containerKey: alpha.containerKey,
      sourceFile: ALPHA,
      cause: 'root',
    });
    expect(explainRetention(graphs, 'NoSuchToken').results).toEqual([{ found: false, token: 'NoSuchToken' }]);
  });

  it('T19-A05 code survives a reworded message', () => {
    const missing = strictErrors.find((error) => error.code === 'NEO_MISSING_PROVIDER' && error.type === 'missing');
    if (!missing) throw new Error('missing provider error not produced');
    const reworded: AnalysisError = { ...missing, message: 'Reworded by a custom formatter' };

    expect(toStableDiagnostic(missing).code).toBe('NEO_MISSING_PROVIDER');
    expect(toStableDiagnostic(reworded).code).toBe('NEO_MISSING_PROVIDER');
    expect(toStableDiagnostic(reworded).severity).toBe('error');
    expect(toStableDiagnostic(reworded).message).toBe('Reworded by a custom formatter');
    expect(stableCodeOf(reworded)).toBe('NEO_MISSING_PROVIDER');
    expect(stableCodeOf({ ...reworded, code: undefined, type: 'duplicate' })).toBe('NEO_DUPLICATE_PROVIDER');
    expect(stableCodeOf({ ...reworded, code: undefined })).toBeUndefined();
    expect(buildRetentionReport(graphs).schemaVersion).toBe(1);
    expect(explainRetention(graphs, 'DiaD').schemaVersion).toBe(1);
  });

  it('T19-A06 rebuild keeps keys distinct', () => {
    const report = buildRetentionReport(graphs);
    const twins = report.containers.filter((item) => item.containerName === 'Twin');
    expect(twins).toHaveLength(2);
    expect(twins[0]?.containerKey).not.toBe(twins[1]?.containerKey);
    expect(tsPath(twins[0]?.sourceFile ?? '')).toBe(tsPath(TWINS));
    expect(tsPath(twins[1]?.sourceFile ?? '')).toBe(tsPath(TWINS));
    expect(twins.map((item) => item.entries.map((entry) => entry.token))).toEqual([['TwinOne'], ['TwinTwo']]);
    expect(new Set(report.containers.map((item) => item.containerKey)).size).toBe(report.containers.length);
    expect(explainRetention(graphs, 'TwinTwo', { container: 'Twin' }).results).toHaveLength(1);
    expect(explainRetention(graphs, 'TwinOne', { container: 'Twin' }).results[0]?.containerKey).toBe(twins[0]?.containerKey);

    const edited = new Map(files);
    edited.set(TWINS, (files.get(TWINS) ?? '').replace('interface TwinTwo', 'interface TwinRenamed').replace('useInterface<TwinTwo>', 'useInterface<TwinRenamed>'));
    const rebuilt = buildRetentionReport(new Analyzer(programFrom(edited)).extractAll());
    const again = rebuilt.containers.filter((item) => item.containerName === 'Twin');
    expect(again.map((item) => item.entries.map((entry) => entry.token))).toEqual([['TwinOne'], ['TwinRenamed']]);
    expect(again[1]?.containerKey).not.toBe(twins[1]?.containerKey);
  });

  it('T19 four causes stay distinct', () => {
    const opaque = byName(compatible, 'OpaqueOpen');
    const open = byName(graphs, 'OpenMode');
    const causes = byName(graphs, 'Causes');
    const found = new Set([
      entryFor(opaque, 'OpaqueHost').cause,
      entryFor(opaque, 'OpaqueCfg').cause,
      entryFor(open, 'OpenOne').cause,
      entryFor(causes, 'CauseEager').cause,
      entryFor(causes, 'CausePart').cause,
    ]);
    expect(entryFor(opaque, 'OpaqueHost').cause).toBe('opaque-boundary');
    expect(entryFor(opaque, 'OpaqueCfg').cause).toBe('open-parent');
    expect(entryFor(open, 'OpenOne').cause).toBe('open-parent');
    expect(entryFor(causes, 'CauseEager').cause).toBe('eager');
    expect(entryFor(causes, 'CausePart').cause).toBe('multi-contribution-of');
    expect([...found].sort()).toEqual(['eager', 'multi-contribution-of', 'opaque-boundary', 'open-parent']);
  });

  it('T19 secret stays out', () => {
    const graph = byName(graphs, 'Secrets');
    const dumps = [
      JSON.stringify(buildRetentionReport(graphs)),
      JSON.stringify(explainRetention(graphs, 'SecretOut')),
      JSON.stringify(explainRetention(graphs, 'SecretCfg')),
      JSON.stringify(retentionEntries(graph)),
    ];
    expect(entryFor(graph, 'SecretCfg').cause).toBe('dependency-of');
    for (const dump of dumps) expect(dump).not.toContain(SECRET);
    expect(dumps[0]).toContain('SecretCfg');
  });

  it('T19 no size field', () => {
    const report = buildRetentionReport(graphs);
    expect(report.containers.length).toBeGreaterThan(5);
    expect([...keysOf(report.containers[0]?.entries[0])].sort()).toEqual(['cause', 'path', 'registrationId', 'token']);
    expect([...keysOf({ ...report, containers: [] })].sort()).toEqual(['containers', 'schemaVersion']);
    expect([...keysOf(report.containers[0])].filter((key) => !['entries', 'registrationId', 'token', 'cause', 'path'].includes(key)).sort()).toEqual(['containerKey', 'containerName', 'sourceFile']);
    const all = keysOf(report);
    for (const forbidden of ['size', 'weight', 'bytes']) expect(all.has(forbidden)).toBe(false);
    const explained = keysOf(explainRetention(graphs, 'DiaD'));
    for (const forbidden of ['size', 'weight', 'bytes']) expect(explained.has(forbidden)).toBe(false);
  });

  it('T19 warning stays a warning', () => {
    const warning = compatibleErrors.find((error) => error.code === 'NEO_FACTORY_DEPENDENCIES_REQUIRED');
    if (!warning) throw new Error('opaque warning not produced');
    const stable = toStableDiagnostic(warning);

    expect(warning.severity).toBe('warning');
    expect(stable.severity).toBe('warning');
    expect(stable.code).toBe('NEO_FACTORY_DEPENDENCIES_REQUIRED');
    expect(stableSeverityOf(warning)).toBe('warning');
    expect(stableSeverityOf({ ...warning, severity: undefined })).toBe('error');
    expect(stableSeverityOf({ ...warning, severity: 'error' })).toBe('error');
  });

  it('T19 diagnostic fields and duplicate code', () => {
    const missing = strictErrors.find((error) => error.code === 'NEO_MISSING_PROVIDER' && error.type === 'missing' && sameFile(error.sourceFile.fileName, MISSING));
    const duplicate = strictErrors.find((error) => error.type === 'duplicate' && sameFile(error.sourceFile.fileName, DUPLICATE));
    const cycle = strictErrors.find((error) => error.type === 'cycle' && sameFile(error.sourceFile.fileName, CYCLE));
    const multiCycle = strictErrors.find((error) => error.type === 'cycle' && sameFile(error.sourceFile.fileName, MULTI_CYCLE));
    const miss = strictErrors.find((error) => error.code === 'NEO_MISSING_PROVIDER' && sameFile(error.sourceFile.fileName, RESOLVE));
    if (!missing || !duplicate || !cycle || !multiCycle || !miss) throw new Error('expected diagnostics were not produced');

    expect(toStableDiagnostic(missing)).toMatchObject({
      code: 'NEO_MISSING_PROVIDER',
      severity: 'error',
      file: MISSING,
      type: 'missing',
      token: 'MissingDep',
      chain: ['NeedsMissing', 'MissingDep'],
    });
    expect(toStableDiagnostic(missing).line).toBeGreaterThan(0);
    expect(toStableDiagnostic(missing).column).toBeGreaterThan(0);

    expect(duplicate.code).toBe('NEO_DUPLICATE_PROVIDER');
    expect(toStableDiagnostic(duplicate).code).toBe('NEO_DUPLICATE_PROVIDER');
    expect(toStableDiagnostic({ ...duplicate, code: undefined }).code).toBe('NEO_DUPLICATE_PROVIDER');

    const stableCycle = toStableDiagnostic(cycle);
    expect(stableCycle.code).toBe('NEO_CYCLE');
    expect(stableCycle.chain).toHaveLength(3);
    expect(stableCycle.chain?.[0]).toBe(stableCycle.chain?.[2]);
    expect([...(stableCycle.chain ?? [])].sort()).toEqual(['CycA', 'CycA', 'CycB']);

    const stableMulti = toStableDiagnostic(multiCycle);
    expect(stableMulti.code).toBe('NEO_CYCLE');
    expect(stableMulti.chain).toEqual(['MultiPlug', 'MultiPlug']);

    const resolver = byName(graphs, 'Resolver');
    expect(toStableDiagnostic(miss).containerId).toBe(resolver.containerKey);
    expect(toStableDiagnostic(miss).token).toBe('ResolveAbsent');
  });

  it('T19-A04 missing provider diagnostic names its container and source', () => {
    const needy = byName(graphs, 'Needy');
    const supplier = byName(graphs, 'Supplier');
    const missing = strictErrors.find((error) => error.code === 'NEO_MISSING_PROVIDER' && sameFile(error.sourceFile.fileName, NEEDY));
    if (!missing) throw new Error('missing provider error not produced');

    // The analyzer leaves containerId out of constructor-level misses: the unplugin tells them
    // from resolve-site misses by it (packages/unplugin/src/buildEndUsages.ts:70).
    expect(missing.containerId).toBeUndefined();
    const stable = toStableDiagnostic(missing, containerLookupOf(graphs));
    expect(stable).toMatchObject({
      code: 'NEO_MISSING_PROVIDER',
      containerId: needy.containerKey,
      containerName: 'Needy',
      containerFile: NEEDY,
      file: NEEDY,
      token: 'NeedyAbsent',
    });
    expect(stable.containerId).not.toBe(supplier.containerKey);
    expect(toStableDiagnostic(missing).containerId).toBeUndefined();
    expect(toStableDiagnostic(missing).containerName).toBeUndefined();
    expect(toStableDiagnostic(missing, containerLookupFor(needy)).containerName).toBe('Needy');
    // Displayed under another container, an error it does not own is not stamped with that container.
    expect(toStableDiagnostic(missing, containerLookupFor(supplier)).containerName).toBeUndefined();
    expect(toStableDiagnostic(missing, containerLookupFor(supplier)).containerFile).toBeUndefined();
    const asked = explainRetention(graphs, 'NeedyAbsent', { container: 'Needy' }).results[0];
    expect(asked).toMatchObject({ found: false, containerKey: needy.containerKey, sourceFile: NEEDY });
  });

  it('T19 unknown container is told apart from an absent token', () => {
    const unknown = explainRetention(graphs, 'AlphaOnly', { container: 'NoSuchContainer' }).results;
    const absent = explainRetention(graphs, 'AlphaOnly', { container: 'Beta' }).results;

    expect(unknown).toEqual([{ found: false, token: 'AlphaOnly', containerFound: false, container: 'NoSuchContainer' }]);
    expect(absent[0]?.containerFound).toBeUndefined();
    expect(absent[0]?.containerKey).toBe(byName(graphs, 'Beta').containerKey);
  });

  it('T19 errors are attributed to their own container', () => {
    const needy = byName(graphs, 'Needy');
    const supplier = byName(graphs, 'Supplier');
    const missing = strictErrors.find((error) => error.code === 'NEO_MISSING_PROVIDER' && sameFile(error.sourceFile.fileName, NEEDY));
    const miss = strictErrors.find((error) => error.code === 'NEO_MISSING_PROVIDER' && sameFile(error.sourceFile.fileName, RESOLVE));
    if (!missing || !miss) throw new Error('expected diagnostics were not produced');
    const owned = attributeErrors(graphs, strictErrors);

    expect(owned.get(needy)).toContain(missing);
    expect(owned.get(supplier)).not.toContain(missing);
    expect(owned.get(byName(graphs, 'Resolver'))).toContain(miss);
    expect(containerLookupOf(graphs)(miss)?.containerKey).toBe(byName(graphs, 'Resolver').containerKey);
    expect(attributeErrors(graphs, []).get(needy)).toEqual([]);
  });

  it('T19 a container is named only when one container owns the error', () => {
    const duplicate = strictErrors.find((error) => error.type === 'duplicate' && sameFile(error.sourceFile.fileName, DUPLICATE));
    if (!duplicate) throw new Error('duplicate error not produced');
    const own = byName(graphs, 'Duplicate');
    const twin = { ...own, containerKey: 'twin-key', containerName: 'Twin' };
    const unpositioned = { ...own, defineBuilderConfigStart: undefined, defineBuilderConfigEnd: undefined };

    expect(containerLookupOf([own])(duplicate)?.containerName).toBe('Duplicate');
    // Two graphs whose range holds the node: no single owner, nothing is named.
    expect(containerLookupOf([own, twin])(duplicate)).toBeUndefined();
    expect(toStableDiagnostic(duplicate, containerLookupOf([own, twin])).containerName).toBeUndefined();
    // A graph with no known range owns nothing, even alone in its file.
    expect(containerLookupOf([unpositioned])(duplicate)).toBeUndefined();
    const shown = attributeErrors([unpositioned, { ...unpositioned, containerKey: 'twin-key' }], [duplicate]);
    expect([...shown.values()].every((list) => list.includes(duplicate))).toBe(true);
  });

  it('T19 a diagnostic outside every container range names no container', () => {
    const outside = (file: string) => strictErrors.find((error) => error.code === 'NEO_UNKNOWN_CONTAINER' && sameFile(error.sourceFile.fileName, file));
    const twoContainers = outside(STRAY_TWO);
    const oneContainer = outside(STRAY_ONE);
    if (!twoContainers || !oneContainer) throw new Error('unknown receiver error not produced');
    const strayA = byName(graphs, 'StrayA');
    const strayB = byName(graphs, 'StrayB');
    const lone = byName(graphs, 'Lone');

    for (const error of [twoContainers, oneContainer]) {
      expect(error.containerId).toBeUndefined();
      expect(containerLookupOf(graphs)(error)).toBeUndefined();
      for (const graph of [strayA, strayB, lone]) {
        expect(containerLookupFor(graph)(error)).toBeUndefined();
        const stable = toStableDiagnostic(error, containerLookupFor(graph));
        expect(stable.code).toBe('NEO_UNKNOWN_CONTAINER');
        expect(stable.containerId).toBeUndefined();
        expect(stable.containerName).toBeUndefined();
        expect(stable.containerFile).toBeUndefined();
      }
    }
    // Still visible: listed under each container of its file, owned by none.
    const listed = attributeErrors(graphs, [twoContainers]);
    expect(listed.get(strayA)).toContain(twoContainers);
    expect(listed.get(strayB)).toContain(twoContainers);
    expect(listed.get(lone)).toEqual([]);
    expect(attributeErrors(graphs, [oneContainer]).get(lone)).toContain(oneContainer);
  });

  it('T19 a container id of another graph is not claimed by range', () => {
    const needy = byName(graphs, 'Needy');
    const supplier = byName(graphs, 'Supplier');
    const missing = strictErrors.find((error) => error.code === 'NEO_MISSING_PROVIDER' && sameFile(error.sourceFile.fileName, NEEDY));
    if (!missing) throw new Error('missing provider error not produced');
    const claimed = { ...missing, containerId: supplier.containerKey };

    expect(containerLookupFor(needy)(claimed)).toBeUndefined();
    expect(containerLookupFor(supplier)(claimed)?.containerName).toBe('Supplier');
    expect(containerLookupOf(graphs)(claimed)?.containerName).toBe('Supplier');
  });
});
