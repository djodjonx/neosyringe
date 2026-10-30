# Baseline T00

HEAD `b2d0033ca3ff139fd50f1c74160d7de2939f64a2`, branche `chore/syringe-corrections-00-reference-et-harnais`, branche par défaut `origin/main`.

Les journaux `baseline-build`, `baseline-typecheck`, `baseline-test`, `baseline-lint` et `baseline-e2e` ont été pris avec Node v22.23.2 et pnpm 10.19.0, après `pnpm install --frozen-lockfile --ignore-scripts`, par les commandes `pnpm build`, `pnpm typecheck`, `pnpm test`, `pnpm lint` et `pnpm test:e2e` (`audit/results/baseline-environment.txt:2`, `audit/results/baseline-environment.txt:4`, `audit/results/baseline-environment.txt:5`, `audit/results/baseline-environment.txt:6`). Le job CI lance Node 20 et Node 22 (`.github/workflows/ci.yml:15`). La relance finale de T00, qui a régénéré `audit/results/audit-*.txt` et `audit/results/t00-e2e-after.txt`, a utilisé Node v24.7.0 et pnpm 10.19.0 (`audit/results/baseline-environment.txt:8`, `audit/results/baseline-environment.txt:9`, `audit/results/audit-runtime.txt:1`).

Versions lues dans le dépôt : pnpm 10.19.0 (`package.json:43`), TypeScript 5.9.3 (`node_modules/typescript/package.json:5`), Vitest 4.0.17 (`node_modules/vitest/package.json:4`, `audit/results/baseline-test.txt:8`), esbuild 0.27.2 (`pnpm-lock.yaml:2728`), Rollup 4.55.2 (`pnpm-lock.yaml:3959`).

## Commandes

`pnpm build` (`package.json:9`). Journal `audit/results/baseline-build.txt`. Portée 7 projets sur 8 (`audit/results/baseline-build.txt:5`). Dernière ligne de paquet : `packages/unplugin build: Done` (`audit/results/baseline-build.txt:124`). Le journal ne contient pas `ELIFECYCLE`.

`pnpm typecheck` (`package.json:13`, `tsc --noEmit`, `audit/results/baseline-typecheck.txt:3`). Aucune ligne `error TS` dans les journaux `baseline-*.txt`.

`pnpm test` (`package.json:10`). Journal `audit/results/baseline-test.txt`. Vitest v4.0.17 (`audit/results/baseline-test.txt:8`). Comptes affichés : neosyringe 3 (`audit/results/baseline-test.txt:12`), core 299 sur 53 fichiers (`audit/results/baseline-test.txt:684`, `audit/results/baseline-test.txt:685`), ui 20 (`audit/results/baseline-test.txt:697`), lsp 38 (`audit/results/baseline-test.txt:706`), unplugin 41 sur 11 fichiers (`audit/results/baseline-test.txt:751`, `audit/results/baseline-test.txt:752`), cli 24 sur 3 fichiers (`audit/results/baseline-test.txt:757`, `audit/results/baseline-test.txt:758`). Le journal ne contient pas `ELIFECYCLE`.

`pnpm lint` (`package.json:12`, oxlint). Journal `audit/results/baseline-lint.txt:97` : 1763 warnings et 0 errors.

`pnpm test:e2e` (`package.json:11`) exige un `pnpm build` avant. Le harnais importe `packages/unplugin/dist/index.mjs` et `packages/core/dist/TSContext.mjs` après le contrôle (`tests/e2e/helpers/execute-fixture.ts:149`, `tests/e2e/helpers/execute-fixture.ts:150`), et charge le runtime dont le point d'entrée CJS est le champ `main` du package (`packages/neosyringe/package.json:7`, `tests/e2e/helpers/execute-fixture.ts:16`). `dist/` est ignoré (`.gitignore:6`). `test:e2e` ne lance pas de build (`package.json:11`). `assertDistFresh` échoue tout de suite si un de ces fichiers manque ou est plus vieux que le fichier le plus récent de `packages/*/src`, et le message nomme `pnpm build` (`tests/e2e/helpers/execute-fixture.ts:12`, `tests/e2e/helpers/execute-fixture.ts:78`, `tests/e2e/helpers/execute-fixture.ts:83`).

