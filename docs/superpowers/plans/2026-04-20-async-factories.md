# Async Factories — Two-Phase Container Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow factory providers to be `async`, pre-initialized once via `await container.initialize()` at app startup. All subsequent `resolve()` calls stay synchronous — zero async impact on business code (Vue composables, services, controllers).

**Architecture:** The Analyzer detects `async` modifier on factory functions (via AST modifier check, not string matching) and sets `isAsync: true` on `ServiceDefinition`. Async factories are restricted to `singleton` lifecycle — the build step emits a compile error for `async + transient`. The Generator detects at least one `isAsync` node and, if present, emits an `initialize(): Promise<void>` method that pre-creates async singletons in topological order, plus an `_initialized` guard in `resolve()`. Containers with no async factories are unchanged — no `initialize()`, no guard.

**Tech Stack:** TypeScript Compiler API, Vitest, pnpm workspaces. Run tests with `pnpm --filter @djodjonx/neosyringe-core test`.

---

## File Map

| File | Change |
|---|---|
| `packages/neosyringe/src/types.ts` | Add `AsyncContainer` interface with `initialize(): Promise<void>` |
| `packages/core/src/analyzer/types.ts` | Add `isAsync?: boolean` to `ServiceDefinition` |
| `packages/core/src/analyzer/collectors/ConfigCollector.ts` | Detect async modifier, set `isAsync`, error on async+transient |
| `packages/core/src/generator/Generator.ts` | Detect async nodes, generate `initialize()` + `_initialized` guard |
| `packages/core/tests/analyzer/AsyncFactory.test.ts` | New: Analyzer tests |
| `packages/core/tests/generator/AsyncFactoryGenerator.test.ts` | New: Generator tests |
| `packages/core/tests/analyzer/AsyncFactoryIntegration.test.ts` | New: End-to-end test |

---

### Task 1: Extend types

**Files:**
- Modify: `packages/neosyringe/src/types.ts`
- Modify: `packages/core/src/analyzer/types.ts`

- [ ] **Step 1: Add `AsyncContainer` to public types**

In `packages/neosyringe/src/types.ts`, add after the `Container` interface:

```typescript
/**
 * Container with async-initialized services.
 * Call `await container.initialize()` once at app startup before any `resolve()`.
 *
 * Generated automatically when at least one injection uses an async factory.
 *
 * @example
 * ```typescript
 * // main.ts — only place with await
 * const container: AsyncContainer = defineBuilderConfig({ ... });
 * await container.initialize();
 *
 * // Everywhere else — stays sync
 * const db = container.resolve(useInterface<IDatabase>());
 * ```
 */
export interface AsyncContainer extends Container {
  /**
   * Pre-creates all async singleton services in dependency order.
   * Must be called before the first resolve() when async services are present.
   */
  initialize(): Promise<void>;
}
```

- [ ] **Step 2: Add `isAsync` to `ServiceDefinition`**

In `packages/core/src/analyzer/types.ts`, add to `ServiceDefinition`:

```typescript
export interface ServiceDefinition {
  // ... existing fields ...
  /** True if the factory function is async (requires initialize() before resolve()). */
  isAsync?: boolean;
}
```

- [ ] **Step 3: Commit**

```bash
git add packages/neosyringe/src/types.ts packages/core/src/analyzer/types.ts
git commit -m "feat(types): add AsyncContainer interface and isAsync to ServiceDefinition"
```

---

### Task 2: Analyzer — detect async factories and validate constraints

**Files:**
- Modify: `packages/core/src/analyzer/collectors/ConfigCollector.ts`
- Create: `packages/core/tests/analyzer/AsyncFactory.test.ts`

- [ ] **Step 1: Write failing tests**

