import { beforeAll, describe, expect, it } from 'vitest';
import { GraphValidator } from '../../src/generator/GraphValidator';
import { warmLibCache } from '../fastProgram';
import {
  CORPUS_SEEDS,
  cycleCode,
  longRing,
  pinnedUndefined,
  runModel,
  scenarioFor,
  type ModelService,
} from '../helpers/t06-model';
import { EMITTERS, loadSource, runScenario } from '../helpers/t06-run';

const STUB = `
  import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';
  declare function defineBuilderConfig<T>(config: T): T;
  declare function useInterface<T>(): T;
`;

const CYCLE = `
  ${STUB}
  interface CycA {}
  interface CycB {}
  const cycA = useInterface<CycA>();
  const cycB = useInterface<CycB>();
  export const cycleBox = defineBuilderConfig({
    name: 'T06Cycle',
    injections: [
      { token: cycA, useFactory: true, dependencies: [cycB], provider: (ctx) => ctx.resolve(cycB) },
      { token: cycB, useFactory: true, dependencies: [cycA], provider: (ctx) => ctx.resolve(cycA) },
    ],
  });
`;

const MULTI = `
  ${STUB}
  interface MultiHost {}
  interface MultiItem {}
  const multiHost = useInterface<MultiHost>();
  const multiItem = useInterface<MultiItem>();
  export const multiBox = defineBuilderConfig({
    name: 'T06MultiCycle',
    injections: [
      {
        token: multiHost,
        useFactory: true,
        dependencies: [{ all: multiItem }],
        provider: (ctx) => ctx.resolveAll(multiItem),
      },
      {
        token: multiItem,
        useFactory: true,
        multi: true,
        dependencies: [multiHost],
        provider: () => ({ n: 1 }),
      },
    ],
  });
`;

function ringSource(size: number): string {
  const ifaces: string[] = [];
  const decls: string[] = [];
  const injections: string[] = [];
  for (let index = 0; index < size; index += 1) {
    const name = `R${index}`;
    const next = `R${(index + 1) % size}`;
    ifaces.push(`interface ${name} { n: number }`);
    decls.push(`const ${name}Token = useInterface<${name}>();`);
    injections.push(
      `{ token: ${name}Token, useFactory: true, dependencies: [${next}Token], provider: (ctx) => ctx.resolve(${next}Token) }`,
    );
  }
  return `${STUB}
    ${ifaces.join('\n    ')}
    ${decls.join('\n    ')}
    export const ringBox = defineBuilderConfig({
      name: 'T06Ring',
      injections: [
        ${injections.join(',\n        ')}
      ],
    });
  `;
}

const MUTUAL: readonly ModelService[] = [
  { name: 'Na', kind: 'singleton', value: 1, borrowed: false, disposable: false, deps: ['Nb'] },
  { name: 'Nb', kind: 'singleton', value: 2, borrowed: false, disposable: false, deps: ['Na'] },
];

describe('T06 lifecycle corpus', () => {
  beforeAll(() => {
    warmLibCache();
  });

  it('L10 corpus seeds', async () => {
    const cyclic = loadSource(CYCLE);
    const cycleGraph = cyclic.graph('cycleBox');
    expect(cycleGraph.errors ?? []).toEqual([]);
    const cycleErrors = new GraphValidator().validateAll(cycleGraph).errors;
    expect(cycleErrors.some((error) => error.code === 'NEO_CYCLE')).toBe(true);
    expect(cycleCode(MUTUAL)).toBe('NEO_CYCLE');
    expect(cycleCode(longRing(2000))).toBe('NEO_CYCLE');

    const multi = loadSource(MULTI);
    const checked = new GraphValidator().validateAll(multi.graph('multiBox'));
    // Topic 13: the multi cycle is now detected by GraphValidator.
    expect(checked.errors.some((error) => error.code === 'NEO_CYCLE')).toBe(true);

    const scenarios = CORPUS_SEEDS.map((seed) => scenarioFor(seed));
    expect(scenarios.some((scenario) => scenario.profile === 'minimal')).toBe(true);
    expect(scenarios.some((scenario) => scenario.mode === 'closed')).toBe(true);
    expect(scenarios.some((scenario) => scenario.services.some((service) => service.value === undefined))).toBe(true);
    expect(scenarios.some((scenario) => scenario.services.some((service) => (
      service.disposable && (service.borrowed || service.kind === 'transient')
    )))).toBe(true);
    const opTexts = scenarios.map((scenario) => JSON.stringify(scenario.ops));
    expect(new Set(opTexts).size).toBe(opTexts.length);

    for (const seed of CORPUS_SEEDS) {
      const scenario = scenarioFor(seed);
      const model = runModel(scenario);
      const label = `seed ${seed} ${scenario.profile} ${scenario.mode}`;
      for (const emitter of EMITTERS) {
        const product = await runScenario(scenario, emitter);
        expect(product.events, `${label} ${emitter} events`).toEqual(model.events);
        expect(product.constructs, `${label} ${emitter} constructs`).toEqual(model.constructs);
        expect(product.disposals, `${label} ${emitter} disposals`).toEqual(model.disposals);
      }
    }
  });

  it('L10 long ring rejected by the product', () => {
    for (const depth of [100, 500, 1000]) {
      const loaded = loadSource(ringSource(depth));
      const graph = loaded.graph('ringBox');
      const errors = new GraphValidator().validateAll(graph).errors;
      expect(errors.some((error) => error.code === 'NEO_CYCLE'), `depth ${depth}`).toBe(true);
    }
  }, 60_000);

  it('L10 seed 7 undefined singleton reference', async () => {
    const scenario = pinnedUndefined();
    const model = runModel(scenario);
    const product = await runScenario(scenario, 'reference');
    expect(model.events.some((event) => event.value === 'undefined')).toBe(true);
    expect(product.events).toEqual(model.events);
    expect(product.constructs).toEqual(model.constructs);
    expect(product.disposals).toEqual(model.disposals);
  });
});
