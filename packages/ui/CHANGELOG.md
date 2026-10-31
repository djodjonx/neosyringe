# Changelog

## [0.3.0](https://github.com/djodjonx/neosyringe/compare/neosyringe-ui-v0.2.1...neosyringe-ui-v0.3.0) (2026-10-31)


### Features

* **vscode:** codelens opens graph on correct container via postMessage ([91e267b](https://github.com/djodjonx/neosyringe/commit/91e267bc6f78cce3a75095c16741ee41300bc88a))


### Bug Fixes

* **ui:** declare DATA before running the inline standalone script ([cae054e](https://github.com/djodjonx/neosyringe/commit/cae054ecd8703913da3cb71ef1b9d9affef3ca43))
* **ui:** rename 'Value' to 'useValue' in legend/stats, move detail panel below graph ([cbbbe5f](https://github.com/djodjonx/neosyringe/commit/cbbbe5f8e4a152dea7c75a57a5eec717b5280ed6))
* **ui:** reset edge styles before highlighting new node selection ([b2d0033](https://github.com/djodjonx/neosyringe/commit/b2d0033ca3ff139fd50f1c74160d7de2939f64a2))
* **vscode:** fix CSP blocking, event delegation, refresh, layout improvements ([97545a3](https://github.com/djodjonx/neosyringe/commit/97545a3f3dbf4c232eb58ddeb779312cd064e8a2))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @djodjonx/neosyringe-core bumped to 3.2.1

## [0.2.1](https://github.com/djodjonx/neosyringe/compare/neosyringe-ui-v0.2.0...neosyringe-ui-v0.2.1) (2026-09-12)


### Bug Fixes

* **ui:** add CSP meta tag to allow Mermaid CDN in VSCode WebViews ([e0bee51](https://github.com/djodjonx/neosyringe/commit/e0bee51273af01ef665baab8e2843ec3758fc1e1))

## [0.2.0](https://github.com/djodjonx/neosyringe/compare/neosyringe-ui-v0.1.0...neosyringe-ui-v0.2.0) (2026-09-12)


### Features

* graph visualization (UI package, CLI export, Vite devtools, VSCode extension) ([0d1ea7d](https://github.com/djodjonx/neosyringe/commit/0d1ea7db51680777fc3ab63742ead9c70d3a90d4))
* **ui:** implement serializeGraph, graphToMermaid, buildStandaloneHtml ([8c2813c](https://github.com/djodjonx/neosyringe/commit/8c2813cfc34315858ea5c5951bf43d52125c6255))
* **ui:** scaffold neosyringe-ui package ([e433e60](https://github.com/djodjonx/neosyringe/commit/e433e6044d9bc21025119e22bf67eca8984b0798))
