# Lifecycle

Control how instances are created and managed.

## Overview

NeoSyringe supports two lifecycle modes:

| Lifecycle | Behavior | Default |
|-----------|----------|---------|
| `singleton` | One instance per container | ✅ Yes |
| `transient` | New instance every `resolve()` | No |

## Singleton (Default)

By default, all services are **singletons**. The container creates one instance and reuses it.

```typescript
export const container = defineBuilderConfig({
  injections: [
    { token: UserService }  // Singleton by default
  ]
});

const a = container.resolve(UserService);
const b = container.resolve(UserService);

console.log(a === b); // true - same instance!
```

### When to Use Singleton

- ✅ Stateless services (most services)
- ✅ Database connections
- ✅ Configuration objects
- ✅ Loggers
- ✅ HTTP clients

## Transient

Use `lifecycle: 'transient'` for a new instance on every resolution.

```typescript
export const container = defineBuilderConfig({
  injections: [
    { token: RequestContext, lifecycle: 'transient' }
  ]
});

const a = container.resolve(RequestContext);
const b = container.resolve(RequestContext);

console.log(a === b); // false - different instances!
```

### When to Use Transient

- ✅ Request-scoped objects
- ✅ Stateful objects that should be isolated
- ✅ Objects with unique IDs
- ✅ Builder/Factory patterns

## Examples

### Request Context

```typescript
class RequestContext {
  readonly id = crypto.randomUUID();
  readonly timestamp = new Date();
}

export const container = defineBuilderConfig({
  injections: [
    { token: RequestContext, lifecycle: 'transient' }
  ]
});

// Each request gets its own context
app.use((req, res, next) => {
  req.context = container.resolve(RequestContext);
  next();
});
```

### Factory with Transient

```typescript
{
  token: useInterface<IRequest>(),
  provider: () => ({
    id: crypto.randomUUID(),
    timestamp: Date.now()
  }),
  lifecycle: 'transient'
}
```

### Mixed Lifecycles

```typescript
class Logger {
  // Singleton - shared across all services
}

class UserService {
  constructor(private logger: Logger) {}
  // Singleton - one instance
}

class RequestHandler {
  constructor(private userService: UserService) {}
  // Transient - new instance per request
}

export const container = defineBuilderConfig({
  injections: [
    { token: Logger },                                    // singleton
    { token: UserService },                               // singleton
    { token: RequestHandler, lifecycle: 'transient' }     // transient
  ]
});

// RequestHandler is new each time, but shares the same UserService
const handler1 = container.resolve(RequestHandler);
const handler2 = container.resolve(RequestHandler);

console.log(handler1 === handler2); // false
console.log(handler1.userService === handler2.userService); // true
```

## Generated Code

Understanding how lifecycle affects the generated code:

### Singleton

```typescript
// Generated for singleton
private resolveLocal(token: any): any {
  if (token === UserService) {
    if (!this.instances.has(UserService)) {
      this.instances.set(UserService, create_UserService(this));
    }
    return this.instances.get(UserService);
  }
}
```

### Transient

```typescript
// Generated for transient
private resolveLocal(token: any): any {
  if (token === RequestContext) {
    return create_RequestContext(this);  // No caching!
  }
}
```

## Scoped Lifecycle with Parent Containers

When using `scoped: true`, you can define a **different lifecycle** than the parent:

```typescript
// Parent: ILogger is singleton
const parent = defineBuilderConfig({
  injections: [
    { token: useInterface<ILogger>(), provider: ConsoleLogger, lifecycle: 'singleton' }
  ]
});

// Child: Override with transient lifecycle
const child = defineBuilderConfig({
  useContainer: parent,
  injections: [
    { 
      token: useInterface<ILogger>(), 
      provider: FileLogger,
      lifecycle: 'transient',  // Different from parent!
      scoped: true
    }
  ]
});

// In parent: same logger instance
const a = parent.resolve(useInterface<ILogger>());
const b = parent.resolve(useInterface<ILogger>());
console.log(a === b); // true

// In child: new instance each time
const c = child.resolve(useInterface<ILogger>());
const d = child.resolve(useInterface<ILogger>());
console.log(c === d); // false
```

## Best Practices

### 1. Default to Singleton

Most services should be singletons. Only use transient when you have a specific reason.

### 2. Transient for Stateful Objects

If an object holds request-specific state, make it transient:

```typescript
class ShoppingCart {
  items: CartItem[] = [];
  
  addItem(item: CartItem) {
    this.items.push(item);
  }
}

// Each user gets their own cart
{ token: ShoppingCart, lifecycle: 'transient' }
```

### 3. Consider Memory

Transient objects are not cached, which can increase memory churn. Profile your application if you're creating many transient instances.