Create `packages/core/tests/analyzer/AsyncFactory.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import * as ts from 'typescript';
import { Analyzer } from '../../src/analyzer/Analyzer';

const createProgram = (fileName: string, content: string) => {
  const host = ts.createCompilerHost({});
  const orig = host.getSourceFile;
  host.getSourceFile = (n, l) => n === fileName ? ts.createSourceFile(fileName, content, l) : orig(n, l);
  return ts.createProgram([fileName], {}, host);
};

describe('Analyzer - async factories', () => {
  it('should detect async arrow function factory and set isAsync', () => {
    const program = createProgram('test.ts', `
      function defineBuilderConfig(c: any) { return c; }
      function useInterface<T>(): any { return null; }

      interface IDatabase { query(sql: string): any; }

      export const container = defineBuilderConfig({
        injections: [
          {
            token: useInterface<IDatabase>(),
            provider: async () => ({ query: (sql: string) => [] }),
            useFactory: true
          }
        ]
      });
    `);

    const graph = new Analyzer(program).extract();
    const node = [...graph.nodes.values()].find(n => n.service.tokenId.includes('IDatabase'));

    expect(node).toBeDefined();
    expect(node!.service.isAsync).toBe(true);
    expect(node!.service.type).toBe('factory');
  });

  it('should set isAsync for async function expression', () => {
    const program = createProgram('test.ts', `
      function defineBuilderConfig(c: any) { return c; }
      function useInterface<T>(): any { return null; }

      interface ICache { get(key: string): any; }

      export const container = defineBuilderConfig({
        injections: [
          {
            token: useInterface<ICache>(),
            provider: async function() { return { get: (k: string) => null }; },
            useFactory: true
          }
        ]
      });
    `);

    const graph = new Analyzer(program).extract();
    const node = [...graph.nodes.values()].find(n => n.service.tokenId.includes('ICache'));

    expect(node!.service.isAsync).toBe(true);
  });

  it('should NOT set isAsync for sync factory', () => {
    const program = createProgram('test.ts', `
      function defineBuilderConfig(c: any) { return c; }
      function useInterface<T>(): any { return null; }

      interface ILogger { log(msg: string): void; }

      export const container = defineBuilderConfig({
        injections: [
          {
            token: useInterface<ILogger>(),
            provider: () => ({ log: (msg: string) => console.log(msg) }),
            useFactory: true
          }
        ]
      });
    `);

    const graph = new Analyzer(program).extract();
    const node = [...graph.nodes.values()].find(n => n.service.tokenId.includes('ILogger'));

    expect(node!.service.isAsync).toBeUndefined();
  });

  it('should emit an error for async factory with lifecycle: transient', () => {
    const program = createProgram('test.ts', `
      function defineBuilderConfig(c: any) { return c; }
      function useInterface<T>(): any { return null; }

      interface IDatabase { query(sql: string): any; }

      export const container = defineBuilderConfig({
        injections: [
          {
            token: useInterface<IDatabase>(),
            provider: async () => ({ query: (sql: string) => [] }),
            useFactory: true,
            lifecycle: 'transient'
          }
        ]
      });
    `);

    const graph = new Analyzer(program).extract();
    expect(graph.errors).toBeDefined();
    expect(graph.errors!.length).toBeGreaterThan(0);
    expect(graph.errors![0].message).toContain('transient');
    expect(graph.errors![0].message).toContain('async');
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
pnpm --filter @djodjonx/neosyringe-core test -- --reporter=verbose tests/analyzer/AsyncFactory.test.ts
```

Expected: FAIL — `isAsync` undefined for async factories; no error for async+transient.

- [ ] **Step 3: Add async detection helper to `ConfigCollector`**

In `packages/core/src/analyzer/collectors/ConfigCollector.ts`, add this private method:

```typescript
/**
 * Returns true if the expression is an async arrow function or async function expression.
 * Uses AST modifier check — more reliable than string matching.
 */
private isAsyncFunction(node: ts.Expression): boolean {
  if (!TSContext.ts.isArrowFunction(node) && !TSContext.ts.isFunctionExpression(node)) {
    return false;
  }
  const fn = node as ts.ArrowFunction | ts.FunctionExpression;
  return fn.modifiers?.some(
    m => m.kind === TSContext.ts.SyntaxKind.AsyncKeyword
  ) ?? false;
}
```

- [ ] **Step 4: Set `isAsync` and validate in `parseInjection()`**

In `parseInjection()`, after detecting `registrationType`:

```typescript
// Detect async factory
const isAsync = registrationType === 'factory' && providerNode
  ? this.isAsyncFunction(providerNode)
  : false;

// Validate: async + transient is disallowed
if (isAsync && lifecycle === 'transient') {
  // Return error signal — same pattern as primitive useValue check
  return {
    type: 'type-mismatch' as const,
    message:
      `Async factory for '${tokenText}' cannot use lifecycle: 'transient'. ` +
      `Async factories are pre-initialized once in initialize() and must be singletons. ` +
      `Remove lifecycle: 'transient' or make the factory synchronous.`,
    node: obj,
    sourceFile,
  } as any;
}
```

