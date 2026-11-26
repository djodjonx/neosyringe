import {
  defineBuilderConfig,
  useInterface,
  useProperty,
  type BoundContainer,
  type Container,
  type ContainerTemplate,
} from '@djodjonx/neosyringe';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Expect<T extends true> = T;

interface Request {
  id: string;
  tenant: string;
}

class Handler {
  retries = 0;
}

const request = useInterface<Request>();
const retries = useProperty<number>(Handler, 'retries');

export const requests = defineBuilderConfig({
  name: 'ScopeInputsRoot',
  scopeInputs: [request, retries],
  injections: [{ token: Handler }],
});

// The values are given in any order, no cast: each pair is checked against the token it names.
const forward = requests.createScope({
  values: [
    { token: request, useValue: { id: 'r1', tenant: 'acme' } },
    { token: retries, useValue: 3 },
  ],
});
const reversed = requests.createScope({
  values: [
    { token: retries, useValue: 3 },
    { token: request, useValue: { id: 'r2', tenant: 'acme' } },
  ],
});
const fromRead = forward.resolve(request);
export type Read = Expect<Equal<typeof fromRead, Request>>;
const handler = reversed.resolve(Handler);
export type Built = Expect<Equal<typeof handler, Handler>>;

// A bound scope has the API of its profile and asks for its values again.
const asBound: BoundContainer<readonly [typeof request, typeof retries], 'full'> = forward;
const nested = asBound.createScope({
  values: [
    { token: request, useValue: { id: 'r3', tenant: 'acme' } },
    { token: retries, useValue: 1 },
  ],
});
const overridden: Promise<void> = nested.override(Handler, () => new Handler());

// The model exposes createScope and destroy.
const template: ContainerTemplate<readonly [typeof request, typeof retries], 'full'> = requests;
const closed: Promise<void> = template.destroy();

// A minimal profile with inputs has the core API only.
export const lean = defineBuilderConfig({
  name: 'ScopeInputsLean',
  runtime: { profile: 'minimal' },
  scopeInputs: [request],
  injections: [{ token: Handler }],
});
const leanScope = lean.createScope({ values: [{ token: request, useValue: { id: 'r4', tenant: 'acme' } }] });
const leanRead = leanScope.resolve(request);
export type LeanRead = Expect<Equal<typeof leanRead, Request>>;

// A container with no input keeps its plain API.
export const plain = defineBuilderConfig({ name: 'ScopeInputsPlain', injections: [{ token: Handler }] });
export type Plain = Expect<Equal<typeof plain, Container>>;
const child: Container = plain.createScope();

export const used = [overridden, closed, child, nested];