Journal d'origine, avant les tests T00 : `audit/results/baseline-e2e.txt`. 8 snapshots échoués, 5 fichiers échoués et 4 réussis sur 9, 16 tests échoués et 92 réussis sur 108 (`audit/results/baseline-e2e.txt:3106`). Exit code 1 (`audit/results/baseline-e2e.txt:3110`).

Journal après les tests T00 : `audit/results/t00-e2e-after.txt`. 8 snapshots échoués (`audit/results/t00-e2e-after.txt:3131`), 5 fichiers échoués et 5 réussis sur 10 (`audit/results/t00-e2e-after.txt:3132`), 16 tests échoués et 102 réussis sur 118 (`audit/results/t00-e2e-after.txt:3133`). Exit code 1 (`audit/results/t00-e2e-after.txt:3137`).

## Seize échecs e2e

0 défaut fonctionnel. 8 snapshots obsolètes, tous des `toMatchSnapshot`. 8 attentes de test obsolètes, des `toContain` ou des `toThrow`. Aucun de ces seize journaux n'est un échec d'outil : chaque ligne est une assertion Vitest.

- `tests/e2e/generated-code.test.ts` :: Parent Container > should delegate to parent in resolve — attente de test obsolète — `audit/results/baseline-e2e.txt:280` attend `this.parent`. Le texte généré déclare `private legacy?` (`audit/results/baseline-e2e.txt:128`). La délégation s'écrit `if (this.legacy)` (`packages/core/src/generator/Generator.ts:385`).
- `tests/e2e/generated-code.test.ts` :: Error Detection > should detect missing bindings — attente de test obsolète — `audit/results/baseline-e2e.txt:299` attend `/Missing binding/` et reçoit `Missing injection: 'MissingDependency'...` (`audit/results/baseline-e2e.txt:294`). Le validateur émet cette formulation (`packages/core/src/generator/GraphValidator.ts:81`).
- `tests/e2e/generated-code.test.ts` :: Complex Scenarios > should handle deeply nested parent containers — attente de test obsolète (guillemets) — `audit/results/baseline-e2e.txt:486` attend `'Application'`. Le texte émet `new NeoContainer([domainContainer], "Application")` (`audit/results/baseline-e2e.txt:480`). Le générateur passe le nom par `JSON.stringify` (`packages/core/src/generator/Generator.ts:438`).
- `tests/e2e/inversify.test.ts` :: should generate valid code bridging to Inversify — attente de test obsolète (guillemets) — `audit/results/baseline-e2e.txt:673` attend `'ReportingApp'`. Le texte émet `new NeoContainer([legacy], "ReportingApp")` (`audit/results/baseline-e2e.txt:667`). Même `JSON.stringify` (`packages/core/src/generator/Generator.ts:438`).
- `tests/e2e/snapshots.test.ts` :: should match snapshot for simple service — snapshot obsolète — `toMatchSnapshot` (`audit/results/baseline-e2e.txt:903`). Le diff passe de `'SimpleApp'` à `"SimpleApp"` (`audit/results/baseline-e2e.txt:896`, `audit/results/baseline-e2e.txt:897`).
- `tests/e2e/snapshots.test.ts` :: should match snapshot for service with dependencies — snapshot obsolète — `toMatchSnapshot` (`audit/results/baseline-e2e.txt:1120`). Le diff passe de `'UserApp'` à `"UserApp"` (`audit/results/baseline-e2e.txt:1113`, `audit/results/baseline-e2e.txt:1114`).
- `tests/e2e/snapshots.test.ts` :: should match snapshot for interface tokens — snapshot obsolète — `toMatchSnapshot` (`audit/results/baseline-e2e.txt:1351`). Le diff passe de `'InterfaceApp'` à `"InterfaceApp"` (`audit/results/baseline-e2e.txt:1344`, `audit/results/baseline-e2e.txt:1345`).
- `tests/e2e/snapshots.test.ts` :: should match snapshot for mixed scopes — snapshot obsolète — `toMatchSnapshot` (`audit/results/baseline-e2e.txt:1585`). Le diff passe de `'ScopesApp'` à `"ScopesApp"` (`audit/results/baseline-e2e.txt:1578`, `audit/results/baseline-e2e.txt:1579`).
- `tests/e2e/snapshots.test.ts` :: should match snapshot for parent container — snapshot obsolète — `toMatchSnapshot` (`audit/results/baseline-e2e.txt:1813`). Le diff passe de `'ChildApp'` à `"ChildApp"` (`audit/results/baseline-e2e.txt:1807`, `audit/results/baseline-e2e.txt:1808`).
- `tests/e2e/snapshots.test.ts` :: should match snapshot for legacy container — snapshot obsolète — `toMatchSnapshot` (`audit/results/baseline-e2e.txt:2030`). Le diff passe de `'LegacyApp'` à `"LegacyApp"` (`audit/results/baseline-e2e.txt:2023`, `audit/results/baseline-e2e.txt:2024`).
- `tests/e2e/snapshots.test.ts` :: should match snapshot for property tokens — snapshot obsolète — `toMatchSnapshot` (`audit/results/baseline-e2e.txt:2250`). Le diff passe de `'PropertyApp'` à `"PropertyApp"` (`audit/results/baseline-e2e.txt:2243`, `audit/results/baseline-e2e.txt:2244`).
- `tests/e2e/snapshots.test.ts` :: should match snapshot for complex real-world scenario — snapshot obsolète — `toMatchSnapshot` (`audit/results/baseline-e2e.txt:2468`). Le diff passe de `'RealWorldApp'` à `"RealWorldApp"` (`audit/results/baseline-e2e.txt:2461`, `audit/results/baseline-e2e.txt:2462`).
- `tests/e2e/standalone.test.ts` :: should compile a complete application with interfaces and classes — attente de test obsolète (guillemets) — `audit/results/baseline-e2e.txt:2703` attend `'AppContainer'`. Le texte émet `new NeoContainer(undefined, "AppContainer")` (`audit/results/baseline-e2e.txt:2697`). Le paramètre par défaut `'NeoContainer'` (`audit/results/baseline-e2e.txt:129`) n'est pas la valeur de cet appel : le nom est passé (`packages/core/src/generator/Generator.ts:438`).
- `tests/e2e/standalone.test.ts` :: should compile with parent NeoSyringe container — attente de test obsolète (guillemets) — `audit/results/baseline-e2e.txt:2890` attend `'AppContainer'`. Le texte émet `new NeoContainer([sharedKernel], "AppContainer")` (`audit/results/baseline-e2e.txt:2884`).
- `tests/e2e/tsyringe.test.ts` :: should generate valid code bridging to tsyringe — attente de test obsolète (guillemets) — `audit/results/baseline-e2e.txt:3077` attend `'AppWithTsyringe'`. Le texte émet `new NeoContainer([legacy], "AppWithTsyringe")` (`audit/results/baseline-e2e.txt:3071`).
- `tests/e2e/tsyringe.test.ts` :: should detect missing legacy token declaration — attente de test obsolète — `audit/results/baseline-e2e.txt:3096` attend `/Missing binding.*MissingService/` et reçoit `Missing injection: 'MissingService'...` (`audit/results/baseline-e2e.txt:3091`). Même formulation du validateur (`packages/core/src/generator/GraphValidator.ts:81`).

