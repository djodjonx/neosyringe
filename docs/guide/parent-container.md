# Parent Container

Build hierarchical container architectures with `useContainer`.

## Overview

NeoSyringe supports parent containers for:

- **SharedKernel pattern**: Core services shared across bounded contexts
- **Modular architecture**: Each module has its own container
- **Testing**: Override production services with mocks

## Basic Usage

```typescript
import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';

// Parent container
const sharedKernel = defineBuilderConfig({
  name: 'SharedKernel',
  injections: [
    { token: useInterface<ILogger>(), provider: ConsoleLogger },
    { token: useInterface<IEventBus>(), provider: InMemoryEventBus }
  ]
});

// Child container
const userModule = defineBuilderConfig({
  name: 'UserModule',
  useContainer: sharedKernel,  // 👈 Inherit from parent
  injections: [
    { token: UserRepository },
    { token: UserService }     // Can use ILogger and IEventBus!
  ]
});
```

## Resolution Order

When you call `resolve()`, NeoSyringe looks up the token in this order:

```
1. Local container (this container's injections)
   └── Found? → Return instance
   └── Not found? ↓

2. Parent container (useContainer)
   └── Found? → Return instance
   └── Not found? ↓

3. Throw "Service not found" error
```

## SharedKernel Architecture

Perfect for Domain-Driven Design with shared infrastructure:

```typescript
// shared-kernel/container.ts
export interface ILogger {
  log(msg: string): void;
}

export interface IEventBus {
  publish(event: any): void;
}

class ConsoleLogger implements ILogger {
  log(msg: string) { console.log(`[LOG] ${msg}`); }
}

class InMemoryEventBus implements IEventBus {
  publish(event: any) { console.log('Event:', event); }
}

export const sharedKernel = defineBuilderConfig({
  name: 'SharedKernel',
  injections: [
    { token: useInterface<ILogger>(), provider: ConsoleLogger },
    { token: useInterface<IEventBus>(), provider: InMemoryEventBus }
  ]
});
```

```typescript
// user-module/container.ts
import { sharedKernel, ILogger, IEventBus } from '../shared-kernel';

class UserRepository {
  constructor(private logger: ILogger) {}
  
  findById(id: string) {
    this.logger.log(`Finding user ${id}`);
    return { id, name: 'John' };
  }
}

class UserService {
  constructor(
    private logger: ILogger,      // From SharedKernel
    private eventBus: IEventBus,  // From SharedKernel
    private repo: UserRepository  // Local
  ) {}
  
  createUser(name: string) {
    const user = { id: crypto.randomUUID(), name };
    this.logger.log(`Creating user: ${name}`);
    this.eventBus.publish({ type: 'UserCreated', user });
    return user;
  }
}

export const userModule = defineBuilderConfig({
  name: 'UserModule',
  useContainer: sharedKernel,
  injections: [
    { token: UserRepository },
    { token: UserService }
  ]
});
```

```typescript
// order-module/container.ts
import { sharedKernel, ILogger } from '../shared-kernel';

class OrderService {
  constructor(private logger: ILogger) {}  // From SharedKernel
}

export const orderModule = defineBuilderConfig({
  name: 'OrderModule',
  useContainer: sharedKernel,
  injections: [
    { token: OrderService }
  ]
});
```

```typescript
// main.ts
import { userModule } from './user-module/container';
import { orderModule } from './order-module/container';

// Both modules share the same ILogger and IEventBus instances!
const userService = userModule.resolve(UserService);
const orderService = orderModule.resolve(OrderService);
```

## Multi-Level Hierarchy

Chain containers for complex architectures:

```typescript
// Level 1: Infrastructure
const infrastructure = defineBuilderConfig({
  name: 'Infrastructure',
  injections: [
    { token: useInterface<ILogger>(), provider: ConsoleLogger },
    { token: useInterface<IDatabase>(), provider: PostgresDatabase }
  ]
});

// Level 2: Domain (inherits Infrastructure)
const domain = defineBuilderConfig({
  name: 'Domain',
  useContainer: infrastructure,
  injections: [
    { token: UserRepository },
    { token: OrderRepository }
  ]
});

// Level 3: Application (inherits Domain + Infrastructure)
const application = defineBuilderConfig({
  name: 'Application',
  useContainer: domain,  // Gets Domain AND Infrastructure!
  injections: [
    { token: UserService },
    { token: OrderService }
  ]
});

// Resolution traverses the chain
application.resolve(UserService);      // Local
application.resolve(UserRepository);   // From Domain
application.resolve(useInterface<ILogger>()); // From Infrastructure
```

## Validation

NeoSyringe validates parent containers at compile-time:

### Duplicate Detection

```typescript
const parent = defineBuilderConfig({
  injections: [
    { token: useInterface<ILogger>(), provider: ConsoleLogger }
  ]
});

// ❌ Error: Duplicate registration
const child = defineBuilderConfig({
  useContainer: parent,
  injections: [
    { token: useInterface<ILogger>(), provider: FileLogger }
  ]
});
```

**Solution**: Use `scoped: true` for intentional overrides.

### Missing Dependencies

```typescript
const parent = defineBuilderConfig({
  injections: [
    { token: useInterface<ILogger>(), provider: ConsoleLogger }
  ]
});

class UserService {
  constructor(
    private logger: ILogger,
    private db: IDatabase  // Not in parent!
  ) {}
}

// ❌ Error: Missing binding 'IDatabase'
const child = defineBuilderConfig({
  useContainer: parent,
  injections: [
    { token: UserService }
  ]
});
```

## Generated Code

The parent relationship is preserved in generated code:

```typescript
// Configuration
export const child = defineBuilderConfig({
  name: 'ChildContainer',
  useContainer: parent,
  injections: [
    { token: UserService }
  ]
});

// Generated code
import { parent } from './parent';

class NeoContainer {
  private instances = new Map<any, any>();

  // ... factories

  constructor(
    private parent?: any,
    private legacy?: any[],
    private name: string = 'ChildContainer'
  ) {}

  public resolve<T>(token: any): T {
    const result = this.resolveLocal(token);
    if (result !== undefined) return result;

    if (this.parent) {
      try {
        return this.parent.resolve(token);
      } catch (e: any) {
        if (!e?.message?.includes('Service not found or token not registered')) throw e;
      }
    }

    throw new Error(`[${this.name}] Service not found or token not registered: ${token}`);
  }

  // resolveLocal, destroy...
}

export const child = new NeoContainer(parent, undefined, "ChildContainer");
```

## Best Practices

### 1. Name Your Containers

Names appear in error messages for easier debugging:

```typescript
defineBuilderConfig({
  name: 'UserModule',  // ✅ Shows in errors
  // ...
});

// Error: [UserModule] Service not found: XYZ
```

### 2. Keep SharedKernel Minimal

Only put truly shared services in the SharedKernel:

```typescript
// ✅ Good: Cross-cutting concerns
{ token: useInterface<ILogger>() }
{ token: useInterface<IEventBus>() }
{ token: useInterface<IDateTime>() }

// ❌ Bad: Domain-specific services
{ token: UserService }
{ token: OrderService }
```

### 3. Use Scoped for Overrides

When you need a different implementation locally:

```typescript
const child = defineBuilderConfig({
  useContainer: parent,
  injections: [
    { token: useInterface<ILogger>(), provider: FileLogger, scoped: true }
  ]
});
```

See [Scoped Injections](/guide/scoped-injections) for details.

