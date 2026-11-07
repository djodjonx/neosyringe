import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as ts from 'typescript';
import { hasText, textAt } from '../helpers/tsPath';
import { Analyzer } from '../../src/analyzer/Analyzer';
import { Generator } from '../../src/generator/Generator';
import type { DependencyGraph } from '../../src/analyzer/types';

const ROOT = path.join(process.cwd(), 't08-runtime');
const PAIR_FILE = path.join(ROOT, 'pair.ts');
const ONCE_FILE = path.join(ROOT, 'once.ts');
const CONSUMER_FILE = path.join(ROOT, 'consumer.ts');
const MIXED_FILE = path.join(ROOT, 'mixed.ts');
const REUSE_FILE = path.join(ROOT, 'reuse.ts');
const TRANSIENT_FILE = path.join(ROOT, 'transient.ts');
const FRESH_FILE = path.join(ROOT, 'fresh.ts');
const FAIL_FILE = path.join(ROOT, 'fail.ts');
const GONE_FILE = path.join(ROOT, 'gone.ts');
const SAME_FILE = path.join(ROOT, 'same.ts');
const PARENT_FILE = path.join(ROOT, 'parent.ts');
const GUARD_FILE = path.join(ROOT, 'guard.ts');
const DEP_FILE = path.join(ROOT, 'dep.ts');
const CHAIN_FILE = path.join(ROOT, 'chain.ts');
const INIT_FILE = path.join(ROOT, 'init.ts');
const ALIAS_FILE = path.join(ROOT, 'alias.ts');
const TWIN_FILE = path.join(ROOT, 'twin.ts');
const AWAIT_FILE = path.join(ROOT, 'await.ts');
const REJECT_FILE = path.join(ROOT, 'reject.ts');
const BLOCK_FILE = path.join(ROOT, 'block.ts');
const EDGE_FILE = path.join(ROOT, 'edge.ts');
const CYCLE_FILE = path.join(ROOT, 'cycle.ts');
const ASYNC_PARENT_FILE = path.join(ROOT, 'async-parent.ts');
const ORDER_FILE = path.join(ROOT, 'order.ts');

const STUB = `
  import { defineBuilderConfig, definePartialConfig, useInterface } from '@djodjonx/neosyringe';
  function defineBuilderConfig(config: any) { return config; }
  function definePartialConfig(config: any) { return config; }
  function useInterface<T>(): any { return null; }
`;

const GONE = `
  class SyncGone {
    n = 1;
    dispose(): void {
      const holder = globalThis as { __t08Gone?: string[] };
      const gone = holder.__t08Gone ?? [];
      gone.push('sync');
      holder.__t08Gone = gone;
    }
  }
  class AsyncGone {
    n = 2;
    async dispose(): Promise<void> {
      await Promise.resolve();
      const holder = globalThis as { __t08Gone?: string[] };
      const gone = holder.__t08Gone ?? [];
      gone.push('async');
      holder.__t08Gone = gone;
    }
  }
`;

const DEP = `
  class Dep {
    dispose(): void {
      const holder = globalThis as { __t08Order?: string[] };
      const order = holder.__t08Order ?? [];
      order.push('dep');
      holder.__t08Order = order;
    }
  }
  class Contrib {
    n = 1;
    constructor(_dep: Dep) {}
    dispose(): void {
      const holder = globalThis as { __t08Order?: string[] };
      const order = holder.__t08Order ?? [];
      order.push('contrib');
      holder.__t08Order = order;
    }
  }
`;

const CHAIN = `
  class ChainE {
    dispose(): void {
      const holder = globalThis as { __t08Order?: string[] };
      const order = holder.__t08Order ?? [];
      order.push('E');
      holder.__t08Order = order;
    }
  }
  class ChainD {
    constructor(_e: ChainE) {}
    dispose(): void {
      const holder = globalThis as { __t08Order?: string[] };
      const order = holder.__t08Order ?? [];
      order.push('D');
      holder.__t08Order = order;
    }
  }
  class ChainContrib {
    n = 1;
    constructor(_d: ChainD) {}
    dispose(): void {
      const holder = globalThis as { __t08Order?: string[] };
      const order = holder.__t08Order ?? [];
      order.push('Contrib');
      holder.__t08Order = order;
    }
  }
`;

const ALIAS = `
  class AliasLogger {
    constructor() {
      (globalThis as { __t08Logger?: AliasLogger }).__t08Logger = this;
    }
    dispose(): void {
      const holder = globalThis as { __t08Order?: string[] };
      const order = holder.__t08Order ?? [];
      order.push('logger');
      holder.__t08Order = order;
    }
  }
`;

const LOG = `
  function t08log(label: string): void {
    const holder = globalThis as { __t08Order?: string[] };
    const order = holder.__t08Order ?? [];
    order.push(label);
    holder.__t08Order = order;
  }
`;

const ORDER_SOURCE = `
  ${STUB}
  interface OrderMid { n: string }
  const mid = useInterface<OrderMid>();
  export const orderPartial = definePartialConfig({
    injections: [
      {
        token: mid,
        useFactory: true,
        dependencies: [],
        multi: true,
        provider: () => ({ n: 'extends' }),
      },
    ],
  });
  export const orderHost = defineBuilderConfig({
    name: 'T08PartialOrder',
    extends: [orderPartial],
    injections: [
      {
        token: mid,
        useFactory: true,
        dependencies: [],
        multi: true,
        provider: () => ({ n: 'local' }),
      },
    ],
  });
`;