Then set `isAsync` on `ServiceDefinition`:

```typescript
const definition: ServiceDefinition = {
  tokenId,
  implementationSymbol,
  registrationNode: obj,
  type: registrationType,
  lifecycle,
  isInterfaceToken,
  factorySource: registrationType === 'factory' && providerNode ? providerNode.getText(sourceFile) : undefined,
  isScoped,
  isAsync: isAsync || undefined, // only set when true
};
```

The async+transient error flows through `valueErrors` (same pipeline added in `useValue` plan). If this plan is implemented independently, add an `asyncErrors: AnalysisError[]` array to `collectInjections()` with the same threading pattern used for `valueErrors`.

- [ ] **Step 5: Run tests**

```bash
pnpm --filter @djodjonx/neosyringe-core test -- --reporter=verbose tests/analyzer/AsyncFactory.test.ts
```

Expected: PASS all 4 tests.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/analyzer/collectors/ConfigCollector.ts packages/core/tests/analyzer/AsyncFactory.test.ts
git commit -m "feat(analyzer): detect async factories and reject async+transient combination"
```

---

### Task 3: Generator — emit `initialize()` and `_initialized` guard

**Files:**
- Modify: `packages/core/src/generator/Generator.ts`
- Create: `packages/core/tests/generator/AsyncFactoryGenerator.test.ts`

- [ ] **Step 1: Write failing generator tests**

Create `packages/core/tests/generator/AsyncFactoryGenerator.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import * as ts from 'typescript';
import { Generator } from '../../src/generator/Generator';
import { DependencyGraph, DependencyNode, ServiceDefinition } from '../../src/analyzer/types';

function mockNode(): ts.Node {
  return { getSourceFile: () => ({ fileName: '' }) } as unknown as ts.Node;
}

function asyncFactoryNode(tokenId: string, factorySource: string): DependencyNode {
  return {
    service: {
      tokenId,
      registrationNode: mockNode(),
      type: 'factory',
      lifecycle: 'singleton',
      isInterfaceToken: true,
      factorySource,
      isAsync: true,
    } as ServiceDefinition,
    dependencies: [],
  };
}

function syncFactoryNode(tokenId: string, factorySource: string): DependencyNode {
  return {
    service: {
      tokenId,
      registrationNode: mockNode(),
      type: 'factory',
      lifecycle: 'singleton',
      isInterfaceToken: true,
      factorySource,
      isAsync: undefined,
    } as ServiceDefinition,
    dependencies: [],
  };
}

