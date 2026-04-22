# NeoSyringe + NestJS Example

A full CRUD Cats API built with NestJS — where **all business logic is pure TypeScript** managed by NeoSyringe's compile-time DI.

## Why This Example Matters

Compare how you'd normally write a NestJS service vs. with NeoSyringe:

### Traditional NestJS

```typescript
// Every service needs @Injectable — NestJS-specific import
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

@Injectable()  // ← framework decorator on your domain class
export class CatsService {
  constructor(
    @InjectRepository(Cat)  // ← another decorator
    private repo: Repository<Cat>,
  ) {}
}
```

**Problems:**
- `@Injectable()` pollutes your domain with NestJS imports
- Unit tests need `TestingModule.createTestingModule(...)` to bootstrap NestJS
- Missing a dependency → runtime crash (`Nest can't resolve dependencies`)
- Switching frameworks means touching every service

### With NeoSyringe

```typescript
// Zero imports from @nestjs/*
export class CatsService {
  constructor(private readonly repository: ICatRepository) {}
}
```

**Benefits:**
- Domain classes are pure TypeScript — no framework coupling
- Missing a dependency → **build error**, not a runtime crash
- Unit tests: `new CatsService(mockRepo)` — instant, no bootstrap
- Switch frameworks? Your domain doesn't change

---

## Architecture

```
src/
├── domain/          ← Pure TypeScript — zero @nestjs/* imports
│   ├── cat.entity.ts
│   ├── i-cat-repository.ts
│   └── cats.service.ts      ← The service NeoSyringe manages
├── infrastructure/
│   └── in-memory-cat.repository.ts
├── di/
│   ├── container.ts          ← NeoSyringe wires everything at build time
│   └── neosyringe.module.ts  ← Thin NestJS bridge (3 lines)
└── http/
    └── cats.controller.ts    ← NestJS handles HTTP
```

### The Bridge (3 lines)

```typescript
// di/neosyringe.module.ts
@Module({
  providers: [{ provide: CatsService, useValue: container.resolve(CatsService) }],
  exports: [CatsService],
})
export class NeoSyringeModule {}
```

NestJS sees `CatsService` as a standard provider — it has no idea NeoSyringe is involved.

### Unit Tests Without NestJS

```typescript
// test/cats.service.spec.ts — runs in milliseconds, no server boot
describe('CatsService', () => {
  it('should create a cat', async () => {
    const service = new CatsService(new StubCatRepository());
    const cat = await service.create({ name: 'Kitty', age: 3, breed: 'Russian Blue' });
    expect(cat.name).toBe('Kitty');
  });
});
```

No `TestingModule`. No `@nestjs/testing`. No waiting for NestJS to initialize.

---

## Getting Started

```bash
pnpm install          # Also runs ts-patch install via "prepare" script
pnpm build            # tsc + NeoSyringe transformer → dist/main.js
pnpm start            # http://localhost:3000
```

```bash
pnpm test             # 6 unit tests — no NestJS bootstrap needed
```

## How It Works

NeoSyringe hooks into the TypeScript compiler via [ts-patch](https://github.com/nonara/ts-patch). No webpack, no Vite — just `tsc`.

```json
// tsconfig.json
{
  "compilerOptions": {
    "plugins": [
      { "name": "@djodjonx/neosyringe-lsp" },
      { "transform": "@djodjonx/neosyringe-plugin/transformer", "transformProgram": true }
    ]
  }
}
```

- `"name"` → IDE diagnostics (missing deps, type errors at design time)
- `"transform"` → Build-time transformation: replaces `defineBuilderConfig(...)` with generated factory code

## API

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/cats` | List all cats |
| `GET` | `/cats/:id` | Find cat by id |
| `POST` | `/cats` | Create cat `{name, age, breed}` |
| `DELETE` | `/cats/:id` | Remove cat |

## Note on `reflect-metadata`

NeoSyringe does **not** require `reflect-metadata`. Only NestJS's own HTTP layer (`@Controller`, `@Module`) needs it. Your domain services — the ones NeoSyringe manages — have zero dependency on reflection.