const files = new Map<string, string>([
  [PAIR_FILE, `
    ${STUB}
    interface PairItem { n: number }
    const pair = useInterface<PairItem>();
    export const pairContainer = defineBuilderConfig({
      name: 'T08Pair',
      injections: [
        {
          token: pair,
          useFactory: true,
          dependencies: [],
          multi: true,
          provider: async () => {
            await (globalThis as { __t08Gate?: { ready: Promise<void> } }).__t08Gate!.ready;
            return { n: 1 };
          },
        },
        {
          token: pair,
          useFactory: true,
          dependencies: [],
          multi: true,
          provider: async () => {
            await (globalThis as { __t08Gate?: { ready: Promise<void> } }).__t08Gate!.ready;
            return { n: 2 };
          },
        },
      ],
    });
  `],
  [ONCE_FILE, `
    ${STUB}
    interface OnceItem { n: number }
    const once = useInterface<OnceItem>();
    export const onceContainer = defineBuilderConfig({
      name: 'T08Once',
      injections: [
        {
          token: once,
          useFactory: true,
          dependencies: [],
          multi: true,
          provider: async () => {
            const holder = globalThis as { __t08Started?: number[] };
            const started = holder.__t08Started ?? [];
            started.push(0);
            holder.__t08Started = started;
            await (globalThis as { __t08Gate0?: { ready: Promise<void> } }).__t08Gate0!.ready;
            return { n: 0 };
          },
        },
        {
          token: once,
          useFactory: true,
          dependencies: [],
          multi: true,
          provider: async () => {
            const holder = globalThis as { __t08Started?: number[] };
            const started = holder.__t08Started ?? [];
            started.push(1);
            holder.__t08Started = started;
            await (globalThis as { __t08Gate1?: { ready: Promise<void> } }).__t08Gate1!.ready;
            return { n: 1 };
          },
        },
      ],
    });
  `],
  [CONSUMER_FILE, `
    ${STUB}
    interface ConsItem { n: number }
    interface ConsPipe { items: ConsItem[] }
    const mid = useInterface<ConsItem>();
    export const consumerContainer = defineBuilderConfig({
      name: 'T08Consumer',
      injections: [
        {
          token: useInterface<ConsPipe>(),
          useFactory: true,
          dependencies: [{ all: mid }],
          provider: async (ctx) => ({ items: ctx.resolveAll(mid) }),
        },
        {
          token: mid,
          useFactory: true,
          dependencies: [],
          multi: true,
          provider: async () => ({ n: 1 }),
        },
        {
          token: mid,
          useFactory: true,
          dependencies: [],
          multi: true,
          provider: async () => ({ n: 2 }),
        },
      ],
    });
  `],
  [MIXED_FILE, `
    ${STUB}
    interface MixedItem { n: string }
    const mixed = useInterface<MixedItem>();
    export const mixedContainer = defineBuilderConfig({
      name: 'T08Mixed',
      injections: [
        {
          token: mixed,
          useFactory: true,
          dependencies: [],
          multi: true,
          provider: () => ({ n: 'sync' }),
        },
        {
          token: mixed,
          useFactory: true,
          dependencies: [],
          multi: true,
          provider: async () => ({ n: 'async' }),
        },
      ],
    });
  `],
  [REUSE_FILE, `
    ${STUB}
    interface ReuseItem { n: number }
    const reuse = useInterface<ReuseItem>();
    export const reuseContainer = defineBuilderConfig({
      name: 'T08Reuse',
      injections: [
        {
          token: reuse,
          useFactory: true,
          dependencies: [],
          multi: true,
          provider: () => ({ n: 1 }),
        },
        {
          token: reuse,
          useFactory: true,
          dependencies: [],
          multi: true,
          provider: () => ({ n: 2 }),
        },
      ],
    });
  `],
  [TRANSIENT_FILE, `
    ${STUB}
    interface TransientItem { n: number }
    const transientItem = useInterface<TransientItem>();
    export const transientContainer = defineBuilderConfig({
      name: 'T08Transient',
      injections: [
        {
          token: transientItem,
          useFactory: true,
          dependencies: [],
          multi: true,
          lifecycle: 'transient',
          provider: () => {
            const holder = globalThis as { __t08Count?: number };
            holder.__t08Count = (holder.__t08Count ?? 0) + 1;
            return { n: holder.__t08Count };
          },
        },
        {
          token: transientItem,
          useFactory: true,
          dependencies: [],
          multi: true,
          lifecycle: 'transient',
          provider: () => {
            const holder = globalThis as { __t08Count?: number };
            holder.__t08Count = (holder.__t08Count ?? 0) + 1;
            return { n: holder.__t08Count };
          },
        },
      ],
    });
  `],
  [FRESH_FILE, `
    ${STUB}
    interface FreshItem { n: number }
    const fresh = useInterface<FreshItem>();
    export const freshContainer = defineBuilderConfig({
      name: 'T08Fresh',
      injections: [
        {
          token: fresh,
          useFactory: true,
          dependencies: [],
          multi: true,
          provider: () => ({ n: 1 }),
        },
        {
          token: fresh,
          useFactory: true,
          dependencies: [],
          multi: true,
          provider: () => ({ n: 2 }),
        },
      ],
    });
  `],
  [FAIL_FILE, `
    ${STUB}
    interface FailItem { tag: number }
    const fail = useInterface<FailItem>();
    export const failContainer = defineBuilderConfig({
      name: 'T08Fail',
      injections: [
        {
          token: fail,
          useFactory: true,
          dependencies: [],
          multi: true,
          provider: async () => {
            const holder = globalThis as { __t08Calls?: number };
            holder.__t08Calls = (holder.__t08Calls ?? 0) + 1;
            return {
              tag: 0,
              dispose(): void {
                const disposed = globalThis as { __t08Disposed?: number[] };
                const list = disposed.__t08Disposed ?? [];
                list.push(0);
                disposed.__t08Disposed = list;
              },
            };
          },
        },
        {
          token: fail,
          useFactory: true,
          dependencies: [],
          multi: true,
          provider: async () => {
            const holder = globalThis as { __t08Calls?: number; __t08Boom?: Error };
            holder.__t08Calls = (holder.__t08Calls ?? 0) + 1;
            throw holder.__t08Boom;
          },
        },
        {
          token: fail,
          useFactory: true,
          dependencies: [],
          multi: true,
          provider: async () => {
            const holder = globalThis as { __t08Calls?: number };
            holder.__t08Calls = (holder.__t08Calls ?? 0) + 1;
            return { tag: 2 };
          },
        },
      ],
    });
  `],
  [GONE_FILE, `
    ${STUB}
    ${GONE}
    interface GoneItem { n: number }
    export const goneContainer = defineBuilderConfig({
      name: 'T08Gone',
      injections: [
        { token: useInterface<GoneItem>(), provider: SyncGone, multi: true },
        { token: useInterface<GoneItem>(), provider: AsyncGone, multi: true },
      ],
    });
  `],
  [SAME_FILE, `
    ${STUB}
    interface SameItem { n: number; dispose: () => void }
    const same = useInterface<SameItem>();
    export const sameContainer = defineBuilderConfig({
      name: 'T08Same',
      injections: [
        {
          token: same,
          useFactory: true,
          dependencies: [],
          multi: true,
          provider: async () => {
            const holder = globalThis as { __t08Made?: SameItem[]; __t08Calls?: number };
            holder.__t08Calls = (holder.__t08Calls ?? 0) + 1;
            const value = {
              n: 1,
              dispose(): void {
                const disposed = globalThis as { __t08Disposed?: SameItem[] };
                const list = disposed.__t08Disposed ?? [];
                list.push(value);
                disposed.__t08Disposed = list;
              },
            };
            const made = holder.__t08Made ?? [];
            made.push(value);
            holder.__t08Made = made;
            return value;
          },
        },
        {
          token: same,
          useFactory: true,
          dependencies: [],
          multi: true,
          provider: async () => {
            const holder = globalThis as { __t08Made?: SameItem[]; __t08Calls?: number };
            holder.__t08Calls = (holder.__t08Calls ?? 0) + 1;
            const value = {
              n: 2,
              dispose(): void {
                const disposed = globalThis as { __t08Disposed?: SameItem[] };
                const list = disposed.__t08Disposed ?? [];
                list.push(value);
                disposed.__t08Disposed = list;
              },
            };
            const made = holder.__t08Made ?? [];
            made.push(value);
            holder.__t08Made = made;
            return value;
          },
        },
      ],
    });
  `],
  [PARENT_FILE, `
    ${STUB}
    interface ParentItem { n: string }
    interface ParentMark { n: number }
    const mid = useInterface<ParentItem>();
    export const parent = defineBuilderConfig({
      name: 'T08Parent',
      injections: [
        {
          token: mid,
          useFactory: true,
          dependencies: [],
          multi: true,
          provider: () => ({ n: 'parent' }),
        },
      ],
    });
    export const childOpen = defineBuilderConfig({
      name: 'T08ChildOpen',
      useContainer: parent,
      injections: [
        {
          token: useInterface<ParentMark>(),
          useFactory: true,
          dependencies: [],
          provider: () => ({ n: 1 }),
        },
      ],
    });
    export const childShadow = defineBuilderConfig({
      name: 'T08ChildShadow',
      useContainer: parent,
      injections: [
        {
          token: mid,
          useFactory: true,
          dependencies: [],
          multi: true,
          scoped: true,
          provider: () => ({ n: 'local' }),
        },
      ],
    });
  `],
  [GUARD_FILE, `
    ${STUB}
    interface GuardSimple { n: number }
    interface GuardMulti { n: number }
    const simple = useInterface<GuardSimple>();
    const multi = useInterface<GuardMulti>();
    export const syncGuard = defineBuilderConfig({
      name: 'T08SyncGuard',
      injections: [
        {
          token: simple,
          useFactory: true,
          dependencies: [],
          provider: () => ({ n: 1 }),
        },
        {
          token: multi,
          useFactory: true,
          dependencies: [],
          multi: true,
          provider: () => ({ n: 2 }),
        },
      ],
    });
    export const asyncGuard = defineBuilderConfig({
      name: 'T08AsyncGuard',
      injections: [
        {
          token: simple,
          useFactory: true,
          dependencies: [],
          provider: async () => ({ n: 3 }),
        },
        {
          token: multi,
          useFactory: true,
          dependencies: [],
          multi: true,
          provider: async () => ({ n: 4 }),
        },
      ],
    });
  `],
  [DEP_FILE, `
    ${STUB}
    ${DEP}
    interface ContribItem { n: number }
    export const depContainer = defineBuilderConfig({
      name: 'T08Dep',
      injections: [
        { token: Dep },
        { token: useInterface<ContribItem>(), provider: Contrib, multi: true },
      ],
    });
  `],
  [CHAIN_FILE, `
    ${STUB}
    ${CHAIN}
    interface ContribItem { n: number }
    export const chainContainer = defineBuilderConfig({
      name: 'T08Chain',
      injections: [
        { token: ChainE },
        { token: ChainD },
        { token: useInterface<ContribItem>(), provider: ChainContrib, multi: true },
      ],
    });
  `],
  [INIT_FILE, `
    ${STUB}
    interface InitA { n: number }
    interface InitC { held: InitA }
    interface InitM { n: number }
    const a = useInterface<InitA>();
    const m = useInterface<InitM>();
    export const initContainer = defineBuilderConfig({
      name: 'T08ChainInit',
      injections: [
        {
          token: a,
          useFactory: true,
          dependencies: [{ all: m }],
          provider: async (ctx) => {
            t08log('A');
            const value = { n: 1, items: ctx.resolveAll(m) };
            (globalThis as { __t08A?: InitA }).__t08A = value;
            return value;
          },
        },
        {
          token: useInterface<InitC>(),
          useFactory: true,
          dependencies: [a],
          provider: async (ctx) => {
            t08log('C');
            return { held: ctx.resolve(a) };
          },
        },
        {
          token: m,
          useFactory: true,
          dependencies: [],
          multi: true,
          provider: async () => {
            t08log('M');
            return { n: 2 };
          },
        },
      ],
    });
  `],
  [ALIAS_FILE, `
    ${STUB}
    ${ALIAS}
    interface AliasMark { n: number }
    export const aliasContainer = defineBuilderConfig({
      name: 'T08Alias',
      injections: [
        { token: AliasLogger },
        {
          token: useInterface<AliasMark>(),
          useFactory: true,
          dependencies: [AliasLogger],
          multi: true,
          provider: (ctx) => ctx.resolve(AliasLogger),
        },
      ],
    });
  `],
  [TWIN_FILE, `
    ${STUB}
    interface TwinItem { n: number }
    const mid = useInterface<TwinItem>();
    export const twinPartial = definePartialConfig({
      injections: [
        {
          token: mid,
          useFactory: true,
          dependencies: [],
          multi: true,
          provider: () => {
            const value = {
              n: 1,
              dispose(): void {
                const holder = globalThis as { __t08Disposed?: object[] };
                const list = holder.__t08Disposed ?? [];
                list.push(value);
                holder.__t08Disposed = list;
              },
            };
            const made = (globalThis as { __t08Made?: object[] }).__t08Made ?? [];
            made.push(value);
            (globalThis as { __t08Made?: object[] }).__t08Made = made;
            return value;
          },
        },
      ],
    });
    export const twinHost = defineBuilderConfig({
      name: 'T08Twin',
      extends: [twinPartial, twinPartial],
      injections: [],
    });
  `],
  [AWAIT_FILE, `
    ${STUB}
    interface AwaitItem { n: number }
    const mid = useInterface<AwaitItem>();
    export const awaitContainer = defineBuilderConfig({
      name: 'T08Await',
      injections: [
        {
          token: mid,
          useFactory: true,
          dependencies: [],
          multi: true,
          provider: () => ({
            n: 1,
            async dispose(): Promise<void> {
              await (globalThis as { __t08Gate?: { ready: Promise<void> } }).__t08Gate!.ready;
              const holder = globalThis as { __t08Order?: string[] };
              const order = holder.__t08Order ?? [];
              order.push('done');
              holder.__t08Order = order;
            },
          }),
        },
      ],
    });
  `],
  [REJECT_FILE, `
    ${STUB}
    interface RejectItem { n: number }
    const mid = useInterface<RejectItem>();
    export const rejectContainer = defineBuilderConfig({
      name: 'T08Reject',
      injections: [
        {
          token: mid,
          useFactory: true,
          dependencies: [],
          multi: true,
          provider: () => ({
            n: 1,
            async dispose(): Promise<void> {
              const holder = globalThis as { __t08Order?: string[] };
              const order = holder.__t08Order ?? [];
              order.push('bad');
              holder.__t08Order = order;
              throw (globalThis as { __t08Boom?: Error }).__t08Boom;
            },
          }),
        },
        {
          token: mid,
          useFactory: true,
          dependencies: [],
          multi: true,
          provider: () => ({
            n: 2,
            dispose(): void {
              const holder = globalThis as { __t08Order?: string[] };
              const order = holder.__t08Order ?? [];
              order.push('good');
              holder.__t08Order = order;
            },
          }),
        },
      ],
    });
  `],
  [BLOCK_FILE, `
    ${STUB}
    interface BlockA { n: number }
    interface BlockM1 { got: BlockA }
    interface BlockM2 { n: number }
    const a = useInterface<BlockA>();
    const m1 = useInterface<BlockM1>();
    const m2 = useInterface<BlockM2>();
    export const blockContainer = defineBuilderConfig({
      name: 'T08Blocked',
      injections: [
        {
          token: m1,
          useFactory: true,
          dependencies: [a],
          multi: true,
          provider: async (ctx) => {
            t08log('M1');
            return { got: ctx.resolve(a) };
          },
        },
        {
          token: a,
          useFactory: true,
          dependencies: [{ all: m2 }],
          provider: async () => {
            t08log('A');
            const value = { n: 1 };
            (globalThis as { __t08A?: BlockA }).__t08A = value;
            return value;
          },
        },
        {
          token: m2,
          useFactory: true,
          dependencies: [],
          multi: true,
          provider: async () => {
            t08log('M2');
            return { n: 2 };
          },
        },
      ],
    });
  `],
  [EDGE_FILE, `
    ${STUB}
    interface EdgeM1 { seen: EdgeM2[] }
    interface EdgeM2 { n: number }
    const m1 = useInterface<EdgeM1>();
    const m2 = useInterface<EdgeM2>();
    export const edgeContainer = defineBuilderConfig({
      name: 'T08MultiEdge',
      injections: [
        {
          token: m1,
          useFactory: true,
          dependencies: [{ all: m2 }],
          multi: true,
          provider: async (ctx) => {
            t08log('M1');
            return { seen: ctx.resolveAll(m2) };
          },
        },
        {
          token: m2,
          useFactory: true,
          dependencies: [],
          multi: true,
          provider: async () => {
            t08log('M2');
            return { n: 2 };
          },
        },
      ],
    });
  `],
  [CYCLE_FILE, `
    ${STUB}
    interface CycleA { seen: CycleM[] }
    interface CycleM { n: number }
    const a = useInterface<CycleA>();
    const m = useInterface<CycleM>();
    export const cycleContainer = defineBuilderConfig({
      name: 'T08Cycle',
      injections: [
        {
          token: a,
          useFactory: true,
          dependencies: [{ all: m }],
          provider: async (ctx) => {
            t08log('A');
            return { seen: ctx.resolveAll(m) };
          },
        },
        {
          token: m,
          useFactory: true,
          dependencies: [a],
          multi: true,
          provider: async () => {
            t08log('M');
            return { n: 1 };
          },
        },
      ],
    });
  `],
  [ASYNC_PARENT_FILE, `
    ${STUB}
    interface AsyncParentItem { n: number }
    interface AsyncChildMark { n: number }
    const mid = useInterface<AsyncParentItem>();
    export const parent = defineBuilderConfig({
      name: 'T08AsyncParent',
      injections: [
        {
          token: mid,
          useFactory: true,
          dependencies: [],
          multi: true,
          provider: async () => {
            const holder = globalThis as { __t08ParentCalls?: number };
            holder.__t08ParentCalls = (holder.__t08ParentCalls ?? 0) + 1;
            await (globalThis as { __t08Gate?: { ready: Promise<void> } }).__t08Gate!.ready;
            return { n: 1 };
          },
        },
        {
          token: mid,
          useFactory: true,
          dependencies: [],
          multi: true,
          provider: async () => ({ n: 2 }),
        },
      ],
    });
    export const asyncChild = defineBuilderConfig({
      name: 'T08AsyncChild',
      useContainer: parent,
      injections: [
        {
          token: useInterface<AsyncChildMark>(),
          useFactory: true,
          dependencies: [],
          provider: () => ({ n: 0 }),
        },
      ],
    });
  `],
]);

