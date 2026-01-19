# @djodjonx/neosyringe-cli

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
