# Coût d'exécution

Banc reproductible. Un processus Node neuf par cas et par index de processus. La compilation est hors du chronomètre du worker. L'ordre des cas est inversé aux index de processus impairs (`tests/bench/runtime-cost.mjs:711-713`).

Le banc charge `Analyzer` et `Generator` depuis le `dist` déjà construit (`tests/bench/runtime-cost.mjs:17-18`). L'émetteur passé au générateur est absent (`tests/bench/runtime-cost.mjs:319`), donc l'émetteur optimisé est choisi quand le profil est `minimal` ou le mode `closed` (`packages/core/src/generator/Generator.ts:201-203`). Le worker ne charge pas esbuild. esbuild ne sert qu'à la taille minifiée, après les processus (`tests/bench/runtime-cost.mjs:648`).

## Matrice

Formes `flat`, `chain`, `diamond`, `multi`, `parent`. Profils `full`, `minimal`. Modes `open`, `closed`. Tailles `10`, `100`, `1000`, `5000`.

Le mode `open` ne déclare pas de racines (`packages/core/src/analyzer/parsers/ConfigParser.ts:604-616`). Le mode `closed` liste chaque jeton mesuré dans `optimization.roots` (`tests/bench/runtime-cost.mjs:122-124`).

Variables, avec leur défaut (`tests/bench/runtime-cost.mjs:22-29`) :

- `NEOSYRINGE_BENCH_SIZES` — `10,100,1000,5000`
- `NEOSYRINGE_BENCH_SHAPES` — `flat,chain,diamond,multi,parent`
- `NEOSYRINGE_BENCH_PROFILES` — `full,minimal`
- `NEOSYRINGE_BENCH_MODES` — `open,closed`
- `NEOSYRINGE_BENCH_PROCESSES` — `5`
- `NEOSYRINGE_BENCH_SAMPLES` — `7`
- `NEOSYRINGE_BENCH_RESOLVE_COUNT` — `100000`. Pour `multi`, le nombre d'appels est `max(256, floor(50000 / size))` (`tests/bench/runtime-cost.mjs:84-86`). La formule est dans `params.multiResolveCount`. Le nombre utilisé est `cases[].resolveCount`.
- `NEOSYRINGE_BENCH_RESOLVE_BATCHES` — `7`
- `NEOSYRINGE_BENCH_REPORT` — fichier JSON. Sans elle, le rapport va dans le répertoire temporaire.
- `NEOSYRINGE_BENCH_BROKEN` — `1` ajoute une seconde inscription du service async. Le cas échoue à la compilation (`tests/bench/runtime-cost.mjs:110`).

```bash
node tests/bench/runtime-cost.mjs
```

La sortie nomme le rapport et le nombre de cas. Les durées restent dans le JSON. Un cas qui ne compile pas est noté dans `error` et la matrice continue (`tests/bench/runtime-cost.mjs:703-705`). Le processus sort en code 1 si un cas a une erreur (`tests/bench/runtime-cost.mjs:812`). Sinon le code est 0.

## Contrôles

Un contrôle qui échoue empêche de garder la durée.

- `warm-resolve` : deux lots d'échauffement sont jetés. Chaque lot gardé a la somme des indices attendue. Une instance fausse donne `incorrect resolution` (`tests/bench/lib/measure.mjs:43`). Pour `multi`, un appel est `resolveAll` puis l'index. Le temps est divisé par la taille (`tests/bench/lib/measure.mjs:44`, `tests/bench/runtime-cost.mjs:483-486`). `resolveAll` construit une liste neuve (`packages/core/src/generator/ResolveEmitter.ts:138-139`).
- `cold-resolve` : au moins 7 échantillons par processus. Le conteneur est recréé hors du chronomètre, puis une résolution est mesurée. `value` doit être l'index, sinon `incorrect resolution` (`tests/bench/lib/measure.mjs:77-81`). Pour `multi`, c'est le premier `resolveAll` (ns par appel), sans division par la taille (`tests/bench/runtime-cost.mjs:483`).
- `create` : pas de contrôle de valeur. Le chronomètre couvre la construction.
- `createScope` : le chronomètre n'a pas de contrôle de valeur. Avant les échantillons, chaque singleton de scope est libéré exactement une fois (`tests/bench/lib/measure.mjs:49-51`). `createScope` fait `new Class(this.legacy, this.name)` (`packages/core/src/generator/LifecycleEmitter.ts:309-311`).
- `initialize` : la fixture a un service async `BenchReady`. Après `await initialize()`, `ready` doit valoir `true`, sinon `async service not ready` (`tests/bench/runtime-cost.mjs:98-101`). Pour `parent`, le chronomètre est `child.initialize()`. Il démarre aussi `BenchReadyParent`. Les deux sont vérifiés (`tests/bench/runtime-cost.mjs:453-454`).
- `destroy` : après le `destroy` chronométré, chaque instance résolue a `disposed === 1`, sinon `destroy did not dispose instance` (`tests/bench/runtime-cost.mjs:102-105`). Pour `parent`, la métrique est seulement `child.destroy()` (`tests/bench/runtime-cost.mjs:459`). Les instances du parent restent à 0.
- `import` : pas de contrôle de valeur. Un échantillon par processus, à cause du cache de modules (`tests/bench/runtime-worker.mjs:13-15`). Cinq processus sont exigés. Sept échantillons ne le sont pas (`scripts/ci/lib/performance-budget.mjs:48-49`).
- `heapAfterGc` : pas de contrôle de valeur.
- `build` : sept compilations par groupe, dans le processus parent, hors des workers (`tests/bench/runtime-cost.mjs:628-630`). Sous la taille 1000, cinq groupes. À 1000 et 5000, un seul groupe : la règle des cinq médianes ne s'applique pas (`scripts/ci/lib/performance-budget.mjs:43-45`, `scripts/ci/performance-budget.mjs:64-68`). Une compilation qui échoue remplit `error`. Elle ne produit pas d'échantillon.

