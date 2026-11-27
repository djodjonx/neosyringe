import { beforeAll, describe, expect, it } from 'vitest';
import { GraphValidator } from '../../src/generator/GraphValidator';
import { Generator } from '../../src/generator/Generator';
import {
  CELLS,
  EMITTERS,
  MATRIX,
  aliasService,
  attempt,
  build,
  call,
  capabilityAlias,
  chainGraph,
  containerText,
  failure,
  graphOf,
  label,
  readKey,
  ready,
  runGenerated,
  shown,
  slice,
  thrown,
  use,
  withEnv,
  type Cell,
  type Emitter,
} from '../helpers/e20-build';
import { warmLibCache } from '../fastProgram';

/**
 * E20 `useExisting` at runtime, on the two emitters, open and closed, sync and async, full and minimal. Every test
 * calls `capabilityAlias(built)` first (the analysis has a node of type `alias`), then reads what a user can observe:
 * the object a token resolves to, the events a listener sees, the constructions and disposals counted, the error code
 * and message. The containers are reached through `Reflect` on `unknown`.
 */

const ALIAS_OVERRIDE = 'NEO_OVERRIDE_ALIAS_UNSUPPORTED';
const NOT_EXPORTED = 'NEO_ROOT_NOT_EXPORTED';

/** A class token that aliases `Engine`: a factory text can name it (`ctx.resolve(Port)`), an interface token has no runtime value there. */
const PORT_DECLARATIONS = "export class Port { readonly id: string = 'port'; }";
const PORT_ALIASES = `{ token: logger, useExisting: Engine },
    { token: Port, useExisting: Engine },`;

const sync = (cells: readonly Cell[]): Cell[] => cells.filter((cell) => cell.timing === 'sync');
const full = (cells: readonly Cell[]): Cell[] => cells.filter((cell) => cell.profile === 'full');

/** The listener of a container, and what it saw: the tokens, in order. */
function listen(box: object): { tokens: unknown[]; instances: unknown[]; stop: () => void } {
  const tokens: unknown[] = [];
  const instances: unknown[] = [];
  const member: unknown = readKey(box, 'on');
  if (typeof member !== 'function') throw new Error('on is not a function');
  const stop: unknown = Reflect.apply(member, box, ['resolve', (token: unknown, instance: unknown) => {
    tokens.push(token);
    instances.push(instance);
  }]);
  return { tokens, instances, stop: () => { if (typeof stop === 'function') stop(); } };
}

