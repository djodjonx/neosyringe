import { describe, expect, it } from 'vitest';
import { build, HEAD, type Emitter } from '../helpers/e17-build';
import { checkStrict, emitCase, formatDiagnostic, unsafeTypesMessage, type EmissionCase } from '../helpers/t23-program';

/**
 * C1 (stage F, compile-time overhead of the disposal slots, docs/benchmarks/stage-f-compile-overhead.md). Each disposal
 * slot of `destroy()` used to inline the whole protocol (the borrowed and seen checks, the choice of the disposer, the
 * observed begin and end), so a graph of 100 disposable services wrote that block 100 times. The first shrink moved the
 * whole protocol into one member that every slot called, and that made the `.dispose()` call site megamorphic: `destroy()`
 * of a 100-service container cost 1.75 times what it did (measured by the orchestrator, same document). The slot is now
 * short and keeps its own call: the read of the instance and the borrowed and seen checks are one private member
 * (`_neoTake`, it calls no user code), the call of `dispose()` stays at the slot, and only the rare tail (a promise the
 * disposer returned) is a small member. The tests read the emitted text of both emitters, for a sync and an async graph,
 * observed or not, and pin: the member is declared once, a slot calls `dispose()` itself and stays short, no slot
 * calls a shared member that holds the `dispose()` call, no member in a graph without a slot.
 */

const SIZE = 100;
const EMITTER_LIST: readonly Emitter[] = ['reference', 'optimized'];

/** `SIZE` services: the even ones are classes with `dispose()`, the odd ones factories whose value has one. */
function disposableSource(options: { async: boolean; observation?: boolean }): string {
  const lines: string[] = [HEAD];
  const injections: string[] = [];
  for (let index = 0; index < SIZE; index += 1) {
    if (index % 2 === 0) {
      lines.push(`export class S${index} { dispose(): void {} }`);
      injections.push(`{ token: S${index} }`);
    } else {
      lines.push(`interface F${index} { dispose(): void }`, `const f${index} = useInterface<F${index}>();`);
      injections.push(`{ token: f${index}, useFactory: true, dependencies: [], provider: () => ({ dispose() {} }) }`);
    }
  }
  if (options.async) {
    lines.push('interface Wait { ready: boolean }', 'const wait = useInterface<Wait>();');
    injections.push('{ token: wait, useFactory: true, dependencies: [], provider: async () => ({ ready: true }) }');
  }
  lines.push(`export const box = defineBuilderConfig({ name: 'Flat', injections: [\n  ${injections.join(',\n  ')}\n] });`);
  return lines.join('\n');
}

function occurrences(text: string, pattern: RegExp): number {
  return text.match(pattern)?.length ?? 0;
}

/** The lines of `destroy()` that write one slot: each reads its instance through `_neoTake`. */
function slotLines(text: string): string[] {
  return text.split('\n').filter((line) => line.includes('this._neoTake('));
}

