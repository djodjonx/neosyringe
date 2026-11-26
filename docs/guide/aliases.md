# Aliases (`useExisting`)

An alias registers a second token for a service that is already registered. `{ token, useExisting }` answers what `useExisting` answers: it builds nothing, caches nothing, owns nothing.

```typescript
import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';

interface Logger { log(message: string): void }

class ConsoleLogger implements Logger {
  log(message: string): void { console.log(message); }
}
class Reporter {
  constructor(readonly logger: Logger) {}
}

const logger = useInterface<Logger>();

export const container = defineBuilderConfig({
  name: 'App',
  injections: [
    { token: ConsoleLogger },
    { token: logger, useExisting: ConsoleLogger },
    { token: Reporter },
  ],
});

// Both tokens answer the same object: it is a singleton.
container.resolve(logger) === container.resolve(ConsoleLogger); // true
```

Registering the same class under two tokens is not an alias: each registration has its own singleton. The alias is what shares one.

## What an alias is

- **The target keeps its lifecycle.** An alias of a singleton answers the one object. An alias of a transient answers a new object at every read, like the target.
- **The target keeps its owner.** The container disposes the target once, whether it was read through the alias, through its own token, or through both. An alias has no slot in the disposal order, and a consumer of the alias is disposed before the target (`packages/core/src/analyzer/shared/aliasLinks.ts:122`).
- **A chain is one read.** An alias of an alias is allowed, to any length. The build flattens the chain once, without recursion (`packages/core/src/analyzer/shared/aliasLinks.ts:23`), and the generated accessor of every link reads the end of the chain directly (`packages/core/src/generator/FactoryEmitter.ts:206`).
- **The target may be in a parent.** `useExisting` can name a token the `useContainer` parent provides, if the parent exports it. The alias reads the parent through a helper that does not fire the resolve event of the parent token (`packages/core/src/generator/ResolveEmitter.ts:649`).
- **An async target works after `initialize()`.** Before it, the alias throws what the target throws.
- **The value must fit.** The value of the target must be assignable to the value of the alias token: a class instance, or the `T` of `useInterface<T>()`. A subtype is accepted. The types check it (`packages/neosyringe/src/types.ts:348`), and so does the build with the checker (`packages/core/src/analyzer/shared/aliasLinks.ts:152`).
- **`scoped` is allowed.** `{ token, useExisting, scoped: true }` replaces the registration of a parent for this container, like any other shape.

## Events

`on('resolve', listener)` sees the token that was asked: `resolve(alias)` fires one event with the alias token, never one with the target, and a consumer that reads the alias token fires the alias event, then its own. `resolve(target)` fires the event of the target (`packages/core/src/generator/ResolveEmitter.ts:412`). The minimal profile has no event, aliases included.

## Closed mode

Publishing an alias (`roots: [alias]`) keeps its target private: the target stays out of the exported roots, and `resolve(target)` throws `NEO_ROOT_NOT_EXPORTED`. A local alias does not make a private root of a closed parent reachable: an alias to it is `NEO_MISSING_PROVIDER`. An alias cannot be listed in `eager`: list its target (`packages/core/src/analyzer/parsers/ConfigParser.ts:340`).

The roots set of a closed container (`_singleRoots`) stays what refuses a token that is not a root, before the table and the parent are read (`packages/core/src/generator/Generator.ts:942`). It is not redundant with the root table: a token the parent provides has no row in the table of the child.

## Overrides

An override targets the target. `override(target, factory)` and `overrideMany` are then seen through every alias of it, and cleared with it by `clearOverrides()`. An override of the alias itself is refused with `NEO_OVERRIDE_ALIAS_UNSUPPORTED`, with no change, and the message names the target: `cannot override an alias: override its target 'ConsoleLogger'` (`packages/core/src/generator/ResolveEmitter.ts:108`). In `overrideMany` the whole batch is refused. The override also reaches an alias whose target is a token the `useContainer` parent provides: the child override of that token is read first, in the reference emitter (`packages/core/src/generator/ResolveEmitter.ts:713`) and in the optimized one (`packages/core/src/generator/FactoryEmitter.ts:228`), and the parent keeps its own object.

```typescript
await container.override(ConsoleLogger, () => new SilentLogger()); // every alias sees it
await container.override(logger, () => new SilentLogger());        // NEO_OVERRIDE_ALIAS_UNSUPPORTED
```

## What an alias cannot carry

| Written | Reported |
|---|---|
| `provider`, `useFactory`, `useValue`, `lifecycle`, `ownership`, `dependencies` next to `useExisting` | `NEO_CONFIG_UNSUPPORTED`, at the registration (`packages/core/src/analyzer/parsers/InjectionParser.ts:410`) |
| `multi: true` on the alias | `NEO_CONFIG_UNSUPPORTED` (`packages/core/src/analyzer/parsers/InjectionParser.ts:412`) |
| a property token (`useProperty`) as the alias token | `NEO_CONFIG_UNSUPPORTED` (`packages/core/src/analyzer/parsers/InjectionParser.ts:419`) |
| an alias in `optimization.eager` | `NEO_CONFIG_UNSUPPORTED`, at the element |
| a token or a `useExisting` that names no class or interface token (a literal, for example) | `NEO_CONFIG_UNSUPPORTED`, at the registration (`packages/core/src/analyzer/parsers/InjectionParser.ts:433`) |
| a target that is a `multi` token | `NEO_MULTI_REQUIRES_RESOLVE_ALL`, at the token of the alias |
| a target no container provides | `NEO_MISSING_PROVIDER`, at the token of the alias |
| aliases that point at each other, or a service that reads an alias of itself | `NEO_CYCLE` |
| a token registered twice (alias and registration, or two aliases), or an alias of a scope input | `NEO_DUPLICATE_PROVIDER` |
| a singleton that reads a disposable transient through an alias | `NEO_DISPOSABLE_TRANSIENT_CAPTURED`, as for a direct read |
| a target whose value is not the value of the token | a `type-mismatch`, at the registration |

The types refuse part of this table, and the build refuses all of it. `Alias<T, U>` is the shape of the registration (`packages/neosyringe/src/types.ts:455`), and the guard of `injections` (`packages/neosyringe/src/types.ts:348`) rejects a value type that does not fit, and `provider`, `useFactory`, `useValue`, `lifecycle`, `ownership`, `multi` or `dependencies` next to `useExisting`. The other rows are reported by the build only: a property token as the alias token when its value type fits, an alias in `optimization.eager`, a token that names no token, a target that is a `multi` token, a target no container provides, a cycle, a token registered twice, and a disposable transient captured by a singleton. The `type-mismatch` of the build also stays silent where the checker cannot tell the type of a token, such as an abstract or generic class (`packages/core/src/analyzer/shared/aliasLinks.ts:160`). The full list of codes is in [errors](../api/errors.md).

## Cost

An alias of a singleton costs about what a read of the target costs at one link, and a little more over a chain of ten. A relay factory written for the same job costs a factory per link when the target is transient. The numbers, the machine and what they do not say are in [the measure of topic 20](../benchmarks/topic-20-alias.md).
