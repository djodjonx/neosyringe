import { describe, expect, it } from 'vitest';
import { build, HEAD, type Emitter } from '../helpers/e17-build';
import { checkStrict, emitCase, formatDiagnostic, unsafeTypesMessage, type EmissionCase } from '../helpers/t23-program';

/**
 * C1 (stage F, compile-time overhead of the disposal slots, docs/benchmarks/stage-f-compile-overhead.md). Each disposal
 * slot of `destroy()` used to inline the whole protocol (the borrowed and seen checks, the choice of the disposer, the
 * observed begin and end), so a graph of 100 disposable services wrote that block 100 times. The protocol is one private
 * member of the generated class, `_neoDisposeSlot`, and a slot is one short call of it. The tests read the emitted text
 * of both emitters, for a sync and an async graph, observed or not, and pin: one declaration of the member, one call per
 * slot, a short call, no member in a graph without a slot.
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

function slotCalls(text: string): string[] {
  return text.split('\n').filter((line) => line.includes('this._neoDisposeSlot('));
}

describe('C1 a disposal slot is a call of one shared member', () => {
  for (const emitter of EMITTER_LIST) {
    for (const timing of ['sync', 'async'] as const) {
      for (const observation of [false, true]) {
        it(`C1 ${SIZE} slots write ${SIZE} short calls and one member (${emitter}, ${timing} graph, observation ${observation ? 'on' : 'off'})`, () => {
          const built = build(disposableSource({ async: timing === 'async' }), { emitter, observation });
          const text = built.generated[0] ?? '';
          expect(occurrences(text, /private _neoDisposeSlot\(/g), 'the member is declared once').toBe(1);
          const calls = slotCalls(text);
          // An async graph has one more slot: its async factory is a guarded one (its value may hold a disposer).
          expect(occurrences(text, /this\._neoDisposeSlot\(/g), 'one call per slot').toBe(SIZE + (timing === 'async' ? 1 : 0));
          // A slot is a call and nothing else: the protocol is not written again at the slot.
          for (const line of calls) {
            expect(line.trim().length, line.trim()).toBeLessThanOrEqual(observation ? 130 : 100);
            expect(line).not.toContain('__neoInst');
            expect(line).not.toContain('.dispose()');
          }
        });
      }
    }

    it(`C1 a graph with no disposal slot has no member (${emitter})`, () => {
      const source = `${HEAD}
export class Plain { readonly value = 1; }
export const box = defineBuilderConfig({ name: 'Plain', injections: [{ token: Plain }] });
`;
      const text = build(source, { emitter }).generated[0] ?? '';
      expect(text).not.toContain('_neoDisposeSlot');
    });
  }
});

const STUB = `
  import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';
  declare function defineBuilderConfig<T>(config: T): T;
  declare function useInterface<T>(): T;
`;

/** Only `dispose()` classes: no slot may hold a symbol disposer, so the member has no `guarded` parameter. */
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

describe('C1 the shared member type-checks at lib es2021 and holds no unsafe type', () => {
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
          // With test overrides the reconfiguration disposes through the same member: it is still declared once.
          expect(occurrences(code, /private _neoDisposeSlot\(/g)).toBe(1);
          const input = { ...emitted.input, consumer: { file: 'consumer.ts', code: CONSUMER }, lib: ['lib.es2021.d.ts'] as const };
          expect(checkStrict(input).map(formatDiagnostic)).toEqual([]);
          expect(unsafeTypesMessage(code, 'box.out.ts')).toBe('');
        });
      }
    }
  }
});
