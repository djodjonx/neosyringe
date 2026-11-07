import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as ts from 'typescript';
import { hasText, textAt } from '../helpers/tsPath';
import { Analyzer } from '../../src/analyzer/Analyzer';
import type { AnalysisError, DependencyGraph } from '../../src/analyzer/types';
import { assignRetention } from '../../src/analyzer/parsers/ConfigParser';
import { createFastProgram, warmLibCache } from '../fastProgram';

const ROOT = '/virtual/t16-retention';

const STUB = `
  import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';
  function defineBuilderConfig(config: any) { return config; }
  function useInterface<T>(): any { return null; }
`;

function source(body: string): string {
  return `${STUB}\n${body}\n`;
}

const REASONS = path.join(ROOT, 'reasons.ts');
const STRICT = path.join(ROOT, 'strict.ts');
const VARIABLE = path.join(ROOT, 'variable.ts');
const SPREAD = path.join(ROOT, 'spread.ts');
const OPEN_ROOTS = path.join(ROOT, 'open-roots.ts');
const MISSING = path.join(ROOT, 'missing.ts');
const OPEN_KEEP = path.join(ROOT, 'open-keep.ts');
const VAR_MODE = path.join(ROOT, 'var-mode.ts');
const ABSENT_MODE = path.join(ROOT, 'absent-mode.ts');

const files = new Map<string, string>([
  [REASONS, source(`
    interface ReasonRoot { n: number }
    interface ReasonDep { n: number }
    interface ReasonHeavy { n: number }
    const root = useInterface<ReasonRoot>();
    const dep = useInterface<ReasonDep>();
    const heavy = useInterface<ReasonHeavy>();
    export const reasons = defineBuilderConfig({
      name: 'Reasons',
      optimization: { mode: 'closed', roots: [root] },
      injections: [
        { token: root, useFactory: true, dependencies: [dep], provider: (ctx) => ctx.resolve(dep) },
        { token: dep, useFactory: true, dependencies: [], provider: () => ({ n: 1 }) },
        { token: heavy, useFactory: true, dependencies: [], provider: () => ({ n: 2 }) },
      ],
    });
  `)],
  [STRICT, source(`
    interface StrictRoot { ok: number }
    const token = useInterface<StrictRoot>();
    export const strictClosed = defineBuilderConfig({
      name: 'NeedsStrict',
      optimization: { mode: 'closed', roots: [token] },
      injections: [
        { token, useFactory: true, dependencies: [], provider: () => ({ ok: 1 }) },
      ],
    });
  `)],
  [VARIABLE, source(`
    interface VarRoot { ok: number }
    const token = useInterface<VarRoot>();
    const roots = [token];
    export const variableRoots = defineBuilderConfig({
      name: 'VariableRoots',
      optimization: { mode: 'closed', roots },
      injections: [
        { token, useFactory: true, dependencies: [], provider: () => ({ ok: 1 }) },
      ],
    });
  `)],
  [SPREAD, source(`
    interface SpreadRoot { ok: number }
    const token = useInterface<SpreadRoot>();
    const extra: unknown[] = [];
    export const spreadRoots = defineBuilderConfig({
      name: 'SpreadRoots',
      optimization: { mode: 'closed', roots: [token, ...extra] },
      injections: [
        { token, useFactory: true, dependencies: [], provider: () => ({ ok: 1 }) },
      ],
    });
  `)],
  [OPEN_ROOTS, source(`
    interface OpenRoot { ok: number }
    const token = useInterface<OpenRoot>();
    export const openRoots = defineBuilderConfig({
      name: 'OpenRoots',
      optimization: { mode: 'open', roots: [token] },
      injections: [
        { token, useFactory: true, dependencies: [], provider: () => ({ ok: 1 }) },
      ],
    });
  `)],
  [MISSING, source(`
    interface PresentRoot { ok: number }
    interface AbsentRoot { ok: number }
    const present = useInterface<PresentRoot>();
    const absent = useInterface<AbsentRoot>();
    export const missingRoot = defineBuilderConfig({
      name: 'MissingRoot',
      optimization: { mode: 'closed', roots: [absent] },
      injections: [
        { token: present, useFactory: true, dependencies: [], provider: () => ({ ok: 1 }) },
      ],
    });
  `)],
  [OPEN_KEEP, source(`
    interface OpenKeepRoot { ok: number }
    interface OpenKeepHeavy { n: number }
    const root = useInterface<OpenKeepRoot>();
    const heavy = useInterface<OpenKeepHeavy>();
    export const openKeep = defineBuilderConfig({
      name: 'OpenKeep',
      optimization: { mode: 'open' },
      injections: [
        { token: root, useFactory: true, dependencies: [], provider: () => ({ ok: 1 }) },
        { token: heavy, useFactory: true, dependencies: [], provider: () => ({ n: 2 }) },
      ],
    });
  `)],
  [VAR_MODE, source(`
    interface VarModeRoot { ok: number }
    const token = useInterface<VarModeRoot>();
    const modeName = 'closed';
    export const varMode = defineBuilderConfig({
      name: 'VarMode',
      optimization: { mode: modeName },
      injections: [
        { token, useFactory: true, dependencies: [], provider: () => ({ ok: 1 }) },
      ],
    });
  `)],
  [ABSENT_MODE, source(`
    interface AbsentModeRoot { ok: number }
    interface AbsentModeHeavy { n: number }
    const root = useInterface<AbsentModeRoot>();
    const heavy = useInterface<AbsentModeHeavy>();
    export const absentMode = defineBuilderConfig({
      name: 'AbsentMode',
      injections: [
        { token: root, useFactory: true, dependencies: [], provider: () => ({ ok: 1 }) },
        { token: heavy, useFactory: true, dependencies: [], provider: () => ({ n: 2 }) },
      ],
    });
  `)],
]);

