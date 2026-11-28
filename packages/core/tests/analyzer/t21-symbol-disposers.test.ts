import { describe, expect, it } from 'vitest';
import type { AnalysisError, DependencyGraph } from '../../src/analyzer/types';
import { analyse, readKey, serviceIn } from '../helpers/t21-build';

/**
 * T21 D5, static detection. A class, an interface or a factory result releases itself through a symbol-keyed method
 * when the checker says the key is `Symbol.dispose` or `Symbol.asyncDispose` of the lib: the symbol is compared, never
 * the text of the name. Every test starts with a control that must be a symbol disposer (`symbolDisposer` is the flag
 * the analysis sets), then reads what the analysis says of the cases under test.
 */

const CODE = 'NEO_DISPOSABLE_TRANSIENT_CAPTURED';

interface Flags {
  sync: unknown;
  async: unknown;
  symbol: unknown;
}

function flagsOf(graphs: readonly DependencyGraph[], container: string, name: string): Flags {
  const service = serviceIn(graphs, container, name);
  return {
    sync: readKey(service, 'isDisposable'),
    async: readKey(service, 'isAsyncDisposable'),
    symbol: readKey(service, 'symbolDisposer'),
  };
}

function captured(graphs: readonly DependencyGraph[], container: string): AnalysisError[] {
  const graph = graphs.find((candidate) => candidate.containerName === container);
  return (graph?.errors ?? []).filter((error) => error.code === CODE);
}

const EXTERNAL = new Map([['ext.d.ts', 'export declare class Ext { [Symbol.dispose](): void }\n']]);

describe('T21-P14 D5 a symbol-keyed disposer is found through the checker', () => {
  const source = `
import { Ext } from './ext';
export class Own { [Symbol.dispose](): void {} }
export class Base { async [Symbol.asyncDispose](): Promise<void> {} }
export class Inherited extends Base {}
export class Slot { [Symbol.dispose]: () => void = () => undefined; }
export class Maybe { [Symbol.dispose]?(): void {} }
interface Shaped { [Symbol.dispose](): void }
interface Anything { id: string }
const shaped = useInterface<Shaped>();
const fromReturn = useInterface<Anything>();
export const box = defineBuilderConfig({
  name: 'Positive',
  injections: [
    { token: Own },
    { token: Inherited },
    { token: Slot },
    { token: Maybe },
    { token: Ext },
    { token: shaped, useFactory: true, dependencies: [], lifecycle: 'transient', provider: (): object => ({ [Symbol.dispose](): void {} }) },
    { token: fromReturn, useFactory: true, dependencies: [], lifecycle: 'transient', provider: () => new Own() },
  ],
});
`;

  it('T21-P14 own, inherited, property-typed, optional and declaration-file members, an interface token and a transient factory result are flagged', () => {
    const graphs = analyse(source, EXTERNAL);
    expect(flagsOf(graphs, 'Positive', 'Own').symbol, 'Own is a symbol disposer').toBe(true);
    expect(flagsOf(graphs, 'Positive', 'Own')).toEqual({ sync: true, async: undefined, symbol: true });
    expect(flagsOf(graphs, 'Positive', 'Inherited')).toEqual({ sync: undefined, async: true, symbol: true });
    expect(flagsOf(graphs, 'Positive', 'Slot')).toEqual({ sync: true, async: undefined, symbol: true });
    expect(flagsOf(graphs, 'Positive', 'Maybe')).toEqual({ sync: true, async: undefined, symbol: true });
    expect(flagsOf(graphs, 'Positive', 'Ext')).toEqual({ sync: true, async: undefined, symbol: true });
    expect(flagsOf(graphs, 'Positive', 'Shaped')).toEqual({ sync: true, async: undefined, symbol: true });
    expect(flagsOf(graphs, 'Positive', 'Anything')).toEqual({ sync: true, async: undefined, symbol: true });
  });
});

describe('T21-P15 D5 what only looks like a symbol disposer is not one', () => {
  const source = `
declare const fake: { readonly dispose: unique symbol };
export class Control { [Symbol.dispose](): void {} }
export class Named { 'Symbol.dispose'(): void {} }
export class Fake { [fake.dispose](): void {} }
export class Iterating { [Symbol.iterator](): Iterator<number> { return [][Symbol.iterator](); } }
export class Stored { [Symbol.dispose]: number = 1; }
export const box = defineBuilderConfig({
  name: 'Negative',
  injections: [{ token: Control }, { token: Named }, { token: Fake }, { token: Iterating }, { token: Stored }],
});
`;

  it('T21-P15 a string name, a foreign unique symbol, another well-known symbol and a non-callable member are not flagged', () => {
    const graphs = analyse(source);
    expect(flagsOf(graphs, 'Negative', 'Control').symbol, 'the control is a symbol disposer').toBe(true);
    for (const name of ['Named', 'Fake', 'Iterating', 'Stored']) {
      expect(flagsOf(graphs, 'Negative', name), name).toEqual({ sync: undefined, async: undefined, symbol: undefined });
    }
  });
});

