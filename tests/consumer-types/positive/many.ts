import {
  defineBuilderConfig,
  useInterface,
  useProperty,
  type Container,
  type CoreContainer,
  type Factory,
  type FactoryContext,
  type Token,
} from '@djodjonx/neosyringe';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Expect<T extends true> = T;
/** Inside a function a type alias would be unused: this call reads it. */
function holds<_Proof extends true>(): void {}

class Mail {
  send(): string {
    return 'sent';
  }
}

interface Clock {
  now(): number;
}

const clock = useInterface<Clock>();
const retries = useProperty<number>(Mail, 'retries');
declare const flag: boolean;

export const root = defineBuilderConfig({
  name: 'ManyRoot',
  injections: [
    { token: Mail },
    { token: clock, useFactory: true, dependencies: [], provider: () => ({ now: () => 1 }) },
    { token: retries, useFactory: true, dependencies: [], provider: () => 3 },
  ],
});

export const minimal = defineBuilderConfig({
  name: 'ManyMinimal',
  runtime: { profile: 'minimal' },
  injections: [{ token: Mail }],
});

// The root container: a tuple, a readonly tuple, a dynamic array, an empty list, a union.
const rootTuple = root.resolveMany([Mail, clock, retries]);
export type RootTuple = Expect<Equal<typeof rootTuple, [Mail, Clock, number]>>;
const frozen = [clock, Mail] as const;
const rootFrozen = root.resolveMany(frozen);
export type RootFrozen = Expect<Equal<typeof rootFrozen, [Clock, Mail]>>;
const listed: ReadonlyArray<Token<Clock>> = [clock];
const rootListed = root.resolveMany(listed);
export type RootListed = Expect<Equal<typeof rootListed, Clock[]>>;
const rootNone = root.resolveMany([]);
export type RootNone = Expect<Equal<typeof rootNone, []>>;
const either = flag ? Mail : clock;
const rootUnion = root.resolveMany([either]);
export type RootUnion = Expect<Equal<typeof rootUnion, [Mail | Clock]>>;

// A scope has the same method and the same types.
const scope = root.createScope();
const scoped = scope.resolveMany([clock, Mail]);
export type Scoped = Expect<Equal<typeof scoped, [Clock, Mail]>>;
const typedRoot: Container = root;
const throughType = typedRoot.resolveMany([Mail]);
export type ThroughType = Expect<Equal<typeof throughType, [Mail]>>;

// The minimal profile.
const minimalTuple = minimal.resolveMany([Mail]);
export type MinimalTuple = Expect<Equal<typeof minimalTuple, [Mail]>>;
const core: CoreContainer = minimal;
const coreScope = core.createScope().resolveMany([Mail, Mail]);
export type CoreScope = Expect<Equal<typeof coreScope, [Mail, Mail]>>;

// The context of a factory.
export const withContext = defineBuilderConfig({
  name: 'ManyContext',
  injections: [
    { token: Mail },
    {
      token: clock,
      useFactory: true,
      dependencies: [Mail],
      provider: (ctx) => {
        const [sender, none] = [ctx.resolveMany([Mail]), ctx.resolveMany([])];
        const [first] = sender;
        holds<Equal<typeof first, Mail>>();
        holds<Equal<typeof none, []>>();
        return { now: () => first.send().length };
      },
    },
  ],
});
const annotated: Factory<Clock> = (ctx: FactoryContext) => {
  const [mail, now] = ctx.resolveMany([Mail, clock]);
  holds<Equal<typeof mail, Mail>>();
  holds<Equal<typeof now, Clock>>();
  return now;
};
export const checkedFactory: Factory<Clock> = annotated;
