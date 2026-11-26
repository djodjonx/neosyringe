import {
  defineBuilderConfig,
  useInterface,
  type Alias,
  type Container,
  type CoreContainer,
  type Token,
} from '@djodjonx/neosyringe';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Expect<T extends true> = T;

interface Logger {
  id: string;
}
interface Named {
  id: string;
  name: string;
}
interface Counter {
  total: number;
}

class Console implements Named {
  id = 'console';
  name = 'console';
}
class Clock {
  total = 1;
}

const logger = useInterface<Logger>();
const named = useInterface<Named>();
const counter = useInterface<Counter>();

// A target whose value is assignable to the value of the alias token: the same type, a subtype, a class token.
export const root = defineBuilderConfig({
  name: 'AliasRoot',
  injections: [
    { token: Console },
    { token: Clock },
    { token: logger, useExisting: Console },
    { token: named, useExisting: Console },
    { token: counter, useExisting: Clock },
  ],
});
export type Root = Expect<Equal<typeof root, Container>>;

const viaAlias: Logger = root.resolve(logger);
const viaNamed: Named = root.resolve(named);
const both = root.resolveMany([logger, named, Console]);
export type Both = Expect<Equal<typeof both, [Logger, Named, Console]>>;
void viaAlias;
void viaNamed;

// An alias of an alias, a scoped alias, and an alias in a minimal container.
export const chained = defineBuilderConfig({
  name: 'AliasChain',
  injections: [
    { token: Console },
    { token: named, useExisting: Console },
    { token: logger, useExisting: named },
    { token: counter, useExisting: Clock, scoped: true },
    { token: Clock },
  ],
});
export type Chained = Expect<Equal<typeof chained, Container>>;

export const lean = defineBuilderConfig({
  name: 'AliasLean',
  runtime: { profile: 'minimal' },
  optimization: { mode: 'closed', roots: [logger] },
  injections: [{ token: Console }, { token: logger, useExisting: Console }],
});
export type Lean = Expect<Equal<typeof lean, CoreContainer>>;

// The helper type names the shape and checks the same relation.
export const same: Alias<typeof logger, typeof Console> = { token: logger, useExisting: Console };
export const wide: Alias<typeof logger, typeof named> = { token: logger, useExisting: named };
export const tokens: readonly Token<unknown>[] = [same.token, wide.useExisting];
