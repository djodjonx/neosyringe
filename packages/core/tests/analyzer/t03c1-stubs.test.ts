import { describe, expect, it } from 'vitest';
import type * as ts from 'typescript';
import { Analyzer } from '../../src/analyzer/Analyzer';
import { ConfigCollector } from '../../src/analyzer/collectors/ConfigCollector';
import { graphsFromSnapshot, mergedGraphFromSnapshot, positionsOfCall } from '../../src/analyzer/graphAdapter';
import {
  assertLocalReferences,
  containerIROf,
  diagnosticIROf,
  type ContainerIR,
} from '../../src/analyzer/ir';
import { normalizeDiagnostic } from '../../src/analyzer/errors/stableDiagnostic';
import { listedCaptures, SnapshotAnalysis, snapshotFor } from '../../src/analyzer/snapshot';
import { TokenResolverService } from '../../src/analyzer/shared/TokenResolverService';
import type { AnalysisError, DependencyGraph } from '../../src/analyzer/types';
import { TSContext } from '../../src/TSContext';
import { DUMP_ROOT } from '../helpers/t03c1-dump';
import { captureRoot, memoryProgram } from '../helpers/memoryModules';

/**
 * P8: every new exported function must be observable. A stand-in that returns nothing, an empty list
 * or the wrong thing turns one of these assertions red.
 */
const FILE = captureRoot('stubs/app.ts');
const SOURCE = [
  "import { defineBuilderConfig, definePartialConfig, useInterface } from '@djodjonx/neosyringe';",
  'interface Plugin { run(): void }',
  'class Logger {}',
  'class One implements Plugin { run(): void {} }',
  'class Two implements Plugin { run(): void {} }',
  'class Service { constructor(public logger: Logger, public plugins: Plugin) {} }',
  'class Missing {}',
  'class NeedsMissing { constructor(public missing: Missing) {} }',
  'export const part = definePartialConfig({ injections: [{ token: Logger }] });',
  'export const app = defineBuilderConfig({',
  "  name: 'StubApp',",
  '  extends: [part],',
  '  injections: [',
  '    { token: useInterface<Plugin>(), provider: One, multi: true },',
  '    { token: useInterface<Plugin>(), provider: Two, multi: true },',
  '    { token: Service },',
  '    { token: NeedsMissing },',
  '  ],',
  '});',
  '',
].join('\n');

function program(): ts.Program {
  return memoryProgram(new Map([[FILE, SOURCE]]));
}

function withRoot<T>(run: () => T): T {
  return TSContext.runWithProjectRoot(DUMP_ROOT, run);
}

function appGraph(): DependencyGraph {
  const graph = withRoot(() => new Analyzer(program()).extractAll().find((item) => item.containerName === 'StubApp'));
  if (!graph) throw new Error('missing graph');
  return graph;
}

