# Why NeoSyringe?

What NeoSyringe does differently, and what it asks of you in return.

For a comparison with other libraries, see [Alternatives](./alternatives.md). That page only states what each project's documentation says, with the date it was read. This page makes no claim about other libraries.

## Resolution is decided at build time

A plugin reads your `defineBuilderConfig(...)` call and replaces it with a generated container. The decisions are made once, in the build:

- which class gets which constructor arguments,
- which registrations exist and who depends on whom,
- which calls can never succeed (a missing provider, a cycle, a duplicate).

No decorators and no `reflect-metadata` are involved: your classes stay plain.

```typescript
import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';

// Pure class - no DI imports!
class UserService {
  constructor(
    private logger: ILogger,
    private db: IDatabase
  ) {}
}

export const container = defineBuilderConfig({
  injections: [
    { token: useInterface<ILogger>(), provider: ConsoleLogger },
    { token: useInterface<IDatabase>(), provider: PostgresDatabase },
    { token: UserService }
  ]
});

const service = container.resolve(UserService);
// Type: UserService (inferred from the token)
```

## Errors show up before you run

```typescript
export const container = defineBuilderConfig({
  injections: [
    { token: UserService } // UserService needs ILogger
  ]
});
// 🔴 NEO_MISSING_PROVIDER: Missing injection: 'ILogger' required by 'UserService' is not registered.
```

The same check runs in the IDE plugin, the [CLI](./cli.md) and the build. See the [error reference](/api/errors).

## Types follow the token

```typescript
const service = container.resolve(UserService);                       // UserService
const logger = container.resolve(useInterface<ILogger>());            // ILogger
const apiUrl = container.resolve(useProperty<string>(ApiService, 'apiUrl')); // string
```

The type of the container depends on its [profile](./profiles.md): `Container` by default, `CoreContainer` with `runtime: { profile: 'minimal' }`.

## Testing

Test the service that consumes a dependency, not only the token. `scoped: true` in a child container changes what that child builds. A service that the parent already owns keeps the parent's dependencies.

<<< @/../examples/new-api/mock.ts#containers

The example is executed by `tests/e2e/t20-docs-examples.test.ts`. The full explanation, with `override` and `clearOverrides`, is in [Scoped Injections](./scoped-injections.md#testing-with-mocks).

## Resources have an owner

A container closes the singletons it built, once, when you call `destroy()`. It does not close values you gave it, mocks, or services owned by a parent. `destroy()` is final. See [States, Scopes and Ownership](./states-and-ownership.md).

## Size and speed

No absolute figure is promised. The generated container is code your build emits, so its size depends on your graph and on the [profile](./profiles.md). The only published measurement, with its command, date and feature sets, is on that page.

## Moving from another container

You do not have to migrate everything at once:

```typescript
import { legacyContainer } from './legacy-tsyringe';
import { declareContainerTokens } from '@djodjonx/neosyringe';

const legacy = declareContainerTokens<{
  AuthService: AuthService;
  UserRepository: UserRepository;
}>(legacyContainer);

export const container = defineBuilderConfig({
  useContainer: legacy, // Delegate to legacy
  injections: [
    { token: NewService },
    { token: AnotherNewService }
  ]
});
```

See [Legacy Migration](./legacy-migration.md) for tsyringe and InversifyJS, and the [migration guide](./migration.md) for NeoSyringe's own contract changes.

## Trade-offs

- You need a build step. `defineBuilderConfig(...)` throws if the plugin did not replace it.
- Factories must declare their `dependencies`, and `destroy()` is final.
- Closed mode, which removes unreachable registrations, is opt-in: see [From Open to Closed](./closed-mode.md). An open container keeps every registration.