function programFrom(sources: Map<string, string>): ts.Program {
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    strict: true,
    noImplicitAny: false,
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
  return createFastProgram([...sources.keys()], options, host);
}

function byName(graphs: DependencyGraph[], name: string): DependencyGraph {
  const found = graphs.find((graph) => graph.containerId === name);
  if (!found) throw new Error(`missing graph ${name}`);
  return found;
}

function codes(errors: readonly AnalysisError[]): string[] {
  return errors.filter((error) => error.severity !== 'warning').map((error) => error.code ?? '');
}

function registrationCount(graph: DependencyGraph): number {
  let count = graph.nodes.size;
  if (graph.multiNodes) {
    for (const nodes of graph.multiNodes.values()) count += nodes.length;
  }
  return count;
}

describe('T16 retention', () => {
  let graphs: DependencyGraph[];
  let compatible: DependencyGraph[];

  beforeAll(() => {
    warmLibCache();
    const program = programFrom(files);
    graphs = new Analyzer(program).extractAll();
    compatible = new Analyzer(program, { validation: 'compatible' }).extractAll();
  });

  afterAll(() => {
    graphs = [];
    compatible = [];
  });

  it('T16 closed requires strict', () => {
    const graph = byName(compatible, 'NeedsStrict');
    expect(codes(graph.errors ?? [])).toContain('NEO_CLOSED_REQUIRES_STRICT');
  });

  it('T16 roots not static', () => {
    expect(codes(byName(graphs, 'VariableRoots').errors ?? [])).toContain('NEO_CONFIG_UNSUPPORTED');
    expect(codes(byName(graphs, 'SpreadRoots').errors ?? [])).toContain('NEO_CONFIG_UNSUPPORTED');
    expect(codes(byName(graphs, 'OpenRoots').errors ?? [])).toContain('NEO_CONFIG_UNSUPPORTED');
    expect(codes(byName(graphs, 'MissingRoot').errors ?? [])).toContain('NEO_MISSING_PROVIDER');
  });

  it('T16 retention reasons', () => {
    const graph = byName(graphs, 'Reasons');
    const reasons = [...(graph.retention?.values() ?? [])];
    expect(reasons).toHaveLength(registrationCount(graph));
    expect(reasons.map((reason) => reason.kind).sort()).toEqual(['dependency-of', 'root', 'unreachable']);
    const dependency = reasons.find((reason) => reason.kind === 'dependency-of');
    const rootId = [...graph.nodes.keys()].find((id) => id.includes('ReasonRoot'));
    expect(dependency && 'token' in dependency ? dependency.token : '').toBe(rootId);
  });

  it('T16 open boundary reason', () => {
    const graph = byName(graphs, 'OpenKeep');
    const reasons = [...(graph.retention?.values() ?? [])];
    expect(reasons).toHaveLength(registrationCount(graph));
    expect(reasons.every((reason) => reason.kind === 'parent-boundary')).toBe(true);
  });

  it('T16 mode not literal', () => {
    const graph = byName(graphs, 'VarMode');
    expect(codes(graph.errors ?? [])).toContain('NEO_CONFIG_UNSUPPORTED');
    expect(graph.optimizationMode).toBeUndefined();
  });

  it('T16 absent mode reason is parent-boundary', () => {
    const graph = byName(graphs, 'AbsentMode');
    assignRetention(graph);
    const reasons = [...(graph.retention?.values() ?? [])];
    expect(reasons).toHaveLength(registrationCount(graph));
    expect(reasons.every((reason) => reason.kind === 'parent-boundary')).toBe(true);
  });
});
