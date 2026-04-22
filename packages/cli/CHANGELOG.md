# @djodjonx/neosyringe-cli

## [0.2.0](https://github.com/djodjonx/neosyringe/compare/neosyringe-cli-v0.1.0...neosyringe-cli-v0.2.0) (2026-04-22)


### Features

* **cli:** init @djodjonx/neosyringe-cli ([dae65c3](https://github.com/djodjonx/neosyringe/commit/dae65c3f37948148aa04ef7dfbee91dd1a77a396))
* **lsp:** detect multiple errors simultaneously ([a54f7ad](https://github.com/djodjonx/neosyringe/commit/a54f7adb21b9f6802145a49b00ebd2a563506405))


### Bug Fixes

* **cli,unplugin,core:** remove deprecated GraphValidator.validate() and report all errors ([e29df2c](https://github.com/djodjonx/neosyringe/commit/e29df2c271df8e39faa84c4166b0ea51d8499151))
* **errors:** normalize missing-injection message and add error reference doc ([c79e2d4](https://github.com/djodjonx/neosyringe/commit/c79e2d40997ae4bf8ec79c6991912cd645de58ee))
* **tests:** use source imports instead of published packages ([0f92646](https://github.com/djodjonx/neosyringe/commit/0f926468cc75aaa03eb53242c2eaa187aa9ce269))

## [0.1.0](https://github.com/djodjonx/neosyringe/compare/neosyringe-cli-v0.0.7...neosyringe-cli-v0.1.0) (2026-04-21)


### Features

* **cli:** init @djodjonx/neosyringe-cli ([dae65c3](https://github.com/djodjonx/neosyringe/commit/dae65c3f37948148aa04ef7dfbee91dd1a77a396))
* **lsp:** detect multiple errors simultaneously ([a54f7ad](https://github.com/djodjonx/neosyringe/commit/a54f7adb21b9f6802145a49b00ebd2a563506405))


### Bug Fixes

* **cli,unplugin,core:** remove deprecated GraphValidator.validate() and report all errors ([30b7c4d](https://github.com/djodjonx/neosyringe/commit/30b7c4dead1fb92d192f29ec60b652819514e0a6))
* **errors:** normalize missing-injection message and add error reference doc ([82c0606](https://github.com/djodjonx/neosyringe/commit/82c060606347c42321df32b41a5eb3b37061a4c8))
* **tests:** use source imports instead of published packages ([0f92646](https://github.com/djodjonx/neosyringe/commit/0f926468cc75aaa03eb53242c2eaa187aa9ce269))

## 0.0.7

### Patch Changes

- Updated dependencies [14cb50c]
  - @djodjonx/neosyringe-core@1.3.0

## 0.0.6

### Patch Changes

- Updated dependencies
  - @djodjonx/neosyringe-core@1.2.0

## 0.0.5

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @djodjonx/neosyringe-core@1.1.0

## 0.0.4

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
