# resolveAll() — Multi-Registration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow multiple providers to be registered under the same token with `multi: true`, resolved together via `container.resolveAll(token)` — enabling plugin/middleware/strategy patterns.

**Architecture:** The Analyzer stores multi-registrations in a separate `multiInjections: Map<TokenId, InjectionInfo[]>` on `ConfigGraph` (parallel to `localInjections`), propagated to a `multiNodes: Map<TokenId, DependencyNode[]>` on `DependencyGraph`. The Generator emits indexed factory methods (`create_IMiddleware_hash_0`, `create_IMiddleware_hash_1`) and a `resolveAll()` method. `DuplicateValidator` skips the duplicate error when all registrations for a token have `multi: true`.

**Tech Stack:** TypeScript Compiler API, Vitest, pnpm workspaces. Run tests with `pnpm --filter @djodjonx/neosyringe-core test`.

---

## File Map

| File | Change |
|---|---|
| `packages/neosyringe/src/types.ts` | Add `multi?: boolean` to `Injection`, add `resolveAll` to `Container` |
| `packages/core/src/analyzer/types.ts` | Add `multiInjections` to `ConfigGraph`, add `multiNodes` to `DependencyGraph` |
| `packages/core/src/analyzer/collectors/ConfigCollector.ts` | Detect `multi: true`, populate `multiInjections` |
| `packages/core/src/analyzer/validators/DuplicateValidator.ts` | Skip error when token has all-multi registrations |
| `packages/core/src/analyzer/resolvers/ParentContainerResolver.ts` | Propagate `multiNodes` from `ConfigGraph` to `DependencyGraph` |
| `packages/core/src/generator/Generator.ts` | Generate indexed factories + `resolveAll()` method |
| `packages/core/tests/analyzer/MultiRegistration.test.ts` | New: Analyzer tests |
| `packages/core/tests/generator/MultiRegistrationGenerator.test.ts` | New: Generator tests |

---

### Task 1: Extend public and core types

**Files:**
- Modify: `packages/neosyringe/src/types.ts`
- Modify: `packages/core/src/analyzer/types.ts`

- [ ] **Step 1: Add `multi` to `Injection` and `resolveAll` to `Container`**

In `packages/neosyringe/src/types.ts`:

```typescript
export interface Injection<T = any> {
  token: Token<T>;
  provider?: Provider<T>;
  useFactory?: boolean;
  useValue?: T;
  lifecycle?: Lifecycle;
  scoped?: boolean;
  /**
   * When true, multiple registrations for the same token are allowed.
   * All multi-registrations for a token are collected by resolveAll().
   *
   * @example
   * { token: useInterface<IMiddleware>(), provider: AuthMiddleware, multi: true }
   * { token: useInterface<IMiddleware>(), provider: LogMiddleware, multi: true }
   *
   * // In your server:
   * const middlewares = container.resolveAll<IMiddleware>(useInterface<IMiddleware>());
   */
  multi?: boolean;
}

export interface Container {
  resolve<T>(token: Token<T>): T;
  /**
   * Resolves all registrations for a token registered with `multi: true`.
   * Returns an empty array if no multi-registrations exist for the token.
   */
  resolveAll<T>(token: Token<T>): T[];
  destroy(): void;
}
```

- [ ] **Step 2: Add `multiInjections` to `ConfigGraph` and `multiNodes` to `DependencyGraph`**

In `packages/core/src/analyzer/types.ts`:

In `ConfigGraph`:
```typescript
/** Multi-registrations (token -> ordered list of injection infos) */
multiInjections: Map<TokenId, InjectionInfo[]>;
```

In `DependencyGraph`:
```typescript
/** Multi-registration nodes (token -> ordered list of nodes) */
multiNodes?: Map<TokenId, DependencyNode[]>;
```

- [ ] **Step 3: Commit**

```bash
git add packages/neosyringe/src/types.ts packages/core/src/analyzer/types.ts
git commit -m "feat(types): add multi registration support to Injection and Container"
```

---

### Task 2: Analyzer — collect multi-registrations

**Files:**
- Modify: `packages/core/src/analyzer/collectors/ConfigCollector.ts`
- Create: `packages/core/tests/analyzer/MultiRegistration.test.ts`

