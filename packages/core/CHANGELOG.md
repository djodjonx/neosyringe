# @djodjonx/neosyringe-core

## [2.0.0](https://github.com/djodjonx/neosyringe/compare/neosyringe-core-v1.3.0...neosyringe-core-v2.0.0) (2026-04-21)


### ⚠ BREAKING CHANGES

* **core:** NeoContainer class is no longer exported automatically. Only the container instance variable respects the user's export choice.

### Features

* add type inference to container resolve method ([14cb50c](https://github.com/djodjonx/neosyringe/commit/14cb50c5a59dbcafef380c00d862c265f02825f9))
* **analyzer:** collect multi-registrations into multiNodes ([3209d3e](https://github.com/djodjonx/neosyringe/commit/3209d3ee11c1769d5d7e4637bda136b1406b793e))
* **analyzer:** detect async factories and reject async+transient combination ([139cdee](https://github.com/djodjonx/neosyringe/commit/139cdee8702ecbfe42c1f5cbd1f07c4926b17196))
* **analyzer:** detect IDisposable and IAsyncDisposable on class registrations ([7dfe5fc](https://github.com/djodjonx/neosyringe/commit/7dfe5fc79ba6960d0d524ff1f569a55a3390221f))
* **analyzer:** detect useValue registrations and reject primitive tokens ([b2e5136](https://github.com/djodjonx/neosyringe/commit/b2e51367577f9d89c98e6c4720155395c761ae0c))
* **core:** add missing dependency validator ([027ae10](https://github.com/djodjonx/neosyringe/commit/027ae10ac41c47713573e95b48fc78e77331376a))
* **core:** add modular analyzer components ([ee07643](https://github.com/djodjonx/neosyringe/commit/ee07643bb4dd33c7ab28fafd8bb1e9fe6a1b5b2a))
* **core:** implement generator logic ([59d34c6](https://github.com/djodjonx/neosyringe/commit/59d34c6083621eb856f6b316821237f85fe855b4))
* **core:** init @djodjonx/neosyringe-core package (analyzer) ([1563a44](https://github.com/djodjonx/neosyringe/commit/1563a440d8358140addffea7ebe231d2992b72f9))
* **core:** refactor GraphValidator to collect all errors ([f84f414](https://github.com/djodjonx/neosyringe/commit/f84f4144c1f85616796108fb269bd5aed67eab80))
* **core:** respect user's export modifier for NeoContainer ([05efdf2](https://github.com/djodjonx/neosyringe/commit/05efdf272cb47e6471dcb0fcf22bd55203177983))
* **core:** support export default defineBuilderConfig() without variable ([0e098b4](https://github.com/djodjonx/neosyringe/commit/0e098b4da0db2195f680e0ab39b504b20ed2f606))
* **core:** support multiple containers per file ([3e17801](https://github.com/djodjonx/neosyringe/commit/3e1780191bb48fe37dba05f973c796350b64262d))
* **generator:** emit dispose() calls in destroy() for IDisposable services ([c44636c](https://github.com/djodjonx/neosyringe/commit/c44636c0a07073708eb98d1e693e9763052e4cfd))
* **generator:** emit initialize() and _initialized guard for async factories ([ad42869](https://github.com/djodjonx/neosyringe/commit/ad4286900caa9fafb67bd10e67826b7d791405f5))
* **generator:** emit value factory for type=value registrations ([9b62f55](https://github.com/djodjonx/neosyringe/commit/9b62f5504d81abad7cadc6d340c8dc42c3657150))
* **generator:** generate indexed factories and resolveAll() for multi-tokens ([2dac5f8](https://github.com/djodjonx/neosyringe/commit/2dac5f82234d273393319936507b7403ccee20ca))
* **lsp:** detect multiple errors simultaneously ([a54f7ad](https://github.com/djodjonx/neosyringe/commit/a54f7adb21b9f6802145a49b00ebd2a563506405))
* **lsp:** display original code in duplicate error messages ([a8d4783](https://github.com/djodjonx/neosyringe/commit/a8d47839c0b1cb19374dfad70346acd1818849dc))
* **types:** add 'value' registration type and useValue to Injection ([5deb413](https://github.com/djodjonx/neosyringe/commit/5deb4139351dbdef0ff12f438e046a36e5ee9d60))
* **types:** add AsyncContainer interface and isAsync to ServiceDefinition ([fa78155](https://github.com/djodjonx/neosyringe/commit/fa78155b8138f6b3371157c7d1eff50bf77a60ed))
* **types:** add IDisposable, IAsyncDisposable and destroy() to Container ([6b72204](https://github.com/djodjonx/neosyringe/commit/6b72204c59716faab47f81287c54400bb417e738))
* **types:** add multi registration support to Injection and Container ([4b21bbc](https://github.com/djodjonx/neosyringe/commit/4b21bbc6936cf03a409e174cae4c8b29b4b84984))


### Bug Fixes

* **analyzer,test:** alias resolution in ConfigCollector; add async-factory+disposable test ([7f996bc](https://github.com/djodjonx/neosyringe/commit/7f996bc21df62c8e2feb3af78a5f08e728fa02d9))
* **analyzer:** add useValue support to LSP path and reject class token useValue ([ede9f3c](https://github.com/djodjonx/neosyringe/commit/ede9f3cf6e44fc7a367cfe4d29dc76df07fc140d))
* **analyzer:** fix useValue+multi routing and extract mixed-multi guard helper ([189f737](https://github.com/djodjonx/neosyringe/commit/189f737b9374a2c19382b1fa9e57fd788c94c215))
* **ci:** build packages before running tests ([554f630](https://github.com/djodjonx/neosyringe/commit/554f630b1c85bc3facd3d5d865acb09f2e042a35))
* **cli,unplugin,core:** remove deprecated GraphValidator.validate() and report all errors ([30b7c4d](https://github.com/djodjonx/neosyringe/commit/30b7c4dead1fb92d192f29ec60b652819514e0a6))
* **core,lsp,unplugin:** fix type validation bugs and eliminate code duplication ([92fa8cd](https://github.com/djodjonx/neosyringe/commit/92fa8cd68debfcdcebb791e0e9c9165d628dba86))
* **core:** export generateTokenId from analyzer index ([a59a2cd](https://github.com/djodjonx/neosyringe/commit/a59a2cdd5549c5ad86c963fb903ed05615da5a33))
* **errors:** normalize missing-injection message and add error reference doc ([82c0606](https://github.com/djodjonx/neosyringe/commit/82c060606347c42321df32b41a5eb3b37061a4c8))
* **generator:** honour lifecycle for multi-nodes and fix namespace import in resolveAll ([24b1fff](https://github.com/djodjonx/neosyringe/commit/24b1fffc49ff6229bf8f75ed01d1d415ede8ffcb))
* **lsp,validators:** extend validators to cover multiInjections and valueErrors ([bda8f23](https://github.com/djodjonx/neosyringe/commit/bda8f23d3f5a8a2b3e7ab306cf741e648539d472))
* **tests:** update LegacyContainer test for JSON.stringify containerName and add feature plans ([7fcd2f6](https://github.com/djodjonx/neosyringe/commit/7fcd2f608d8d16e7950604c546a23c8d5bf24752))
* **tests:** use source imports instead of published packages ([0f92646](https://github.com/djodjonx/neosyringe/commit/0f926468cc75aaa03eb53242c2eaa187aa9ce269))
* **test:** update error message to match normalized missing injection wording ([ef425b0](https://github.com/djodjonx/neosyringe/commit/ef425b0992ee045a84d0dbf297511e4e4193a77a))
* **validator:** skip type and dependency checks for value registrations ([94964ce](https://github.com/djodjonx/neosyringe/commit/94964ce059cd9f0d4a62d5d69b3fa075e86c4627))

## 1.3.0

### Minor Changes

- 14cb50c: Add full type inference to container resolve method

  The generated container now uses a generic typed signature `resolve<T>(token: any): T` instead of `resolve(token: any): any`, providing complete type safety and automatic type inference.

  **Benefits:**

  - ✨ Automatic type inference - no type assertions needed
  - 🛡️ Full compile-time type checking
  - 📝 Complete IDE auto-completion support
  - 🔄 100% backward compatible

  **Example:**

  ```typescript
  const userService = container.resolve(UserService);
  // Type: UserService ✅ (automatically inferred)

  const logger = container.resolve(useInterface<ILogger>());
  // Type: ILogger ✅
  ```

  **Documentation:**

  - Added comprehensive type safety examples across all guides
  - Added comparison with other DI libraries (tsyringe, InversifyJS, Awilix)
  - Updated API documentation with type inference details

## 1.2.0

### Minor Changes

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

## 1.1.0

### Minor Changes

- Add comprehensive missing dependency detection.
  The analyzer now detects when a service depends on tokens that are not registered in the container, considering the full container hierarchy (parent containers via useContainer and extended partials via extends).
  All missing dependencies are reported at once with clean error messages showing readable token names without internal hash IDs.
- Add comprehensive missing dependency detection with clean error messages.
- Support multiple defineBuilderConfig per file with unique container IDs.
  Each container can have a unique `name` field that becomes its container ID. If no name is provided, a stable hash is generated. The generator creates unique class names like `NeoContainer_UserModule` or `NeoContainer_a1b2c3d4`.
  Duplicate container names in the same file are detected and reported as errors during validation.
- Support multiple defineBuilderConfig per file with unique container IDs.

### Patch Changes

- Add modular validator architecture with ConfigCollector, ErrorFormatter, and TokenResolver for better code organization and maintainability.

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
