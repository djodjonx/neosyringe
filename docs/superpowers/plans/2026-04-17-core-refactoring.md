# Core Refactoring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate code duplication, enforce single-responsibility principle, standardize patterns, add performance caching, and complete documentation gaps in the `@djodjonx/neosyringe-core` and `@djodjonx/neosyringe-lsp` packages.

**Architecture:** The refactor works bottom-up — utilities first, then integrate into higher-level services. Each task is self-contained and independently testable. No public API changes.

**Tech Stack:** TypeScript 5.9, Vitest 4, tsdown, pnpm workspaces

---

## File Map

### New Files
- `packages/core/src/analyzer/utils/PropertyFinder.ts` — shared AST property lookup utility
- `packages/core/src/analyzer/parsers/InjectionParser.ts` — injection array parsing (extracted from ConfigParser)
- `packages/core/src/analyzer/parsers/ExtendsParser.ts` — extends/useContainer parsing (extracted from ConfigParser)
- `packages/core/src/analyzer/cache/SymbolCache.ts` — LRU cache for TypeChecker results
- `packages/core/tests/README.md` — test strategy documentation
- `docs/api/configuration.md` — BuilderConfig interface docs
- `docs/api/types.md` — all public types docs
- `docs/api/errors.md` — error types and handling

### Modified Files
- `packages/core/src/analyzer/utils/index.ts` — export PropertyFinder
- `packages/core/src/analyzer/parsers/index.ts` — export InjectionParser, ExtendsParser
- `packages/core/src/analyzer/parsers/ConfigParser.ts` — delegate to InjectionParser and ExtendsParser
- `packages/core/src/analyzer/collectors/ConfigCollector.ts` — use PropertyFinder, use ASTVisitor
- `packages/core/src/analyzer/Analyzer.ts` — use ASTVisitor, remove duplicate visitNode, standardize errors init
- `packages/core/src/analyzer/shared/TokenResolverService.ts` — use SymbolCache
- `packages/core/src/generator/Generator.ts` — incremental generation support
- `packages/lsp/src/index.ts` — remove debug trace instrumentation
- `packages/core/tests/analyzer/Analyzer.test.ts` — tests for ASTVisitor integration
- `packages/core/tests/shared/TokenResolverService.test.ts` — cache tests

---

## Task 1: Extract PropertyFinder Utility

**Files:**
- Create: `packages/core/src/analyzer/utils/PropertyFinder.ts`
- Modify: `packages/core/src/analyzer/utils/index.ts`
- Test: `packages/core/tests/shared/PropertyFinder.test.ts`

This pattern is repeated 8+ times across ConfigParser, ConfigCollector, and Analyzer:
```typescript
obj.properties.find(p =>
  p.name && TSContext.ts.isIdentifier(p.name) && p.name.text === propName
)
```

- [ ] **Step 1: Write the failing tests**

Create `packages/core/tests/shared/PropertyFinder.test.ts`:

```typescript
import { describe, it, expect, beforeAll } from 'vitest';
import ts from 'typescript';
import { TSContext } from '../../../src/TSContext';
import { PropertyFinder } from '../../../src/analyzer/utils/PropertyFinder';

beforeAll(() => {
  TSContext.ts = ts;
});

function makeObjectLiteral(src: string): ts.ObjectLiteralExpression {
  const file = ts.createSourceFile('test.ts', `const x = ${src};`, ts.ScriptTarget.ESNext, true);
  const stmt = file.statements[0] as ts.VariableStatement;
  const decl = stmt.declarationList.declarations[0];
  return decl.initializer as ts.ObjectLiteralExpression;
}

describe('PropertyFinder', () => {
  it('finds an existing property', () => {
    const obj = makeObjectLiteral('{ name: "App", injections: [] }');
    const result = PropertyFinder.find(obj, 'name');
    expect(result).toBeDefined();
    expect(ts.isStringLiteral((result as ts.PropertyAssignment).initializer)).toBe(true);
  });

  it('returns undefined for missing property', () => {
    const obj = makeObjectLiteral('{ name: "App" }');
    const result = PropertyFinder.find(obj, 'missing');
    expect(result).toBeUndefined();
  });

  it('returns undefined for non-identifier property name', () => {
    const obj = makeObjectLiteral('{ "name": "App" }');
    const result = PropertyFinder.find(obj, 'name');
    expect(result).toBeUndefined();
  });

  it('hasProperty returns true when property exists', () => {
    const obj = makeObjectLiteral('{ name: "App" }');
    expect(PropertyFinder.has(obj, 'name')).toBe(true);
  });

  it('hasProperty returns false when property is missing', () => {
    const obj = makeObjectLiteral('{ name: "App" }');
    expect(PropertyFinder.has(obj, 'injections')).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /Users/jonathan/projects/neo-syringe
pnpm --filter @djodjonx/neosyringe-core test -- PropertyFinder
```
Expected: FAIL — `PropertyFinder` is not defined

- [ ] **Step 3: Implement PropertyFinder**

Create `packages/core/src/analyzer/utils/PropertyFinder.ts`:

