# @djodjonx/neosyringe

## 0.1.2

### Patch Changes

- afbcc52: fix dependencies versions in all packages published

## 0.1.1

### Patch Changes

- Add MIT license to all packages and fix test imports to use source code instead of published packages. This ensures tests run against the actual source code in CI environments.

## 0.1.0

### Minor Changes

- # Initial Release & Internal Refactoring

  - **Encapsulated Factories:** Refactored the container generator to produce private factory methods inside the `NeoContainer` class instead of global functions.
  - **API Cleanup:** Removed the unused `createChildContainer` method from the `Container` interface and generated code.
  - **Branding:** Standardized the brand name to **NeoSyringe** across all packages and documentation.
  - **Internal:** Standardized package imports and fixed internal resolution issues.
