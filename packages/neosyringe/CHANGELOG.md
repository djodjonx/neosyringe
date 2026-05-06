# @djodjonx/neosyringe

## [0.2.1](https://github.com/djodjonx/neosyringe/compare/neosyringe-v0.2.0...neosyringe-v0.2.1) (2026-05-06)


### Bug Fixes

* address all remaining code review issues ([2ce9310](https://github.com/djodjonx/neosyringe/commit/2ce9310ce3da4bb49d6ab9b540d7eee9a06aae94))
* address code review feedback ([75fe611](https://github.com/djodjonx/neosyringe/commit/75fe611c933e5ddce015a9c59296af85ea95a9ea))
* address PR review feedback (C2, C4, C5, C6, C7) ([05bd819](https://github.com/djodjonx/neosyringe/commit/05bd8193ebf825e9acbba9f3c41afd8a3a53d085))
* **neosyringe:** narrow BuilderConfig.useContainer from any to Container | AsyncContainer ([4533bf5](https://github.com/djodjonx/neosyringe/commit/4533bf5ad31462002ee128d7d192df2cd56f9228))

## [0.2.0](https://github.com/djodjonx/neosyringe/compare/neosyringe-v0.1.2...neosyringe-v0.2.0) (2026-04-21)


### Features

* **runtime:** init @djodjonx/neosyringe package ([a7d18a9](https://github.com/djodjonx/neosyringe/commit/a7d18a9eb36fa6029e2deebffef6ddab93bb5000))
* **types:** add 'value' registration type and useValue to Injection ([5deb413](https://github.com/djodjonx/neosyringe/commit/5deb4139351dbdef0ff12f438e046a36e5ee9d60))
* **types:** add AsyncContainer interface and isAsync to ServiceDefinition ([fa78155](https://github.com/djodjonx/neosyringe/commit/fa78155b8138f6b3371157c7d1eff50bf77a60ed))
* **types:** add IDisposable, IAsyncDisposable and destroy() to Container ([6b72204](https://github.com/djodjonx/neosyringe/commit/6b72204c59716faab47f81287c54400bb417e738))
* **types:** add multi registration support to Injection and Container ([4b21bbc](https://github.com/djodjonx/neosyringe/commit/4b21bbc6936cf03a409e174cae4c8b29b4b84984))

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
