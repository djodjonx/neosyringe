# Functions

API functions exported by NeoSyringe.

## defineBuilderConfig

```typescript
function defineBuilderConfig(config: BuilderConfig): Container
```

Define a container configuration. At runtime without the build plugin, this throws an error. At build time, it's replaced with the generated container.

### Parameters

| Name | Type | Description |
|------|------|-------------|
| `config` | `BuilderConfig` | Container configuration |

### Returns

`Container` - The generated container (after build)

### Example

```typescript
import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';

export const container = defineBuilderConfig({
  name: 'AppContainer',
  injections: [
    { token: useInterface<ILogger>(), provider: ConsoleLogger },
    { token: UserService }
  ]
});
```

---

## definePartialConfig

```typescript
function definePartialConfig(config: PartialConfig): PartialConfig
```

Define a reusable partial configuration that can be extended by a `defineBuilderConfig`.

### Parameters

| Name | Type | Description |
|------|------|-------------|
| `config.injections` | `Injection[]` | Services provided by this partial |
| `config.expects` | `any[]` | Tokens this partial expects from its host container |

### Returns

`PartialConfig` — The partial configuration

### Example — basic partial

```typescript
import { definePartialConfig, useInterface } from '@djodjonx/neosyringe';

export const loggingPartial = definePartialConfig({
  injections: [
    { token: useInterface<ILogger>(), provider: ConsoleLogger }
  ]
});

export const container = defineBuilderConfig({
  extends: [loggingPartial],
  injections: [{ token: UserService }]
});
```

### Example — partial with `expects` (peer dependencies)

Use `expects` when a partial's services depend on tokens registered in the host container. Common in feature-first / DDD architectures where a shared kernel registers cross-cutting concerns.

```typescript
// user/config.ts
export const userPartial = definePartialConfig({
  expects: [
    useInterface<ICacheClient>(),
    useInterface<ITokenService>(),
    useInterface<IIdGenerator>(),
  ],
  injections: [
    { token: Login },
    { token: Register },
    { token: GetMe },
  ]
});

// app/container.ts
export const appContainer = defineBuilderConfig({
  useContainer: sharedKernel,      // provides ICacheClient, ITokenService, IIdGenerator
  extends: [userPartial],
});
```

::: tip
If the host builder does not provide a token declared in `expects`, the analyzer raises an error pointing to the builder — not the partial.
:::

---

## useInterface

```typescript
function useInterface<T>(): InterfaceToken<T>
```

Create a token for an interface. At compile time, this generates a unique string ID.

### Type Parameters

| Name | Description |
|------|-------------|
| `T` | The interface type |

### Returns

`InterfaceToken<T>` - A token representing the interface

### Example

```typescript
import { useInterface } from '@djodjonx/neosyringe';

interface ILogger {
  log(msg: string): void;
}

interface IDatabase {
  query(sql: string): any[];
}

// In configuration
{
  injections: [
    { token: useInterface<ILogger>(), provider: ConsoleLogger },
    { token: useInterface<IDatabase>(), provider: PostgresDatabase }
  ]
}

// Resolution
const logger = container.resolve(useInterface<ILogger>());
```

---

## useProperty

```typescript
function useProperty<T, C extends Constructor<any> = Constructor<any>>(
  targetClass: C,
  paramName: string
): PropertyToken<T, InstanceType<C>>
```

Create a token for a primitive constructor parameter.

### Type Parameters

| Name | Description |
|------|-------------|
| `T` | **Required.** The primitive type (`string`, `number`, `boolean`) |
| `C` | **Inferred** from `targetClass`. Rarely needs to be explicit. |

### Parameters

| Name | Type | Description |
|------|------|-------------|
| `targetClass` | `C` | The class that has this parameter |
| `paramName` | `string` | The parameter name |

### Returns

`PropertyToken<T, InstanceType<C>>` - A token for the primitive

### Example

```typescript
import { useProperty } from '@djodjonx/neosyringe';

class ApiService {
  constructor(
    private apiUrl: string,
    private timeout: number
  ) {}
}

// Only T needs to be explicit — C is inferred from the class argument
const apiUrl = useProperty<string>(ApiService, 'apiUrl');
const timeout = useProperty<number>(ApiService, 'timeout');

// In configuration
{
  injections: [
    { token: apiUrl, provider: () => 'https://api.example.com' },
    { token: timeout, provider: () => 5000 },
    { token: ApiService }
  ]
}
```

---

## declareContainerTokens

```typescript
function declareContainerTokens<T>(container: any): any
```

Declare tokens provided by a legacy container for type-safety and validation.

### Type Parameters

| Name | Description |
|------|-------------|
| `T` | Object type mapping token names to types |

### Parameters

| Name | Type | Description |
|------|------|-------------|
| `container` | `any` | The legacy container instance |

### Returns

The container with declared types

### Example

```typescript
import { declareContainerTokens } from '@djodjonx/neosyringe';
import { container as tsyringeContainer } from 'tsyringe';

// Declare what tsyringe provides
const legacy = declareContainerTokens<{
  AuthService: AuthService;
  UserRepository: UserRepository;
}>(tsyringeContainer);

// Use in configuration
export const container = defineBuilderConfig({
  useContainer: legacy,
  injections: [
    { token: NewService }  // Can depend on AuthService, UserRepository
  ]
});
```

---

## Container.resolve

```typescript
resolve<T>(token: Token<T>): T
```

Resolve a service from the container. The return type is **automatically inferred** from the token.

### Type Parameters

| Name | Description |
|------|-------------|
| `T` | The service type (inferred automatically) |

### Parameters

| Name | Type | Description |
|------|------|-------------|
| `token` | `Token<T>` | Class, interface token, or property token |

### Returns

`T` - The resolved instance with **full type safety**

### Throws

`Error` - If the service is not found

### Type Inference Examples

NeoSyringe provides complete type safety without any type assertions:

```typescript
// ✅ Class token - Type: UserService
const userService = container.resolve(UserService);
userService.createUser('John'); // Full auto-completion

// ✅ Interface token - Type: ILogger
const logger = container.resolve(useInterface<ILogger>());
logger.log('Hello'); // Methods of ILogger available

// ✅ Property token - Type: string
const apiUrl = container.resolve(useProperty<string>(ApiService, 'apiUrl'));
apiUrl.toUpperCase(); // String methods available

// ✅ Generic classes - Type: Repository<User>
const userRepo = container.resolve(Repository<User>);
userRepo.findById(1); // Typed with User
```

### Advanced Type Safety

```typescript
// Dependencies are also fully typed
class UserService {
  constructor(
    private logger: ILogger,
    private repo: UserRepository
  ) {}
  
  async createUser(name: string) {
    // this.logger is typed as ILogger
    this.logger.log(`Creating user: ${name}`);
    // this.repo is typed as UserRepository
    return this.repo.save({ name });
  }
}

const service = container.resolve(UserService);
// Type: UserService
// All properties correctly typed!
```

::: tip No Type Assertions Needed
Unlike other DI libraries, you never need `as` or `<Type>` casts:

```typescript
// ❌ Other libraries
const service = container.get('UserService') as UserService;

// ✅ NeoSyringe
const service = container.resolve(UserService);
```
:::