describe('C1 a disposal slot is short and keeps its own dispose() call', () => {
  for (const emitter of EMITTER_LIST) {
    for (const timing of ['sync', 'async'] as const) {
      for (const observation of [false, true]) {
        it(`C1 ${SIZE} slots write ${SIZE} short slots that call dispose() themselves, and one _neoTake (${emitter}, ${timing} graph, observation ${observation ? 'on' : 'off'})`, () => {
          const built = build(disposableSource({ async: timing === 'async' }), { emitter, observation });
          const text = built.generated[0] ?? '';
          expect(text, 'the shared slot member is gone').not.toContain('_neoDisposeSlot');
          expect(occurrences(text, /private _neoTake\(/g), 'the read of the instance is declared once').toBe(1);
          const lines = slotLines(text);
          // An async graph has one more slot: its async factory is a guarded one (its value may hold a disposer).
          expect(lines.length, 'one slot per service').toBe(SIZE + (timing === 'async' ? 1 : 0));
          let inline = 0;
          let asking = 0;
          for (const line of lines) {
            expect(line.trim().length, line.trim()).toBeLessThanOrEqual(observation ? 480 : 320);
            // The call is at the slot: a guarded slot asks the container for its disposer, the others call `dispose()`.
            expect(line.includes('.dispose()') || line.includes('this._neoDisposer('), line.trim()).toBe(true);
            if (line.includes('.dispose()')) inline += 1;
            if (line.includes('this._neoDisposer(')) asking += 1;
          }
          // The even services are classes with `dispose()`, the odd ones factories (and the async graph has one more).
          expect(inline, 'every class slot calls dispose() itself').toBe(SIZE / 2);
          expect(asking, 'every factory slot asks for its disposer').toBe(SIZE / 2 + (timing === 'async' ? 1 : 0));
        });
      }
    }

    it(`C1 a graph with no disposal slot has no member (${emitter})`, () => {
      const source = `${HEAD}
export class Plain { readonly value = 1; }
export const box = defineBuilderConfig({ name: 'Plain', injections: [{ token: Plain }] });
`;
      const text = build(source, { emitter }).generated[0] ?? '';
      expect(text).not.toContain('_neoTake');
      expect(text).not.toContain('_neoDisposeSlot');
    });
  }
});

const STUB = `
  import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';
  declare function defineBuilderConfig<T>(config: T): T;
  declare function useInterface<T>(): T;
`;

/** Only `dispose()` classes: no slot may hold a symbol disposer, so no slot asks `_neoDisposer`. */
const UNGUARDED = `${STUB}
  export class C1Leaf { dispose(): void {} }
  export class C1Other { dispose(): void {} }
  export const box = defineBuilderConfig({ name: 'C1Unguarded', injections: [{ token: C1Leaf }, { token: C1Other }] });
`;

/** A `dispose()` class, a symbol-only class, a factory and an async-disposable class: every kind of slot. */
function mixed(async: boolean): string {
  return `${STUB}
  export class C1Leaf { dispose(): void {} }
  export class C1Sym { [Symbol.dispose](): void {} }
  export class C1Late { async [Symbol.asyncDispose](): Promise<void> {} }
  interface C1Made { n: number }
  const made = useInterface<C1Made>();
  ${async ? 'interface C1Wait { ok: boolean }\n  const wait = useInterface<C1Wait>();' : ''}
  export const box = defineBuilderConfig({
    name: 'C1Mixed',
    injections: [
      { token: C1Leaf },
      { token: C1Sym },
      { token: C1Late },
      { token: made, useFactory: true, dependencies: [], provider: () => ({ n: 1 }) },
      ${async ? '{ token: wait, useFactory: true, dependencies: [], provider: async () => ({ ok: true }) },' : ''}
    ],
  });
`;
}

function floorCase(name: string, source: string, observation: boolean): EmissionCase {
  return { name, profile: 'full', source, testOverrides: true, parent: false, observation };
}

const CONSUMER = `import { box } from './box.out.ts';\nexport const touch = (): unknown => box;\n`;

describe('C1 the shared members type-check at lib es2021 and holds no unsafe type', () => {
  for (const emitter of EMITTER_LIST) {
    for (const observation of [false, true]) {
      const cells: readonly EmissionCase[] = [
        floorCase('c1 unguarded only', UNGUARDED, observation),
        floorCase('c1 mixed sync', mixed(false), observation),
        floorCase('c1 mixed async', mixed(true), observation),
      ];
      for (const item of cells) {
        it(`C1-floor ${emitter}, ${item.name}, observation ${observation ? 'on' : 'off'}: the member is there, no diagnostic, no unsafe type`, () => {
          const emitted = emitCase(item, emitter);
          const code = emitted.outputs[0]?.code ?? '';
          // With test overrides the reconfiguration reads its instances through the same member: it is still declared once.
          expect(occurrences(code, /private _neoTake\(/g)).toBe(1);
          const input = { ...emitted.input, consumer: { file: 'consumer.ts', code: CONSUMER }, lib: ['lib.es2021.d.ts'] as const };
          expect(checkStrict(input).map(formatDiagnostic)).toEqual([]);
          expect(unsafeTypesMessage(code, 'box.out.ts')).toBe('');
        });
      }
    }
  }
});