interface RuntimeContainer {
  initialize: () => Promise<void>;
  resolve: (token: unknown) => unknown;
  resolveAll: (token: unknown) => unknown[];
  destroy: () => Promise<void>;
}

interface Gate {
  ready: Promise<void>;
  open: () => void;
}

const opened: RuntimeContainer[] = [];

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
    const text = textAt(sources, fileName);
    if (text !== undefined) return ts.createSourceFile(fileName, text, languageVersion, true);
    return originalGetSourceFile(fileName, languageVersion);
  };
  host.fileExists = (fileName) => hasText(sources, fileName) || originalFileExists(fileName);
  return ts.createProgram([...sources.keys()], options, host);
}

function tokenId(graph: DependencyGraph, name: string): string {
  const keys = [
    ...graph.nodes.keys(),
    ...(graph.multiNodes ? [...graph.multiNodes.keys()] : []),
  ];
  const found = keys.find((id) => id.includes(name));
  if (!found) throw new Error(`missing token ${name}`);
  return found;
}

function execute(
  graph: DependencyGraph,
  bindings: Record<string, string> = {},
  options: { prelude?: string; direct?: boolean } = {},
): RuntimeContainer {
  const generator = new Generator(graph, options.direct === true);
  const name = graph.exportedVariableName ?? 'container';
  const prelude = [
    options.prelude ?? '',
    ...Object.entries(bindings).map(([binding, value]) => `const ${binding} = ${JSON.stringify(value)};`),
  ].join('\n');
  const exported = options.direct === true
    ? `\nexport const ${name} = ${generator.generateInstantiation()};`
    : '';
  const tsCode = `${prelude}\n${generator.generate()}${exported}`;
  const jsCode = ts.transpileModule(tsCode, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const moduleRecord: { exports: Record<string, RuntimeContainer | undefined> } = { exports: {} };
  const run = new Function('module', 'exports', 'require', jsCode) as (
    module: typeof moduleRecord,
    exports: typeof moduleRecord.exports,
    require: (id: string) => unknown,
  ) => void;
  run(moduleRecord, moduleRecord.exports, () => ({}));
  const container = moduleRecord.exports[name];
  if (!container) throw new Error(`generated module did not export ${name}`);
  opened.push(container);
  return container;
}

function executeChild(graph: DependencyGraph, parent: object): RuntimeContainer {
  const tsCode = new Generator(graph, false).generate();
  const jsCode = ts.transpileModule(tsCode, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const moduleRecord: { exports: Record<string, RuntimeContainer | undefined> } = { exports: {} };
  const run = new Function('parent', 'module', 'exports', 'require', jsCode) as (
    parent: object,
    module: typeof moduleRecord,
    exports: typeof moduleRecord.exports,
    require: (id: string) => unknown,
  ) => void;
  run(parent, moduleRecord, moduleRecord.exports, () => ({}));
  const name = graph.exportedVariableName ?? 'container';
  const container = moduleRecord.exports[name];
  if (!container) throw new Error(`generated module did not export ${name}`);
  opened.push(container);
  return container;
}

function shutGate(key: string): Gate {
  let openGate: () => void = () => {};
  const ready = new Promise<void>((resolve) => {
    openGate = resolve;
  });
  const gate: Gate = { ready, open: () => { openGate(); } };
  Reflect.set(globalThis, key, gate);
  return gate;
}

function readFailure(value: unknown): { code: string | undefined; message: string; cause: unknown } {
  if (!(value instanceof Error)) return { code: undefined, message: '', cause: undefined };
  const coded = value as Error & { code?: unknown; cause?: unknown };
  const code = typeof coded.code === 'string' ? coded.code : undefined;
  return { code, message: value.message, cause: coded.cause };
}

function count(key: string): number {
  const value = Reflect.get(globalThis, key);
  return typeof value === 'number' ? value : 0;
}

function texts(key: string): string[] {
  const value = Reflect.get(globalThis, key);
  return Array.isArray(value) ? value.map((item) => String(item)) : [];
}

function started(): number[] {
  const value = Reflect.get(globalThis, '__t08Started');
  return Array.isArray(value) ? value.filter((item): item is number => typeof item === 'number') : [];
}

function graphByName(graphs: Map<string, DependencyGraph>, name: string): DependencyGraph {
  const graph = graphs.get(name);
  if (!graph) throw new Error(`missing ${name}`);
  const errors = (graph.errors ?? []).filter((error) => error.severity !== 'warning');
  if (errors.length > 0) throw new Error(errors.map((error) => error.message).join('\n'));
  return graph;
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function partialOrder(): string[] {
  const program = createProgram(new Map([[ORDER_FILE, ORDER_SOURCE]]));
  const graph = new Analyzer(program).extractAll().find((item) => item.containerId === 'T08PartialOrder');
  if (!graph) throw new Error('missing T08PartialOrder');
  const container = execute(graph, { mid: tokenId(graph, 'OrderMid') });
  return container.resolveAll(tokenId(graph, 'OrderMid')).map((item) => {
    const row = item as { n?: unknown };
    return String(row.n);
  });
}

describe('T08 multi runtime', () => {
  let graphs: Map<string, DependencyGraph>;

  beforeAll(() => {
    graphs = new Map();
    for (const graph of new Analyzer(createProgram(files)).extractAll()) graphs.set(graph.containerId, graph);
  });

  afterEach(async () => {
    for (const key of ['__t08Gate', '__t08Gate0', '__t08Gate1']) {
      const gate = Reflect.get(globalThis, key) as Gate | undefined;
      gate?.open();
    }
    const pending = opened.splice(0);
    await Promise.allSettled(pending.map((container) => container.destroy()));
    for (const key of [
      '__t08Gate', '__t08Gate0', '__t08Gate1', '__t08Started', '__t08Count',
      '__t08Calls', '__t08Boom', '__t08Disposed', '__t08Gone', '__t08Made',
      '__t08Order', '__t08ParentCalls', '__t08A', '__t08Logger',
    ]) {
      Reflect.deleteProperty(globalThis, key);
    }
  });

  it('T08-P1 [A01] async multi initialize returns ready objects', async () => {
    const graph = graphByName(graphs, 'T08Pair');
    const gate = shutGate('__t08Gate');
    const token = tokenId(graph, 'PairItem');
    const container = execute(graph);
    const pending = container.initialize();
    await flush();
    let during: unknown;
    try {
      container.resolveAll(token);
    } catch (error) {
      during = error;
    }
    expect(readFailure(during).code).toBe('NEO_NOT_INITIALIZED');
    gate.open();
    await pending;
    expect(container.resolveAll(token)).toEqual([{ n: 1 }, { n: 2 }]);
  });

  it('T08-P2 [A01] second multi factory waits and initialize runs once', async () => {
    const graph = graphByName(graphs, 'T08Once');
    const gate0 = shutGate('__t08Gate0');
    const gate1 = shutGate('__t08Gate1');
    Reflect.set(globalThis, '__t08Started', []);
    const container = execute(graph);
    const first = container.initialize();
    const second = container.initialize();
    await flush();
    expect(started()).toEqual([0]);
    gate0.open();
    await flush();
    expect(started()).toEqual([0, 1]);
    gate1.open();
    await first;
    await second;
    expect(started()).toEqual([0, 1]);
  });

  it('T08-P3 [A01] consumer receives ready multi contributions', async () => {
    const graph = graphByName(graphs, 'T08Consumer');
    const container = execute(graph, { mid: tokenId(graph, 'ConsItem') });
    await container.initialize();
    const pipe = container.resolve(tokenId(graph, 'ConsPipe')) as { items: Array<{ n: number }> };
    expect(pipe.items).toEqual([{ n: 1 }, { n: 2 }]);
    expect(pipe.items[0]).not.toBeInstanceOf(Promise);
  });

  it('T08-P4 [A07] sync then async contributions keep declaration order', async () => {
    const graph = graphByName(graphs, 'T08Mixed');
    const token = tokenId(graph, 'MixedItem');
    const container = execute(graph);
    await container.initialize();
    const first = container.resolveAll(token);
    const second = container.resolveAll(token);
    expect(first).toEqual([{ n: 'sync' }, { n: 'async' }]);
    expect(second[0]).toBe(first[0]);
    expect(second[1]).toBe(first[1]);
  });

  it('T08-P5 [A02] two resolveAll calls reuse instances but not the array', () => {
    const graph = graphByName(graphs, 'T08Reuse');
    const token = tokenId(graph, 'ReuseItem');
    const container = execute(graph);
    const first = container.resolveAll(token);
    const second = container.resolveAll(token);
    expect(second[0]).toBe(first[0]);
    expect(second[1]).toBe(first[1]);
    expect(second).not.toBe(first);
  });

  it('T08-P6 [A03] sync multi transient builds new contributions', () => {
    const graph = graphByName(graphs, 'T08Transient');
    const token = tokenId(graph, 'TransientItem');
    const container = execute(graph);
    const first = container.resolveAll(token) as Array<{ n: number }>;
    const second = container.resolveAll(token) as Array<{ n: number }>;
    expect(count('__t08Count')).toBe(4);
    expect(first.map((item) => item.n)).toEqual([1, 2]);
    expect(second.map((item) => item.n)).toEqual([3, 4]);
    expect(second[0]).not.toBe(first[0]);
  });

  it('T08-P7 [A04] mutating resolveAll does not change the next call', () => {
    const graph = graphByName(graphs, 'T08Fresh');
    const token = tokenId(graph, 'FreshItem');
    const container = execute(graph);
    const first = container.resolveAll(token) as Array<{ n: number }>;
    first.push({ n: 9 });
    first.reverse();
    const second = container.resolveAll(token) as Array<{ n: number }>;
    expect(second).toHaveLength(2);
    expect(second.map((item) => item.n)).toEqual([1, 2]);
  });

  it('T08-P8 [A05] a failed contribution leaves only the created one to destroy', async () => {
    const graph = graphByName(graphs, 'T08Fail');
    const boom = new Error('boom-2');
    Reflect.set(globalThis, '__t08Boom', boom);
    Reflect.set(globalThis, '__t08Disposed', []);
    const token = tokenId(graph, 'FailItem');
    const container = execute(graph);
    let rejected: unknown;
    try {
      await container.initialize();
    } catch (error) {
      rejected = error;
    }
    expect(rejected).toBe(boom);
    expect(count('__t08Calls')).toBe(2);
    let resolved: unknown;
    try {
      container.resolveAll(token);
    } catch (error) {
      resolved = error;
    }
    expect(readFailure(resolved).code).toBe('NEO_CONTAINER_FAILED');
    await container.destroy();
    expect(texts('__t08Disposed')).toEqual(['0']);
    await container.destroy();
    expect(texts('__t08Disposed')).toEqual(['0']);
  });

  it('T08-P9 [A06] destroy disposes created multi singletons once', async () => {
    const graph = graphByName(graphs, 'T08Gone');
    const token = tokenId(graph, 'GoneItem');
    const untouched = execute(graph, {}, { prelude: GONE, direct: true });
    await untouched.destroy();
    expect(texts('__t08Gone')).toEqual([]);
    const container = execute(graph, {}, { prelude: GONE, direct: true });
    container.resolveAll(token);
    await container.destroy();
    expect(texts('__t08Gone').slice().sort()).toEqual(['async', 'sync']);
    await container.destroy();
    expect(texts('__t08Gone').slice().sort()).toEqual(['async', 'sync']);
  });

  it('T08-P10 [A06] initialize resolveAll and destroy share each contribution', async () => {
    const graph = graphByName(graphs, 'T08Same');
    const token = tokenId(graph, 'SameItem');
    const container = execute(graph);
    await container.initialize();
    const listed = container.resolveAll(token) as Array<{ n: number }>;
    const made = Reflect.get(globalThis, '__t08Made') as Array<{ n: number }>;
    expect(count('__t08Calls')).toBe(2);
    expect(listed[0]).toBe(made[0]);
    expect(listed[1]).toBe(made[1]);
    expect(listed[0]).not.toBe(listed[1]);
    await container.destroy();
    const disposed = Reflect.get(globalThis, '__t08Disposed') as Array<{ n: number }>;
    expect(disposed).toHaveLength(2);
    expect(disposed).toContain(listed[0]);
    expect(disposed).toContain(listed[1]);
  });

  it('T08-P11 [A07] extends contributions stay before local ones', () => {
    expect(partialOrder()).toEqual(['extends', 'local']);
    expect(partialOrder()).toEqual(['extends', 'local']);
  });

  it('T08-P12 [A07] child delegates or shadows the parent multi list', () => {
    const parentGraph = graphByName(graphs, 'T08Parent');
    const openGraph = graphByName(graphs, 'T08ChildOpen');
    const shadowGraph = graphByName(graphs, 'T08ChildShadow');
    const token = tokenId(parentGraph, 'ParentItem');
    const parent = execute(parentGraph);
    const child = executeChild(openGraph, parent);
    const shadow = executeChild(shadowGraph, parent);
    const fromParent = parent.resolveAll(token);
    const fromChild = child.resolveAll(token);
    expect(fromChild[0]).toBe(fromParent[0]);
    expect(fromChild).not.toBe(fromParent);
    const local = shadow.resolveAll(token) as Array<{ n: string }>;
    expect(local.map((item) => item.n)).toEqual(['local']);
    expect(parent.resolveAll(token)[0]).toBe(fromParent[0]);
    const legacy = executeChild(openGraph, { resolve: () => ({ n: 'bare' }) });
    let listed: unknown;
    try {
      listed = legacy.resolveAll(token);
    } catch (error) {
      listed = error;
    }
    expect(listed).toEqual([]);
  });

  it('T08-P13 [NS007] resolve on a multi token asks for resolveAll', async () => {
    const syncGraph = graphByName(graphs, 'T08SyncGuard');
    const asyncGraph = graphByName(graphs, 'T08AsyncGuard');
    const sync = execute(syncGraph);
    let syncError: unknown;
    try {
      sync.resolve(tokenId(syncGraph, 'GuardMulti'));
    } catch (error) {
      syncError = error;
    }
    const syncFailure = readFailure(syncError);
    expect(syncFailure.code).toBe('NEO_MULTI_REQUIRES_RESOLVE_ALL');
    expect(syncFailure.message).toContain('resolveAll');
    expect(sync.resolveAll(tokenId(syncGraph, 'GuardSimple'))).toEqual([]);
    const asyncContainer = execute(asyncGraph);
    await asyncContainer.initialize();
    let asyncError: unknown;
    try {
      asyncContainer.resolve(tokenId(asyncGraph, 'GuardMulti'));
    } catch (error) {
      asyncError = error;
    }
    const asyncFailure = readFailure(asyncError);
    expect(asyncFailure.code).toBe('NEO_MULTI_REQUIRES_RESOLVE_ALL');
    expect(asyncFailure.message).toContain('resolveAll');
    expect(asyncContainer.resolveAll(tokenId(asyncGraph, 'GuardSimple'))).toEqual([]);
  });

  it('T08-P14 [A06] a multi contribution is disposed before its dependency', async () => {
    const graph = graphByName(graphs, 'T08Dep');
    Reflect.set(globalThis, '__t08Order', []);
    const container = execute(graph, {}, { prelude: DEP, direct: true });
    container.resolveAll(tokenId(graph, 'ContribItem'));
    await container.destroy();
    expect(texts('__t08Order')).toEqual(['contrib', 'dep']);
  });

  it('T08-P15 [A06] contribution disposed before its dependency chain (Contrib -> D -> E)', async () => {
    const graph = graphByName(graphs, 'T08Chain');
    Reflect.set(globalThis, '__t08Order', []);
    const container = execute(graph, {}, { prelude: CHAIN, direct: true });
    container.resolveAll(tokenId(graph, 'ContribItem'));
    await container.destroy();
    expect(texts('__t08Order')).toEqual(['Contrib', 'D', 'E']);
  });

  it('T08-P16 [A01] a child waits for a parent that only has async multi contributions', async () => {
    const parentGraph = graphByName(graphs, 'T08AsyncParent');
    const childGraph = graphByName(graphs, 'T08AsyncChild');
    const gate = shutGate('__t08Gate');
    const token = tokenId(parentGraph, 'AsyncParentItem');
    const parent = execute(parentGraph);
    const child = executeChild(childGraph, parent);
    let during: unknown;
    try {
      child.resolveAll(token);
    } catch (error) {
      during = error;
    }
    expect(readFailure(during).code).toBe('NEO_NOT_INITIALIZED');
    let settled = false;
    const pending = child.initialize().then(() => { settled = true; }, () => { settled = true; });
    await flush();
    expect(settled).toBe(false);
    expect(count('__t08ParentCalls')).toBe(1);
    gate.open();
    await pending;
    expect(child.resolveAll(token)).toEqual([{ n: 1 }, { n: 2 }]);
  });

  it('T08-P17 [A01] async singleton waits for its multi before a dependent singleton', async () => {
    const graph = graphByName(graphs, 'T08ChainInit');
    Reflect.set(globalThis, '__t08Order', []);
    const container = execute(graph, {
      a: tokenId(graph, 'InitA'),
      m: tokenId(graph, 'InitM'),
    }, { prelude: LOG });
    let failed: unknown;
    try {
      await container.initialize();
    } catch (error) {
      failed = error;
    }
    expect(failed).toBeUndefined();
    expect(texts('__t08Order')).toEqual(['M', 'A', 'C']);
    const held = container.resolve(tokenId(graph, 'InitC')) as { held: unknown };
    expect(held.held).toBe(Reflect.get(globalThis, '__t08A'));
  });

  it('T08-P18 [A06] an aliased local singleton is disposed once', async () => {
    const graph = graphByName(graphs, 'T08Alias');
    Reflect.set(globalThis, '__t08Order', []);
    const container = execute(graph, {}, { prelude: ALIAS, direct: true });
    const listed = container.resolveAll(tokenId(graph, 'AliasMark'));
    expect(listed[0]).toBe(Reflect.get(globalThis, '__t08Logger'));
    await container.destroy();
    expect(texts('__t08Order')).toEqual(['logger']);
  });

  it('T08-P19 [A06] the same partial extended twice builds two objects', () => {
    const graph = graphByName(graphs, 'T08Twin');
    Reflect.set(globalThis, '__t08Made', []);
    Reflect.set(globalThis, '__t08Disposed', []);
    const container = execute(graph, { mid: tokenId(graph, 'TwinItem') });
    const listed = container.resolveAll(tokenId(graph, 'TwinItem'));
    expect(listed).toHaveLength(2);
    expect(listed[0]).not.toBe(listed[1]);
    return container.destroy().then(() => {
      const disposed = Reflect.get(globalThis, '__t08Disposed') as unknown[];
      expect(disposed).toHaveLength(2);
      expect(disposed).toContain(listed[0]);
      expect(disposed).toContain(listed[1]);
    });
  });

  it('T08-P20 [A06] a factory dispose is awaited and a rejection still runs the others', async () => {
    const awaitGraph = graphByName(graphs, 'T08Await');
    const gate = shutGate('__t08Gate');
    Reflect.set(globalThis, '__t08Order', []);
    const waiting = execute(awaitGraph, { mid: tokenId(awaitGraph, 'AwaitItem') });
    waiting.resolveAll(tokenId(awaitGraph, 'AwaitItem'));
    let settled = false;
    const pending = waiting.destroy().then(() => { settled = true; }, () => { settled = true; });
    await flush();
    expect(settled).toBe(false);
    expect(texts('__t08Order')).toEqual([]);
    gate.open();
    await pending;
    expect(settled).toBe(true);
    expect(texts('__t08Order')).toEqual(['done']);

    const rejectGraph = graphByName(graphs, 'T08Reject');
    const marker = new Error('dispose-failed');
    Reflect.set(globalThis, '__t08Boom', marker);
    Reflect.set(globalThis, '__t08Order', []);
    const rejecting = execute(rejectGraph, { mid: tokenId(rejectGraph, 'RejectItem') });
    rejecting.resolveAll(tokenId(rejectGraph, 'RejectItem'));
    let rejected: unknown;
    try {
      await rejecting.destroy();
    } catch (error) {
      rejected = error;
    }
    expect(rejected).toBeInstanceOf(Error);
    expect(texts('__t08Order')).toEqual(['bad', 'good']);
  });

  it('T08-P21 [A01] a multi contribution waits for a blocked singleton', async () => {
    const graph = graphByName(graphs, 'T08Blocked');
    Reflect.set(globalThis, '__t08Order', []);
    const container = execute(graph, {
      a: tokenId(graph, 'BlockA'),
      m1: tokenId(graph, 'BlockM1'),
      m2: tokenId(graph, 'BlockM2'),
    }, { prelude: LOG });
    let failed: unknown;
    try {
      await container.initialize();
    } catch (error) {
      failed = error;
    }
    expect(failed).toBeUndefined();
    expect(texts('__t08Order')).toEqual(['M2', 'A', 'M1']);
    const listed = container.resolveAll(tokenId(graph, 'BlockM1')) as Array<{ got: unknown }>;
    expect(listed[0].got).toBe(Reflect.get(globalThis, '__t08A'));
  });

  it('T08-P22 [A01] a multi contribution waits for the multi it consumes', async () => {
    const graph = graphByName(graphs, 'T08MultiEdge');
    Reflect.set(globalThis, '__t08Order', []);
    const container = execute(graph, {
      m1: tokenId(graph, 'EdgeM1'),
      m2: tokenId(graph, 'EdgeM2'),
    }, { prelude: LOG });
    await container.initialize();
    expect(texts('__t08Order')).toEqual(['M2', 'M1']);
    const listed = container.resolveAll(tokenId(graph, 'EdgeM1')) as Array<{ seen: Array<{ n: number }> }>;
    expect(listed[0].seen).toEqual([{ n: 2 }]);
  });

  it('T08-P23 [NS007] a cycle keeps the earlier step first', async () => {
    const graph = graphByName(graphs, 'T08Cycle');
    Reflect.set(globalThis, '__t08Order', []);
    const container = execute(graph, {
      a: tokenId(graph, 'CycleA'),
      m: tokenId(graph, 'CycleM'),
    }, { prelude: LOG });
    let failed: unknown;
    try {
      await container.initialize();
    } catch (error) {
      failed = error;
    }
    expect(failed).toBeUndefined();
    expect(texts('__t08Order')).toEqual(['A', 'M']);
  });

  it('T08-P24 [NS007] a non-array legacy resolveAll is ignored', () => {
    const openGraph = graphByName(graphs, 'T08ChildOpen');
    const token = tokenId(graphByName(graphs, 'T08Parent'), 'ParentItem');
    const legacy = executeChild(openGraph, { resolveAll: () => ({ n: 'not-array' }) });
    let listed: unknown;
    try {
      listed = legacy.resolveAll(token);
    } catch (error) {
      listed = error;
    }
    expect(listed).toEqual([]);
  });
});