describe('T21-P15 D5 without the disposable lib the symbols do not exist for the checker', () => {
  it('T21-P15 a lib that declares no Symbol.dispose finds no symbol disposer, and dispose() is still found', () => {
    const source = `
export class Control { dispose(): void {} }
export class Keyed { [Symbol.dispose](): void {} }
export const box = defineBuilderConfig({ name: 'NoLib', injections: [{ token: Control }, { token: Keyed }] });
`;
    const graphs = analyse(source, new Map(), ['lib.es2022.d.ts']);
    expect(flagsOf(graphs, 'NoLib', 'Control')).toEqual({ sync: true, async: undefined, symbol: undefined });
    expect(flagsOf(graphs, 'NoLib', 'Keyed')).toEqual({ sync: undefined, async: undefined, symbol: undefined });
  });
});

describe('T21-P16 D5 the static priority is the runtime priority', () => {
  const source = `
export class Control { async [Symbol.asyncDispose](): Promise<void> {} }
export class Both { dispose(): void {} async [Symbol.asyncDispose](): Promise<void> {} }
export class Weak { dispose: number = 1; [Symbol.dispose](): void {} }
export class Pair { async [Symbol.asyncDispose](): Promise<void> {} [Symbol.dispose](): void {} }
export const box = defineBuilderConfig({
  name: 'Priority',
  injections: [{ token: Control }, { token: Both }, { token: Weak }, { token: Pair }],
});
`;

  it('T21-P16 dispose() wins over a symbol, a non-callable dispose gives way to one, asyncDispose wins over dispose', () => {
    const graphs = analyse(source);
    expect(flagsOf(graphs, 'Priority', 'Control').symbol, 'the control is a symbol disposer').toBe(true);
    expect(flagsOf(graphs, 'Priority', 'Both')).toEqual({ sync: true, async: undefined, symbol: undefined });
    expect(flagsOf(graphs, 'Priority', 'Weak')).toEqual({ sync: true, async: undefined, symbol: true });
    expect(flagsOf(graphs, 'Priority', 'Pair')).toEqual({ sync: undefined, async: true, symbol: true });
  });
});

describe('T21-P17 D5 a disposable transient captured by a singleton is reported for the symbol protocols', () => {
  const source = `
export class SyncConn { [Symbol.dispose](): void {} }
export class AsyncConn { async [Symbol.asyncDispose](): Promise<void> {} }
export class Lookalike { 'Symbol.dispose'(): void {} }
export class SyncUse { constructor(readonly conn: SyncConn) {} }
export class AsyncUse { constructor(readonly conn: AsyncConn) {} }
export class LookUse { constructor(readonly conn: Lookalike) {} }
interface Made { id: string }
interface MadeUse { made: Made }
const made = useInterface<Made>();
const madeUse = useInterface<MadeUse>();
export const syncBox = defineBuilderConfig({
  name: 'SyncBox',
  injections: [{ token: SyncConn, lifecycle: 'transient' }, { token: SyncUse }],
});
export const asyncBox = defineBuilderConfig({
  name: 'AsyncBox',
  injections: [{ token: AsyncConn, lifecycle: 'transient' }, { token: AsyncUse }],
});
export const factoryBox = defineBuilderConfig({
  name: 'FactoryBox',
  injections: [
    { token: made, useFactory: true, dependencies: [], lifecycle: 'transient', provider: () => new SyncConn() },
    { token: madeUse, useFactory: true, dependencies: [made], provider: (context) => ({ made: context.resolve(made) }) },
  ],
});
export const lookBox = defineBuilderConfig({
  name: 'LookBox',
  injections: [{ token: Lookalike, lifecycle: 'transient' }, { token: LookUse }],
});
`;

  it('T21-P17 a transient with [Symbol.dispose], with [Symbol.asyncDispose] or built by a factory is refused; a lookalike is not', () => {
    const graphs = analyse(source);
    expect(captured(graphs, 'SyncBox'), 'SyncBox').toHaveLength(1);
    expect(captured(graphs, 'AsyncBox'), 'AsyncBox').toHaveLength(1);
    expect(captured(graphs, 'FactoryBox'), 'FactoryBox').toHaveLength(1);
    expect(captured(graphs, 'LookBox'), 'LookBox').toHaveLength(0);
  });
});