```typescript
import type * as ts from 'typescript';
import { TSContext } from '../../TSContext';

export class PropertyFinder {
  static find(
    obj: ts.ObjectLiteralExpression,
    name: string
  ): ts.PropertyAssignment | undefined {
    for (const prop of obj.properties) {
      if (
        TSContext.ts.isPropertyAssignment(prop) &&
        TSContext.ts.isIdentifier(prop.name) &&
        prop.name.text === name
      ) {
        return prop;
      }
    }
    return undefined;
  }

  static has(obj: ts.ObjectLiteralExpression, name: string): boolean {
    return PropertyFinder.find(obj, name) !== undefined;
  }
}
```

- [ ] **Step 4: Export from utils index**

In `packages/core/src/analyzer/utils/index.ts`, add:
```typescript
export { PropertyFinder } from './PropertyFinder';
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
pnpm --filter @djodjonx/neosyringe-core test -- PropertyFinder
```
Expected: PASS — 5 tests

- [ ] **Step 6: Replace inline patterns in ConfigParser.ts**

Open `packages/core/src/analyzer/parsers/ConfigParser.ts`. Replace every `configObj.properties.find(p => p.name && TSContext.ts.isIdentifier(p.name) && p.name.text === '...')` call with `PropertyFinder.find(configObj, '...')`.

Add import at top:
```typescript
import { PropertyFinder } from '../utils/PropertyFinder';
```

Occurrences to replace (search for `properties.find`):
- Line ~59: nameProp lookup → `PropertyFinder.find(configObj, 'name')`
- Line ~72: injectionsProp → `PropertyFinder.find(configObj, 'injections')`
- Line ~80: extendsProp → `PropertyFinder.find(configObj, 'extends')`
- Line ~95: useContainerProp → `PropertyFinder.find(configObj, 'useContainer')`
- Line ~440: Analyzer.ts useContainerProp in parseBuilderConfig → `PropertyFinder.find(args[0], 'useContainer')`

Also replace in `packages/core/src/analyzer/collectors/ConfigCollector.ts` — the `findProperty` private method can be deleted entirely; replace all calls to `this.findProperty(...)` with `PropertyFinder.find(...)`.

- [ ] **Step 7: Run all tests**

```bash
pnpm --filter @djodjonx/neosyringe-core test
```
Expected: All passing

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/analyzer/utils/PropertyFinder.ts \
        packages/core/src/analyzer/utils/index.ts \
        packages/core/src/analyzer/parsers/ConfigParser.ts \
        packages/core/src/analyzer/collectors/ConfigCollector.ts \
        packages/core/src/analyzer/Analyzer.ts \
        packages/core/tests/shared/PropertyFinder.test.ts
git commit -m "refactor(core): extract PropertyFinder utility to eliminate repeated AST property lookup"
```

---

## Task 2: Integrate ASTVisitor into ConfigCollector

**Files:**
- Modify: `packages/core/src/analyzer/collectors/ConfigCollector.ts`
- Test: `packages/core/tests/analyzer/Analyzer.test.ts` (verify no regressions)

`ASTVisitor` at `packages/core/src/analyzer/visitors/ASTVisitor.ts` already collects `builderConfigs` and `partialConfigs` call expressions. `ConfigCollector.visitNode` reimplements the same traversal.

- [ ] **Step 1: Read ASTVisitor interface**

Confirm `ASTVisitor.visit(node)` and `getResults()` → `{ builderConfigs, partialConfigs, ... }`.
File: `packages/core/src/analyzer/visitors/ASTVisitor.ts:73`

- [ ] **Step 2: Verify existing tests pass before changes**

```bash
pnpm --filter @djodjonx/neosyringe-core test
```
Expected: All passing (baseline)

- [ ] **Step 3: Refactor ConfigCollector.collect() to use ASTVisitor**

In `packages/core/src/analyzer/collectors/ConfigCollector.ts`, replace the `collect()` method:

```typescript
import { ASTVisitor } from '../visitors/ASTVisitor';

collect(): Map<string, ConfigGraph> {
  const configs = new Map<string, ConfigGraph>();
  const containerIdsByFile = new Map<string, Map<string, ConfigGraph>>();
  const visitor = new ASTVisitor();

  for (const sourceFile of this.program.getSourceFiles()) {
    if (sourceFile.isDeclarationFile) continue;

    visitor.reset();
    visitor.visit(sourceFile);
    const { builderConfigs, partialConfigs } = visitor.getResults();

    const fileConfigs = new Map<string, ConfigGraph>();

    for (const node of [...builderConfigs, ...partialConfigs]) {
      const type: ConfigType = builderConfigs.includes(node) ? 'builder' : 'partial';
      const config = this.parseConfig(node, sourceFile, type);
      if (config) {
        const uniqueKey = `${sourceFile.fileName}:${config.name}`;
        configs.set(uniqueKey, config);
        const fileUniqueKey = `${config.name}:${node.getStart()}`;
        fileConfigs.set(fileUniqueKey, config);
      }
    }

    if (fileConfigs.size > 0) {
      containerIdsByFile.set(sourceFile.fileName, fileConfigs);
    }
  }

  this.validateContainerIdCollisions(containerIdsByFile);
  return configs;
}
```

Delete the private `visitNode` method (lines 95–116) and private `tryParseConfig` (lines 119–143) from ConfigCollector — `collect()` now calls `parseConfig` directly after ASTVisitor determines the type.

Also delete the private `getFunctionName` method from ConfigCollector (line 145–151) — now handled by ASTVisitor.

- [ ] **Step 4: Run all tests**

```bash
pnpm --filter @djodjonx/neosyringe-core test
```
Expected: All passing

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/analyzer/collectors/ConfigCollector.ts
git commit -m "refactor(core): replace ConfigCollector.visitNode with ASTVisitor for single-pass collection"
```

