import type {
  Alias,
  BoundContainer,
  ContainerFor,
  FactoryContext,
  InterfaceToken,
  PropertyToken,
  Token,
} from '@djodjonx/neosyringe';

// Port of the public-API fixture of the topic pack (implementation/checks/public-api.fixture.ts) to the names of the
// product: ProposedContainerFor is ContainerFor, ProposedContext is FactoryContext, the profiles of ProposedCore are
// CoreContainer and BoundContainer<I, 'minimal'>, ProposedFull is Container. Only the valid lines are here; the
// refused ones are in the negative fixture of the same name. Not ported: `construct` (the product exports no such
// helper).

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;
type IsUnsafe<T> = 0 extends 1 & T ? true : false;

class Service {
  constructor(readonly label: string) {}
}
class Wide extends Service {
  readonly extra = 1;
}

declare const request: InterfaceToken<{ requestId: string }>;
declare const count: PropertyToken<number>;
declare const full: BoundContainer;
declare const minimal: BoundContainer<readonly [], 'minimal'>;
declare const context: FactoryContext;

const values = full.resolveMany([Service, count]);
export type Tuple = Assert<Equal<typeof values, [Service, number]>>;
export type Safe = Assert<Equal<IsUnsafe<(typeof values)[0]>, false>>;
full.overrideMany([
  [Service, () => new Service('mock')],
  [count, () => 3],
]);

const lean = minimal.resolveMany([Service, count]);
export type Lean = Assert<Equal<typeof lean, [Service, number]>>;

const ctx = context.resolveMany([Service, count]);
export type ContextTuple = Assert<Equal<typeof ctx, [Service, number]>>;

declare const template: ContainerFor<{
  scopeInputs: readonly [typeof request, typeof count];
  runtime: { profile: 'minimal' };
}>;
const scope = template.createScope({
  values: [
    { token: count, useValue: 2 },
    { token: request, useValue: { requestId: 'r1' } },
  ],
});
const newScope = scope.createScope({
  values: [
    { token: request, useValue: { requestId: 'r2' } },
    { token: count, useValue: 3 },
  ],
});
full.createScope();
const safeClass: Token<Service> = Service;

// An alias of the same type, and of a subtype.
export const sameAlias: Alias<typeof Service, typeof Service> = { token: Service, useExisting: Service };
export const wideAlias: Alias<typeof Service, typeof Wide> = { token: Service, useExisting: Wide };
void safeClass;
void values;
void ctx;
void scope;
void newScope;

type GoodOverrideUnion =
  | readonly [typeof count, () => number]
  | readonly [typeof request, () => { requestId: string }];
declare const goodOverrideUnion: readonly GoodOverrideUnion[];
full.overrideMany(goodOverrideUnion);
type GoodInputUnion =
  | { readonly token: typeof count; readonly useValue: number }
  | { readonly token: typeof request; readonly useValue: { requestId: string } };
declare const goodInputUnion: readonly GoodInputUnion[];
template.createScope({ values: goodInputUnion });
