# @djodjonx/neosyringe-plugin

## [0.2.0](https://github.com/djodjonx/neosyringe/compare/neosyringe-plugin-v0.1.0...neosyringe-plugin-v0.2.0) (2026-04-22)


### Features

* **example/nestjs:** replace webpack with ts-patch TypeScript transformer ([0891f3a](https://github.com/djodjonx/neosyringe/commit/0891f3a7970d760f4249759744a49e867b78ff76))
* **unplugin:** add TypeScript compiler transformer for ts-patch ([fb54297](https://github.com/djodjonx/neosyringe/commit/fb54297a3f7fecadd283f18191917a980db7d8c1))
* **unplugin:** expose ./transformer export path for ts-patch usage ([630c5b5](https://github.com/djodjonx/neosyringe/commit/630c5b5868e30d678c140aa8817c588c20bd8bcf))
* **unplugin:** init @djodjonx/neosyringe-plugin ([ff89e74](https://github.com/djodjonx/neosyringe/commit/ff89e744255f248638de4998eb9ab819ff80514b))


### Bug Fixes

* **cli,unplugin,core:** remove deprecated GraphValidator.validate() and report all errors ([e29df2c](https://github.com/djodjonx/neosyringe/commit/e29df2c271df8e39faa84c4166b0ea51d8499151))
* **core,lsp,unplugin:** fix type validation bugs and eliminate code duplication ([92fa8cd](https://github.com/djodjonx/neosyringe/commit/92fa8cd68debfcdcebb791e0e9c9165d628dba86))
* **tests:** use source imports instead of published packages ([0f92646](https://github.com/djodjonx/neosyringe/commit/0f926468cc75aaa03eb53242c2eaa187aa9ce269))
* **unplugin:** update to use new Analyzer APIs ([0c6aab6](https://github.com/djodjonx/neosyringe/commit/0c6aab6b36eabe82dfed158e1a03c71fdcec26ba))

## [0.1.0](https://github.com/djodjonx/neosyringe/compare/neosyringe-plugin-v0.0.7...neosyringe-plugin-v0.1.0) (2026-04-21)


### Features

* **unplugin:** init @djodjonx/neosyringe-plugin ([ff89e74](https://github.com/djodjonx/neosyringe/commit/ff89e744255f248638de4998eb9ab819ff80514b))


### Bug Fixes

* **cli,unplugin,core:** remove deprecated GraphValidator.validate() and report all errors ([30b7c4d](https://github.com/djodjonx/neosyringe/commit/30b7c4dead1fb92d192f29ec60b652819514e0a6))
* **core,lsp,unplugin:** fix type validation bugs and eliminate code duplication ([92fa8cd](https://github.com/djodjonx/neosyringe/commit/92fa8cd68debfcdcebb791e0e9c9165d628dba86))
* **tests:** use source imports instead of published packages ([0f92646](https://github.com/djodjonx/neosyringe/commit/0f926468cc75aaa03eb53242c2eaa187aa9ce269))
* **unplugin:** update to use new Analyzer APIs ([0c6aab6](https://github.com/djodjonx/neosyringe/commit/0c6aab6b36eabe82dfed158e1a03c71fdcec26ba))

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