- [ ] **Step 1: Write failing tests**

Create `packages/core/tests/analyzer/MultiRegistration.test.ts`:

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

describe('Analyzer - multi registrations', () => {
  it('should collect multi-registrations in multiNodes', () => {
    const program = createProgram('test.ts', `
      function defineBuilderConfig(c: any) { return c; }
      function useInterface<T>(): any { return null; }

      interface IMiddleware { handle(req: any): void; }
      class AuthMiddleware implements IMiddleware { handle(req: any) {} }
      class LogMiddleware implements IMiddleware { handle(req: any) {} }

      export const container = defineBuilderConfig({
        injections: [
          { token: useInterface<IMiddleware>(), provider: AuthMiddleware, multi: true },
          { token: useInterface<IMiddleware>(), provider: LogMiddleware, multi: true },
        ]
      });
    `);

    const graph = new Analyzer(program).extract();

    // Should not be in regular nodes (single-resolve)
    const inNodes = [...graph.nodes.keys()].some(k => k.includes('IMiddleware'));
    expect(inNodes).toBe(false);

    // Should be in multiNodes
    expect(graph.multiNodes).toBeDefined();
    const multiEntry = [...graph.multiNodes!.entries()].find(([k]) => k.includes('IMiddleware'));
    expect(multiEntry).toBeDefined();
    expect(multiEntry![1]).toHaveLength(2);
  });

  it('should emit a duplicate error when one has multi and one does not', () => {
    const program = createProgram('test.ts', `
      function defineBuilderConfig(c: any) { return c; }
      function useInterface<T>(): any { return null; }

      interface IMiddleware { handle(req: any): void; }
      class AuthMiddleware implements IMiddleware { handle(req: any) {} }
      class LogMiddleware implements IMiddleware { handle(req: any) {} }

      export const container = defineBuilderConfig({
        injections: [
          { token: useInterface<IMiddleware>(), provider: AuthMiddleware },
          { token: useInterface<IMiddleware>(), provider: LogMiddleware, multi: true },
        ]
      });
    `);

    const graph = new Analyzer(program).extract();
    expect(graph.errors).toBeDefined();
    expect(graph.errors!.length).toBeGreaterThan(0);
    expect(graph.errors![0].message).toContain('multi');
  });

  it('should not treat multi-registrations as duplicates', () => {
    const program = createProgram('test.ts', `
      function defineBuilderConfig(c: any) { return c; }
      function useInterface<T>(): any { return null; }

      interface IPlugin { execute(): void; }
      class PluginA implements IPlugin { execute() {} }
      class PluginB implements IPlugin { execute() {} }
      class PluginC implements IPlugin { execute() {} }

      export const container = defineBuilderConfig({
        injections: [
          { token: useInterface<IPlugin>(), provider: PluginA, multi: true },
          { token: useInterface<IPlugin>(), provider: PluginB, multi: true },
          { token: useInterface<IPlugin>(), provider: PluginC, multi: true },
        ]
      });
    `);

    const graph = new Analyzer(program).extract();
    expect(graph.errors ?? []).toHaveLength(0);

    const multiEntry = [...graph.multiNodes!.entries()].find(([k]) => k.includes('IPlugin'));
    expect(multiEntry![1]).toHaveLength(3);
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
pnpm --filter @djodjonx/neosyringe-core test -- --reporter=verbose tests/analyzer/MultiRegistration.test.ts
```

Expected: FAIL — multiNodes is undefined, duplicate errors thrown for multi registrations.

- [ ] **Step 3: Detect `multi: true` in `ConfigCollector.parseInjection()`**

In `packages/core/src/analyzer/collectors/ConfigCollector.ts`, add `multi` detection to `parseInjection()`:

```typescript
// Add inside the switch in parseInjection():
case 'multi':
  if (prop.initializer.kind === TSContext.ts.SyntaxKind.TrueKeyword) {
    isMulti = true;
  }
  break;
```

Add `let isMulti = false;` at the top of `parseInjection()`.

Add `isMulti` to the returned `InjectionInfo`. First, extend `InjectionInfo` in `types.ts`:

```typescript
export interface InjectionInfo {
  definition: ServiceDefinition;
  node: Node;
  tokenText: string;
  isScoped: boolean;
  /** True when registered with multi: true */
  isMulti?: boolean;
}
```

In `parseInjection()`, set `isMulti` on the returned object:
```typescript
return { definition, node: obj, tokenText, isScoped, isMulti };
```

- [ ] **Step 4: Populate `multiInjections` in `collectInjections()`**

Update `collectInjections()` to return `multiInjections`:

```typescript
private collectInjections(
  configObj: ts.ObjectLiteralExpression,
  sourceFile: ts.SourceFile
): {
  injections: Map<TokenId, InjectionInfo>;
  duplicates: InjectionInfo[];
  multiInjections: Map<TokenId, InjectionInfo[]>;
  valueErrors: AnalysisError[];
} {
  const injections = new Map<TokenId, InjectionInfo>();
  const duplicates: InjectionInfo[] = [];
  const multiInjections = new Map<TokenId, InjectionInfo[]>();
  const valueErrors: AnalysisError[] = [];

  const injectionsProperty = this.findProperty(configObj, 'injections');
  if (!injectionsProperty || !TSContext.ts.isArrayLiteralExpression(injectionsProperty.initializer)) {
    return { injections, duplicates, multiInjections, valueErrors };
  }

  for (const element of injectionsProperty.initializer.elements) {
    if (!TSContext.ts.isObjectLiteralExpression(element)) continue;

    const result = this.parseInjectionOrError(element, sourceFile);
    if (!result) continue;

    if ('type' in result && 'message' in result) {
      valueErrors.push(result as AnalysisError);
      continue;
    }

    const info = result as InjectionInfo;

    if (info.isMulti) {
      const existing = multiInjections.get(info.definition.tokenId) ?? [];
      existing.push(info);
      multiInjections.set(info.definition.tokenId, existing);
    } else if (injections.has(info.definition.tokenId)) {
      duplicates.push(info);
    } else {
      injections.set(info.definition.tokenId, info);
    }
  }

  return { injections, duplicates, multiInjections, valueErrors };
}
```

Update `parseConfig()` to destructure `multiInjections` and include it in the returned `ConfigGraph`.

- [ ] **Step 5: Validate mixed multi / non-multi in `DuplicateValidator`**

In `packages/core/src/analyzer/validators/DuplicateValidator.ts`, add a check for tokens that appear in both `localInjections` and `multiInjections`:

```typescript
validate(config: ConfigGraph, context: ValidationContext): AnalysisError[] {
  const errors = super_validate(config, context); // existing logic

  // Check for mixed multi/non-multi for same token
  for (const [tokenId, multiList] of (config.multiInjections ?? [])) {
    if (config.localInjections.has(tokenId)) {
      const info = multiList[0];
      errors.push({
        type: 'duplicate',
        message: `Token '${info.tokenText}' is registered both with and without 'multi: true'. ` +
          `All registrations for a token must consistently use multi: true or not at all.`,
        node: info.node,
        sourceFile: config.sourceFile,
      });
    }
  }

  return errors;
}
```

- [ ] **Step 6: Propagate `multiNodes` in `ParentContainerResolver` / Analyzer**

In `packages/core/src/analyzer/Analyzer.ts`, after building `graph.nodes`, populate `graph.multiNodes` from `config.multiInjections`. Locate the method that converts `ConfigGraph` → `DependencyGraph` (in `extract()`). After `graph.nodes` is populated, add:

```typescript
// Build multiNodes from multiInjections
if (config.multiInjections && config.multiInjections.size > 0) {
  graph.multiNodes = new Map();
  for (const [tokenId, infoList] of config.multiInjections) {
    const depNodes: DependencyNode[] = infoList.map(info => ({
      service: info.definition,
      dependencies: [],
    }));
    graph.multiNodes.set(tokenId, depNodes);
  }
  // Resolve dependencies for each multi-node
  for (const depNodes of graph.multiNodes.values()) {
    for (const depNode of depNodes) {
      this.dependencyResolver.resolve(depNode, graph);
    }
  }
}
```

- [ ] **Step 7: Run tests**

```bash
pnpm --filter @djodjonx/neosyringe-core test -- --reporter=verbose tests/analyzer/MultiRegistration.test.ts
```

Expected: PASS all 3 tests.

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/analyzer/collectors/ConfigCollector.ts packages/core/src/analyzer/types.ts packages/core/src/analyzer/validators/DuplicateValidator.ts packages/core/src/analyzer/Analyzer.ts packages/core/tests/analyzer/MultiRegistration.test.ts
git commit -m "feat(analyzer): collect multi-registrations into multiNodes"
```

---

### Task 3: Generator — emit indexed factories and `resolveAll()`

**Files:**
- Modify: `packages/core/src/generator/Generator.ts`
- Create: `packages/core/tests/generator/MultiRegistrationGenerator.test.ts`

- [ ] **Step 1: Write failing generator tests**

Create `packages/core/tests/generator/MultiRegistrationGenerator.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import * as ts from 'typescript';
import { Generator } from '../../src/generator/Generator';
import { DependencyGraph, DependencyNode, ServiceDefinition } from '../../src/analyzer/types';

function mockNode(): ts.Node {
  return { getSourceFile: () => ({ fileName: '' }) } as unknown as ts.Node;
}

function classNode(tokenId: string, implName: string, filePath: string): DependencyNode {
  return {
    service: {
      tokenId,
      implementationSymbol: {
        getName: () => implName,
        declarations: [{ getSourceFile: () => ({ fileName: filePath }) }],
      } as unknown as ts.Symbol,
      registrationNode: mockNode(),
      type: 'explicit',
      lifecycle: 'singleton',
      isInterfaceToken: true,
    } as ServiceDefinition,
    dependencies: [],
  };
}

describe('Generator - resolveAll', () => {
  it('should generate indexed factories for multi-nodes', () => {
    const tokenId = 'IMiddleware_abc';
    const graph: DependencyGraph = {
      containerId: 'Test',
      nodes: new Map(),
      roots: [],
      multiNodes: new Map([
        [tokenId, [
          classNode(tokenId, 'AuthMiddleware', '/src/auth.ts'),
          classNode(tokenId, 'LogMiddleware', '/src/log.ts'),
        ]],
      ]),
    };

    const code = new Generator(graph).generate();

    expect(code).toContain('create_IMiddleware_abc_0');
    expect(code).toContain('create_IMiddleware_abc_1');
    expect(code).toContain('new Import_0.AuthMiddleware()');
    expect(code).toContain('new Import_1.LogMiddleware()');
  });

  it('should generate resolveAll() method', () => {
    const tokenId = 'IPlugin_def';
    const graph: DependencyGraph = {
      containerId: 'Test',
      nodes: new Map(),
      roots: [],
      multiNodes: new Map([
        [tokenId, [
          classNode(tokenId, 'PluginA', '/src/a.ts'),
          classNode(tokenId, 'PluginB', '/src/b.ts'),
        ]],
      ]),
    };

    const code = new Generator(graph).generate();

    expect(code).toContain('public resolveAll<T>(token: any): T[]');
    expect(code).toContain('"IPlugin_def"');
    expect(code).toContain('this.create_IPlugin_def_0()');
    expect(code).toContain('this.create_IPlugin_def_1()');
  });

  it('should return empty array for unknown token in resolveAll', () => {
    const graph: DependencyGraph = {
      containerId: 'Test',
      nodes: new Map(),
      roots: [],
      multiNodes: new Map([
        ['IPlugin_def', [classNode('IPlugin_def', 'PluginA', '/src/a.ts')]],
      ]),
    };

    const code = new Generator(graph).generate();

    expect(code).toContain('return [];');
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
pnpm --filter @djodjonx/neosyringe-core test -- --reporter=verbose tests/generator/MultiRegistrationGenerator.test.ts
```

Expected: FAIL — no `resolveAll`, no indexed factories.

- [ ] **Step 3: Update `Generator.generate()` to include multi factories and `resolveAll()`**

In `packages/core/src/generator/Generator.ts`, update `generate()` to add after the existing factories + resolveCases:

```typescript
public generate(): string {
  const sorted = this.topologicalSort();
  const imports = new Map<string, string>();

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

  // Multi-registration factories and resolveAll cases
  const multiFactories = this.generateMultiFactories(getImport);
  const resolveAllMethod = this.generateResolveAllMethod(getImport);

  const importLines: string[] = [];
  if (!this.useDirectSymbolNames) {
    for (const [filePath, alias] of imports) {
      importLines.push(`import * as ${alias} from '${filePath}';`);
    }
  }

  return `
${importLines.join('\n')}

// -- Container --
class NeoContainer {
  private instances = new Map<any, any>();

  // -- Factories --
  ${[...factories, ...multiFactories].join('\n  ')}

  constructor(
    private parent?: any,
    private legacy?: any[],
    private name: string = 'NeoContainer'
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
    this.instances.clear();
  }

  public get _graph() {
    return ${JSON.stringify(Array.from(this.graph.nodes.keys()))};
  }
}
${this.useDirectSymbolNames ? '' : this.generateContainerVariable()}`;
}
```

Add the two new private methods to `Generator`:

```typescript
/** Generates indexed factory methods for multi-registration nodes. */
private generateMultiFactories(getImport: (s: ts.Symbol) => string): string[] {
  const factories: string[] = [];
  if (!this.graph.multiNodes) return factories;

  for (const [tokenId, nodes] of this.graph.multiNodes) {
    nodes.forEach((node, index) => {
      const factoryId = `${this.getFactoryName(tokenId)}_${index}`;

      if (node.service.type === 'factory' && node.service.factorySource) {
        factories.push(`
  private ${factoryId}(): any {
    const userFactory = ${node.service.factorySource};
    return userFactory(this);
  }`);
      } else if (node.service.type === 'value' && node.service.valueSource !== undefined) {
        factories.push(`
  private ${factoryId}(): any {
    return ${node.service.valueSource};
  }`);
      } else {
        if (!node.service.implementationSymbol) return;
        const className = getImport(node.service.implementationSymbol);
        const args = this.resolveConstructorArgs(node.dependencies, getImport);
        factories.push(`
  private ${factoryId}(): any {
    return new ${className}(${args});
  }`);
      }
    });
  }

  return factories;
}

/** Generates the resolveAll() method with one branch per multi-token. */
private generateResolveAllMethod(getImport: (s: ts.Symbol) => string): string {
  if (!this.graph.multiNodes || this.graph.multiNodes.size === 0) {
    return `public resolveAll<T>(token: any): T[] { return []; }`;
  }

  const cases: string[] = [];

  for (const [tokenId, nodes] of this.graph.multiNodes) {
    // Determine the token check expression (same logic as resolveLocal)
    const firstNode = nodes[0];
    let tokenCheck: string;

    if (firstNode.service.isInterfaceToken) {
      tokenCheck = `if (token === "${firstNode.service.tokenId}")`;
    } else if (firstNode.service.tokenSymbol) {
      tokenCheck = `if (token === ${getImport(firstNode.service.tokenSymbol)})`;
    } else {
      tokenCheck = `if (token === "${firstNode.service.tokenId}")`;
    }

    const calls = nodes.map((_, i) => `this.${this.getFactoryName(tokenId)}_${i}()`).join(', ');
    cases.push(`${tokenCheck} return [${calls}] as T[];`);
  }

  return `public resolveAll<T>(token: any): T[] {
    ${cases.join('\n    ')}
    return [];
  }`;
}
```

- [ ] **Step 4: Run generator tests**

```bash
pnpm --filter @djodjonx/neosyringe-core test -- --reporter=verbose tests/generator/MultiRegistrationGenerator.test.ts
```

Expected: PASS all 3 tests.

- [ ] **Step 5: Run full suite**

```bash
pnpm test
```

Expected: all packages pass.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/generator/Generator.ts packages/core/tests/generator/MultiRegistrationGenerator.test.ts
git commit -m "feat(generator): generate indexed factories and resolveAll() for multi-tokens"
```

---

### Task 4: End-to-end integration test

**Files:**
- Create: `packages/core/tests/analyzer/MultiRegistrationIntegration.test.ts`

- [ ] **Step 1: Write integration test**

Create `packages/core/tests/analyzer/MultiRegistrationIntegration.test.ts`:

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

describe('resolveAll — Analyzer to Generator integration', () => {
  it('should generate resolveAll with all multi-providers', () => {
    const program = createProgram('container.ts', `
      function defineBuilderConfig(c: any) { return c; }
      function useInterface<T>(): any { return null; }

      interface IMiddleware { handle(req: any): void; }
      class AuthMiddleware { handle(req: any) {} }
      class LogMiddleware { handle(req: any) {} }
      class RateLimiter { handle(req: any) {} }

      export const container = defineBuilderConfig({
        injections: [
          { token: useInterface<IMiddleware>(), provider: AuthMiddleware, multi: true },
          { token: useInterface<IMiddleware>(), provider: LogMiddleware, multi: true },
          { token: useInterface<IMiddleware>(), provider: RateLimiter, multi: true },
        ]
      });
    `);

    const graph = new Analyzer(program).extract();
    expect(graph.errors ?? []).toHaveLength(0);

    // Three multi-nodes for IMiddleware
    const multiEntry = [...(graph.multiNodes ?? new Map()).entries()]
      .find(([k]) => k.includes('IMiddleware'));
    expect(multiEntry).toBeDefined();
    expect(multiEntry![1]).toHaveLength(3);

    const code = new Generator(graph, true).generate();

    expect(code).toContain('public resolveAll<T>(token: any): T[]');
    expect(code).toContain('new AuthMiddleware()');
    expect(code).toContain('new LogMiddleware()');
    expect(code).toContain('new RateLimiter()');
    expect(code).not.toContain('new undefined');
  });

  it('should not include multi-tokens in regular resolve()', () => {
    const program = createProgram('container.ts', `
      function defineBuilderConfig(c: any) { return c; }
      function useInterface<T>(): any { return null; }

      interface IPlugin { run(): void; }
      class PluginA { run() {} }
      class PluginB { run() {} }

      export const container = defineBuilderConfig({
        injections: [
          { token: useInterface<IPlugin>(), provider: PluginA, multi: true },
          { token: useInterface<IPlugin>(), provider: PluginB, multi: true },
        ]
      });
    `);

    const graph = new Analyzer(program).extract();
    const code = new Generator(graph, true).generate();

    // resolveAll exists, but resolve() for IPlugin should throw "not found"
    // (multi-tokens are not in resolveLocal)
    expect(code).toContain('public resolveAll<T>');
    const injectableTokenInResolveLocal = code.includes('IPlugin') && code.includes('resolveLocal');
    // IPlugin should appear only in resolveAll, not in resolveLocal switch
    const resolveLocalSection = code.split('private resolveLocal')[1]?.split('public destroy')[0] ?? '';
    expect(resolveLocalSection).not.toContain('IPlugin');
  });
});
```

- [ ] **Step 2: Run integration tests**

```bash
pnpm --filter @djodjonx/neosyringe-core test -- --reporter=verbose tests/analyzer/MultiRegistrationIntegration.test.ts
```

Expected: PASS.

- [ ] **Step 3: Run all tests**

```bash
pnpm test
```

Expected: all packages pass.

- [ ] **Step 4: Commit**

```bash
git add packages/core/tests/analyzer/MultiRegistrationIntegration.test.ts
git commit -m "test(resolveAll): add end-to-end integration tests"
```

---

## Self-Review Checklist

- [x] `multi?: boolean` in `Injection` — Task 1
- [x] `resolveAll<T>()` on `Container` interface — Task 1
- [x] `multiInjections` on `ConfigGraph` — Task 1
- [x] `multiNodes` on `DependencyGraph` — Task 1
- [x] Collector detects `multi: true` — Task 2
- [x] Mixed multi/non-multi triggers error — Task 2
- [x] Multi-registrations not treated as duplicates — Task 2
- [x] `multiNodes` populated from `multiInjections` — Task 2
- [x] Indexed factory methods generated — Task 3
- [x] `resolveAll()` method generated — Task 3
- [x] Multi-tokens NOT in `resolveLocal()` (only in `resolveAll()`) — Task 4 integration test
- [x] Full suite passes — Task 4