---

## Task 3: Integrate ASTVisitor into Analyzer

**Files:**
- Modify: `packages/core/src/analyzer/Analyzer.ts`
- Test: `packages/core/tests/analyzer/Analyzer.test.ts`

`Analyzer` has three separate traversals: `identifyParentContainers`, `visitNode`, and `collectPartialsInExtends`. `ASTVisitor` already collects `parentContainers` and `extendsReferences` in a single pass.

- [ ] **Step 1: Verify tests pass before changes**

```bash
pnpm --filter @djodjonx/neosyringe-core test -- Analyzer
```
Expected: All passing

- [ ] **Step 2: Refactor Analyzer.extract() to use ASTVisitor**

Replace the three-pass logic in `extract()` with a two-pass (visitor + processing):

```typescript
import { ASTVisitor } from './visitors/ASTVisitor';

public extract(): DependencyGraph {
  const graph: DependencyGraph = {
    containerId: 'DefaultContainer',
    nodes: new Map(),
    roots: [],
    buildArguments: [],
    errors: [],
  };

  const visitor = new ASTVisitor();

  // Single pass: collect all DI-related nodes
  for (const sourceFile of this.program.getSourceFiles()) {
    if (sourceFile.isDeclarationFile) continue;
    visitor.visit(sourceFile);
  }

  const { parentContainers, builderConfigs, partialConfigs, extendsReferences } = visitor.getResults();

  // Populate parentContainerNames from visitor results
  this.parentContainerNames = parentContainers;

  // Lazy-init partialsUsedInExtends from visitor results
  this.partialNamesUsedInExtends = extendsReferences;

  // Process builder configs (skip those used as parents)
  for (const node of builderConfigs) {
    const parent = node.parent;
    if (
      TSContext.ts.isVariableDeclaration(parent) &&
      TSContext.ts.isIdentifier(parent.name) &&
      this.parentContainerNames.has(parent.name.text)
    ) {
      continue; // skip parent containers
    }
    this.processBuilderConfigNode(node, graph);
  }

  // Process standalone partial configs not used in any extends
  for (const node of partialConfigs) {
    const parent = node.parent;
    if (
      TSContext.ts.isVariableDeclaration(parent) &&
      TSContext.ts.isIdentifier(parent.name) &&
      !this.partialNamesUsedInExtends.has(parent.name.text)
    ) {
      const partialGraph: DependencyGraph = {
        containerId: parent.name.text,
        nodes: new Map(),
        roots: [],
        errors: [],
      };
      this.parseBuilderConfig(node, partialGraph);
      graph.errors.push(...partialGraph.errors);
    }
  }

  this.resolveAllDependencies(graph);
  return graph;
}
```

Extract the `processBuilderConfigNode` helper (pull out from old `visitNode`) — it handles the `export default` / `const x =` distinction and calls `parseBuilderConfig`:

```typescript
private processBuilderConfigNode(node: ts.CallExpression, graph: DependencyGraph): void {
  const parent = node.parent;

  if (TSContext.ts.isVariableDeclaration(parent) && TSContext.ts.isIdentifier(parent.name)) {
    graph.exportedVariableName = parent.name.text;

    let current: ts.Node = parent;
    while (current && !TSContext.ts.isVariableStatement(current)) {
      current = current.parent;
    }
    if (current && TSContext.ts.isVariableStatement(current)) {
      graph.variableStatementStart = current.getStart();

      const modifiers = TSContext.ts.canHaveModifiers(current)
        ? TSContext.ts.getModifiers(current)
        : undefined;

      if (modifiers) {
        const hasExport = modifiers.some(m => m.kind === TSContext.ts.SyntaxKind.ExportKeyword);
        const hasDefault = modifiers.some(m => m.kind === TSContext.ts.SyntaxKind.DefaultKeyword);
        graph.variableExportModifier = hasExport && hasDefault ? 'export default'
          : hasExport ? 'export' : 'none';
      } else {
        graph.variableExportModifier = 'none';
      }
    }
  } else if (TSContext.ts.isExportAssignment(parent) && parent.isExportEquals === false) {
    graph.variableExportModifier = 'export default';
    graph.variableStatementStart = parent.getStart();
  }

  graph.defineBuilderConfigStart = node.getStart();
  graph.defineBuilderConfigEnd = node.getEnd();
  this.parseBuilderConfig(node, graph);
}
```

