import { defineBuilderConfig, useInterface, useProperty, type Alias } from '@djodjonx/neosyringe';

interface Logger {
  id: string;
}
interface Other {
  label: string;
}

class Console {
  id = 'console';
}
class Holder {
  retries = 0;
}

const logger = useInterface<Logger>();
const other = useInterface<Other>();
const retries = useProperty<number>(Holder, 'retries');

// The value of the target is not the value of the alias token.
export const wrongType = defineBuilderConfig({
  name: 'AliasWrongType',
  injections: [
    { token: Console },
    { token: other, useExisting: Console },
  ],
});
// An alias carries no provider, factory, value, lifecycle, ownership, dependency list or multi.
export const withProvider = defineBuilderConfig({
  name: 'AliasWithProvider',
  injections: [
    { token: Console },
    { token: logger, useExisting: Console, provider: Console },
  ],
});
export const withFactory = defineBuilderConfig({
  name: 'AliasWithFactory',
  injections: [
    { token: Console },
    { token: logger, useExisting: Console, useFactory: true, provider: () => new Console() },
  ],
});
export const withValue = defineBuilderConfig({
  name: 'AliasWithValue',
  injections: [
    { token: Console },
    { token: logger, useExisting: Console, useValue: { id: 'v' } },
  ],
});
export const withLifecycle = defineBuilderConfig({
  name: 'AliasWithLifecycle',
  injections: [
    { token: Console },
    { token: logger, useExisting: Console, lifecycle: 'transient' },
  ],
});
export const withOwnership = defineBuilderConfig({
  name: 'AliasWithOwnership',
  injections: [
    { token: Console },
    { token: logger, useExisting: Console, ownership: 'borrowed' },
  ],
});
export const withDependencies = defineBuilderConfig({
  name: 'AliasWithDependencies',
  injections: [
    { token: Console },
    { token: logger, useExisting: Console, dependencies: [] },
  ],
});
export const withMulti = defineBuilderConfig({
  name: 'AliasWithMulti',
  injections: [
    { token: Console },
    { token: logger, useExisting: Console, multi: true },
  ],
});
// The helper type refuses the same pair.
export const helper: Alias<typeof other, typeof Console> = { token: other, useExisting: Console };
// A property token has no alias: its provider is a factory.
export const property = defineBuilderConfig({
  name: 'AliasProperty',
  injections: [
    { token: Console },
    { token: retries, useExisting: Console },
  ],
});
