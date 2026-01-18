# Legacy Migration

Bridge existing DI containers (tsyringe, InversifyJS) while migrating to Neosyringe.

## Overview

You don't have to migrate everything at once. Neosyringe can delegate resolution to any container that has a `resolve()` method.

```typescript
// Bridge your existing container
export const container = defineBuilderConfig({
  useContainer: legacyContainer,  // Delegate to legacy
  injections: [
    { token: NewService }  // New services in Neosyringe
  ]
});
```

## With tsyringe

### Step 1: Keep Your Existing Setup

```typescript
// legacy-container.ts (existing tsyringe code)
import 'reflect-metadata';
import { container, injectable } from 'tsyringe';

@injectable()
export class AuthService {
  validateToken(token: string) { return true; }
}

@injectable()
export class LegacyUserRepository {
  findById(id: string) { return { id, name: 'John' }; }
}

// Register in tsyringe
container.registerSingleton(AuthService);
container.registerSingleton(LegacyUserRepository);

export { container as legacyContainer };
```

### Step 2: Declare Legacy Tokens

Use `declareContainerTokens` for type-safety:

```typescript
// container.ts
import { defineBuilderConfig, declareContainerTokens, useInterface } from '@djodjonx/neosyringe';
import { legacyContainer, AuthService, LegacyUserRepository } from './legacy-container';

// Declare what the legacy container provides
const legacy = declareContainerTokens<{
  AuthService: AuthService;
  LegacyUserRepository: LegacyUserRepository;
}>(legacyContainer);
```

### Step 3: Bridge and Extend

```typescript
// New services using Neosyringe
interface ILogger {
  log(msg: string): void;
}

class ConsoleLogger implements ILogger {
  log(msg: string) { console.log(msg); }
}

class UserService {
  constructor(
    private auth: AuthService,           // From legacy!
    private repo: LegacyUserRepository,  // From legacy!
    private logger: ILogger              // From neo-syringe
  ) {}
}

export const appContainer = defineBuilderConfig({
  name: 'AppContainer',
  useContainer: legacy,  // 👈 Bridge to legacy
  injections: [
    { token: useInterface<ILogger>(), provider: ConsoleLogger },
    { token: UserService }
  ]
});
```

### Step 4: Use It

```typescript
// main.ts
import { appContainer } from './container';

const userService = appContainer.resolve(UserService);
// ✅ AuthService and LegacyUserRepository come from tsyringe
// ✅ ILogger comes from neo-syringe
```

## With InversifyJS

```typescript
// legacy-inversify.ts
import 'reflect-metadata';
import { Container, injectable } from 'inversify';

@injectable()
class DatabaseConnection {
  query(sql: string) { return []; }
}

const inversifyContainer = new Container();
inversifyContainer.bind(DatabaseConnection).toSelf().inSingletonScope();

export { inversifyContainer, DatabaseConnection };
```

```typescript
// container.ts
import { defineBuilderConfig, declareContainerTokens } from '@djodjonx/neosyringe';
import { inversifyContainer, DatabaseConnection } from './legacy-inversify';

const legacy = declareContainerTokens<{
  DatabaseConnection: DatabaseConnection;
}>(inversifyContainer);

class ReportService {
  constructor(private db: DatabaseConnection) {}
}

export const container = defineBuilderConfig({
  useContainer: legacy,
  injections: [
    { token: ReportService }
  ]
});
```

## With Awilix

```typescript
// legacy-awilix.ts
import { createContainer, asClass } from 'awilix';

class EmailService {
  send(to: string, subject: string) { /* ... */ }
}

const awilixContainer = createContainer();
awilixContainer.register({
  emailService: asClass(EmailService).singleton()
});

// Awilix uses different API, create wrapper
export const legacyContainer = {
  resolve(token: any) {
    return awilixContainer.resolve(token.name ?? token);
  }
};
```

