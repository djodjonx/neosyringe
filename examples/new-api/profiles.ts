import { defineBuilderConfig, type Container, type CoreContainer } from '@djodjonx/neosyringe';

class Counter {
  value = 0;
}

// #region profiles
// Default: the full profile. `override`, `clearOverrides` and `on` are in the type.
export const full: Container = defineBuilderConfig({
  name: 'FullProfile',
  injections: [{ token: Counter }],
});

// Opt-in: `runtime.profile` must be the literal 'minimal'. The type is CoreContainer.
export const minimal: CoreContainer = defineBuilderConfig({
  name: 'MinimalProfile',
  runtime: { profile: 'minimal' },
  injections: [{ token: Counter }],
});
// #endregion profiles

export async function run() {
  await minimal.initialize();
  const sameInstance = minimal.resolve(Counter) === minimal.resolve(Counter);
  const scope = minimal.createScope();
  await scope.initialize();
  await scope.destroy();
  await minimal.destroy();
  const lean = minimal as Partial<Container>;
  const result = {
    sameInstance,
    fullHasOverride: typeof full.override,
    fullHasOn: typeof full.on,
    minimalHasOverride: typeof lean.override,
    minimalHasOn: typeof lean.on,
  };
  await full.destroy();
  return result;
}
