import { describe, expect, it } from 'vitest';
import { stableOrder } from '../../src/generator/LifecycleEmitter';
import { loadSource } from '../helpers/t06-run';

const STUB = `
  import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';
  declare function defineBuilderConfig<T>(config: T): T;
  declare function useInterface<T>(): T;
`;

function legacyOrder<T extends { id: string }>(
  steps: readonly T[],
  before: ReadonlyMap<string, ReadonlySet<string>>,
): T[] {
  const remaining = new Set(steps.map((step) => step.id));
  const byId = new Map(steps.map((step) => [step.id, step]));
  const ordered: T[] = [];
  while (remaining.size > 0) {
    let picked: string | undefined;
    for (const step of steps) {
      if (!remaining.has(step.id)) continue;
      const preds = before.get(step.id);
      if (!preds || [...preds].every((pred) => !remaining.has(pred))) {
        picked = step.id;
        break;
      }
    }
    if (!picked) {
      for (const step of steps) {
        if (remaining.has(step.id)) ordered.push(step);
      }
      break;
    }
    remaining.delete(picked);
    const step = byId.get(picked);
    if (step) ordered.push(step);
  }
  return ordered;
}

function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

interface Shape {
  seed: number;
  size: number;
  /** Chance of one more predecessor, tried `fan` times per step. */
  density: number;
  fan: number;
}

function corpus(shape: Shape): { steps: { id: string }[]; before: Map<string, Set<string>> } {
  const random = lcg(shape.seed);
  const steps = Array.from({ length: shape.size }, (_, index) => ({ id: `N${index}` }));
  const before = new Map<string, Set<string>>();
  const add = (id: string, pred: string): void => {
    const set = before.get(id) ?? new Set<string>();
    set.add(pred);
    before.set(id, set);
  };
  add('N1', 'N0');
  add('N2', 'N0');
  add('N3', 'N1');
  add('N3', 'N2');
  add('N4', 'external');
  add('N5', 'N6');
  add('N6', 'N5');
  for (let index = 7; index < steps.length; index += 1) {
    for (let attempt = 0; attempt < shape.fan; attempt += 1) {
      if (random() < shape.density) add(`N${index}`, `N${Math.floor(random() * index)}`);
    }
  }
  return { steps, before };
}

// Recorded shapes: six seeds, a sparse graph, a dense one, and 2000 steps.
const PARITY_SHAPES: readonly Shape[] = [
  { seed: 20261124, size: 40, density: 0.4, fan: 1 },
  { seed: 1, size: 40, density: 0.4, fan: 1 },
  { seed: 7, size: 60, density: 0.5, fan: 1 },
  { seed: 42, size: 120, density: 0.3, fan: 2 },
  { seed: 99991, size: 200, density: 0.9, fan: 4 },
  { seed: 123456789, size: 2000, density: 0.4, fan: 1 },
];

function texts(key: string): string[] {
  const value = Reflect.get(globalThis, key);
  return Array.isArray(value) ? value.map((item) => String(item)) : [];
}

