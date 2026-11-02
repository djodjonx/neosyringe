import { afterEach, describe, expect, it } from 'vitest';
import * as ts from 'typescript';
import { Analyzer } from '../../src/analyzer/Analyzer';
import { Generator } from '../../src/generator/Generator';
import type { DependencyGraph } from '../../src/analyzer/types';
import { captureRoot, memoryProgram } from '../helpers/memoryModules';

const PART = captureRoot('part.ts');
const NAMED = captureRoot('named.ts');
const ALIAS = captureRoot('alias.ts');
const NAMESPACE = captureRoot('ns.ts');

const PART_SOURCE = [
  "import { definePartialConfig, useInterface } from '@djodjonx/neosyringe';",
  'declare const globalThis: { __t09Next(label: string): { id: number } };',
  'export interface Port { id: number }',
  'export const part = definePartialConfig({',
  '  injections: [',
  "    { token: useInterface<Port>(), useValue: globalThis.__t09Next('once') },",
  '  ],',
  '});',
  '',
].join('\n');

function host(binding: string, extendsExpr: string, containerName: string): string {
  return [
    "import { defineBuilderConfig } from '@djodjonx/neosyringe';",
    binding,
    `export const container = defineBuilderConfig({`,
    `  name: '${containerName}',`,
    `  extends: [${extendsExpr}],`,
    '  injections: [],',
    '});',
    '',
  ].join('\n');
}

const CASES = [
  {
    fileName: NAMESPACE,
    containerName: 'T09Ns',
    prelude: 'const P = { part: (globalThis as { __t09Partial: { injections: { useValue: unknown }[] } }).__t09Partial };',
  },
  {
    fileName: ALIAS,
    containerName: 'T09Alias',
    prelude: 'const p = (globalThis as { __t09Partial: { injections: { useValue: unknown }[] } }).__t09Partial;',
  },
  {
    fileName: NAMED,
    containerName: 'T09Named',
    prelude: 'const part = (globalThis as { __t09Partial: { injections: { useValue: unknown }[] } }).__t09Partial;',
  },
];

interface RuntimeContainer {
  resolve: (token: unknown) => unknown;
  destroy: () => Promise<void>;
}

const opened: RuntimeContainer[] = [];

function calls(): number {
  const value = Reflect.get(globalThis, '__t09Calls');
  return typeof value === 'number' ? value : 0;
}

function execute(graph: DependencyGraph, prelude: string): { error: string; resolved: unknown } {
  const errors = (graph.errors ?? []).filter((error) => error.severity !== 'warning');
  if (errors.length > 0) return { error: errors.map((error) => error.message).join('\n'), resolved: undefined };
  try {
    const generator = new Generator(graph, true);
    const name = graph.exportedVariableName ?? 'container';
    const tsCode = `${prelude}\n${generator.generate()}\nexport const ${name} = ${generator.generateInstantiation()};`;
    const jsCode = ts.transpileModule(tsCode, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    }).outputText;
    const moduleRecord: { exports: Record<string, RuntimeContainer | undefined> } = { exports: {} };
    const run = new Function('module', 'exports', jsCode) as (
      module: typeof moduleRecord,
      exports: typeof moduleRecord.exports,
    ) => void;
    run(moduleRecord, moduleRecord.exports);
    const container = moduleRecord.exports[name];
    if (!container) return { error: `generated module did not export ${name}`, resolved: undefined };
    opened.push(container);
    const token = [...graph.nodes.keys()].find((id) => id.includes('Port'));
    if (!token) return { error: 'missing token Port', resolved: undefined };
    return { error: '', resolved: container.resolve(token) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error), resolved: undefined };
  }
}

describe('T09 partial capture', () => {
  afterEach(async () => {
    const pending = opened.splice(0);
    await Promise.allSettled(pending.map((container) => container.destroy()));
    Reflect.deleteProperty(globalThis, '__t09Calls');
    Reflect.deleteProperty(globalThis, '__t09Partial');
    Reflect.deleteProperty(globalThis, '__t09Next');
  });

  it('T09-P16 namespace/alias partial useValue', () => {
    const files = new Map<string, string>([
      [PART, PART_SOURCE],
      [NAMED, host("import { part } from './part';", 'part', 'T09Named')],
      [ALIAS, host("import { part as p } from './part';", 'p', 'T09Alias')],
      [NAMESPACE, host("import * as P from './part';", 'P.part', 'T09Ns')],
    ]);
    const graphs = new Map<string, DependencyGraph>();
    for (const graph of new Analyzer(memoryProgram(files)).extractAll()) {
      graphs.set(graph.containerId, graph);
    }
    Reflect.set(globalThis, '__t09Calls', 0);
    Reflect.set(globalThis, '__t09Next', (label: string) => {
      const holder = globalThis as { __t09Calls?: number };
      holder.__t09Calls = (holder.__t09Calls ?? 0) + 1;
      return { id: holder.__t09Calls, label };
    });
    const next = Reflect.get(globalThis, '__t09Next') as (label: string) => { id: number };
    const partial = { injections: [{ useValue: next('once') }] };
    Reflect.set(globalThis, '__t09Partial', partial);
    expect(calls()).toBe(1);

    for (const spec of CASES) {
      const graph = graphs.get(spec.containerName);
      if (!graph) throw new Error(`missing ${spec.containerName}`);
      const result = execute(graph, spec.prelude);
      expect(result.error, spec.containerName).toBe('');
      expect(result.resolved, spec.containerName).toBe(partial.injections[0]?.useValue);
      expect(calls(), spec.containerName).toBe(1);
    }
  });
});