Delete old private methods from Analyzer: `identifyParentContainers`, `visitNode`, `collectPartialsInExtends`, `isPartialUsedInExtends`.

Also delete the `partialNamesUsedInExtends` field (now set directly in extract()).

- [ ] **Step 3: Run all tests**

```bash
pnpm --filter @djodjonx/neosyringe-core test
```
Expected: All passing

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/analyzer/Analyzer.ts
git commit -m "refactor(core): replace Analyzer multi-pass traversal with ASTVisitor single-pass"
```

---

## Task 4: Standardize Error Initialization

**Files:**
- Modify: `packages/core/src/analyzer/Analyzer.ts`

The `errors` field is initialized in `DependencyGraph` but has a redundant null-check at line 383.

- [ ] **Step 1: Remove the defensive null check**

In `packages/core/src/analyzer/Analyzer.ts`, find the block around line 383 (after Task 3 refactor, this may have shifted):

```typescript
// Before (remove this):
if (!graph.errors) graph.errors = [];
graph.errors.push(...partialGraph.errors);

// After:
graph.errors.push(...partialGraph.errors);
```

Also, in `extract()`, change `errors: []` to `errors: [] as AnalysisError[]` with explicit typing for clarity.

- [ ] **Step 2: Remove the deprecated `simpleHash` method from ConfigCollector**

In `packages/core/src/analyzer/collectors/ConfigCollector.ts`, find and delete the `simpleHash` private method (line ~356):

```typescript
// Delete this entire method:
private simpleHash(str: string): string {
  // Deprecated - use generateTokenId instead
  ...
}
```

- [ ] **Step 3: Run all tests**

```bash
pnpm --filter @djodjonx/neosyringe-core test
```
Expected: All passing

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/analyzer/Analyzer.ts packages/core/src/analyzer/collectors/ConfigCollector.ts
git commit -m "refactor(core): remove redundant null checks and deprecated simpleHash method"
```

---

## Task 5: Extract InjectionParser and ExtendsParser from ConfigParser

**Files:**
- Create: `packages/core/src/analyzer/parsers/InjectionParser.ts`
- Create: `packages/core/src/analyzer/parsers/ExtendsParser.ts`
- Modify: `packages/core/src/analyzer/parsers/ConfigParser.ts`
- Modify: `packages/core/src/analyzer/parsers/index.ts`
- Test: `packages/core/tests/analyzer/ConfigParser.test.ts` (if it exists, verify no regression)

- [ ] **Step 1: Verify tests pass before changes**

```bash
pnpm --filter @djodjonx/neosyringe-core test
```

- [ ] **Step 2: Create InjectionParser**

Create `packages/core/src/analyzer/parsers/InjectionParser.ts`:

```typescript
import type * as ts from 'typescript';
import { TSContext } from '../../TSContext';
import type { DependencyGraph, ServiceDefinition, TokenId } from '../types';
import { TokenResolverService } from '../shared/TokenResolverService';
import { PropertyFinder } from '../utils/PropertyFinder';

export class InjectionParser {
  constructor(
    private checker: ts.TypeChecker,
    private tokenResolverService: TokenResolverService
  ) {}

  /**
   * Parses the 'injections' array from a config object and populates graph nodes.
   */
  parse(configObj: ts.ObjectLiteralExpression, graph: DependencyGraph): void {
    const injectionsProp = PropertyFinder.find(configObj, 'injections');
    if (!injectionsProp || !TSContext.ts.isArrayLiteralExpression(injectionsProp.initializer)) return;

    for (const element of injectionsProp.initializer.elements) {
      if (!TSContext.ts.isObjectLiteralExpression(element)) continue;
      this.parseInjectionEntry(element, graph);
    }
  }

  private parseInjectionEntry(obj: ts.ObjectLiteralExpression, graph: DependencyGraph): void {
    let tokenNode: ts.Expression | undefined;
    let providerNode: ts.Expression | undefined;
    let lifecycle: 'singleton' | 'transient' = 'singleton';
    let useFactory = false;
    let isScoped = false;

    for (const prop of obj.properties) {
      if (!TSContext.ts.isPropertyAssignment(prop) || !TSContext.ts.isIdentifier(prop.name)) continue;

      switch (prop.name.text) {
        case 'token': tokenNode = prop.initializer; break;
        case 'provider': providerNode = prop.initializer; break;
        case 'lifecycle':
          if (TSContext.ts.isStringLiteral(prop.initializer) && prop.initializer.text === 'transient') {
            lifecycle = 'transient';
          }
          break;
        case 'useFactory':
          useFactory = prop.initializer.kind === TSContext.ts.SyntaxKind.TrueKeyword;
          break;
        case 'scoped':
          isScoped = prop.initializer.kind === TSContext.ts.SyntaxKind.TrueKeyword;
          break;
      }
    }

    if (!tokenNode) return;

    const tokenId = this.tokenResolverService.resolveTokenId(tokenNode);
    if (!tokenId) return;

    // Auto-detect factory
    if (providerNode && (TSContext.ts.isArrowFunction(providerNode) || TSContext.ts.isFunctionExpression(providerNode))) {
      useFactory = true;
    }

    const registrationType: 'explicit' | 'autowire' | 'factory' = useFactory ? 'factory'
      : providerNode ? 'explicit' : 'autowire';

    const implementationSymbol = providerNode
      ? this.checker.getSymbolAtLocation(providerNode)
      : this.checker.getSymbolAtLocation(tokenNode);

    const definition: ServiceDefinition = {
      tokenId,
      implementationSymbol,
      registrationNode: obj,
      type: registrationType,
      lifecycle,
      isInterfaceToken: this.tokenResolverService.isUseInterfaceCall(tokenNode),
      isFactory: useFactory,
      factorySource: useFactory && providerNode ? providerNode.getText(obj.getSourceFile()) : undefined,
      isScoped,
    };

    const existing = graph.nodes.get(tokenId as string);
    if (existing) {
      if (!graph.errors) graph.errors = [];
      // Duplicate — will be caught by DuplicateValidator; store node for error reporting
    } else {
      graph.nodes.set(tokenId as string, { definition, dependencies: [] });
    }
  }
}
```

