import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';

// The registrations of packages/neosyringe/USAGE.md, built in strict mode: a factory always lists its dependencies.

class SomeClass {
  constructor(readonly label: string) {}
}

interface Settings {
  endpoint: string;
}

const settings = useInterface<Settings>();
const instance = new SomeClass('prebuilt');

// #region container
export const container = defineBuilderConfig({
  name: 'UsageRecipes',
  injections: [
    // A pre-built instance under a class token: a factory, not `useValue`.
    { token: SomeClass, provider: () => instance, useFactory: true, dependencies: [] },
    // `useValue` for an interface token.
    { token: settings, useValue: { endpoint: '/api' } },
  ],
});
// #endregion container

export async function run() {
  const prebuilt = container.resolve(SomeClass);
  const endpoint = container.resolve(settings).endpoint;
  const result = { prebuilt: prebuilt.label, sameObject: prebuilt === instance, endpoint };
  await container.destroy();
  return result;
}