describe('Generator - async factories', () => {
  it('should generate initialize() when any factory is async', () => {
    const graph: DependencyGraph = {
      containerId: 'Test',
      nodes: new Map([
        ['IDatabase_abc', asyncFactoryNode('IDatabase_abc', 'async () => createPool()')],
      ]),
      roots: [],
    };

    const code = new Generator(graph).generate();

    expect(code).toContain('public async initialize(): Promise<void>');
    expect(code).toContain('await this.create_IDatabase_abc()');
    expect(code).toContain('this.instances.set("IDatabase_abc"');
    expect(code).toContain('this._initialized = true');
  });

  it('should add _initialized guard to resolve()', () => {
    const graph: DependencyGraph = {
      containerId: 'Test',
      nodes: new Map([
        ['IDatabase_abc', asyncFactoryNode('IDatabase_abc', 'async () => createPool()')],
      ]),
      roots: [],
    };

    const code = new Generator(graph).generate();

    expect(code).toContain('private _initialized = false');
    expect(code).toContain('if (!this._initialized)');
    expect(code).toContain('await container.initialize()');
  });

  it('should NOT generate initialize() when all factories are sync', () => {
    const graph: DependencyGraph = {
      containerId: 'Test',
      nodes: new Map([
        ['ILogger_abc', syncFactoryNode('ILogger_abc', '() => ({ log: () => {} })')],
      ]),
      roots: [],
    };

    const code = new Generator(graph).generate();

    expect(code).not.toContain('initialize()');
    expect(code).not.toContain('_initialized');
  });

  it('should pre-initialize async singletons in topological order in initialize()', () => {
    const graph: DependencyGraph = {
      containerId: 'Test',
      nodes: new Map([
        ['IDatabase_abc', asyncFactoryNode('IDatabase_abc', 'async () => createPool()')],
        ['ICache_def', asyncFactoryNode('ICache_def', 'async (c) => createRedis()')],
      ]),
      roots: [],
    };

    const code = new Generator(graph).generate();

    // Both async singletons pre-created in initialize()
    expect(code).toContain('await this.create_IDatabase_abc()');
    expect(code).toContain('await this.create_ICache_def()');
  });

  it('should not pre-initialize sync services in initialize()', () => {
    const implSymbol = {
      getName: () => 'LoggerService',
      declarations: [{ getSourceFile: () => ({ fileName: '/src/logger.ts' }) }],
    } as unknown as ts.Symbol;

    const graph: DependencyGraph = {
      containerId: 'Test',
      nodes: new Map([
        ['IDatabase_abc', asyncFactoryNode('IDatabase_abc', 'async () => createPool()')],
        ['ILogger_def', {
          service: {
            tokenId: 'ILogger_def',
            implementationSymbol: implSymbol,
            registrationNode: mockNode(),
            type: 'explicit',
            lifecycle: 'singleton',
            isInterfaceToken: true,
          } as ServiceDefinition,
          dependencies: [],
        }],
      ]),
      roots: [],
    };

    const code = new Generator(graph).generate();

    // initialize() only pre-creates the async node
    const initMethod = code.split('async initialize()')[1]?.split('}')[0] ?? '';
    expect(initMethod).toContain('IDatabase_abc');
    expect(initMethod).not.toContain('ILogger_def');
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
pnpm --filter @djodjonx/neosyringe-core test -- --reporter=verbose tests/generator/AsyncFactoryGenerator.test.ts
```

Expected: FAIL — no `initialize()`, no `_initialized`.

- [ ] **Step 3: Add `hasAsyncFactories()` and `generateInitializeMethod()` to `Generator`**

In `packages/core/src/generator/Generator.ts`, add two private methods:

```typescript
/** Returns true if any node in the graph has an async factory. */
private hasAsyncFactories(): boolean {
  for (const node of this.graph.nodes.values()) {
    if (node.service.isAsync) return true;
  }
  return false;
}

/**
 * Generates the initialize() method that pre-creates all async singleton factories
 * in topological order. Only called when hasAsyncFactories() is true.
 */
private generateInitializeMethod(sorted: TokenId[]): string {
  const asyncSingletons = sorted.filter(tokenId => {
    const node = this.graph.nodes.get(tokenId);
    return node?.service.isAsync && node.service.lifecycle === 'singleton';
  });

  const lines = asyncSingletons.map(tokenId => {
    const factoryId = this.getFactoryName(tokenId);
    return `this.instances.set("${tokenId}", await ${factoryId.startsWith('this.') ? factoryId : `this.${factoryId}`}());`;
  });

  return `public async initialize(): Promise<void> {
    if (this._initialized) return;
    ${lines.join('\n    ')}
    this._initialized = true;
  }`;
}
```

- [ ] **Step 4: Update `generate()` to use `initialize()` and `_initialized` guard**

In `Generator.generate()`, update the template. Add `_initialized` field and the guard to `resolve()`, and include `initialize()` when needed:

```typescript
public generate(): string {
  const sorted = this.topologicalSort();
  const imports = new Map<string, string>();
  const hasAsync = this.hasAsyncFactories();

  const getImport = (symbol: ts.Symbol): string => {
    if (this.useDirectSymbolNames) return symbol.getName();
    const decl = symbol.declarations?.[0];
    if (!decl) return 'UNKNOWN';
    const filePath = decl.getSourceFile().fileName;
    if (!imports.has(filePath)) imports.set(filePath, `Import_${imports.size}`);
    return `${imports.get(filePath)}.${symbol.getName()}`;
  };

  const factories = this.generateFactories(sorted, getImport);
  const resolveCases = this.generateResolveCases(sorted, getImport);
  const multiFactories = this.generateMultiFactories(getImport);
  const resolveAllMethod = this.generateResolveAllMethod(getImport);
  const initializeMethod = hasAsync ? this.generateInitializeMethod(sorted) : '';

  const importLines: string[] = [];
  if (!this.useDirectSymbolNames) {
    for (const [filePath, alias] of imports) {
      importLines.push(`import * as ${alias} from '${filePath}';`);
    }
  }

  const initializedField = hasAsync ? `private _initialized = false;` : '';

  const resolveGuard = hasAsync
    ? `if (!this._initialized) {
      throw new Error(
        \`[\${this.name}] Ce container a des services async — appelle \\\`await container.initialize()\\\` avant le premier resolve().\`
      );
    }`
    : '';

  return `
${importLines.join('\n')}

// -- Container --
class NeoContainer {
  private instances = new Map<any, any>();
  ${initializedField}

  // -- Factories --
  ${[...factories, ...multiFactories].join('\n  ')}

  constructor(
    private parent?: any,
    private legacy?: any[],
    private name: string = 'NeoContainer'
  ) {}

  ${initializeMethod}

  public resolve<T>(token: any): T {
    ${resolveGuard}
    const result = this.resolveLocal(token);
    if (result !== undefined) return result;

    if (this.parent) {
        try {
            return this.parent.resolve(token);
        } catch (e: any) {
            if (!e?.message?.includes('Service not found or token not registered')) throw e;
        }
    }

    if (this.legacy) {
        for (const legacyContainer of this.legacy) {
            try {
                if (legacyContainer.resolve) return legacyContainer.resolve(token);
            } catch (e: any) {
                if (!e?.message?.includes('Service not found or token not registered')) throw e;
            }
        }
    }

    throw new Error(\`[\${this.name}] Service not found or token not registered: \${token}\`);
  }

  ${resolveAllMethod}

  private resolveLocal(token: any): any {
    ${resolveCases.join('\n    ')}
    return undefined;
  }

  public destroy(): void {
    this._initialized = false;
    this.instances.clear();
  }

  public get _graph() {
    return ${JSON.stringify(Array.from(this.graph.nodes.keys()))};
  }
}
${this.useDirectSymbolNames ? '' : this.generateContainerVariable()}`;
}
```

Note: `destroy()` also resets `_initialized` so `initialize()` can be called again (useful in tests).

- [ ] **Step 5: Run generator tests**

```bash
pnpm --filter @djodjonx/neosyringe-core test -- --reporter=verbose tests/generator/AsyncFactoryGenerator.test.ts
```

Expected: PASS all 5 tests.

- [ ] **Step 6: Run full suite**

```bash
pnpm test
```

Expected: all packages pass.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/generator/Generator.ts packages/core/tests/generator/AsyncFactoryGenerator.test.ts
git commit -m "feat(generator): emit initialize() and _initialized guard for async factories"
```

---

### Task 4: End-to-end integration test

**Files:**
- Create: `packages/core/tests/analyzer/AsyncFactoryIntegration.test.ts`

- [ ] **Step 1: Write integration tests**

Create `packages/core/tests/analyzer/AsyncFactoryIntegration.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import * as ts from 'typescript';
import { Analyzer } from '../../src/analyzer/Analyzer';
import { Generator } from '../../src/generator/Generator';

const createProgram = (fileName: string, content: string) => {
  const host = ts.createCompilerHost({});
  const orig = host.getSourceFile;
  host.getSourceFile = (n, l) => n === fileName ? ts.createSourceFile(fileName, content, l) : orig(n, l);
  return ts.createProgram([fileName], {}, host);
};

describe('Async factories — Analyzer to Generator integration', () => {
  it('should generate initialize() for async factory', () => {
    const program = createProgram('container.ts', `
      function defineBuilderConfig(c: any) { return c; }
      function useInterface<T>(): any { return null; }

      interface IDatabase { query(sql: string): any; }
      class UserService { constructor(private db: IDatabase) {} }

      export const container = defineBuilderConfig({
        injections: [
          {
            token: useInterface<IDatabase>(),
            provider: async () => {
              const pool = { query: (sql: string) => [] };
              return pool;
            },
            useFactory: true
          },
          { token: UserService }
        ]
      });
    `);

    const graph = new Analyzer(program).extract();
    expect(graph.errors ?? []).toHaveLength(0);

    // isAsync is set on the DB node
    const dbNode = [...graph.nodes.values()].find(n => n.service.tokenId.includes('IDatabase'));
    expect(dbNode!.service.isAsync).toBe(true);

    // UserService has no isAsync
    const userNode = [...graph.nodes.values()].find(n => n.service.tokenId.includes('UserService'));
    expect(userNode!.service.isAsync).toBeFalsy();

    const code = new Generator(graph, true).generate();

    // initialize() is generated
    expect(code).toContain('public async initialize(): Promise<void>');
    // DB is pre-created in initialize()
    expect(code).toContain('await this.create_');
    expect(code).toContain('IDatabase');
    // UserService is NOT pre-created in initialize() (it's sync)
    const initSection = code.split('async initialize()')[1]?.split('public resolve')[0] ?? '';
    expect(initSection).not.toContain('UserService');
    // resolve() has the guard
    expect(code).toContain('if (!this._initialized)');
  });

  it('should NOT generate initialize() for all-sync container', () => {
    const program = createProgram('container.ts', `
      function defineBuilderConfig(c: any) { return c; }
      function useInterface<T>(): any { return null; }

      interface ILogger { log(msg: string): void; }
      class ConsoleLogger { log(msg: string) { console.log(msg); } }

      export const container = defineBuilderConfig({
        injections: [
          { token: useInterface<ILogger>(), provider: ConsoleLogger }
        ]
      });
    `);

    const graph = new Analyzer(program).extract();
    const code = new Generator(graph, true).generate();

    expect(code).not.toContain('initialize()');
    expect(code).not.toContain('_initialized');
  });

  it('should emit error for async factory with transient lifecycle', () => {
    const program = createProgram('container.ts', `
      function defineBuilderConfig(c: any) { return c; }
      function useInterface<T>(): any { return null; }

      interface IDatabase { query(sql: string): any; }

      export const container = defineBuilderConfig({
        injections: [
          {
            token: useInterface<IDatabase>(),
            provider: async () => ({ query: (sql: string) => [] }),
            useFactory: true,
            lifecycle: 'transient'
          }
        ]
      });
    `);

    const graph = new Analyzer(program).extract();
    expect(graph.errors!.length).toBeGreaterThan(0);
    expect(graph.errors![0].message).toContain('transient');
    expect(graph.errors![0].message).toContain('async');
  });

  it('should reset _initialized in destroy() to allow re-initialization in tests', () => {
    const program = createProgram('container.ts', `
      function defineBuilderConfig(c: any) { return c; }
      function useInterface<T>(): any { return null; }

      interface IDatabase { query(sql: string): any; }

      export const container = defineBuilderConfig({
        injections: [
          {
            token: useInterface<IDatabase>(),
            provider: async () => ({ query: (sql: string) => [] }),
            useFactory: true
          }
        ]
      });
    `);

    const graph = new Analyzer(program).extract();
    const code = new Generator(graph, true).generate();

    // destroy() resets _initialized so test suites can call initialize() again
    expect(code).toContain('destroy()');
    const destroySection = code.split('public destroy()')[1]?.split('}')[0] ?? '';
    expect(destroySection).toContain('_initialized = false');
  });
});
```

- [ ] **Step 2: Run integration tests**

```bash
pnpm --filter @djodjonx/neosyringe-core test -- --reporter=verbose tests/analyzer/AsyncFactoryIntegration.test.ts
```

Expected: PASS all 4 tests.

- [ ] **Step 3: Run all tests in all packages**

```bash
pnpm test
```

Expected: all packages pass.

- [ ] **Step 4: Commit**

```bash
git add packages/core/tests/analyzer/AsyncFactoryIntegration.test.ts
git commit -m "test(async): add end-to-end integration tests for async factory two-phase container"
```

---

## Usage Documentation (for CLAUDE.md or README)

The pattern for users — document this clearly:

```typescript
// container.ts — async factory registered normally
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
      // lifecycle: 'singleton' is the default — required for async factories
    },
    { token: UserService } // depends on IDatabase — no change needed
  ]
});

// main.ts (Vue, Node.js, etc.)
await container.initialize(); // one await, at startup only

// composables / services / controllers — zero async
const userService = container.resolve(useInterface<IUserService>()); // sync
```

---

## Self-Review Checklist

- [x] `AsyncContainer` interface with `initialize(): Promise<void>` — Task 1
- [x] `isAsync?: boolean` on `ServiceDefinition` — Task 1
- [x] Async detection via AST modifier (not string match) — Task 2
- [x] async function expression also detected — Task 2 test
- [x] `isAsync` NOT set for sync factories — Task 2 test
- [x] Error emitted for `async + transient` — Task 2
- [x] `initialize()` generated only when async factories present — Task 3 test
- [x] Only async singleton nodes pre-created in `initialize()` — Task 3 test
- [x] Sync services NOT in `initialize()` — Task 3 test
- [x] `_initialized` guard in `resolve()` — Task 3
- [x] `destroy()` resets `_initialized` (test re-initialization) — Task 4 test
- [x] No `initialize()` for all-sync container — Task 4 test
- [x] Full suite passes — Task 4
