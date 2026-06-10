# @djodjonx/neosyringe-plugin

## [0.3.0](https://github.com/djodjonx/neosyringe/compare/neosyringe-plugin-v0.2.1...neosyringe-plugin-v0.3.0) (2026-06-10)


### Features

* **plugin:** track generated container variable names ([534c1db](https://github.com/djodjonx/neosyringe/commit/534c1db8d6ab84f60112113aa8bed42d53ba2686))


### Bug Fixes

* normalize sourceFileName paths for Windows ([4f6cb2c](https://github.com/djodjonx/neosyringe/commit/4f6cb2cb7b47ad4336bf63242c614f74aa4acf0d))
* **plugin:** generate all containers per file ([1a978c1](https://github.com/djodjonx/neosyringe/commit/1a978c1d56d3c0b83231651daeeafcc1a36a3ba0))
* **unplugin:** track useInterface tokens in container-file branch ([477c6c5](https://github.com/djodjonx/neosyringe/commit/477c6c5c8ce9e08b0477f9ca9f30fd4efd069785))

## [0.2.1](https://github.com/djodjonx/neosyringe/compare/neosyringe-plugin-v0.2.0...neosyringe-plugin-v0.2.1) (2026-05-06)


### Bug Fixes

* address all remaining code review issues ([2ce9310](https://github.com/djodjonx/neosyringe/commit/2ce9310ce3da4bb49d6ab9b540d7eee9a06aae94))
* address code review feedback ([75fe611](https://github.com/djodjonx/neosyringe/commit/75fe611c933e5ddce015a9c59296af85ea95a9ea))
* address PR review feedback (C2, C4, C5, C6, C7) ([05bd819](https://github.com/djodjonx/neosyringe/commit/05bd8193ebf825e9acbba9f3c41afd8a3a53d085))


### Performance Improvements

* **unplugin:** cache per-file TypeScript programs to avoid redundant createProgram calls ([428dc29](https://github.com/djodjonx/neosyringe/commit/428dc294982367a2e878138cb7a713f9198a2af6))

## [0.2.0](https://github.com/djodjonx/neosyringe/compare/neosyringe-plugin-v0.1.0...neosyringe-plugin-v0.2.0) (2026-04-22)


### Features

* **example/nestjs:** replace webpack with ts-patch TypeScript transformer ([0891f3a](https://github.com/djodjonx/neosyringe/commit/0891f3a7970d760f4249759744a49e867b78ff76))
* **unplugin:** add TypeScript compiler transformer for ts-patch ([fb54297](https://github.com/djodjonx/neosyringe/commit/fb54297a3f7fecadd283f18191917a980db7d8c1))
* **unplugin:** expose ./transformer export path for ts-patch usage ([630c5b5](https://github.com/djodjonx/neosyringe/commit/630c5b5868e30d678c140aa8817c588c20bd8bcf))

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