describe('t13 stable order', () => {
  it('P26 B A C with B after A', async () => {
    const steps = [{ id: 'B' }, { id: 'A' }, { id: 'C' }];
    const before = new Map<string, Set<string>>([['B', new Set(['A'])]]);
    expect(stableOrder(steps, before).map((step) => step.id)).toEqual(['A', 'B', 'C']);

    const source = `
      ${STUB}
      interface InitA { n: number }
      interface InitB { n: number }
      interface InitC { n: number }
      const initA = useInterface<InitA>();
      const initB = useInterface<InitB>();
      const initC = useInterface<InitC>();
      export const box = defineBuilderConfig({
        name: 'InitOrder',
        injections: [
          {
            token: initB,
            useFactory: true,
            dependencies: [initA],
            provider: async () => {
              const slot = globalThis as { __p26?: string[] };
              (slot.__p26 ??= []).push('B');
              return { n: 2 };
            },
          },
          {
            token: initA,
            useFactory: true,
            dependencies: [],
            provider: async () => {
              const slot = globalThis as { __p26?: string[] };
              (slot.__p26 ??= []).push('A');
              return { n: 1 };
            },
          },
          {
            token: initC,
            useFactory: true,
            dependencies: [],
            provider: async () => {
              const slot = globalThis as { __p26?: string[] };
              (slot.__p26 ??= []).push('C');
              return { n: 3 };
            },
          },
        ],
      });
    `;
    Reflect.set(globalThis, '__p26', []);
    const loaded = loadSource(source);
    const opened = loaded.open('box', { emitter: 'reference' });
    try {
      await opened.container.initialize();
      expect(texts('__p26')).toEqual(['A', 'B', 'C']);
    } finally {
      await opened.container.destroy();
      Reflect.deleteProperty(globalThis, '__p26');
    }
  });

  it('P27 seeded DAGs match the old oracle', () => {
    for (const shape of PARITY_SHAPES) {
      const seeded = corpus(shape);
      const label = `seed ${shape.seed} size ${shape.size}`;
      const ordered = stableOrder(seeded.steps, seeded.before).map((step) => step.id);
      expect(ordered, label).toEqual(legacyOrder(seeded.steps, seeded.before).map((step) => step.id));
      expect(ordered, label).toHaveLength(shape.size);
    }
    expect(() => stableOrder([{ id: 'A' }, { id: 'A' }], new Map())).toThrow(/duplicate step id/);
  });

  it('P29 10000 independent steps', () => {
    const steps = Array.from({ length: 10000 }, (_, index) => ({ id: `S${index}` }));
    const stats = { visits: 0, heapOps: 0, comparisons: 0 };
    const ordered = stableOrder(steps, new Map(), stats);
    expect(ordered).toHaveLength(10000);
    expect(ordered[0]?.id).toBe('S0');
    expect(ordered[9999]?.id).toBe('S9999');
    const vertices = steps.length;
    const edges = 0;
    const bound = 3 * (vertices + edges);
    expect(stats.visits).toBeGreaterThan(0);
    expect(stats.heapOps).toBeGreaterThan(0);
    expect(stats.visits).toBeLessThanOrEqual(bound);
    expect(stats.heapOps).toBeLessThanOrEqual(bound);
    // Counted inside the heap: every comparison of a sift goes through one helper.
    expect(stats.comparisons).toBeGreaterThan(0);
    // Measured 226682 on this run. A linear scan per pop would count about 50 million.
    expect(stats.comparisons).toBeLessThanOrEqual(2 * (vertices + edges) * Math.ceil(Math.log2(vertices + 1)));
  });

  it('P30 dependents are destroyed first', async () => {
    const source = `
      ${STUB}
      interface Dep { dispose(): void }
      interface Base { dispose(): void }
      interface Ind1 { dispose(): void }
      interface Ind2 { dispose(): void }
      const dep = useInterface<Dep>();
      const base = useInterface<Base>();
      const ind1 = useInterface<Ind1>();
      const ind2 = useInterface<Ind2>();
      export const box = defineBuilderConfig({
        name: 'DestroyOrder',
        injections: [
          { token: ind1, useFactory: true, dependencies: [], provider: () => ({ dispose() { const slot = globalThis as { __p30?: string[] }; (slot.__p30 ??= []).push('I1'); } }) },
          { token: ind2, useFactory: true, dependencies: [], provider: () => ({ dispose() { const slot = globalThis as { __p30?: string[] }; (slot.__p30 ??= []).push('I2'); } }) },
          { token: dep, useFactory: true, dependencies: [base], provider: () => ({ dispose() { const slot = globalThis as { __p30?: string[] }; (slot.__p30 ??= []).push('Dep'); } }) },
          { token: base, useFactory: true, dependencies: [], provider: () => ({ dispose() { const slot = globalThis as { __p30?: string[] }; (slot.__p30 ??= []).push('Base'); } }) },
        ],
      });
    `;
    const once = async (): Promise<string[]> => {
      Reflect.set(globalThis, '__p30', []);
      const loaded = loadSource(source);
      const opened = loaded.open('box', { emitter: 'reference' });
      try {
        const graph = opened.graph;
        opened.container.resolve(loaded.token(graph, 'Base'));
        opened.container.resolve(loaded.token(graph, 'Ind2'));
        opened.container.resolve(loaded.token(graph, 'Ind1'));
        opened.container.resolve(loaded.token(graph, 'Dep'));
        await opened.container.destroy();
        return texts('__p30');
      } finally {
        Reflect.deleteProperty(globalThis, '__p30');
      }
    };
    const first = await once();
    const second = await once();
    expect(second).toEqual(first);
    expect(first.indexOf('Dep')).toBeGreaterThanOrEqual(0);
    expect(first.indexOf('Dep')).toBeLessThan(first.indexOf('Base'));
    const independents = first.filter((name) => name === 'I1' || name === 'I2');
    expect(independents).toEqual(['I2', 'I1']);
  });
});
