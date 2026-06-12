# @djodjonx/neosyringe-core

## [3.0.1](https://github.com/djodjonx/neosyringe/compare/neosyringe-core-v3.0.0...neosyringe-core-v3.0.1) (2026-06-12)


### Bug Fixes

* prefix inline namespace imports and strip TS extensions ([3bd1335](https://github.com/djodjonx/neosyringe/commit/3bd1335a103488b816fb99f89decfdb7e9d66da7))
* use namespace import for default exports to prevent bundler ReferenceError ([061dd2f](https://github.com/djodjonx/neosyringe/commit/061dd2f2090a51ff3e6745dcda9db9ce3187124d))

## [3.0.0](https://github.com/djodjonx/neosyringe/compare/neosyringe-core-v2.2.3...neosyringe-core-v3.0.0) (2026-06-11)


### ⚠ BREAKING CHANGES

* **core:** NeoContainer class is no longer exported automatically. Only the container instance variable respects the user's export choice.

### Features

* add type inference to container resolve method ([14cb50c](https://github.com/djodjonx/neosyringe/commit/14cb50c5a59dbcafef380c00d862c265f02825f9))
* **analyzer:** collect multi-registrations into multiNodes ([8b2c919](https://github.com/djodjonx/neosyringe/commit/8b2c919b7817a118e9b69ac42ea0ca0e12098c98))
* **analyzer:** detect async factories and reject async+transient combination ([de1687c](https://github.com/djodjonx/neosyringe/commit/de1687cd1dce7e4d85c52b7aa69e39b74bd93df0))
* **analyzer:** detect IDisposable and IAsyncDisposable on class registrations ([acefbdb](https://github.com/djodjonx/neosyringe/commit/acefbdbaaff473914da596aa307a827fc2a61796))
* **analyzer:** detect useValue registrations and reject primitive tokens ([c5921f1](https://github.com/djodjonx/neosyringe/commit/c5921f19e808154961b07c25ee8c78ddd06cf89f))
* **core:** add Analyzer.extractAll() ([dc44cad](https://github.com/djodjonx/neosyringe/commit/dc44cad451a17207cbba653636fc5cea12e8ff92))
* **core:** add ILogger abstraction to TokenResolverService ([aa38741](https://github.com/djodjonx/neosyringe/commit/aa38741025f414787169850637a2c1a4adef9930))
* **core:** add missing dependency validator ([027ae10](https://github.com/djodjonx/neosyringe/commit/027ae10ac41c47713573e95b48fc78e77331376a))
* **core:** add modular analyzer components ([ee07643](https://github.com/djodjonx/neosyringe/commit/ee07643bb4dd33c7ab28fafd8bb1e9fe6a1b5b2a))
* **core:** implement generator logic ([59d34c6](https://github.com/djodjonx/neosyringe/commit/59d34c6083621eb856f6b316821237f85fe855b4))
* **core:** init @djodjonx/neosyringe-core package (analyzer) ([1563a44](https://github.com/djodjonx/neosyringe/commit/1563a440d8358140addffea7ebe231d2992b72f9))
* **core:** refactor GraphValidator to collect all errors ([f84f414](https://github.com/djodjonx/neosyringe/commit/f84f4144c1f85616796108fb269bd5aed67eab80))
* **core:** respect user's export modifier for NeoContainer ([05efdf2](https://github.com/djodjonx/neosyringe/commit/05efdf272cb47e6471dcb0fcf22bd55203177983))
* **core:** support export default defineBuilderConfig() without variable ([0e098b4](https://github.com/djodjonx/neosyringe/commit/0e098b4da0db2195f680e0ab39b504b20ed2f606))
* **core:** support multiple containers per file ([3e17801](https://github.com/djodjonx/neosyringe/commit/3e1780191bb48fe37dba05f973c796350b64262d))
* **generator:** emit dispose() calls in destroy() for IDisposable services ([97301f4](https://github.com/djodjonx/neosyringe/commit/97301f4b52c55ee45df81ef61cae90e88d096144))
* **generator:** emit initialize() and _initialized guard for async factories ([7f4ed88](https://github.com/djodjonx/neosyringe/commit/7f4ed88a64e66a71157e53b7740066c58bc7698c))
* **generator:** emit value factory for type=value registrations ([22b8a26](https://github.com/djodjonx/neosyringe/commit/22b8a267671206685248f0a2f5503ce4eccb5b28))
* **generator:** generate indexed factories and resolveAll() for multi-tokens ([66cc910](https://github.com/djodjonx/neosyringe/commit/66cc910637510628cd7f9ea1e50a794052d9770b))
* **lsp:** detect multiple errors simultaneously ([a54f7ad](https://github.com/djodjonx/neosyringe/commit/a54f7adb21b9f6802145a49b00ebd2a563506405))
* **lsp:** display original code in duplicate error messages ([a8d4783](https://github.com/djodjonx/neosyringe/commit/a8d47839c0b1cb19374dfad70346acd1818849dc))
* **types:** add 'value' registration type and useValue to Injection ([a65d368](https://github.com/djodjonx/neosyringe/commit/a65d368a886c019d7bb15fea0fd74e90184d9699))
* **types:** add AsyncContainer interface and isAsync to ServiceDefinition ([3149ebb](https://github.com/djodjonx/neosyringe/commit/3149ebbb5ad1606c518e3bf5b0c6d899ed356605))
* **types:** add IDisposable, IAsyncDisposable and destroy() to Container ([f0eb00b](https://github.com/djodjonx/neosyringe/commit/f0eb00ba24fa6df1fe5b30a7b16c54125884a1a7))
* **types:** add multi registration support to Injection and Container ([060b89b](https://github.com/djodjonx/neosyringe/commit/060b89b8da4f0dab9df066abb651384118b7c230))


### Bug Fixes

* address all 15 code review issues ([d66a26a](https://github.com/djodjonx/neosyringe/commit/d66a26af5be3de7e5e4ce521eb689a9fcdf155c7))
* address all remaining code review issues ([2ce9310](https://github.com/djodjonx/neosyringe/commit/2ce9310ce3da4bb49d6ab9b540d7eee9a06aae94))
* address code review feedback ([75fe611](https://github.com/djodjonx/neosyringe/commit/75fe611c933e5ddce015a9c59296af85ea95a9ea))
* address PR review feedback (C2, C4, C5, C6, C7) ([05bd819](https://github.com/djodjonx/neosyringe/commit/05bd8193ebf825e9acbba9f3c41afd8a3a53d085))
* **analyzer,test:** alias resolution in ConfigCollector; add async-factory+disposable test ([82fe862](https://github.com/djodjonx/neosyringe/commit/82fe86234528dbae07a01efbf12aa8136be4c924))
* **analyzer:** add useValue support to LSP path and reject class token useValue ([9bfda9a](https://github.com/djodjonx/neosyringe/commit/9bfda9ae92faa903065b8cecefcdf04484625697))
* **analyzer:** fix useValue+multi routing and extract mixed-multi guard helper ([1962969](https://github.com/djodjonx/neosyringe/commit/19629699b64e44a0dc7c500235612eb23ef00045))
* capture default export references at module scope for rolldown compatibility ([19e910b](https://github.com/djodjonx/neosyringe/commit/19e910bf0a95926278064945f988476591586897))
* **ci:** build packages before running tests ([554f630](https://github.com/djodjonx/neosyringe/commit/554f630b1c85bc3facd3d5d865acb09f2e042a35))
* **cli,unplugin,core:** remove deprecated GraphValidator.validate() and report all errors ([e29df2c](https://github.com/djodjonx/neosyringe/commit/e29df2c271df8e39faa84c4166b0ea51d8499151))
* **core,lsp,unplugin:** fix type validation bugs and eliminate code duplication ([92fa8cd](https://github.com/djodjonx/neosyringe/commit/92fa8cd68debfcdcebb791e0e9c9165d628dba86))
* **core:** address code-review issues — guard duplication and struct mutation ([5a6e48d](https://github.com/djodjonx/neosyringe/commit/5a6e48dcb2afc4e73067d1ee49f035044cfac27b))
* **core:** address Copilot PR review comments ([0ff8292](https://github.com/djodjonx/neosyringe/commit/0ff8292b9b1e98bfe4b4bedd65c8381a104789c6))
* **core:** detect cycles involving multi-injection tokens in CycleValidator ([92e3c2a](https://github.com/djodjonx/neosyringe/commit/92e3c2a04923df996e7a5940493c9c4ddef96e06))
* **core:** emit one cycle error per multi-provider instead of only the first ([4e74a25](https://github.com/djodjonx/neosyringe/commit/4e74a2530c1d2569e653138b519e3a0e37bf770f))
* **core:** export generateTokenId from analyzer index ([a59a2cd](https://github.com/djodjonx/neosyringe/commit/a59a2cdd5549c5ad86c963fb903ed05615da5a33))
* **core:** include multi-registration tokens in missing-dep available set ([badacba](https://github.com/djodjonx/neosyringe/commit/badacba6c3aa4fc216fcdb68fdf0de2122479923))
* **core:** preserve first-match semantics in buildNameIndex ([7cf69ce](https://github.com/djodjonx/neosyringe/commit/7cf69ce05319ec24182b473001ba500121f557c5))
* **core:** resolve property tokens in DependencyAnalyzer to prevent false missing-dep errors ([250e5ae](https://github.com/djodjonx/neosyringe/commit/250e5ae4504aa4aed0a071f775b550e3c51930a5))
* **core:** unify getHashedTokenIdFromType with getTypeId to prevent type alias token mismatch ([ee580ef](https://github.com/djodjonx/neosyringe/commit/ee580ef03282b69cde18db28d5c8edf1f8f1179f))
* **core:** use per-node lifecycle in generateResolveAllMethod ([aae2864](https://github.com/djodjonx/neosyringe/commit/aae28641d1b3ca5e9f821d17957a123c02b586ad))
* **core:** use TSContext.projectRoot in HashUtils instead of process.cwd() ([f67fbce](https://github.com/djodjonx/neosyringe/commit/f67fbce1c14458979c887c2aa58ca85b581be591))
* default export class name in generated code ([28396b3](https://github.com/djodjonx/neosyringe/commit/28396b3a28cd9221bbd02ee387d6b2265afe6846))
* **errors:** normalize missing-injection message and add error reference doc ([c79e2d4](https://github.com/djodjonx/neosyringe/commit/c79e2d40997ae4bf8ec79c6991912cd645de58ee))
* **generator:** honour lifecycle for multi-nodes and fix namespace import in resolveAll ([f51bdbf](https://github.com/djodjonx/neosyringe/commit/f51bdbf742e6a0e1e8b6532383097fb490c2d970))
* lsp missing injection for imported classes ([b9bf8eb](https://github.com/djodjonx/neosyringe/commit/b9bf8ebe26fb0355b3a688fb1feaa314a862eadb))
* **lsp,validators:** extend validators to cover multiInjections and valueErrors ([6200608](https://github.com/djodjonx/neosyringe/commit/6200608824c834ace8e95be99153670cde7dd18f))
* normalize sourceFileName paths for Windows ([4f6cb2c](https://github.com/djodjonx/neosyringe/commit/4f6cb2cb7b47ad4336bf63242c614f74aa4acf0d))
* **tests:** update LegacyContainer test for JSON.stringify containerName and add feature plans ([4922387](https://github.com/djodjonx/neosyringe/commit/492238729f63ebf58f1298a9b6e6f3883fe202e5))
* **tests:** use source imports instead of published packages ([0f92646](https://github.com/djodjonx/neosyringe/commit/0f926468cc75aaa03eb53242c2eaa187aa9ce269))
* **test:** update error message to match normalized missing injection wording ([1439564](https://github.com/djodjonx/neosyringe/commit/143956419f696b562482d7c8373a01d1bc3927f6))
* use local import alias for default export class in generated code ([b84384e](https://github.com/djodjonx/neosyringe/commit/b84384ead4f59cacd72aaea222ac4a4012648e28))
* **validator:** skip type and dependency checks for value registrations ([a7754e5](https://github.com/djodjonx/neosyringe/commit/a7754e58ccf45da853a62c1f2fa13f083b371414))


### Performance Improvements

* **core:** cache per-file identifier index in ConfigCollector ([edc4036](https://github.com/djodjonx/neosyringe/commit/edc403620a02d38549bbc24fefe6e4f0a1e89984))
* **core:** replace O(n) findConfigByName with O(1) name index in TokenResolver ([a814759](https://github.com/djodjonx/neosyringe/commit/a814759762daa6c70aecf91292c1a588a450b64e))

## [2.2.3](https://github.com/djodjonx/neosyringe/compare/neosyringe-core-v2.2.2...neosyringe-core-v2.2.3) (2026-06-11)


### Bug Fixes

* capture default export references at module scope for rolldown compatibility ([19e910b](https://github.com/djodjonx/neosyringe/commit/19e910bf0a95926278064945f988476591586897))

## [2.2.2](https://github.com/djodjonx/neosyringe/compare/neosyringe-core-v2.2.1...neosyringe-core-v2.2.2) (2026-06-11)


### Bug Fixes

* use local import alias for default export class in generated code ([b84384e](https://github.com/djodjonx/neosyringe/commit/b84384ead4f59cacd72aaea222ac4a4012648e28))

## [2.2.1](https://github.com/djodjonx/neosyringe/compare/neosyringe-core-v2.2.0...neosyringe-core-v2.2.1) (2026-06-10)


### Bug Fixes

* default export class name in generated code ([28396b3](https://github.com/djodjonx/neosyringe/commit/28396b3a28cd9221bbd02ee387d6b2265afe6846))
* lsp missing injection for imported classes ([b9bf8eb](https://github.com/djodjonx/neosyringe/commit/b9bf8ebe26fb0355b3a688fb1feaa314a862eadb))

## [2.2.0](https://github.com/djodjonx/neosyringe/compare/neosyringe-core-v2.1.0...neosyringe-core-v2.2.0) (2026-06-10)


### Features

* **core:** add Analyzer.extractAll() ([dc44cad](https://github.com/djodjonx/neosyringe/commit/dc44cad451a17207cbba653636fc5cea12e8ff92))


### Bug Fixes

* **core:** include multi-registration tokens in missing-dep available set ([badacba](https://github.com/djodjonx/neosyringe/commit/badacba6c3aa4fc216fcdb68fdf0de2122479923))
* **core:** use per-node lifecycle in generateResolveAllMethod ([aae2864](https://github.com/djodjonx/neosyringe/commit/aae28641d1b3ca5e9f821d17957a123c02b586ad))
* normalize sourceFileName paths for Windows ([4f6cb2c](https://github.com/djodjonx/neosyringe/commit/4f6cb2cb7b47ad4336bf63242c614f74aa4acf0d))


### Performance Improvements

* **core:** cache per-file identifier index in ConfigCollector ([edc4036](https://github.com/djodjonx/neosyringe/commit/edc403620a02d38549bbc24fefe6e4f0a1e89984))

## [2.1.0](https://github.com/djodjonx/neosyringe/compare/neosyringe-core-v2.0.0...neosyringe-core-v2.1.0) (2026-05-06)


### Features

* **core:** add ILogger abstraction to TokenResolverService ([aa38741](https://github.com/djodjonx/neosyringe/commit/aa38741025f414787169850637a2c1a4adef9930))


### Bug Fixes

* address all 15 code review issues ([d66a26a](https://github.com/djodjonx/neosyringe/commit/d66a26af5be3de7e5e4ce521eb689a9fcdf155c7))
* address all remaining code review issues ([2ce9310](https://github.com/djodjonx/neosyringe/commit/2ce9310ce3da4bb49d6ab9b540d7eee9a06aae94))
* address code review feedback ([75fe611](https://github.com/djodjonx/neosyringe/commit/75fe611c933e5ddce015a9c59296af85ea95a9ea))
* address PR review feedback (C2, C4, C5, C6, C7) ([05bd819](https://github.com/djodjonx/neosyringe/commit/05bd8193ebf825e9acbba9f3c41afd8a3a53d085))
* **core:** address code-review issues — guard duplication and struct mutation ([5a6e48d](https://github.com/djodjonx/neosyringe/commit/5a6e48dcb2afc4e73067d1ee49f035044cfac27b))
* **core:** address Copilot PR review comments ([0ff8292](https://github.com/djodjonx/neosyringe/commit/0ff8292b9b1e98bfe4b4bedd65c8381a104789c6))
* **core:** detect cycles involving multi-injection tokens in CycleValidator ([92e3c2a](https://github.com/djodjonx/neosyringe/commit/92e3c2a04923df996e7a5940493c9c4ddef96e06))
* **core:** emit one cycle error per multi-provider instead of only the first ([4e74a25](https://github.com/djodjonx/neosyringe/commit/4e74a2530c1d2569e653138b519e3a0e37bf770f))
* **core:** preserve first-match semantics in buildNameIndex ([7cf69ce](https://github.com/djodjonx/neosyringe/commit/7cf69ce05319ec24182b473001ba500121f557c5))
* **core:** resolve property tokens in DependencyAnalyzer to prevent false missing-dep errors ([250e5ae](https://github.com/djodjonx/neosyringe/commit/250e5ae4504aa4aed0a071f775b550e3c51930a5))
* **core:** unify getHashedTokenIdFromType with getTypeId to prevent type alias token mismatch ([ee580ef](https://github.com/djodjonx/neosyringe/commit/ee580ef03282b69cde18db28d5c8edf1f8f1179f))
* **core:** use TSContext.projectRoot in HashUtils instead of process.cwd() ([f67fbce](https://github.com/djodjonx/neosyringe/commit/f67fbce1c14458979c887c2aa58ca85b581be591))


### Performance Improvements

* **core:** replace O(n) findConfigByName with O(1) name index in TokenResolver ([a814759](https://github.com/djodjonx/neosyringe/commit/a814759762daa6c70aecf91292c1a588a450b64e))

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
