import * as ts from 'typescript';
import { Analyzer } from '../../src/analyzer/Analyzer';
import type { DependencyGraph } from '../../src/analyzer/types';
import { Generator } from '../../src/generator/Generator';
import { createFastProgram, warmLibCache } from '../fastProgram';
import {
  showValue,
  type ModelService,
  type Scenario,
  type Trace,
  type TraceEvent,
} from './t06-model';

/** Generator constructor argument. Same pair as the topic 00 harness. */
export type Emitter = 'reference' | 'optimized';

export const EMITTERS: readonly Emitter[] = ['reference', 'optimized'];

export interface Container {
  initialize: (options?: { signal?: unknown }) => Promise<void>;
  resolve: (token: unknown) => unknown;
  destroy: () => Promise<void>;
  createScope: () => Container;
  override: (token: unknown, factory: () => unknown) => Promise<void>;
  clearOverrides: () => Promise<void>;
}

export interface Opened {
  readonly container: Container;
  readonly source: string;
  readonly graph: DependencyGraph;
}

export interface OpenOptions {
  readonly emitter?: Emitter;
  readonly parent?: Container;
  readonly testOverrides?: boolean;
  /** Generator `observation`: the container carries the optional production observation (topic 22). Absent: off. */
  readonly observation?: boolean;
  /** Const bindings the copied factory source still names, prepended to the generated module. */
  readonly prelude?: string;
}

export interface Loaded {
  readonly graphs: readonly DependencyGraph[];
  graph(name: string): DependencyGraph;
  token(graph: DependencyGraph, name: string): string;
  open(name: string, options?: OpenOptions): Opened;
}

const STUB = `
  import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';
  declare function defineBuilderConfig<T>(config: T): T;
  declare function useInterface<T>(): T;
`;

const RUN_KEY = '__t06Run';

interface RunSlot {
  constructs: Record<string, number>;
  disposals: Record<string, number>;
}

let fileSeq = 0;

/**
 * Analyzer.extractAll, then `new Generator` with the requested emitter,
 * transpileModule, then new Function. `emitter` undefined keeps the default.
 */
export function loadSource(source: string, options: { validation?: 'compatible' } = {}): Loaded {
  warmLibCache();
  const fileName = `/virtual/t06/${fileSeq}.ts`;
  fileSeq += 1;
  const program = programOf(fileName, source);
  const analyzer = options.validation === undefined ? new Analyzer(program) : new Analyzer(program, { validation: options.validation });
  const graphs = analyzer.extractAll();
  return {
    graphs,
    graph(name: string): DependencyGraph {
      const found = graphs.find((item) => item.exportedVariableName === name);
      if (!found) throw new Error(`missing container ${name}`);
      return found;
    },
    token(graph: DependencyGraph, name: string): string {
      return tokenId(graph, name);
    },
    open(name: string, options: OpenOptions = {}): Opened {
      return instantiate(this.graph(name), options);
    },
  };
}

export function sourceForScenario(scenario: Scenario): string {
  const services = scenario.services;
  const decls = services.map((service) => (
    `interface ${service.name} {}\n  const ${varName(service.name)} = useInterface<${service.name}>();`
  ));
  const injections = services.map((service) => injectionOf(service));
  const runtime = scenario.profile === 'minimal' ? "runtime: { profile: 'minimal' }," : '';
  const roots = services.map((service) => varName(service.name)).join(', ');
  const optimization = scenario.mode === 'closed'
    ? `optimization: { mode: 'closed', roots: [${roots}] },`
    : '';
  return `
    ${STUB}
    ${decls.join('\n    ')}
    export const box = defineBuilderConfig({
      name: 'T06Corpus',
      ${runtime}
      ${optimization}
      injections: [
        ${injections.join(',\n        ')}
      ],
    });
  `;
}

/** Runs one scenario on generated code. The counters live on globalThis for this call only. */
export async function runScenario(scenario: Scenario, emitter: Emitter): Promise<Trace> {
  const slot: RunSlot = { constructs: {}, disposals: {} };
  for (const service of scenario.services) {
    slot.constructs[service.name] = 0;
    slot.disposals[service.name] = 0;
  }
  Reflect.set(globalThis, RUN_KEY, slot);
  const scopes: Container[] = [];
  const events: TraceEvent[] = [];
  try {
    const loaded = loadSource(sourceForScenario(scenario));
    const graph = loaded.graph('box');
    const prelude = scenario.services
      .map((service) => `const ${varName(service.name)} = ${JSON.stringify(loaded.token(graph, service.name))};`)
      .join('\n');
    const opened = loaded.open('box', { emitter, prelude });
    scopes.push(opened.container);
    for (const op of scenario.ops) {
      const scope = scopes[op.scope];
      if (!scope) {
        events.push({ value: '', code: 'NEO_CONTAINER_DESTROYED', delivery: 'sync' });
        continue;
      }
      if (op.kind === 'initialize') {
        events.push(await callPromise(() => scope.initialize()));
        continue;
      }
      if (op.kind === 'destroy') {
        events.push(await callPromise(() => scope.destroy()));
        continue;
      }
      if (op.kind === 'createScope') {
        try {
          scopes.push(scope.createScope());
          events.push({ value: 'scope', code: '', delivery: 'value' });
        } catch (error) {
          events.push({ value: '', code: errorCode(error), delivery: 'sync' });
        }
        continue;
      }
      if (op.kind !== 'resolve') continue;
      const token = loaded.token(graph, op.name);
      events.push(callSync(() => scope.resolve(token)));
    }
    return {
      events,
      constructs: { ...slot.constructs },
      disposals: { ...slot.disposals },
    };
  } finally {
    for (const scope of scopes.splice(0).reverse()) {
      try {
        await scope.destroy();
      } catch {
        // The scenario may already have destroyed this scope.
      }
    }
    Reflect.deleteProperty(globalThis, RUN_KEY);
  }
}

