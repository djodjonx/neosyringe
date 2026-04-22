# @djodjonx/neosyringe

## [0.3.0](https://github.com/djodjonx/neosyringe/compare/neosyringe-v0.2.0...neosyringe-v0.3.0) (2026-04-22)


### Features

* **runtime:** init @djodjonx/neosyringe package ([a7d18a9](https://github.com/djodjonx/neosyringe/commit/a7d18a9eb36fa6029e2deebffef6ddab93bb5000))
* **types:** add 'value' registration type and useValue to Injection ([a65d368](https://github.com/djodjonx/neosyringe/commit/a65d368a886c019d7bb15fea0fd74e90184d9699))
* **types:** add AsyncContainer interface and isAsync to ServiceDefinition ([3149ebb](https://github.com/djodjonx/neosyringe/commit/3149ebbb5ad1606c518e3bf5b0c6d899ed356605))
* **types:** add IDisposable, IAsyncDisposable and destroy() to Container ([f0eb00b](https://github.com/djodjonx/neosyringe/commit/f0eb00ba24fa6df1fe5b30a7b16c54125884a1a7))
* **types:** add multi registration support to Injection and Container ([060b89b](https://github.com/djodjonx/neosyringe/commit/060b89b8da4f0dab9df066abb651384118b7c230))

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
