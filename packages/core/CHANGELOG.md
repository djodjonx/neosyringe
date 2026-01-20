# @djodjonx/neosyringe-core

## 1.0.0

### Major Changes

- "@djodjonx/neosyringe-core":

  - major: "BREAKING CHANGE: The `NeoContainer` class is no longer automatically exported in generated code. It now strictly respects the export modifier used on the configuration variable (e.g., `const container = ...`). If you need the class exported, you must export the variable."
  - minor: "Support `export default defineBuilderConfig(...)` syntax directly without requiring an intermediate variable."

  "@djodjonx/neosyringe-lsp":

  - minor: "Display original source code in duplicate registration error messages for better debugging."
  - minor: "Enhanced error reporting: Detects and displays multiple errors (duplicates, type mismatches) simultaneously."

## 0.1.2

### Patch Changes

- afbcc52: fix dependencies versions in all packages published
- Updated dependencies [afbcc52]
  - @djodjonx/neosyringe@0.1.2

## 0.1.1

### Patch Changes

- Add MIT license to all packages and fix test imports to use source code instead of published packages. This ensures tests run against the actual source code in CI environments.
- Updated dependencies
  - @djodjonx/neosyringe@0.1.1

## 0.1.0

### Minor Changes

- # Initial Release & Internal Refactoring

  - **Encapsulated Factories:** Refactored the container generator to produce private factory methods inside the `NeoContainer` class instead of global functions.
  - **API Cleanup:** Removed the unused `createChildContainer` method from the `Container` interface and generated code.
  - **Branding:** Standardized the brand name to **NeoSyringe** across all packages and documentation.
  - **Internal:** Standardized package imports and fixed internal resolution issues.

### Patch Changes

- Updated dependencies
  - @djodjonx/neosyringe@0.1.0
