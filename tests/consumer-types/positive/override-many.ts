import { defineBuilderConfig, useInterface, type Container, type Token } from '@djodjonx/neosyringe';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Expect<T extends true> = T;

class Mail {
  send(): string {
    return 'sent';
  }
}

interface Clock {
  now(): number;
}

const clock = useInterface<Clock>();

export const root = defineBuilderConfig({
  name: 'OverrideManyRoot',
  injections: [
    { token: Mail },
    { token: clock, useFactory: true, dependencies: [], provider: () => ({ now: () => 1 }) },
  ],
});

// A tuple of pairs, no cast: each factory returns the value type of its token.
const done = root.overrideMany([
  [Mail, () => new Mail()],
  [clock, () => ({ now: () => 2 })],
]);
export type Done = Expect<Equal<typeof done, Promise<void>>>;

// A readonly tuple.
const frozen = [
  [Mail, () => new Mail()],
  [clock, () => ({ now: () => 3 })],
] as const;
const fromFrozen = root.overrideMany(frozen);
export type Frozen = Expect<Equal<typeof fromFrozen, Promise<void>>>;

// A union of coherent pairs is accepted.
declare const coherent: ReadonlyArray<readonly [typeof Mail, () => Mail] | readonly [Token<Clock>, () => Clock]>;
const fromUnion = root.overrideMany(coherent);
export type Union = Expect<Equal<typeof fromUnion, Promise<void>>>;

// An empty batch, and a scope.
const none = root.overrideMany([]);
export type None = Expect<Equal<typeof none, Promise<void>>>;
const scope = root.createScope();
const scoped = scope.overrideMany([[Mail, () => new Mail()]]);
export type Scoped = Expect<Equal<typeof scoped, Promise<void>>>;
const typedRoot: Container = root;
const throughType = typedRoot.overrideMany([[clock, () => ({ now: () => 4 })]]);
export type ThroughType = Expect<Equal<typeof throughType, Promise<void>>>;
