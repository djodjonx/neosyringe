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

## Async Parent Containers (`useContainer`)

If a container has **no async factories of its own**, but its `useContainer` parent does, it still gets an `initialize()` — purely to cascade into the parent:

```typescript
// shared-kernel.ts — has an async factory
export const sharedKernel = defineBuilderConfig({
  injections: [
    {
      token: useInterface<IDatabase>(),
      provider: async () => { /* connect, etc. */ },
      useFactory: true
    }
  ]
});

// app.ts — no async factories of its own, but depends on the async parent
export const app = defineBuilderConfig({
  useContainer: sharedKernel,
  injections: [
    { token: UserService }  // constructor(private db: IDatabase) — sync code, no await anywhere
  ]
});
```

```typescript
// main.ts — one call is enough; you don't need to separately
// initialize sharedKernel yourself
await app.initialize();

const userService = app.resolve(UserService);
```

`app`'s generated `initialize()` (real output, trimmed) does nothing but cascade:

```typescript
public async initialize(): Promise<void> {
  if (this._initialized) return;
  if (this.legacy) { for (const c of this.legacy) { if (typeof c?.initialize === 'function') { await c.initialize(); } } }
  this._initialized = true;
}
```

This also means `app.resolve(...)` throws the same "call `await container.initialize()` first" guard if you forget — even though `app` itself has no async work, resolving before the cascade runs would mean `sharedKernel`'s async singleton might not be ready yet.

::: tip Works through any depth of `useContainer` chaining
The cascade check (`typeof c?.initialize === 'function'`) is a runtime check, not a static one — so it also covers a `declareContainerTokens` legacy adapter that happens to expose its own `initialize()`, and a multi-level `useContainer` chain (domain → infrastructure) cascades all the way down automatically.
:::

## Testing

`destroy()` resets the initialized state so you can call `initialize()` again between tests:

```typescript
beforeEach(async () => {
  container.destroy();
  await container.initialize();
});
```