```typescript
// container.ts
import { defineBuilderConfig, declareContainerTokens } from '@djodjonx/neosyringe';
import { legacyContainer, EmailService } from './legacy-awilix';

const legacy = declareContainerTokens<{
  EmailService: EmailService;
}>(legacyContainer);

export const container = defineBuilderConfig({
  useContainer: legacy,
  injections: [
    { token: NotificationService }  // Uses EmailService from Awilix
  ]
});
```

## How It Works

### At Compile-Time

1. `declareContainerTokens<T>()` is analyzed
2. Type `T` properties are extracted (e.g., `{ AuthService, UserRepo }`)
3. These tokens are added to `parentProvidedTokens`
4. GraphValidator accepts them as valid dependencies
5. Generator outputs: `new NeoContainer(undefined, [legacyContainer])`

### At Runtime

```typescript
// Generated code (simplified)
class NeoContainer {
  constructor(
    private parent?: any,
    private legacy?: any[]  // ← Your tsyringe/inversify container
  ) {}

  resolve(token: any): any {
    // 1. Try local resolution
    const local = this.resolveLocal(token);
    if (local !== undefined) return local;

    // 2. Delegate to parent (Neosyringe container)
    if (this.parent) {
      try { return this.parent.resolve(token); }
      catch { /* continue */ }
    }

    // 3. Delegate to legacy containers
    if (this.legacy) {
      for (const container of this.legacy) {
        try { return container.resolve(token); }  // ← Calls tsyringe!
        catch { /* try next */ }
      }
    }

    throw new Error(`Service not found: ${token}`);
  }
}
```

## Validation

Neosyringe validates legacy bindings at compile-time:

| Check | Description |
|-------|-------------|
| ✅ Missing binding | Error if dependency not in local OR legacy container |
| ✅ Duplicate detection | Error if token already registered in legacy |
| ✅ Type safety | `declareContainerTokens<T>()` provides TypeScript types |

## Migration Strategy

### Phase 1: Bridge Everything

```typescript
const legacy = declareContainerTokens<{
  ServiceA: ServiceA;
  ServiceB: ServiceB;
  ServiceC: ServiceC;
  // ... all services
}>(tsyringeContainer);

export const container = defineBuilderConfig({
  useContainer: legacy,
  injections: []  // Nothing new yet
});
```

### Phase 2: New Services in Neosyringe

```typescript
export const container = defineBuilderConfig({
  useContainer: legacy,
  injections: [
    { token: NewServiceD },
    { token: NewServiceE }
  ]
});
```

### Phase 3: Migrate One at a Time

```typescript
// Remove ServiceA from legacy declaration
const legacy = declareContainerTokens<{
  ServiceB: ServiceB;
  ServiceC: ServiceC;
}>(tsyringeContainer);

// Add to Neosyringe
export const container = defineBuilderConfig({
  useContainer: legacy,
  injections: [
    { token: ServiceA },  // Migrated!
    { token: NewServiceD },
    { token: NewServiceE }
  ]
});
```

### Phase 4: Complete Migration

```typescript
// No more legacy!
export const container = defineBuilderConfig({
  injections: [
    { token: ServiceA },
    { token: ServiceB },
    { token: ServiceC },
    { token: NewServiceD },
    { token: NewServiceE }
  ]
});
```

## Tips

### Keep Legacy Container Isolated

Put legacy code in a separate file that you can eventually delete:

```
src/
├── legacy/
│   └── container.ts      # Will be deleted later
├── container.ts          # Neosyringe
└── services/
    ├── legacy/           # To be migrated
    └── new/              # Pure TypeScript
```

### Test Both Paths

Ensure services work whether resolved from legacy or Neosyringe:

```typescript
describe('UserService', () => {
  it('works from legacy container', () => {
    const service = legacyContainer.resolve(UserService);
    expect(service).toBeDefined();
  });
  
  it('works from neo-syringe container', () => {
    const service = container.resolve(UserService);
    expect(service).toBeDefined();
  });
});
```