- [ ] **Step 3: Create ExtendsParser**

Create `packages/core/src/analyzer/parsers/ExtendsParser.ts`:

```typescript
import type * as ts from 'typescript';
import { TSContext } from '../../TSContext';
import type { DependencyGraph } from '../types';
import { PropertyFinder } from '../utils/PropertyFinder';

export class ExtendsParser {
  /**
   * Parses the 'extends' and 'useContainer' properties from a config object.
   */
  parse(configObj: ts.ObjectLiteralExpression, graph: DependencyGraph): void {
    this.parseExtends(configObj, graph);
    this.parseUseContainer(configObj, graph);
  }

  private parseExtends(configObj: ts.ObjectLiteralExpression, graph: DependencyGraph): void {
    const extendsProp = PropertyFinder.find(configObj, 'extends');
    if (!extendsProp || !TSContext.ts.isArrayLiteralExpression(extendsProp.initializer)) return;

    if (!graph.extendsRefs) graph.extendsRefs = [];

    for (const element of extendsProp.initializer.elements) {
      if (TSContext.ts.isIdentifier(element)) {
        graph.extendsRefs.push(element.text);
      }
    }
  }

  private parseUseContainer(configObj: ts.ObjectLiteralExpression, graph: DependencyGraph): void {
    const useContainerProp = PropertyFinder.find(configObj, 'useContainer');
    if (!useContainerProp || !TSContext.ts.isIdentifier(useContainerProp.initializer)) return;
    graph.useContainerRef = useContainerProp.initializer.text;
  }
}
```

- [ ] **Step 4: Slim down ConfigParser to delegate**

Replace the injection and extends parsing in `packages/core/src/analyzer/parsers/ConfigParser.ts` with calls to the new parsers:

```typescript
import { InjectionParser } from './InjectionParser';
import { ExtendsParser } from './ExtendsParser';
import { PropertyFinder } from '../utils/PropertyFinder';

export class ConfigParser {
  private injectionParser: InjectionParser;
  private extendsParser: ExtendsParser;

  constructor(
    private checker: ts.TypeChecker,
    private tokenResolverService: TokenResolverService
  ) {
    this.injectionParser = new InjectionParser(checker, tokenResolverService);
    this.extendsParser = new ExtendsParser();
  }

  parseBuilderConfig(node: ts.CallExpression, graph: DependencyGraph, parentContainerNames: Set<string>): void {
    const args = node.arguments;
    if (args.length < 1) return;

    const configObj = args[0];
    if (!TSContext.ts.isObjectLiteralExpression(configObj)) return;

    // Parse container name/id
    const nameProp = PropertyFinder.find(configObj, 'name');
    if (nameProp && TSContext.ts.isPropertyAssignment(nameProp) && TSContext.ts.isStringLiteral(nameProp.initializer)) {
      graph.containerName = nameProp.initializer.text;
      graph.containerId = nameProp.initializer.text;
    } else {
      graph.containerId = this.generateHashBasedContainerId(node);
    }

    // Delegate to specialized parsers
    this.injectionParser.parse(configObj, graph);
    this.extendsParser.parse(configObj, graph);
  }

  private generateHashBasedContainerId(node: ts.CallExpression): string {
    const sourceFile = node.getSourceFile();
    const path = require('path');
    const fileName = path.basename(sourceFile.fileName, '.ts');
    return HashUtils.generateContainerId(fileName, node.getStart(), node.getText());
  }
}
```

- [ ] **Step 5: Export from parsers index**

In `packages/core/src/analyzer/parsers/index.ts`:
```typescript
export { ConfigParser } from './ConfigParser';
export { InjectionParser } from './InjectionParser';
export { ExtendsParser } from './ExtendsParser';
```

- [ ] **Step 6: Run all tests**