## Scripts historiques

`pnpm exec node audit/run-historical.mjs`. La relance finale a enregistré Node v24.7.0 (`audit/results/audit-runtime.txt:1`). Les cinq processus ont `exit: 0` (`audit/results/audit-runtime.txt:4`). `cwd` est `.` (`audit/results/audit-runtime.txt:3`). La qualification est la phrase `exit N n'est pas une réussite du contrat ; comparer la sortie à audit/BASELINE.md`, plus les valeurs lues dans stdout (`audit/run-historical.mjs:67`, `audit/run-historical.mjs:107`). Elle ne fige pas une observation. Le runner s'arrête si un script existe déjà à la racine avec des octets, ou si `.audit-tree-shaking/` existe déjà (`audit/run-historical.mjs:33`, `audit/run-historical.mjs:40`). Il n'efface que le fichier et le dossier qu'il a créés (`audit/run-historical.mjs:94`, `audit/run-historical.mjs:97`).

- `audit/results/audit-runtime.txt:5` et lignes 7 à 12.
- `audit/results/audit-edge-cases.txt:5` et lignes 7 à 15.
- `audit/results/audit-types.txt:5` et lignes 7 à 10.
- `audit/results/audit-devtools.txt:5` et ligne 8.
- `audit/results/audit-tree-shaking.txt:5`, lignes 11 à 12 (`unusedPayloadRetained` true) et ligne 43 (`Verified 36`).

