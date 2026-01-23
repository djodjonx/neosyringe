# Basic Usage

Learn the fundamental concepts and injection patterns in NeoSyringe.

## Container Configuration

All configuration is done through `defineBuilderConfig`:

```typescript
import { defineBuilderConfig } from '@djodjonx/neosyringe';

export const container = defineBuilderConfig({
  name: 'MyContainer',      // Optional: container name for debugging
  injections: [             // Required: list of injections
    // ... your injections
  ],
  extends: [],              // Optional: inherit from partials
  useContainer: undefined   // Optional: parent container
});
```

## Injection Types

### Class Token (Autowire)

The simplest form - register a class and let NeoSyringe resolve its dependencies:

```typescript
class UserRepository {
  findAll() { return []; }
}

class UserService {
  constructor(private repo: UserRepository) {}
}

export const container = defineBuilderConfig({
  injections: [
    { token: UserRepository },
    { token: UserService }  // Dependencies auto-resolved
  ]
});
```

### Interface Token

Use `useInterface<T>()` to bind interfaces to implementations:

```typescript
import { useInterface } from '@djodjonx/neosyringe';

interface ILogger {
  log(msg: string): void;
}

class ConsoleLogger implements ILogger {
  log(msg: string) { console.log(msg); }
}

class FileLogger implements ILogger {
  log(msg: string) { /* write to file */ }
}

export const container = defineBuilderConfig({
  injections: [
    { token: useInterface<ILogger>(), provider: ConsoleLogger }
  ]
});

// Resolve by interface
const logger = container.resolve(useInterface<ILogger>());
```

::: tip Automatic ID Generation
`useInterface<ILogger>()` generates a unique string ID at compile-time. You don't need to manage Symbols manually!
:::

### Explicit Provider

Override the default implementation:

```typescript
class UserService {
  // ...
}

class MockUserService extends UserService {
  // Test implementation
}

export const container = defineBuilderConfig({
  injections: [
    { token: UserService, provider: MockUserService }
  ]
});
```

### Factory Provider

Use factory functions for dynamic instantiation:

```typescript
// Arrow functions are auto-detected as factories
{ 
  token: useInterface<IConfig>(), 
  provider: (container) => ({
    apiUrl: process.env.API_URL ?? 'http://localhost',
    timeout: 5000
  })
}

// Factory with dependencies
{ 
  token: useInterface<IService>(), 
  provider: (container) => {
    const logger = container.resolve(useInterface<ILogger>());
    const config = container.resolve(useInterface<IConfig>());
    return new MyService(logger, config);
  }
}

// Explicit factory flag (for non-arrow functions)
{ 
  token: useInterface<IDatabase>(), 
  provider: createDatabaseConnection,
  useFactory: true
}
```

### Property Token

Inject primitive values (string, number, boolean) while keeping classes pure:

```typescript
import { useProperty } from '@djodjonx/neosyringe';

// Pure class - no DI imports!
class ApiService {
  constructor(
    private apiUrl: string,
    private timeout: number,
    private debug: boolean
  ) {}
}

// Define property tokens
const apiUrl = useProperty<string>(ApiService, 'apiUrl');
const timeout = useProperty<number>(ApiService, 'timeout');
const debug = useProperty<boolean>(ApiService, 'debug');

export const container = defineBuilderConfig({
  injections: [
    { token: apiUrl, provider: () => process.env.API_URL ?? 'http://localhost' },
    { token: timeout, provider: () => 5000 },
    { token: debug, provider: () => process.env.NODE_ENV === 'development' },
    { token: ApiService }  // Primitives auto-wired!
  ]
});
```

::: info Type Safety
`useProperty(ApiService, 'apiUrl')` creates a unique token scoped to that specific class parameter. This means `useProperty(ServiceA, 'url')` ≠ `useProperty(ServiceB, 'url')`.
:::

## Resolving Services

The `container.resolve()` method provides **full type safety** without any type assertions:

```typescript
import { container } from './container';
import { UserService } from './services/user.service';
import { useInterface } from '@djodjonx/neosyringe';
import type { ILogger } from './services/logger';

// ✅ Resolve by class - Type: UserService
const userService = container.resolve(UserService);
userService.createUser('John'); // Full auto-completion!

// ✅ Resolve by interface - Type: ILogger  
const logger = container.resolve(useInterface<ILogger>());
logger.log('Hello'); // ILogger methods available

// ✅ Resolve by property - Type: string
const apiUrl = container.resolve(useProperty<string>(ApiService, 'apiUrl'));
apiUrl.toUpperCase(); // String methods work
```

### Type Inference

TypeScript automatically infers the return type from the token:

```typescript
// No type assertion needed!
const service = container.resolve(UserService);
// Type: UserService ✅

// Compare with other DI libraries:
// ❌ const service = container.get('UserService') as UserService;
```

::: tip IDE Support
Your IDE will provide full auto-completion for resolved services. No more guessing what methods are available!
:::

## Partials (Modular Configuration)

Split configuration into reusable modules:

```typescript
// logging.partial.ts
import { definePartialConfig, useInterface } from '@djodjonx/neosyringe';

export const loggingConfig = definePartialConfig({
  injections: [
    { token: useInterface<ILogger>(), provider: ConsoleLogger }
  ]
});

// database.partial.ts
export const databaseConfig = definePartialConfig({
  injections: [
    { token: useInterface<IDatabase>(), provider: PostgresDatabase }
  ]
});

// container.ts
export const container = defineBuilderConfig({
  extends: [loggingConfig, databaseConfig], // Inherit injections
  injections: [
    { token: UserService },
    { token: OrderService }
  ]
});
```

## Complete Example

```typescript
// interfaces.ts
export interface ILogger {
  log(msg: string): void;
}

export interface IUserRepository {
  findById(id: string): User | null;
}

// implementations.ts
export class ConsoleLogger implements ILogger {
  log(msg: string) { console.log(`[LOG] ${msg}`); }
}

export class InMemoryUserRepository implements IUserRepository {
  private users = new Map<string, User>();
  
  findById(id: string) {
    return this.users.get(id) ?? null;
  }
}

// services.ts
export class UserService {
  constructor(
    private logger: ILogger,
    private repo: IUserRepository
  ) {}

  getUser(id: string) {
    this.logger.log(`Fetching user ${id}`);
    return this.repo.findById(id);
  }
}

// container.ts
import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';

export const container = defineBuilderConfig({
  name: 'AppContainer',
  injections: [
    { token: useInterface<ILogger>(), provider: ConsoleLogger },
    { token: useInterface<IUserRepository>(), provider: InMemoryUserRepository },
    { token: UserService }
  ]
});

// main.ts
import { container } from './container';

const userService = container.resolve(UserService);
const user = userService.getUser('123');
```

