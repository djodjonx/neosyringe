# Async Factories

Initialize async services (databases, HTTP clients, external connections) once at startup. All subsequent `resolve()` calls stay synchronous.

## The Problem

Some services require async initialization — opening a database pool, loading remote config, connecting to Redis. But your business code shouldn't have to `await` every `resolve()`.

## The Solution

Mark the factory `async`, call `await container.initialize()` once at app startup, then resolve everything synchronously as usual.

```typescript
import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';

interface IDatabase {
  query(sql: string): Promise<any[]>;
}

export const container = defineBuilderConfig({
  injections: [
    {
      token: useInterface<IDatabase>(),
      provider: async () => {
        const pool = new Pool({ connectionString: process.env.DATABASE_URL });
        await pool.connect();
        return pool;
      },
      useFactory: true
    },
    { token: UserService }  // depends on IDatabase — no change needed
  ]
});
```

```typescript
// main.ts — the only place with await
await container.initialize();

// Everywhere else — fully synchronous
const userService = container.resolve(useInterface<IUserService>());
```

## How It Works

When at least one factory is `async`, the generated container gets an `initialize()` method:

```typescript
// Generated (simplified)
class NeoContainer {
  private _initialized = false;

  public async initialize(): Promise<void> {
    if (this._initialized) return;
    this.instances.set("IDatabase", await this.create_IDatabase());
    this._initialized = true;
  }

  public resolve<T>(token: any): T {
    if (!this._initialized) {
      throw new Error('Call await container.initialize() before the first resolve()');
    }
    // ... normal resolution
  }
}
```

All async singletons are pre-created in `initialize()`, in dependency order. After that, `resolve()` returns them from cache — no `await` needed anywhere in your application code.

Containers with no async factories are completely unchanged — no `initialize()`, no guard.

## Constraints

::: warning Singleton Only
Async factories must be `singleton` (the default). Using `lifecycle: 'transient'` with an async factory is a compile-time error — transient services are created on every `resolve()`, which would require making `resolve()` async and break all existing call sites.
:::

## Multiple Async Services

All async singletons are pre-created together in `initialize()`:

```typescript
export const container = defineBuilderConfig({
  injections: [
    {
      token: useInterface<IDatabase>(),
      provider: async () => {
        const pool = new Pool({ connectionString: process.env.DATABASE_URL });
        await pool.connect();
        return pool;
      },
      useFactory: true
    },
    {
      token: useInterface<ICache>(),
      provider: async () => {
        const client = createClient({ url: process.env.REDIS_URL });
        await client.connect();
        return client;
      },
      useFactory: true
    },
    { token: UserService }
  ]
});

// One call initializes everything
await container.initialize();
```

## Testing

`destroy()` resets the initialized state so you can call `initialize()` again between tests:

```typescript
beforeEach(async () => {
  container.destroy();
  await container.initialize();
});
```