Digests : `audit/historical/SHA256SUMS:1` à `:5`.

## Inventaire NS

- NS001 — encore reproductible. `generic_tokens` résout vers `{"value":{"total":42}}` (`audit/results/audit-edge-cases.txt:10`).
- NS002 — encore reproductible. `inherited_constructor.injected` vaut false (`audit/results/audit-edge-cases.txt:12`).
- NS003 — encore reproductible. `factory_missing` compile puis échoue à l'exécution (`audit/results/audit-runtime.txt:11`).
- NS004 — encore reproductible. `wrong_container` compile puis ne trouve pas `ILogger` (`audit/results/audit-runtime.txt:12`).
- NS005 — encore reproductible. `async` compile puis lève la garde `initialize` (`audit/results/audit-runtime.txt:9`).
- NS006 — encore reproductible. `concurrent_init.factoryCalls` vaut 2 (`audit/results/audit-edge-cases.txt:7`).
- NS007 — encore reproductible. `multi_async` a `initializeType` undefined et des promesses (`audit/results/audit-edge-cases.txt:8`). `multi_dispose.disposed` vaut 0 (`audit/results/audit-edge-cases.txt:9`).
- NS008 — encore reproductible. `override.after` reste `"mock"` (`audit/results/audit-runtime.txt:8`).
- NS009 — encore reproductible. `scoped.throughService` vaut `"real"` alors que `direct` vaut `"mock"` (`audit/results/audit-runtime.txt:10`).
- NS010 — encore reproductible. Quatre diagnostics 2339 : `initialize`, `override`, `clearOverrides`, `on` (`audit/results/audit-types.txt:7`).
- NS011 — encore reproductible. `property_variable` lève `useProperty` appelé au runtime (`audit/results/audit-edge-cases.txt:11`).
- NS012 — encore reproductible. `alias_marker` et `namespace_marker` laissent `defineBuilderConfig` au runtime (`audit/results/audit-edge-cases.txt:13`). `false_positive_marker` produit `NeoContainer_5e07e591` (`audit/results/audit-edge-cases.txt:15`).
- NS013 — encore reproductible. `middlewareInstalled` true et `graphs` vide (`audit/results/audit-devtools.txt:8`).
- NS014 — encore reproductible. `pnpm test:e2e` sort en code 1 avec 16 échecs (`audit/results/baseline-e2e.txt:3106`, `audit/results/baseline-e2e.txt:3110`). Le job CI lance `pnpm build` puis `pnpm test:coverage` et ne lance pas `pnpm test:e2e` (`.github/workflows/ci.yml:25`, `.github/workflows/ci.yml:34`). Après les tests T00, le même constat tient : 16 échoués, 102 réussis, exit 1 (`audit/results/t00-e2e-after.txt:3133`, `audit/results/t00-e2e-after.txt:3137`).
- NS015 — encore reproductible. Le guide coche « Zero runtime overhead » (`docs/guide/why-neo-syringe.md:9`) et annonce ~0 KB (`docs/guide/why-neo-syringe.md:31`). Le générateur émet une comparaison `if (token === ...)` par service (`packages/core/src/generator/ResolveEmitter.ts:30`).
- NS016 — encore reproductible. Le graphe ne connaît que `'singleton' | 'transient'` (`packages/core/src/analyzer/types.ts:44`). Le guide présente ce transient comme une instance par requête (`docs/guide/lifecycle.md:75`, `docs/guide/lifecycle.md:79`, `docs/guide/lifecycle.md:113`). Il n'y a pas de scope de requête.
- NS017 — encore reproductible. 36 combinaisons ont le runtime `used-ok` (`audit/results/audit-tree-shaking.txt:43`). `unused_registered` garde la charge utile sur esbuild et Rollup (`audit/results/audit-tree-shaking.txt:11`, `audit/results/audit-tree-shaking.txt:12`). Exit 0 : le script vérifie la rétention actuelle, pas une élimination cible.