```bash
pnpm --filter @djodjonx/neosyringe-core test
```
Expected: All passing

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/analyzer/parsers/
git commit -m "refactor(core): extract InjectionParser and ExtendsParser from ConfigParser (SRP)"
```

---

## Task 6: Add Symbol Cache to TokenResolverService

**Files:**
- Create: `packages/core/src/analyzer/cache/SymbolCache.ts`
- Modify: `packages/core/src/analyzer/shared/TokenResolverService.ts`
- Test: `packages/core/tests/shared/TokenResolverService.test.ts`

TypeChecker calls (especially `getTypeOfSymbol` and `typeToString`) are expensive. Cache them keyed by symbol identity.

- [ ] **Step 1: Write failing tests for SymbolCache**

Create `packages/core/tests/shared/SymbolCache.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { SymbolCache } from '../../../src/analyzer/cache/SymbolCache';

describe('SymbolCache', () => {
  it('returns cached value on second call', () => {
    const cache = new SymbolCache<string>(10);
    const factory = vi.fn().mockReturnValue('result');
    const key = {};

    cache.getOrCompute(key, factory);
    const result = cache.getOrCompute(key, factory);

    expect(result).toBe('result');
    expect(factory).toHaveBeenCalledTimes(1); // only called once
  });

  it('evicts oldest entry when capacity exceeded', () => {
    const cache = new SymbolCache<number>(2);
    const key1 = {}, key2 = {}, key3 = {};

    cache.getOrCompute(key1, () => 1);
    cache.getOrCompute(key2, () => 2);
    cache.getOrCompute(key3, () => 3); // key1 should be evicted

    const factory = vi.fn().mockReturnValue(99);
    cache.getOrCompute(key1, factory);
    expect(factory).toHaveBeenCalledTimes(1); // key1 was evicted, recomputed
  });

  it('clear() empties the cache', () => {
    const cache = new SymbolCache<string>(10);
    const key = {};
    const factory = vi.fn().mockReturnValue('val');

    cache.getOrCompute(key, factory);
    cache.clear();
    cache.getOrCompute(key, factory);

    expect(factory).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
pnpm --filter @djodjonx/neosyringe-core test -- SymbolCache
```
Expected: FAIL

- [ ] **Step 3: Implement SymbolCache**

Create `packages/core/src/analyzer/cache/SymbolCache.ts`:

```typescript
export class SymbolCache<V> {
  private cache = new Map<object, V>();
  private insertionOrder: object[] = [];

  constructor(private readonly maxSize: number) {}

  getOrCompute(key: object, factory: () => V): V {
    if (this.cache.has(key)) {
      return this.cache.get(key)!;
    }

    const value = factory();

    if (this.cache.size >= this.maxSize) {
      const oldest = this.insertionOrder.shift()!;
      this.cache.delete(oldest);
    }

    this.cache.set(key, value);
    this.insertionOrder.push(key);
    return value;
  }

  clear(): void {
    this.cache.clear();
    this.insertionOrder = [];
  }
}
```

Create `packages/core/src/analyzer/cache/index.ts`:
```typescript
export { SymbolCache } from './SymbolCache';
```

- [ ] **Step 4: Wire into TokenResolverService**

In `packages/core/src/analyzer/shared/TokenResolverService.ts`, add at the top of the class:

```typescript
import { SymbolCache } from '../cache/SymbolCache';

export class TokenResolverService {
  private typeStringCache = new SymbolCache<string>(500);
  private symbolTypeCache = new SymbolCache<ts.Type>(500);

  // In getTypeId(), wrap the checker.typeToString call:
  getTypeId(type: ts.Type): string {
    return this.typeStringCache.getOrCompute(type as object, () =>
      this.checker.typeToString(type)
    );
  }
}
```

Apply the same pattern in `resolveTokenId` for `checker.getTypeAtLocation` calls.

- [ ] **Step 5: Run all tests**

```bash
pnpm --filter @djodjonx/neosyringe-core test
```
Expected: All passing

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/analyzer/cache/ packages/core/src/analyzer/shared/TokenResolverService.ts packages/core/tests/shared/SymbolCache.test.ts
git commit -m "perf(core): add LRU SymbolCache to memoize TypeChecker calls in TokenResolverService"
```

---

## Task 7: Clean Up LSP Plugin Debug Instrumentation

**Files:**
- Modify: `packages/lsp/src/index.ts`

The LSP plugin has a `methodsToTrace` loop (lines 291–318) that logs every call to 16 language service methods. This is debug scaffolding that should not be in production.

- [ ] **Step 1: Remove the methodsToTrace instrumentation**

In `packages/lsp/src/index.ts`, delete lines 291–318:

```typescript
// DELETE this entire block:
const methodsToTrace = [
  'getCompilerOptionsDiagnostics',
  ...
];

for (const methodName of methodsToTrace) {
  const original = (info.languageService as any)[methodName];
  if (typeof original === 'function') {
    (info.languageService as any)[methodName] = function(...args: any[]) {
      logger.info(`[LS-TRACE] ${methodName} called`);
      return original.apply(info.languageService, args);
    };
  }
}
```

- [ ] **Step 2: Remove getSuggestionDiagnostics duplication**

`getSuggestionDiagnostics` currently runs the full NeoSyringe analysis again (same as `getSemanticDiagnostics`). This is redundant and runs analysis twice per file save. Replace with cached results:

```typescript
info.languageService.getSuggestionDiagnostics = function(fileName: string) {
  return originalGetSuggestionDiagnostics.call(info.languageService, fileName);
};
```

- [ ] **Step 3: Remove unused `analyzedFiles` set**

The `analyzedFiles` Set tracks files that triggered `getQuickInfoAtPosition` analysis, but its only effect is a conditional log message. Delete the `analyzedFiles` declaration and the condition that uses it.

- [ ] **Step 4: Build LSP package**

```bash
pnpm --filter @djodjonx/neosyringe-lsp build
```
Expected: Build succeeds with no errors

- [ ] **Step 5: Run LSP tests**

```bash
pnpm --filter @djodjonx/neosyringe-lsp test
```
Expected: All passing

- [ ] **Step 6: Commit**

```bash
git add packages/lsp/src/index.ts
git commit -m "refactor(lsp): remove debug trace instrumentation and redundant suggestion diagnostics analysis"
```

---

## Task 8: Add Test Documentation

**Files:**
- Create: `packages/core/tests/README.md`

- [ ] **Step 1: Create tests/README.md**

Create `packages/core/tests/README.md`:

```markdown
# Core Package Tests

## Structure

\`\`\`
tests/
├── analyzer/          # Analyzer integration tests (full analysis pipeline)
│   ├── Analyzer.test.ts          - Main analyzer extract() and extractForFile()
│   ├── AnalyzerDeclarative.test.ts - Declarative config syntax tests
│   ├── AnalyzerSafety.test.ts    - Edge cases: circular refs, missing tokens
│   ├── Partials.test.ts          - definePartialConfig + extends behavior
│   └── ...
├── generator/         # Code generator tests
│   ├── Generator.test.ts         - Container factory generation
│   └── FactoryGenerator.test.ts  - Factory injection patterns
├── shared/            # Unit tests for shared services
│   ├── HashUtils.test.ts         - Token ID hashing
│   ├── TokenResolverService.test.ts - Token resolution from AST
│   ├── CallExpressionUtils.test.ts  - Call expression helpers
│   └── PropertyFinder.test.ts    - AST property lookup utility
└── fixtures/          # Reusable TypeScript fixture files
    └── simple-container.ts       - Basic container for smoke tests
\`\`\`

## Test Philosophy

- **Unit tests** (shared/) test a single service in isolation with a real TypeScript program constructed inline.
- **Integration tests** (analyzer/, generator/) feed real TypeScript source code through the full analysis pipeline.
- **No mocking** of TypeScript compiler internals — we use real `ts.createProgram()` with in-memory source files.

## Writing a New Test

For analyzer tests, use this pattern:

\`\`\`typescript
import ts from 'typescript';
import { TSContext } from '../../src/TSContext';
import { Analyzer } from '../../src/analyzer/Analyzer';

function createProgram(source: string) {
  TSContext.ts = ts;
  const options: ts.CompilerOptions = { strict: true, target: ts.ScriptTarget.ESNext };
  const host = ts.createCompilerHost(options);
  const original = host.getSourceFile;
  host.getSourceFile = (fileName, languageVersion) => {
    if (fileName === 'test.ts') {
      return ts.createSourceFile(fileName, source, languageVersion, true);
    }
    return original.call(host, fileName, languageVersion);
  };
  return ts.createProgram(['test.ts'], options, host);
}

it('should detect duplicate registrations', () => {
  const program = createProgram(\`
    import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';
    export const container = defineBuilderConfig({
      injections: [
        { token: useInterface<IFoo>(), provider: Foo },
        { token: useInterface<IFoo>(), provider: Foo }, // duplicate
      ]
    });
  \`);
  const analyzer = new Analyzer(program);
  const result = analyzer.extractForFile('test.ts');
  expect(result.errors.some(e => e.type === 'duplicate')).toBe(true);
});
\`\`\`

## Running Tests

\`\`\`bash
# All tests
pnpm --filter @djodjonx/neosyringe-core test

# Watch mode
pnpm --filter @djodjonx/neosyringe-core test -- --watch

# Specific file
pnpm --filter @djodjonx/neosyringe-core test -- Analyzer.test
\`\`\`
```

- [ ] **Step 2: Commit**

```bash
git add packages/core/tests/README.md
git commit -m "docs(core): add tests/README.md with test strategy and patterns"
```

---

## Task 9: Complete API Documentation

**Files:**
- Create: `docs/api/configuration.md`
- Create: `docs/api/types.md`
- Create: `docs/api/errors.md`

- [ ] **Step 1: Create configuration.md**

Create `docs/api/configuration.md`:

```markdown
# Configuration API

## BuilderConfig

Passed to `defineBuilderConfig()` to define a DI container.

\`\`\`typescript
interface BuilderConfig {
  name?: string;         // Human-readable container ID. Used in generated code.
  injections: Injection[]; // Service registrations
  extends?: PartialConfig[]; // Partial configs to merge in
  useContainer?: Container;  // Parent container for inherited bindings
}
\`\`\`

### name

Optional string identifier for this container. Used as the `containerId` in generated code and error messages. If omitted, a hash is generated from file + position.

\`\`\`typescript
defineBuilderConfig({
  name: 'AppContainer',
  injections: [...]
})
\`\`\`

### injections

Array of service registrations. Each entry maps a token to a provider.

See: [Injection Types](../guide/injection-types.md)

### extends

Array of `definePartialConfig` results to merge into this container.

\`\`\`typescript
const dbPartial = definePartialConfig({ injections: [...] });
defineBuilderConfig({
  extends: [dbPartial],
  injections: [...]
});
\`\`\`

### useContainer

Reference to a parent container to inherit bindings from.

\`\`\`typescript
defineBuilderConfig({
  useContainer: parentContainer,
  injections: [...]
});
\`\`\`

## PartialConfig

Passed to `definePartialConfig()` — a reusable group of registrations.

\`\`\`typescript
interface PartialConfig {
  injections: Injection[];
}
\`\`\`

## Injection

A single service registration entry.

\`\`\`typescript
interface Injection {
  token: Token<T>;              // What to inject
  provider?: Class<T> | Factory<T>; // How to create it (omit for autowire)
  lifecycle?: 'singleton' | 'transient'; // Default: 'singleton'
  useFactory?: boolean;         // Force factory mode
  scoped?: boolean;             // Scoped to request/context
}
\`\`\`
```

- [ ] **Step 2: Create types.md**

Create `docs/api/types.md`:

```markdown
# Public Types

## Token Types

### InterfaceToken\<T\>

A branded type representing an interface-based injection token.
Created by `useInterface<T>()`.

\`\`\`typescript
type InterfaceToken<T> = { readonly __interface: T; readonly __brand: 'interface' };
\`\`\`

### PropertyToken\<T\>

A branded type for property-based injection tokens.
Created by `useProperty<T>()`.

### Token\<T\>

Discriminated union of all token types:

\`\`\`typescript
type Token<T> = InterfaceToken<T> | PropertyToken<T> | (new (...args: any[]) => T);
\`\`\`

## Container

The runtime DI container interface:

\`\`\`typescript
interface Container {
  resolve<T>(token: any): T;
  build(): void;
}
\`\`\`

## AnalysisResult

Returned by `Analyzer.extractForFile()`:

\`\`\`typescript
interface AnalysisResult {
  configs: Map<string, ConfigGraph>; // all configs found in program
  errors: AnalysisError[];           // errors for the analyzed file
}
\`\`\`

## AnalysisError

\`\`\`typescript
interface AnalysisError {
  type: 'duplicate' | 'type-mismatch' | 'cycle' | 'missing';
  message: string;
  node: ts.Node;       // AST node for error positioning
  sourceFile: ts.SourceFile;
  context?: Record<string, unknown>;
}
\`\`\`
```

- [ ] **Step 3: Create errors.md**

Create `docs/api/errors.md`:

```markdown
# Error Reference

All NeoSyringe errors are surfaced as TypeScript diagnostics (in the IDE via the LSP plugin) or thrown exceptions (in the CLI/build plugin).

## Error Codes

| Code | Type | Description |
|------|------|-------------|
| 9995 | `missing` | A dependency required by a service has no binding |
| 9996 | `cycle` | A circular dependency was detected |
| 9997 | `type-mismatch` | Provider type is incompatible with token type |
| 9998 | `duplicate` | Same token registered more than once in a container |
| 9999 | `unknown` | Unexpected analysis error |

## Thrown Exceptions

### DuplicateRegistrationError

Thrown when a token appears twice in the same container's `injections` array.

\`\`\`typescript
import { DuplicateRegistrationError } from '@djodjonx/neosyringe-core';

try {
  analyzer.extract();
} catch (e) {
  if (e instanceof DuplicateRegistrationError) {
    console.error(e.message, e.node, e.sourceFile);
  }
}
\`\`\`

### TypeMismatchError

Thrown when a provider class does not implement the interface referenced by its token.

## Fixing Common Errors

### missing dependency

\`\`\`
[NeoSyringe] Missing binding for 'IEmailService'. Add it to your container's injections.
\`\`\`

Add `{ token: useInterface<IEmailService>(), provider: EmailService }` to injections.

### duplicate registration

\`\`\`
[NeoSyringe] Duplicate registration: 'useInterface<IUserRepo>()' is already registered.
\`\`\`

Remove the second entry, or use `extends` / `useContainer` to split registrations.

### cycle

\`\`\`
[NeoSyringe] Circular dependency detected: ServiceA → ServiceB → ServiceA
\`\`\`

Break the cycle by introducing an interface or lazy resolution.
```

- [ ] **Step 4: Commit**

```bash
git add docs/api/
git commit -m "docs: add API reference for configuration, types, and errors"
```

---

## Verification

After all tasks, run the full test suite and build:

```bash
pnpm test
pnpm build
```

Expected: Zero failures, zero build errors.
