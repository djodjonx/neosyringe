import { defineBuilderConfig, useInterface, type BoundContainer, type Container, type ContainerTemplate, type CoreContainer } from '@djodjonx/neosyringe';

// The consumer compiles with the disposable lib: a container and a scope are `await using` resources.

class Mailer {
  send(): string {
    return 'sent';
  }
}

interface Request {
  id: string;
}

const request = useInterface<Request>();

const full = defineBuilderConfig({ name: 'DisposableFull', injections: [{ token: Mailer }] });
const lean = defineBuilderConfig({ name: 'DisposableLean', runtime: { profile: 'minimal' }, injections: [{ token: Mailer }] });
const model = defineBuilderConfig({ name: 'DisposableModel', scopeInputs: [request], injections: [{ token: Mailer }] });
const leanModel = defineBuilderConfig({ name: 'DisposableLeanModel', runtime: { profile: 'minimal' }, scopeInputs: [request], injections: [{ token: Mailer }] });

const close: () => Promise<void> = () => full[Symbol.asyncDispose]();
void close;

const asResource: AsyncDisposable = full;
const leanAsResource: AsyncDisposable = lean;
const modelAsResource: AsyncDisposable = model;
void asResource;
void leanAsResource;
void modelAsResource;

export async function run(): Promise<string> {
  await using root = full;
  await using scope = root.createScope();
  await using leanScope = lean.createScope();
  await using bound = model.createScope({ values: [{ token: request, useValue: { id: 'r1' } }] });
  await using leanBound = leanModel.createScope({ values: [{ token: request, useValue: { id: 'r2' } }] });
  await using template = model;
  void leanScope;
  void bound;
  void leanBound;
  void template;
  return scope.resolve(Mailer).send();
}

// `destroy()` stays the way to end a container.
export async function legacy(): Promise<void> {
  const scope = full.createScope();
  await scope.destroy();
  await full.destroy();
}

// A hand-built object typed as a container (a test double, an adapter) compiles once it has the method the lib asks
// for: `async [Symbol.asyncDispose]() { await this.destroy(); }`.
type WithoutAsyncDispose<T> = Omit<T, typeof Symbol.asyncDispose>;
declare const coreDouble: WithoutAsyncDispose<CoreContainer>;
declare const fullDouble: WithoutAsyncDispose<Container>;
declare const templateDouble: WithoutAsyncDispose<ContainerTemplate<readonly [], 'full'>>;
declare const boundDouble: WithoutAsyncDispose<BoundContainer>;

export const asCore: CoreContainer = {
  ...coreDouble,
  async [Symbol.asyncDispose]() {
    await this.destroy();
  },
};
export const asFull: Container = {
  ...fullDouble,
  async [Symbol.asyncDispose]() {
    await this.destroy();
  },
};
export const asTemplate: ContainerTemplate<readonly [], 'full'> = {
  ...templateDouble,
  async [Symbol.asyncDispose]() {
    await this.destroy();
  },
};
export const asBound: BoundContainer = {
  ...boundDouble,
  async [Symbol.asyncDispose]() {
    await this.destroy();
  },
};