describe('T03 C1 the new exports do something observable', () => {
  it('P8 snapshotFor returns one collected snapshot per program, validation mode and root', () => {
    const subject = program();
    const snapshot = withRoot(() => snapshotFor(subject, 'strict'));
    expect(withRoot(() => snapshotFor(subject, 'strict'))).toBe(snapshot);
    expect(withRoot(() => snapshotFor(subject, 'compatible'))).not.toBe(snapshot);
    expect([...snapshot.configs().values()].map((config) => `${config.type}:${config.name}`)).toEqual([
      'partial:part',
      'builder:app',
    ]);
    expect(snapshot.diagnostics().map((error) => error.code)).toEqual(['NEO_MISSING_PROVIDER']);
    expect(snapshot.diagnosticsOfFile(FILE)).toEqual(snapshot.diagnostics());
    expect(snapshot.graphs()).toHaveLength(1);
  });

  it('P8 SnapshotAnalysis collects once, validates each file once and keeps a failure', () => {
    const calls = { collect: 0, validate: 0, graphs: 0 };
    const subject = {};
    const analysis = new SnapshotAnalysis<object, number, string, string>(subject, {
      collect: () => { calls.collect += 1; return 7; },
      files: () => ['a', 'b'],
      validateFile: (_program, collection, file) => { calls.validate += 1; return [`${file}${collection}`]; },
      list: (all) => [...all].reverse(),
      graphs: () => { calls.graphs += 1; return ['a.g', 'b.g']; },
      fileOfGraph: (graph) => graph.split('.')[0] ?? '',
    });
    expect(analysis.diagnostics()).toEqual(['b7', 'a7']);
    expect(analysis.diagnosticsOfFile('a')).toEqual(['a7']);
    expect(analysis.forFile('b')).toEqual({ graphs: ['b.g'], diagnostics: ['b7'] });
    expect(analysis.collection()).toBe(7);
    expect(calls).toEqual({ collect: 1, validate: 2, graphs: 1 });

    let attempts = 0;
    const failing = new SnapshotAnalysis<object, number, string, string>({}, {
      collect: () => { attempts += 1; throw new Error('boom'); },
      files: () => [],
      validateFile: () => [],
      list: (all) => all,
      graphs: () => [],
      fileOfGraph: () => '',
    });
    expect(() => failing.graphs()).toThrow('boom');
    expect(() => failing.diagnostics()).toThrow('boom');
    expect(attempts).toBe(1);
  });

  it('P8 graphsFromSnapshot and mergedGraphFromSnapshot build graphs from the collection', () => {
    const subject = program();
    const checker = subject.getTypeChecker();
    const tokens = new TokenResolverService(checker);
    withRoot(() => {
      const collection = new ConfigCollector(subject, checker, tokens, 'strict').collectAll();
      const env = { checker, tokens, validation: 'strict' as const };
      const graphs = graphsFromSnapshot(env, collection);
      expect(graphs).toHaveLength(1);
      const [graph] = graphs;
      expect(graph?.containerName).toBe('StubApp');
      expect([...(graph?.nodes.keys() ?? [])].map((id) => id.split('_')[0])).toEqual(['Logger', 'Service', 'NeedsMissing']);
      expect([...(graph?.multiNodes?.values() ?? [])][0]).toHaveLength(2);
      expect(graph?.sourceFileName).toBe(FILE);
      const merged = mergedGraphFromSnapshot(env, collection);
      expect([...merged.nodes.keys()]).toEqual([...(graph?.nodes.keys() ?? [])]);
      expect(merged.sourceFileName).toBeUndefined();
    });
  });

  it('P8 positionsOfCall fills the export modifier and the statement start', () => {
    const subject = program();
    const checker = subject.getTypeChecker();
    const collection = withRoot(() => new ConfigCollector(subject, checker, new TokenResolverService(checker)).collectAll());
    const builder = [...collection.configs.values()].find((config) => config.type === 'builder');
    if (!builder) throw new Error('missing builder');
    const target: DependencyGraph = { containerId: 'x', nodes: new Map(), roots: [] };
    expect(positionsOfCall(builder.node, target)).toBe(true);
    expect(target.exportedVariableName).toBe('app');
    expect(target.variableExportModifier).toBe('export');
    expect(target.variableStatementStart).toBe(SOURCE.indexOf('export const app'));
  });

  it('P8 containerIROf lists registrations in graph order with local, all and parent references', () => {
    const graph = appGraph();
    const ir = withRoot(() => containerIROf(graph, DUMP_ROOT));
    expect(ir.schemaVersion).toBe(1);
    expect(ir.mode).toBe('open');
    expect(ir.profile).toBe('full');
    expect(ir.registrations.map((item) => `${item.token.split('_')[0]}:${item.multi}`)).toEqual([
      'Logger:false',
      'Service:false',
      'NeedsMissing:false',
      'Plugin:true',
      'Plugin:true',
    ]);
    expect(ir.registrations.map((item) => item.order)).toEqual([0, 1, 2, 3, 4]);
    const service = ir.registrations[1];
    expect(service?.provider).toEqual({ kind: 'class', expressionRef: 'Service' });
    expect(service?.dependencies).toEqual([
      { kind: 'local', registration: ir.registrations[0]?.id },
      { kind: 'all', token: ir.registrations[3]?.token, registrations: [ir.registrations[3]?.id, ir.registrations[4]?.id] },
    ]);
    expect(service?.origin.file).toBe('stubs/app.ts');
    expect(service?.origin.start).toBe(SOURCE.indexOf('{ token: Service }'));
    expect(ir.registrations[0]?.lifecycle).toBe('singleton');
    expect(ir.registrations[0]?.ownership).toBe('owned');
    expect(() => assertLocalReferences(ir)).not.toThrow();
  });

  it('P8 diagnosticIROf carries code, severity, origin and chain', () => {
    const error = withRoot(() => new Analyzer(program()).extractAllErrors()[0]);
    if (!error) throw new Error('missing error');
    const diagnostic = withRoot(() => diagnosticIROf(error, DUMP_ROOT));
    expect(diagnostic.code).toBe('NEO_MISSING_PROVIDER');
    expect(diagnostic.severity).toBe('error');
    expect(diagnostic.message).toContain('Missing');
    expect(diagnostic.origin.file).toBe('stubs/app.ts');
    expect(diagnostic.origin.start).toBe(SOURCE.indexOf('token: NeedsMissing'));
    expect(diagnostic.chain).toEqual(['NeedsMissing', 'Missing']);
    expect(diagnostic.related).toEqual([]);
  });

  it('P8 assertLocalReferences refuses a duplicate id and a reference to nothing', () => {
    const ir: ContainerIR = withRoot(() => containerIROf(appGraph(), DUMP_ROOT));
    const first = ir.registrations[0];
    if (!first) throw new Error('missing registration');
    expect(() => assertLocalReferences({ ...ir, registrations: [first, first] })).toThrow('duplicate registration id');
    const dangling = { ...first, id: 'solo', dependencies: [{ kind: 'local' as const, registration: 'nowhere' }] };
    expect(() => assertLocalReferences({ ...ir, registrations: [dangling] })).toThrow('invalid local reference');
  });

  it('P8 normalizeDiagnostic keeps code (or type), severity, file and start', () => {
    const [error] = withRoot(() => new Analyzer(program()).extractAllErrors());
    if (!error) throw new Error('missing error');
    expect(normalizeDiagnostic(error)).toEqual({
      code: 'NEO_MISSING_PROVIDER',
      severity: 'error',
      file: FILE,
      start: SOURCE.indexOf('token: NeedsMissing'),
    });
    const bare: AnalysisError = { ...error, code: undefined, severity: 'warning', type: 'cycle' };
    expect(normalizeDiagnostic(bare)).toMatchObject({ code: 'cycle', severity: 'warning' });
  });

  it('P8 listedCaptures keeps one capture per registration and token', () => {
    const [base] = withRoot(() => new Analyzer(program()).extractAllErrors());
    if (!base) throw new Error('missing error');
    const capture: AnalysisError = { ...base, code: 'NEO_DISPOSABLE_TRANSIENT_CAPTURED', context: { tokenText: 'T' } };
    const other: AnalysisError = { ...capture, context: { tokenText: 'U' } };
    expect(listedCaptures([capture, capture, other, base])).toEqual([capture, other, base]);
  });
});