`recreate` détruit le conteneur seulement si `settle` ne l'a pas déjà fait (`tests/bench/runtime-cost.mjs:393-400` et `:523-530`).

## Rapport

`environment` porte `node`, `typescript`, `sha`, `dirty`, `cpu`, `cores`, `memory`, `os`, `flags` (`tests/bench/runtime-cost.mjs:768-778`). `params` reprend la matrice, plus `multiResolveCount`, `buildGroups` et `caseOrder` (`tests/bench/runtime-cost.mjs:779-791`). `schedule` est l'ordre réel des processus. Chaque cas porte `shape`, `profile`, `mode`, `size`, `checksum`, `resolveCount`, et, sans erreur, `buildMs`, `module.raw`, `module.min`, `module.gzip`, et les métriques. Chaque métrique porte `unit`, `processes` (échantillons bruts), `processMedians`, `median`, `mad`.

Unités : `warm-resolve` en ns/op. Pour `multi`, c'est une contribution de `resolveAll`. `import`, `create`, `cold-resolve`, `createScope`, `initialize`, `destroy` en ns. Pour `multi`, `cold-resolve` est un appel `resolveAll`. `heapAfterGc` en octets. `build` et `buildMs` en ms. Les tailles de module en octets.

## Budget

Un écart est un échec seulement si la médiane régresse de plus de 10 % et si le delta dépasse `2 × (MAD de base + MAD candidate)`. Si le bruit dépasse 10 % de la médiane de base, le verdict est `inconclusive`. Sinon `pass` (`scripts/ci/lib/performance-budget.mjs:24-26`). Les médianes viennent des échantillons de `processes`, pas du champ `processMedians` (`scripts/ci/performance-budget.mjs:34-36` et `:71-73`).

Moins de 5 médianes de processus, ou une médiane nulle ou négative, est refusé (`scripts/ci/lib/performance-budget.mjs:9`). Moins de 5 processus, ou moins de 7 échantillons hors `import` et hors l'exemption `build` des tailles 1000 et 5000, est refusé avec le message `at least 7 samples per process and 5 processes required` (`scripts/ci/lib/performance-budget.mjs:41-50`).

`node`, `typescript`, `cpu` et `flags` doivent être identiques. `params` aussi. Les messages sont `environment mismatch: node`, `environment mismatch: typescript`, `environment mismatch: cpu`, `environment mismatch: flags` et `params mismatch` (`scripts/ci/lib/performance-budget.mjs:30-36`).

Un cas présent dans la base et absent du candidat est un échec. Un cas en erreur, ou une métrique absente d'un côté, est un échec (`scripts/ci/performance-budget.mjs:42-60`).

```bash
node scripts/ci/performance-budget.mjs --baseline <fichier> --candidate <fichier>
```

La commande lit les deux fichiers et n'en écrit aucun (`scripts/ci/performance-budget.mjs:1` et `:13-15`). La table sort sur stdout.

Codes de sortie du budget :

- `2` — arguments invalides (`scripts/ci/performance-budget.mjs:6-8`)
- `1` — rapport refusé, ou verdict résumé `fail` (`scripts/ci/performance-budget.mjs:21` et `:92`)
- `0` — verdict résumé `pass` ou `inconclusive` (`scripts/ci/performance-budget.mjs:92`)

Codes de sortie du banc :

- `0` — aucun cas en erreur
- `1` — au moins un cas a `error` (`tests/bench/runtime-cost.mjs:812`)

## CI

Le workflow `.github/workflows/benchmark.yml` est informatif. Il ne certifie pas une performance (`.github/workflows/benchmark.yml:8` et `:33-35`). Il construit d'abord les paquets, parce que `dist/` n'est pas versionné (`.gitignore:6`). Le cas CI est `flat`, `full`, `open`, taille 10, `NEOSYRINGE_BENCH_RESOLVE_COUNT=1000` (`.github/workflows/benchmark.yml:24-31`). `set -o pipefail` fait échouer l'étape si le budget échoue. `continue-on-error` laisse le job continuer (`.github/workflows/benchmark.yml:35-37`). Sans fichier de base, la comparaison écrit `no baseline; comparison skipped` et cette branche sort en code 0 (`.github/workflows/benchmark.yml:40-41`).

## Banc de compilation

`tests/bench/compile-cost.mjs` ajoute une ligne `# environment` suivie du JSON machine (`tests/bench/compile-cost.mjs:434-444`). La ligne de mesures ajoute `samples_json` après `max` (`tests/bench/compile-cost.mjs:421`, `tests/bench/compile-cost.mjs:445`). Les neuf champs déjà imprimés restent `size`, `shape`, `profile`, `mode`, `tool`, `metric`, `median`, `min`, `max`.

## Baseline (stage A)

to be filled by the measurement campaign
