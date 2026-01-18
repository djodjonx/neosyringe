# NeoSyringe + Nuxt 4.2 DDD Example

A complete example demonstrating **Domain-Driven Design** architecture with **NeoSyringe** compile-time dependency injection in a **Nuxt 4.2** application.

> ⚠️ This example uses NeoSyringe from npm (`@djodjonx/neosyringe`) and demonstrates real DI container usage.

## 🚀 Quick Start

```bash
# Install dependencies
pnpm install

# Build (NeoSyringe transforms DI at build time)
pnpm build

# Preview built app
pnpm preview

# Or run in dev mode
pnpm dev
```

## 💉 How NeoSyringe is Used

### 1. Container Definition (`src/di/container.ts`)

```typescript
import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';

export const appContainer = defineBuilderConfig({
  name: 'AppContainer',
  injections: [
    // SINGLETON (default) - One instance shared across the app
    { token: useInterface<ILogger>(), provider: ConsoleLogger },
    { token: useInterface<IEventBus>(), provider: InMemoryEventBus },
    { token: UserService },
    
    // TRANSIENT - New instance on every resolve()
    { 
      token: useInterface<IRequestContext>(), 
      provider: RequestContext,
      lifecycle: 'transient'
    },
    { 
      token: useInterface<IOperationTracker>(), 
      provider: OperationTracker,
      lifecycle: 'transient'
    }
  ]
});
```

### 2. Singleton vs Transient Usage

```typescript
// SINGLETON: Same instance every time
const userService = container.resolve(UserService);

// TRANSIENT: New instance with unique ID each time
const tracker1 = container.resolve<IOperationTracker>('IOperationTracker');
const tracker2 = container.resolve<IOperationTracker>('IOperationTracker');
console.log(tracker1.operationId !== tracker2.operationId); // true!
```

### 3. Practical Transient Example

```typescript
export function useUsers() {
  // Singleton - shared UserService
  const userService = container.resolve(UserService);

  async function createUser(email: string, name: string) {
    // Transient - unique tracker for this operation
    const tracker = container.resolve<IOperationTracker>('IOperationTracker');
    tracker.start('CreateUser');
    
    try {
      const user = await userService.createUser(email, name);
      tracker.complete(); // Logs with unique operationId
      return user;
    } catch (e) {
      tracker.fail(e);
      throw e;
    }
  }
}
```

### 3. Build-Time Transformation

At build time, NeoSyringe:
1. Analyzes the dependency graph
2. Validates (no circular deps, no missing bindings)
3. Generates optimized factory code

**Before (source):**
```typescript
const userService = container.resolve(UserService);
```

**After (generated):**
```javascript
// Factory function generated
function create_UserService(container) {
  return new UserService(
    container.resolve("IUserRepository"),
    container.resolve("ILogger"),
    container.resolve("IEventBus")
  );
}
```

## 🏗️ Architecture

```
app/
├── di/
│   └── container.ts          # Single DI container with all services
│
├── domain/                   # Domain Layer (pure business logic)
│   ├── user/
│   │   ├── entities/         # User aggregate
│   │   ├── repositories/     # IUserRepository interface
│   │   └── services/         # UserService
│   └── product/
│       ├── entities/         # Product aggregate
│       ├── repositories/     # IProductRepository interface
│       └── services/         # ProductService
│
├── infrastructure/           # Infrastructure Layer (adapters)
│   ├── repositories/         # InMemory implementations
│   └── services/             # ConsoleLogger, InMemoryEventBus
│
├── shared-kernel/            # Shared Kernel
│   ├── interfaces/           # ILogger, IEventBus
│   └── value-objects/        # Email, etc.
│
├── composables/              # Vue Composables using DI
│   ├── useUsers.ts           # Uses container.resolve(UserService)
│   └── useProducts.ts        # Uses container.resolve(ProductService)
│
└── pages/                    # Nuxt Pages
    ├── index.vue
    ├── users.vue
    └── products.vue
```

## 🛠️ Nuxt Configuration

The NeoSyringe plugin is configured in `nuxt.config.ts`:

```typescript
import { neoSyringePlugin } from '@djodjonx/neosyringe/plugin';

export default defineNuxtConfig({
  vite: {
    plugins: [neoSyringePlugin.vite()]
  }
});
```

> The plugin automatically runs before esbuild (`enforce: 'pre'`) to properly transform TypeScript files.

## ✨ Key Points

1. **Pure Domain Classes** - No decorators, no DI-specific code
2. **Build-Time DI** - Zero runtime overhead
3. **Type-Safe** - `useInterface<ILogger>()` with full TypeScript support
4. **Validated** - Circular dependencies and missing bindings caught at build time

## 📚 Learn More

- [NeoSyringe Documentation](https://djodjonx.github.io/neo-syringe/)
- [Getting Started](https://djodjonx.github.io/neo-syringe/guide/getting-started)

