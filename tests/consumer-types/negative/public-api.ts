import type {
  Alias,
  BoundContainer,
  ContainerFor,
  InterfaceToken,
  PropertyToken,
} from '@djodjonx/neosyringe';

// The refused lines of the public-API fixture of the topic pack (implementation/checks/public-api.fixture.ts), on the
// names of the product. Each line is a diagnostic pinned in expected-diagnostic.txt. The valid lines are in the
// positive fixture of the same name. Not ported: `construct` (the product exports no such
// helper).

class Service {
  constructor(readonly label: string) {}
}
class Other {
  readonly other = 1;
}

declare const request: InterfaceToken<{ requestId: string }>;
declare const count: PropertyToken<number>;
declare const unexpected: InterfaceToken<{ tenant: string }>;
declare const full: BoundContainer;
declare const minimal: BoundContainer<readonly [], 'minimal'>;
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

// A wrong value for the token.
full.overrideMany([[count, () => 'wrong']]);
// The minimal profile has no overrides.
minimal.overrideMany([]);
// Not a token.
full.resolveMany([42]);
// The unbound template resolves nothing.
template.resolve(Service);
// A scope asks for its values again.
scope.createScope();
// A missing input.
template.createScope({ values: [{ token: count, useValue: 2 }] });
// A wrong input type.
template.createScope({
  values: [
    { token: count, useValue: 'two' },
    { token: request, useValue: { requestId: 'r' } },
  ],
});
// An unknown input.
template.createScope({
  values: [
    { token: count, useValue: 2 },
    { token: request, useValue: { requestId: 'r' } },
    { token: unexpected, useValue: { tenant: 'x' } },
  ],
});
// The bound profile stays minimal.
newScope.override(Service, () => new Service('x'));
// An alias whose target has not the value of the token.
export const alias: Alias<typeof Service, typeof Other> = { token: Service, useExisting: Other };

type BadOverrideUnion =
  | readonly [typeof count, () => { requestId: string }]
  | readonly [typeof request, () => number];
declare const badOverrideUnion: readonly BadOverrideUnion[];
// Each union member must keep its token/factory correlation.
full.overrideMany(badOverrideUnion);
type BadInputUnion =
  | { readonly token: typeof count; readonly useValue: { requestId: string } }
  | { readonly token: typeof request; readonly useValue: number };
declare const badInputUnion: readonly BadInputUnion[];
// Each union member must keep its token/value correlation.
template.createScope({ values: badInputUnion });
