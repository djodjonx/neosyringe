# @djodjonx/neosyringe-lsp

## [0.3.2](https://github.com/djodjonx/neosyringe/compare/neosyringe-lsp-v0.3.1...neosyringe-lsp-v0.3.2) (2026-04-22)


### Bug Fixes

* address code review feedback ([75fe611](https://github.com/djodjonx/neosyringe/commit/75fe611c933e5ddce015a9c59296af85ea95a9ea))

## [0.3.1](https://github.com/djodjonx/neosyringe/compare/neosyringe-lsp-v0.3.0...neosyringe-lsp-v0.3.1) (2026-04-22)


### Bug Fixes

* **lsp:** report missing dependency errors in IDE diagnostics ([8f7165e](https://github.com/djodjonx/neosyringe/commit/8f7165e7329b95eb87b544edfb96ecbbb4a4263f))

## [0.3.0](https://github.com/djodjonx/neosyringe/compare/neosyringe-lsp-v0.2.2...neosyringe-lsp-v0.3.0) (2026-04-21)


### Features

* **lsp:** add LSPLogger class with performance optimizations ([27f3397](https://github.com/djodjonx/neosyringe/commit/27f3397f225d4a19ff70b6c02fe7d4c8f1aaa753))
* **lsp:** detect multiple errors simultaneously ([a54f7ad](https://github.com/djodjonx/neosyringe/commit/a54f7adb21b9f6802145a49b00ebd2a563506405))
* **lsp:** init @djodjonx/neosyringe-lsp ([01f8e0b](https://github.com/djodjonx/neosyringe/commit/01f8e0b4e0df85340ad541ae29b26436f4fbfd8f))
* **lsp:** integrate new validators for comprehensive error reporting ([1564bd9](https://github.com/djodjonx/neosyringe/commit/1564bd984706f142ee7ba22831e1c15748fea615))


### Bug Fixes

* **core,lsp,unplugin:** fix type validation bugs and eliminate code duplication ([92fa8cd](https://github.com/djodjonx/neosyringe/commit/92fa8cd68debfcdcebb791e0e9c9165d628dba86))
* **lsp,validators:** extend validators to cover multiInjections and valueErrors ([bda8f23](https://github.com/djodjonx/neosyringe/commit/bda8f23d3f5a8a2b3e7ab306cf741e648539d472))
* **lsp:** add IntelliJ IDEA compatibility ([4ca95c1](https://github.com/djodjonx/neosyringe/commit/4ca95c192c8caca893967365f17015c8ae9932d7))

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
