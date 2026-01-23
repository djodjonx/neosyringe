# @djodjonx/neosyringe-lsp

## 0.2.2

### Patch Changes

- Updated dependencies [14cb50c]
  - @djodjonx/neosyringe-core@1.3.0

## 0.2.1

### Patch Changes

- **Core: Major internal refactoring and improvements**

  - Refactor Analyzer: reduce codebase from 1070 to 447 lines (-58%)
  - Add specialized services for better code organization:
    - HashUtils: centralized hashing utilities
    - TokenResolverService: token resolution logic
    - ConfigParser: config parsing and validation
    - DependencyResolver: constructor dependency analysis
    - ParentContainerResolver: parent container logic
    - CallExpressionUtils: call expression identification
    - ASTVisitor: generic AST visitor (for future use)
  - Add 46 new unit tests for the new services
  - Improve code documentation with comprehensive JSDoc
  - Eliminate ~200 lines of duplicated code
  - Simplify MissingDependencyValidator logic
  - Update core README documentation

  **LSP: Build improvements**

  - Add `type: "module"` to package.json to eliminate build warnings

- Updated dependencies
  - @djodjonx/neosyringe-core@1.2.0

## 0.2.0

### Minor Changes

- Add structured logging with LSPLogger class and performance optimizations.
- Add comprehensive missing dependency detection.
  The analyzer now detects when a service depends on tokens that are not registered in the container, considering the full container hierarchy (parent containers via useContainer and extended partials via extends).
  All missing dependencies are reported at once with clean error messages showing readable token names without internal hash IDs.
- Add comprehensive missing dependency detection with clean error messages.

### Patch Changes

- Fix IntelliJ IDEA and WebStorm compatibility with runtime capability detection.
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @djodjonx/neosyringe-core@1.1.0

## 0.1.0

### Minor Changes

- "@djodjonx/neosyringe-core":

  - major: "BREAKING CHANGE: The `NeoContainer` class is no longer automatically exported in generated code. It now strictly respects the export modifier used on the configuration variable (e.g., `const container = ...`). If you need the class exported, you must export the variable."
  - minor: "Support `export default defineBuilderConfig(...)` syntax directly without requiring an intermediate variable."

  "@djodjonx/neosyringe-lsp":

  - minor: "Display original source code in duplicate registration error messages for better debugging."
  - minor: "Enhanced error reporting: Detects and displays multiple errors (duplicates, type mismatches) simultaneously."

### Patch Changes

- Updated dependencies
  - @djodjonx/neosyringe-core@1.0.0

## 0.0.3

### Patch Changes

- afbcc52: fix dependencies versions in all packages published
- Updated dependencies [afbcc52]
  - @djodjonx/neosyringe-core@0.1.2

## 0.0.2

### Patch Changes

- Add MIT license to all packages and fix test imports to use source code instead of published packages. This ensures tests run against the actual source code in CI environments.
- Updated dependencies
  - @djodjonx/neosyringe-core@0.1.1

## 0.0.1

### Patch Changes

- # Initial Release & Internal Refactoring

  - **Encapsulated Factories:** Refactored the container generator to produce private factory methods inside the `NeoContainer` class instead of global functions.
  - **API Cleanup:** Removed the unused `createChildContainer` method from the `Container` interface and generated code.
  - **Branding:** Standardized the brand name to **NeoSyringe** across all packages and documentation.
  - **Internal:** Standardized package imports and fixed internal resolution issues.

- Updated dependencies
  - @djodjonx/neosyringe-core@0.1.0
