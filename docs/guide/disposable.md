# Disposable Services

Release resources (database connections, file handles, subscriptions) automatically when the container is destroyed.

## The Problem

Services that hold external resources need explicit cleanup. Without a lifecycle hook, resources leak when you replace or shut down a container.

## The Solution

Implement `IDisposable` or `IAsyncDisposable`. NeoSyringe calls `dispose()` automatically when `container.destroy()` is invoked.

```typescript
import { IDisposable, IAsyncDisposable } from '@djodjonx/neosyringe';

// Sync cleanup
class DbConnection implements IDisposable {
  private pool = new Pool();

  query(sql: string) { return this.pool.query(sql); }

  dispose(): void {
    this.pool.end();
  }
}

// Async cleanup
class RedisClient implements IAsyncDisposable {
  private client = createClient();

  async get(key: string) { return this.client.get(key); }

  async dispose(): Promise<void> {
    await this.client.quit();
  }
}

export const container = defineBuilderConfig({
  injections: [
    { token: DbConnection },
    { token: RedisClient },
  ]
});
```

```typescript
// Shutdown
await container.destroy();
// DbConnection.dispose() and RedisClient.dispose() are called automatically
```

## How It Works

NeoSyringe detects `dispose()` at compile time by inspecting the class's declared type. The generated `destroy()` method:

1. Calls `dispose()` on each cached singleton **in reverse dependency order** (dependents before dependencies)
2. Checks `instances.has()` first — services never resolved are skipped
3. Clears the instance cache last

If any service has `dispose(): Promise<void>`, the generated `destroy()` becomes `async`.

## Constraints

::: warning Singletons Only
Only singleton services (the default lifecycle) are disposed. Transient services are not cached, so `destroy()` cannot track them. Manage transient resource cleanup in your own code.
:::

::: tip Factories Excluded
Factory providers (`useFactory: true`) are excluded from auto-detection — the return type of an arbitrary function cannot be inspected statically. If a factory returns a disposable, wrap it in a class that implements `IDisposable`.
:::

## Dispose Order

Services are disposed in reverse dependency order: if `UserService` depends on `DbConnection`, then `UserService.dispose()` is called before `DbConnection.dispose()`.

## Testing

```typescript
beforeEach(async () => {
  await container.destroy(); // clears instances + calls dispose()
  // Note: destroy() resets _initialized for async containers
});
```