describe('E20 useExisting runtime', () => {
  beforeAll(() => {
    warmLibCache();
  });

  it('E20-P0 the alias is a node of the graph and answers resolve', async () => {
    await withEnv(CELLS[0] as Cell, {}, async (env) => {
      capabilityAlias(env.built);
      const service = graphOf(env.built).nodes.get(env.logger)?.service;
      expect(readKey(readKey(service, 'aliasTarget'), 'tokenId'), 'the alias names its direct target').toBeTruthy();
      expect(readKey(use(env.box, 'resolve', env.logger), 'id'), 'resolve(alias) answers the target').toBe('engine');
    });
  });

  it('E20-P1 an alias of a singleton, and a chain of aliases, answer the one object of the target, built once', async () => {
    for (const cell of MATRIX) {
      await withEnv(cell, {}, async (env) => {
        capabilityAlias(env.built);
        await ready(cell, env);
        const name = label(cell);
        const direct = env.read(env.engine);
        expect(env.read(env.logger), `${name}: alias`).toBe(direct);
        expect(env.read(env.audit), `${name}: alias of an alias`).toBe(direct);
        expect(env.read(env.sink), `${name}: three links`).toBe(direct);
        expect(readKey(env.read(env.reader), 'logger'), `${name}: a consumer of the alias token`).toBe(direct);
        expect(env.count('buildEngine'), `${name}: the target is built once`).toBe(1);
        expect(containerText(env.built), `${name}: an alias has no creator`).not.toMatch(/create_(Logger|Audit|Sink)_/);
        if (cell.emitter === 'optimized' && cell.profile === 'minimal') {
          expect(containerText(env.built), `${name}: a minimal container has no resolve event, aliases included`).not.toContain('notifyResolve');
        }
      });
    }
  }, 240_000);

  it('E20-P2 an alias of a transient builds a new instance at every read, the consumer gets its own', async () => {
    for (const cell of sync(MATRIX)) {
      await withEnv(cell, { target: 'transient', disposable: false }, async (env) => {
        capabilityAlias(env.built);
        const name = label(cell);
        const first = env.read(env.sink);
        const second = env.read(env.sink);
        expect(readKey(first, 'id'), `${name}: an Engine`).toBe('engine');
        expect(first, `${name}: two reads, two objects`).not.toBe(second);
        expect(env.count('buildEngine'), `${name}: one construction per read`).toBe(2);
        expect(env.read(env.engine), `${name}: not the alias reads`).not.toBe(first);
        expect(readKey(env.read(env.reader), 'logger'), `${name}: the consumer has an object of its own`).not.toBe(first);
        expect(env.count('buildEngine'), `${name}: the target read and the consumer built two more`).toBe(4);
      });
    }
  }, 240_000);

  it('E20-P3 a chain of 50000 aliases is validated, generated and read with no recursion', () => {
    warmLibCache();
    const graph = chainGraph(50_000);
    expect(new GraphValidator().validateAll(graph).errors, 'no missing provider and no cycle').toEqual([]);
    const runs: ReadonlyArray<{ emitter: Emitter; minimal: boolean }> = [
      { emitter: 'reference', minimal: false },
      { emitter: 'optimized', minimal: false },
      { emitter: 'optimized', minimal: true },
    ];
    for (const { emitter, minimal } of runs) {
      const profile = minimal ? 'minimal' : 'full';
      const chain = chainGraph(50_000);
      if (minimal) chain.runtimeProfile = 'minimal';
      let generated: { box: object; text: string } | undefined;
      const failed = attempt(() => { generated = runGenerated(new Generator(chain, true, undefined, false, false, emitter)); });
      expect(failed, `${emitter} ${profile}: the generator accepts a chain of aliases`).toBeUndefined();
      if (generated === undefined) continue;
      const read = (token: string): unknown => use(generated?.box ?? {}, 'resolve', token);
      let last: unknown;
      const outcome = attempt(() => { last = read('A_49999'); });
      expect(outcome, `${emitter} ${profile}: reading the last alias is not a RangeError`).toBeUndefined();
      expect(last, `${emitter} ${profile}: the last alias is the target`).toBe(read('T'));
      expect(read('A_0'), `${emitter} ${profile}: the first alias is the target`).toBe(read('T'));
      if (emitter === 'optimized') {
        const accessor = slice(generated.text, minimal ? 'private _direct_A_49999(' : 'private _get_A_49999(', ['private _']);
        expect(accessor, 'the last alias reads the canonical target').toContain('this._direct_T()');
        expect(accessor, 'and no link of the chain').not.toContain('A_49998');
      }
    }
  }, 600_000);

  it('E20-P3 a chain of 5000 aliases written in a source is analyzed, generated and read on both emitters', async () => {
    const size = 5000;
    const classes = Array.from({ length: size }, (_, index) => `export class C${index} { readonly v = 0; }`).join('\n');
    const injections = Array.from({ length: size }, (_, index) => (index === 0
      ? '{ token: C0 },'
      : `{ token: C${index}, useExisting: C${index - 1} },`)).join('\n    ');
    const source = `${'import { defineBuilderConfig, useInterface, useProperty } from \'@djodjonx/neosyringe\';'}
declare function defineBuilderConfig<T>(config: T): T;
declare function useInterface<T>(): T;
declare function useProperty<T>(target: unknown, name: string): T;
${classes}
export const box = defineBuilderConfig({ name: 'Deep', injections: [
    ${injections}
] });
`;
    for (const emitter of EMITTERS) {
      const built = build(source, { emitter });
      try {
        const node = built.graphs[0]?.nodes.get(built.id(`C${size - 1}`));
        expect(readKey(node?.service, 'type'), `${emitter}: the last class token is an alias`).toBe('alias');
        const box = built.box();
        const last = use(box, 'resolve', built.exports[`C${size - 1}`]);
        expect(last, `${emitter}: the last alias is the target`).toBe(use(box, 'resolve', built.exports['C0']));
      } finally {
        await built.close();
      }
    }
  }, 600_000);

  it('E20-P4 two classes of one name, in two files, keep their own alias', async () => {
    const modules = new Map<string, string>([
      ['a.ts', "export class Logger { readonly id = 'a'; }\n"],
      ['b.ts', "export class Logger { readonly id = 'b'; }\n"],
    ]);
    for (const emitter of EMITTERS) {
      class LoggerA { readonly id = 'a'; }
      class LoggerB { readonly id = 'b'; }
      const runtime: Record<string, unknown> = { './a': { Logger: LoggerA }, './b': { Logger: LoggerB } };
      const source = `import { Logger as LoggerA } from './a';
import { Logger as LoggerB } from './b';
${'import { defineBuilderConfig, useInterface } from \'@djodjonx/neosyringe\';'}
declare function defineBuilderConfig<T>(config: T): T;
declare function useInterface<T>(): T;
interface PortA { id: string }
interface PortB { id: string }
const ids = defineBuilderConfig({
  name: 'Ids',
  injections: [
    { token: useInterface<PortA>(), useValue: { id: 'ids' } },
    { token: useInterface<PortB>(), useValue: { id: 'ids' } },
  ],
});
export const box = defineBuilderConfig({
  name: 'Homonyms',
  injections: [
    { token: LoggerA },
    { token: LoggerB },
    { token: useInterface<PortA>(), useExisting: LoggerA },
    { token: useInterface<PortB>(), useExisting: LoggerB },
  ],
});
`;
      const built = build(source, { emitter, modules, require: (id) => runtime[id] });
      try {
        const node = built.graphs.find((graph) => graph.containerName === 'Homonyms')?.nodes.get(built.id('PortA'));
        expect(readKey(node?.service, 'type'), `${emitter}: PortA is an alias`).toBe('alias');
        const box = built.box();
        const a = use(box, 'resolve', built.id('PortA'));
        const b = use(box, 'resolve', built.id('PortB'));
        expect(a, `${emitter}: PortA reaches the Logger of a.ts`).toBeInstanceOf(LoggerA);
        expect(b, `${emitter}: PortB reaches the Logger of b.ts`).toBeInstanceOf(LoggerB);
        expect(readKey(a, 'id'), `${emitter}: ids`).toBe('a');
      } finally {
        await built.close();
      }
    }
  }, 120_000);

  const PARENT_OPEN = "export const parent = defineBuilderConfig({ name: 'E20Parent', injections: [{ token: Engine }] });";
  const PARENT_CLOSED = "export const parent = defineBuilderConfig({ name: 'E20Parent', optimization: { mode: 'closed', roots: [Engine] }, injections: [{ token: Engine }] });";

  it('E20-P5 an alias of a token the parent provides, open or closed root, answers the parent object with one event', async () => {
    for (const parentText of [PARENT_OPEN, PARENT_CLOSED]) {
      for (const cell of sync(MATRIX)) {
        const roots = '[sink, audit, logger, Reader]';
        await withEnv(cell, { target: 'none', before: parentText, useContainer: 'useContainer: parent,', roots }, async (env) => {
          capabilityAlias(env.built);
          const name = `${label(cell)} ${parentText === PARENT_OPEN ? 'open parent' : 'closed parent'}`;
          const parent = env.built.box('parent');
          const fromParent = use(parent, 'resolve', env.engine);
          const events = cell.profile === 'full' ? listen(env.box) : undefined;
          expect(env.read(env.sink), `${name}: the chain ends at the parent object`).toBe(fromParent);
          expect(env.read(env.logger), `${name}: the alias of the parent token`).toBe(fromParent);
          expect(readKey(env.read(env.reader), 'logger'), `${name}: a consumer reads the parent object`).toBe(fromParent);
          if (events) expect(events.tokens.slice(0, 2), `${name}: one event per read, on the token asked`).toEqual([env.sink, env.logger]);
          events?.stop();
        });
      }
    }
  }, 240_000);

  it('E20-P5 a consumer of a token the parent aliases gets the parent object', async () => {
    const parentText = `export const parent = defineBuilderConfig({
  name: 'E20Parent',
  injections: [{ token: Engine }, { token: logger, useExisting: Engine }],
});`;
    for (const cell of sync(MATRIX)) {
      await withEnv(cell, {
        target: 'none',
        before: parentText,
        useContainer: 'useContainer: parent,',
        aliases: '',
        roots: '[Reader]',
      }, async (env) => {
        const parentGraph = env.built.graphs.find((graph) => graph.containerName === 'E20Parent');
        expect(readKey(parentGraph?.nodes.get(env.logger)?.service, 'type'), 'the parent has the alias').toBe('alias');
        const name = label(cell);
        const reader = env.read(env.reader);
        expect(readKey(reader, 'logger'), `${name}: the consumer of the parent alias`).toBe(use(env.built.box('parent'), 'resolve', env.engine));
      });
    }
  }, 240_000);

  it('E20-P6 a published alias keeps its target private and the target is not a root', async () => {
    for (const cell of MATRIX.filter((candidate) => candidate.mode === 'closed')) {
      await withEnv(cell, { roots: '[sink]' }, async (env) => {
        capabilityAlias(env.built);
        await ready(cell, env);
        const name = label(cell);
        expect(readKey(env.read(env.sink), 'id'), `${name}: the alias root answers`).toBe('engine');
        expect(thrown(() => env.read(env.engine)).code, `${name}: the target stays private`).toBe(NOT_EXPORTED);
        expect(thrown(() => env.read(env.logger)).code, `${name}: so does a middle link`).toBe(NOT_EXPORTED);
        const text = containerText(env.built);
        expect(text.match(/__neoSets = \[new Set<unknown>\(\[([^\]]*)\]\)/)?.[1], `${name}: the only root is the alias`).toBe(JSON.stringify(env.sink));
      });
    }
  }, 240_000);

  it('E20-P7 an alias to what a closed parent exports works, and the parent keeps refusing what it hides', async () => {
    const parentText = `export const parent = defineBuilderConfig({
  name: 'E20Parent',
  optimization: { mode: 'closed', roots: [Engine] },
  injections: [{ token: Engine }, { token: Hidden }],
});`;
    for (const cell of sync(MATRIX)) {
      await withEnv(cell, {
        target: 'none',
        declarations: "export class Hidden { readonly id = 'hidden'; }",
        before: parentText,
        useContainer: 'useContainer: parent,',
        aliases: '{ token: logger, useExisting: Engine },',
        roots: '[logger]',
        extra: '',
      }, async (env) => {
        capabilityAlias(env.built);
        const name = label(cell);
        expect(readKey(env.read(env.logger), 'id'), `${name}: the alias of the exported root answers`).toBe('engine');
        // The child's own roots refuse `Hidden` through the child; what the closed parent decides is its own answer.
        expect(thrown(() => use(env.built.box('parent'), 'resolve', env.built.exports['Hidden'])).code, `${name}: the closed parent still refuses its private root`).toBe(NOT_EXPORTED);
      });
    }
  }, 240_000);

  it('E20-P8 a listener sees the token asked, never the target of an alias', async () => {
    for (const cell of sync(full(MATRIX))) {
      await withEnv(cell, {}, async (env) => {
        capabilityAlias(env.built);
        const name = label(cell);
        const events = listen(env.box);
        const viaSink = env.read(env.sink);
        expect(events.tokens, `${name}: resolve(alias) is one event`).toEqual([env.sink]);
        expect(events.instances[0], `${name}: with the target object`).toBe(viaSink);
        const reader = env.read(env.reader);
        expect(events.tokens.slice(1), `${name}: a consumer reads the alias token, then is itself served`).toEqual([env.logger, env.reader]);
        env.read(env.engine);
        expect(events.tokens.slice(3), `${name}: the target has its own event`).toEqual([env.engine]);
        expect(readKey(reader, 'logger')).toBe(viaSink);
        events.stop();
      });
    }
  }, 240_000);

  it('E20-P9 the target is disposed once, also when only an alias reached it, and no alias has a disposal slot', async () => {
    for (const cell of MATRIX) {
      await withEnv(cell, { roots: '[sink]' }, async (env) => {
        capabilityAlias(env.built);
        await ready(cell, env);
        const name = label(cell);
        env.read(env.sink);
        if (cell.mode === 'open') {
          env.read(env.logger);
          env.read(env.engine);
        }
        await call(env.box, 'destroy');
        expect(env.count('disposeEngine'), `${name}: disposed exactly once`).toBe(1);
        const destroy = slice(containerText(env.built), 'destroy(): Promise<void>', ['public resolveAll']);
        for (const id of [env.logger, env.audit, env.sink]) {
          expect(destroy, `${name}: no slot for ${shown(id)}`).not.toContain(JSON.stringify(id));
        }
      });
    }
  }, 240_000);

  it('E20-W6 a consumer of an alias is disposed before the target the alias reaches', async () => {
    for (const cell of MATRIX) {
      await withEnv(cell, { logDisposal: true }, async (env) => {
        capabilityAlias(env.built);
        await ready(cell, env);
        const name = label(cell);
        env.read(env.reader);
        await call(env.box, 'destroy');
        expect(env.built.probe.log, `${name}: the async consumer first, then the target of its alias`).toEqual(['Reader', 'Engine']);
      });
    }
  }, 240_000);

  it('E20-W12 an alias is never constructed at start, whatever a hand-built graph lists as eager', () => {
    const graph = chainGraph(1);
    graph.optimizationMode = 'closed';
    graph.publicRoots = ['A_0'];
    graph.eagerRoots = ['A_0'];
    let text = '';
    const failed = attempt(() => { text = runGenerated(new Generator(graph, true, undefined, false, false, 'reference')).text; });
    expect(failed, 'the generator accepts an eager alias without building it').toBeUndefined();
    expect(text, 'and writes no construction of it').not.toContain('create_A_0');
  });

  it('E20-W7 an alias of a token a parent provides is refused by the generator when no key can read it', () => {
    const graph = chainGraph(1);
    const anchor = graph.nodes.get('T')?.service.registrationNode;
    if (anchor === undefined) throw new Error('missing target node');
    graph.nodes.delete('T');
    graph.nodes.set('A_0', { service: aliasService('A_0', 'FromParent', anchor), dependencies: ['FromParent'] });
    graph.parentProvidedTokens = new Set(['FromParent']);
    const failed = attempt(() => runGenerated(new Generator(graph, true, undefined, false, false, 'optimized')));
    expect(failed, 'no key reads a parent token that is neither resolvable by id nor a class').toContain("Cannot read 'FromParent' from a parent/legacy container for an alias");
    graph.parentResolvableTokens = new Set(['FromParent']);
    const text = new Generator(graph, true, undefined, false, false, 'optimized').generate();
    expect(text, 'with an id, the alias reads the parent through _neoParent').toContain('this._neoParent("FromParent")');
  });

  it('E20-P10 an alias of an async target answers after initialize, and refuses before it as the target does', async () => {
    for (const cell of MATRIX.filter((candidate) => candidate.timing === 'async')) {
      await withEnv(cell, {}, async (env) => {
        capabilityAlias(env.built);
        const name = label(cell);
        const before = thrown(() => env.read(env.sink));
        const beforeTarget = thrown(() => env.read(env.engine));
        expect(before.code, `${name}: before initialize the alias refuses`).not.toBe('');
        expect(before.code, `${name}: with the code of the target`).toBe(beforeTarget.code);
        await call(env.box, 'initialize');
        const target = env.read(env.engine);
        expect(env.read(env.sink), `${name}: after initialize, the target object`).toBe(target);
        expect(env.count('asyncEngine'), `${name}: the async factory ran once`).toBe(1);
      });
    }
  }, 240_000);

  it('E20-P11 an override of the target is seen through every alias, and cleared with it', async () => {
    for (const cell of full(MATRIX)) {
      await withEnv(cell, { testOverrides: true }, async (env) => {
        capabilityAlias(env.built);
        await ready(cell, env);
        const name = label(cell);
        const real = env.read(env.engine);
        const double = { id: 'double' };
        await call(env.box, 'override', [env.engine, () => double]);
        await ready(cell, env);
        expect(env.read(env.engine), `${name}: the target`).toBe(double);
        expect(env.read(env.logger), `${name}: an alias`).toBe(double);
        expect(env.read(env.sink), `${name}: the end of the chain`).toBe(double);
        expect(readKey(env.read(env.reader), 'logger'), `${name}: a consumer`).toBe(double);
        await call(env.box, 'clearOverrides');
        await ready(cell, env);
        expect(env.read(env.sink), `${name}: cleared, the alias reads the target again`).not.toBe(double);
        expect(readKey(env.read(env.sink), 'id'), `${name}: an Engine`).toBe('engine');
        expect(real, `${name}: an Engine was built before`).toBeTruthy();
        const double2 = { id: 'double2' };
        await call(env.box, 'overrideMany', [[[env.engine, () => double2]]]);
        await ready(cell, env);
        expect(env.read(env.audit), `${name}: overrideMany of the target`).toBe(double2);
      });
    }
  }, 240_000);

  it('E20-F1 a scoped alias over a token the parent provides answers its local target, the parent keeps its own value', async () => {
    const parentText = "export const parent = defineBuilderConfig({ name: 'E20Parent', injections: [{ token: logger, useValue: { id: 'parent' } }] });";
    for (const cell of sync(MATRIX)) {
      await withEnv(cell, {
        before: parentText,
        useContainer: 'useContainer: parent,',
        aliases: '{ token: logger, useExisting: Engine, scoped: true },',
        roots: '[logger, Reader, Engine]',
      }, async (env) => {
        capabilityAlias(env.built);
        const name = label(cell);
        expect(readKey(env.read(env.logger), 'id'), `${name}: the child alias answers its local target`).toBe('engine');
        expect(readKey(env.read(env.reader), 'logger'), `${name}: a consumer of the token gets the local target`).toBe(env.read(env.engine));
        expect(readKey(use(env.built.box('parent'), 'resolve', env.logger), 'id'), `${name}: the parent keeps its own value`).toBe('parent');
      });
    }
  }, 240_000);

  it('E20-P11 an override of a target the parent provides is seen through every alias of the child, and cleared with it', async () => {
    for (const parentText of [PARENT_OPEN, PARENT_CLOSED]) {
      for (const cell of full(sync(MATRIX))) {
        await withEnv(cell, {
          target: 'none',
          before: parentText,
          useContainer: 'useContainer: parent,',
          roots: '[sink, audit, logger, Reader]',
          testOverrides: true,
        }, async (env) => {
          capabilityAlias(env.built);
          const name = `${label(cell)} ${parentText === PARENT_OPEN ? 'open parent' : 'closed parent'}`;
          const fromParent = use(env.built.box('parent'), 'resolve', env.engine);
          expect(env.read(env.sink), `${name}: before the override, the parent object`).toBe(fromParent);
          const double = { id: 'double' };
          await call(env.box, 'override', [env.engine, () => double]);
          // A closed child has no root for the parent's token: only its aliases and its consumer are read there.
          if (cell.mode === 'open') expect(env.read(env.engine), `${name}: the target`).toBe(double);
          expect(env.read(env.logger), `${name}: an alias`).toBe(double);
          expect(env.read(env.sink), `${name}: the end of the chain`).toBe(double);
          expect(readKey(env.read(env.reader), 'logger'), `${name}: a consumer`).toBe(double);
          expect(use(env.built.box('parent'), 'resolve', env.engine), `${name}: the parent keeps its own object`).toBe(fromParent);
          await call(env.box, 'clearOverrides');
          expect(env.read(env.sink), `${name}: cleared, the alias reads the parent again`).toBe(fromParent);
        });
      }
    }
  }, 240_000);

  it('E20-F3 a factory that depends on an alias of a transient builds the target once per call', async () => {
    for (const cell of sync(MATRIX)) {
      await withEnv(cell, {
        target: 'transient',
        disposable: false,
        declarations: PORT_DECLARATIONS + '\nexport class Probed { constructor(readonly engine: unknown) {} }',
        aliases: PORT_ALIASES,
        extra: '{ token: Probed, useFactory: true, dependencies: [Port], provider: (ctx) => new Probed(ctx.resolve(Port)) },',
        roots: '[logger, Port, Reader, Engine, Probed]',
      }, async (env) => {
        capabilityAlias(env.built);
        const name = label(cell);
        const probed = env.read(env.built.exports['Probed']);
        expect(readKey(readKey(probed, 'engine'), 'id'), `${name}: the factory read an Engine`).toBe('engine');
        expect(env.count('buildEngine'), `${name}: one construction for the one read the factory made`).toBe(1);
      });
    }
  }, 240_000);

  it('E20-F4 a declared factory keeps its permissions even when two tokens lead to the same target', async () => {
    const declarations = `${PORT_DECLARATIONS}
export class ViaAlias {}
export class ViaTarget {}
export class OwnToken {}
const outcome = (run: () => unknown): string => {
  try { run(); return 'ok'; } catch (error) { return String((error as { code?: unknown }).code); }
};`;
    const extra = `{ token: ViaAlias, useFactory: true, dependencies: [Port], provider: (ctx) => { probe.log.push('declares the alias, reads the target: ' + outcome(() => ctx.resolve(Engine))); return new ViaAlias(); } },
    { token: ViaTarget, useFactory: true, dependencies: [Engine], provider: (ctx) => { probe.log.push('declares the target, reads the alias: ' + outcome(() => ctx.resolve(Port))); return new ViaTarget(); } },
    { token: OwnToken, useFactory: true, dependencies: [Port], provider: (ctx) => { probe.log.push('declares the alias, reads the alias: ' + outcome(() => ctx.resolve(Port))); return new OwnToken(); } },`;
    for (const cell of sync(MATRIX)) {
      await withEnv(cell, {
        declarations,
        aliases: PORT_ALIASES,
        extra,
        roots: '[logger, Port, Reader, Engine, ViaAlias, ViaTarget, OwnToken]',
      }, async (env) => {
        capabilityAlias(env.built);
        const name = label(cell);
        for (const factory of ['ViaAlias', 'ViaTarget', 'OwnToken']) env.read(env.built.exports[factory]);
        expect(env.built.probe.log, name).toEqual([
          'declares the alias, reads the target: NEO_UNDECLARED_FACTORY_DEP',
          'declares the target, reads the alias: NEO_UNDECLARED_FACTORY_DEP',
          'declares the alias, reads the alias: ok',
        ]);
      });
    }
  }, 240_000);

  it('E20-P12 override and overrideMany refuse an alias, name its target, and change nothing', async () => {
    for (const cell of full(MATRIX)) {
      await withEnv(cell, { testOverrides: true }, async (env) => {
        capabilityAlias(env.built);
        await ready(cell, env);
        const name = label(cell);
        const first = env.read(env.sink);
        const builds = env.count('buildEngine');
        const one = await failure(() => call(env.box, 'override', [env.sink, () => ({ id: 'no' })]));
        expect(one.code, `${name}: override(alias)`).toBe(ALIAS_OVERRIDE);
        expect(one.message, `${name}: names the canonical target`).toContain("cannot override an alias: override its target 'Engine'");
        const many = await failure(() => call(env.box, 'overrideMany', [[
          [env.engine, () => ({ id: 'yes' })],
          [env.audit, () => ({ id: 'no' })],
        ]]));
        expect(many.code, `${name}: overrideMany with an alias`).toBe(ALIAS_OVERRIDE);
        expect(many.message, `${name}: names the target`).toContain("override its target 'Engine'");
        expect(env.read(env.sink), `${name}: the cached singleton is the same object`).toBe(first);
        expect(readKey(env.read(env.engine), 'id'), `${name}: the target of the batch was not overridden`).toBe('engine');
        expect(env.count('buildEngine'), `${name}: nothing was rebuilt`).toBe(builds);
        expect(env.count('disposeEngine'), `${name}: nothing was disposed`).toBe(0);
      });
    }
  }, 240_000);

  it('E20-P20 resolveMany answers the same object for an alias and its target, and a large table has rows for aliases', async () => {
    for (const cell of full(sync(MATRIX)).concat(sync(MATRIX).filter((candidate) => candidate.profile === 'minimal'))) {
      await withEnv(cell, {}, async (env) => {
        capabilityAlias(env.built);
        const name = label(cell);
        const pair = use(env.box, 'resolveMany', [env.sink, env.engine]);
        expect(Array.isArray(pair) ? pair[0] === pair[1] : false, `${name}: one object twice`).toBe(true);
      });
    }
    const total = 140;
    const classes = Array.from({ length: total }, (_, index) => `export class K${index} { readonly id = 'engine'; }`).join('\n');
    const aliases = Array.from({ length: total }, (_, index) => `{ token: K${index}, useExisting: Engine },`).join('\n    ');
    const open = CELLS.find((cell) => cell.emitter === 'optimized' && cell.mode === 'open' && cell.timing === 'sync') as Cell;
    await withEnv(open, { declarations: classes, aliases }, async (env) => {
      const first = env.built.exports['K0'];
      const node = graphOf(env.built).nodes.get(env.built.id('K0'));
      expect(readKey(node?.service, 'type'), 'K0 is an alias').toBe('alias');
      const text = containerText(env.built);
      expect(text, 'above the linear threshold the container has a shared dispatch table').toContain('__neoDispatch');
      expect(text.match(/private static __neoDispatch:[\s\S]*?return __neoTable;/)?.[0] ?? '', 'with a row for an alias').toMatch(/_get_K0/);
      expect(env.read(first), 'and the alias answers').toBe(env.read(env.engine));
    });
  }, 240_000);
});
