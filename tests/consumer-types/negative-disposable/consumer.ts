import { defineBuilderConfig, type BoundContainer, type Container, type ContainerTemplate, type CoreContainer } from '@djodjonx/neosyringe';

class Mailer {
  send(): string {
    return 'sent';
  }
}

const full = defineBuilderConfig({ name: 'NegativeDisposable', injections: [{ token: Mailer }] });
const lean = defineBuilderConfig({ name: 'NegativeLean', runtime: { profile: 'minimal' }, injections: [{ token: Mailer }] });

export function synchronous(): void {
  using scope = full.createScope();
  using leanScope = lean.createScope();
  using root = full;
  void scope;
  void leanScope;
  void root;
}

export async function notAResource(): Promise<void> {
  await using plain = { id: 1 };
  void plain;
}

// A hand-built object typed as a container (a test double, an adapter) has no `[Symbol.asyncDispose]`: with a lib that
// declares the symbol the member is required, so the three interfaces refuse it.
type WithoutAsyncDispose<T> = Omit<T, typeof Symbol.asyncDispose>;
declare const coreDouble: WithoutAsyncDispose<CoreContainer>;
declare const fullDouble: WithoutAsyncDispose<Container>;
declare const templateDouble: WithoutAsyncDispose<ContainerTemplate<readonly [], 'full'>>;
declare const boundDouble: WithoutAsyncDispose<BoundContainer>;

export const asCore: CoreContainer = coreDouble;
export const asFull: Container = fullDouble;
export const asTemplate: ContainerTemplate<readonly [], 'full'> = templateDouble;
export const asBound: BoundContainer = boundDouble;
