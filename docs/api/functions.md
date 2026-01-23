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

Define a reusable partial configuration that can be extended.

### Parameters

| Name | Type | Description |
|------|------|-------------|
| `config` | `PartialConfig` | Partial configuration |

### Returns

`PartialConfig` - The partial configuration

### Example

```typescript
import { definePartialConfig, useInterface } from '@djodjonx/neosyringe';

export const loggingPartial = definePartialConfig({
  injections: [
    { token: useInterface<ILogger>(), provider: ConsoleLogger }
  ]
});

// Use in main config
export const container = defineBuilderConfig({
  extends: [loggingPartial],
  injections: [
    { token: UserService }
  ]
});
```

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
function useProperty<T, C = unknown>(
  targetClass: Constructor<C>,
  paramName: string
): PropertyToken<T, C>
```

Create a token for a primitive constructor parameter.

### Type Parameters

| Name | Description |
|------|-------------|
| `T` | The primitive type (string, number, boolean) |
| `C` | The class type |

### Parameters

| Name | Type | Description |
|------|------|-------------|
| `targetClass` | `Constructor<C>` | The class that has this parameter |
| `paramName` | `string` | The parameter name |

### Returns

`PropertyToken<T, C>` - A token for the primitive

### Example

```typescript
import { useProperty } from '@djodjonx/neosyringe';

class ApiService {
  constructor(
    private apiUrl: string,
    private timeout: number
  ) {}
}

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