export function tokenId(graph: DependencyGraph, name: string): string {
  const keys = [
    ...graph.nodes.keys(),
    ...(graph.multiNodes ? [...graph.multiNodes.keys()] : []),
  ];
  const found = keys.find((id) => id.includes(name));
  if (!found) throw new Error(`missing token ${name}`);
  return found;
}

export function errorCode(error: unknown): string {
  if (!(error instanceof Error)) return '';
  const code = Reflect.get(error, 'code');
  if (typeof code === 'string' && code.length > 0) return code;
  return error.name;
}

function instantiate(graph: DependencyGraph, options: OpenOptions): Opened {
  const messages = (graph.errors ?? [])
    .filter((error) => error.severity !== 'warning')
    .map((error) => error.message);
  if (messages.length > 0) throw new Error(messages.join('\n'));
  const generated = new Generator(
    graph,
    false,
    undefined,
    false,
    options.testOverrides === true,
    options.emitter,
    undefined,
    undefined,
    undefined,
    options.observation === true ? { observation: true } : undefined,
  ).generate();
  const js = ts.transpileModule(`${options.prelude ?? ''}\n${generated}`, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: false,
    },
  }).outputText;
  const record: { exports: Record<string, Container | undefined> } = { exports: {} };
  const run = new Function('parent', 'module', 'exports', 'require', js) as (
    parent: Container | undefined,
    module: { exports: Record<string, Container | undefined> },
    exports: Record<string, Container | undefined>,
    require: (id: string) => Record<string, never>,
  ) => void;
  run(options.parent, record, record.exports, () => ({}));
  const name = graph.exportedVariableName ?? 'box';
  const container = record.exports[name];
  if (!container) throw new Error(`generated module did not export ${name}`);
  return { container, source: generated, graph };
}

function programOf(fileName: string, source: string): ts.Program {
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    strict: true,
    noImplicitAny: false,
  };
  const sources = new Map([[fileName, source]]);
  const host = ts.createCompilerHost(options);
  const read = host.getSourceFile.bind(host);
  const exists = host.fileExists.bind(host);
  host.getSourceFile = (name, languageVersion, onError, shouldCreateNewSourceFile) => {
    const text = sources.get(name);
    if (text !== undefined) return ts.createSourceFile(name, text, languageVersion, true);
    return read(name, languageVersion, onError, shouldCreateNewSourceFile);
  };
  host.fileExists = (name) => sources.has(name) || exists(name);
  return createFastProgram([fileName], options, host);
}

function injectionOf(service: ModelService): string {
  const deps = service.deps.map((dep) => varName(dep));
  const reads = deps.map((dep) => `ctx.resolve(${dep});`).join('\n            ');
  const ownership = service.borrowed ? "ownership: 'borrowed'," : '';
  const lifecycle = service.kind === 'transient' ? "lifecycle: 'transient'," : '';
  const body = service.disposable
    ? `return { tag: ${JSON.stringify(service.name)}, dispose() { ${countLine('disposals', service.name)} } };`
    : `return ${literal(service.value)};`;
  return `{
          token: ${varName(service.name)},
          useFactory: true,
          ${lifecycle}
          ${ownership}
          dependencies: [${deps.join(', ')}],
          provider: (ctx) => {
            ${reads}
            ${countLine('constructs', service.name)}
            ${body}
          },
        }`;
}

function countLine(bucket: 'constructs' | 'disposals', name: string): string {
  const key = JSON.stringify(name);
  const slot = '(globalThis as { __t06Run: { constructs: { [key: string]: number }; disposals: { [key: string]: number } } }).__t06Run';
  return `const __neoSlot = ${slot}; __neoSlot.${bucket}[${key}] = (__neoSlot.${bucket}[${key}] ?? 0) + 1;`;
}

function literal(value: ModelService['value']): string {
  if (value === undefined) return 'undefined';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return String(value);
}

function varName(name: string): string {
  return `t${name}`;
}

function callSync(run: () => unknown): TraceEvent {
  try {
    return { value: showValue(run()), code: '', delivery: 'value' };
  } catch (error) {
    return { value: '', code: errorCode(error), delivery: 'sync' };
  }
}

async function callPromise(run: () => Promise<void>): Promise<TraceEvent> {
  let pending: Promise<void>;
  try {
    pending = run();
  } catch (error) {
    return { value: '', code: errorCode(error), delivery: 'sync' };
  }
  try {
    await pending;
    return { value: '', code: '', delivery: 'value' };
  } catch (error) {
    return { value: '', code: errorCode(error), delivery: 'reject' };
  }
}
