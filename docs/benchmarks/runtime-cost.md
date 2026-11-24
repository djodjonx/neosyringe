# Coût d'exécution

Banc reproductible. Un processus Node neuf par cas et par index de processus. La compilation est hors du chronomètre du worker. L'ordre des cas est inversé aux index de processus impairs (`tests/bench/runtime-cost.mjs:893`).

Le banc charge `Analyzer` et `Generator` depuis le `dist` déjà construit (`tests/bench/runtime-cost.mjs:17-18`). L'émetteur passé au générateur est absent (`tests/bench/runtime-cost.mjs:327`), donc l'émetteur optimisé est choisi quand le profil est `minimal` ou le mode `closed` (`packages/core/src/generator/Generator.ts:201-204`). Le worker ne charge pas esbuild. esbuild ne sert qu'à la taille minifiée, après les processus (`tests/bench/runtime-cost.mjs:795`).

## Matrice

Formes `flat`, `chain`, `diamond`, `multi`, `parent`. Profils `full`, `minimal`. Modes `open`, `closed`. Tailles `10`, `100`, `1000`, `5000`.

Le mode `open` ne déclare pas de racines (`packages/core/src/analyzer/parsers/ConfigParser.ts:604-612`). Le mode `closed` liste chaque jeton mesuré dans `optimization.roots` (`tests/bench/runtime-cost.mjs:131`).

Variables, avec leur défaut (`tests/bench/runtime-cost.mjs:22-29`) :

- `NEOSYRINGE_BENCH_SIZES` — `10,100,1000,5000`
- `NEOSYRINGE_BENCH_SHAPES` — `flat,chain,diamond,multi,parent`
- `NEOSYRINGE_BENCH_PROFILES` — `full,minimal`
- `NEOSYRINGE_BENCH_MODES` — `open,closed`
- `NEOSYRINGE_BENCH_PROCESSES` — `5`
- `NEOSYRINGE_BENCH_SAMPLES` — `7`
- `NEOSYRINGE_BENCH_RESOLVE_COUNT` — `100000`. Pour `multi`, le nombre d'appels de départ est `max(256, floor(50000 / size))` (`tests/bench/runtime-cost.mjs:84-86`). La formule est dans `params.multiResolveCount`. La calibration peut allonger `warm-resolve`. La mesure garde ce nombre. Il est publié dans `cases[].resolveCount`.
- `NEOSYRINGE_BENCH_RESOLVE_BATCHES` — `7`
- `NEOSYRINGE_BENCH_REPORT` — fichier JSON. Sans elle, le rapport va dans le répertoire temporaire.
- `NEOSYRINGE_BENCH_K_FROM` — chemin d'un rapport déjà écrit. Son `params.k` fixe le `k` de chaque cas (`tests/bench/runtime-cost.mjs:724-737`). Sans elle, un worker de calibration choisit `k`.
- `NEOSYRINGE_BENCH_BROKEN` — `1` ajoute une seconde inscription du service async. Le cas échoue à la compilation (`tests/bench/runtime-cost.mjs:118`).

```bash
node tests/bench/runtime-cost.mjs
```

La sortie nomme le rapport et le nombre de cas. Les durées restent dans le JSON. Un cas qui ne compile pas est noté dans `error` et la matrice continue (`tests/bench/runtime-cost.mjs:863-865`). Le processus sort en code 1 si un cas a une erreur (`tests/bench/runtime-cost.mjs:994`). Sinon le code est 0.

## Horloge

`performance.now` avance par pas. Une seule opération tient dans quelques pas, et un pas de plus ressemble à une régression. Le worker mesure la résolution au démarrage (`tests/bench/runtime-worker.mjs:22`, `tests/bench/lib/measure.mjs:44-60`). Le rapport la range dans `environment.timerResolutionNs`. Un échantillon chronométré doit durer au moins `max(1 ms, 1000 × timerResolutionNs)` (`tests/bench/lib/measure.mjs:12-13` et `tests/bench/lib/measure.mjs:63-67`). Ce plancher est `params.sampleMinimumNs`.

Un worker de calibration par cas choisit `k` avant la rotation. Ses échantillons ne sont pas gardés (`tests/bench/runtime-cost.mjs:871-884`, `tests/bench/lib/measure.mjs:5-7`). La sonde vise le double du minimum (`tests/bench/lib/measure.mjs:82-85`). Tant qu'elle est plus courte, `k` passe à la puissance de dix supérieure (`tests/bench/lib/measure.mjs:70-79`, `tests/bench/lib/measure.mjs:215-225`). `NEOSYRINGE_BENCH_K_FROM` remplace cette recherche par le `params.k` du rapport donné (`tests/bench/runtime-cost.mjs:724-737`). Une seule sonde vérifie ce `k` avec la règle d'un échantillon gardé : au moins une fois le minimum, pas le double (`tests/bench/lib/measure.mjs:87-89`, `tests/bench/lib/measure.mjs:215-220`, `tests/bench/lib/measure.mjs:121-124`). Un cas devenu plus rapide garde donc son `k` tant que sa sonde couvre le minimum. Une sonde sous le minimum donne `batch k exceeded` au cas. Le `k` n'est jamais recalculé. Une clé absente reçoit `missing batch k` (`tests/bench/runtime-cost.mjs:735-736`).

Chaque processus mesuré reprend ensuite le même `k` et la même procédure. `k` ne change plus (`tests/bench/lib/measure.mjs:203-212`, `tests/bench/lib/measure.mjs:131-141`). Deux lots d'échauffement sont jetés (`tests/bench/lib/measure.mjs:15`, `tests/bench/lib/measure.mjs:206-208`). Le seuil d'un échantillon gardé est le minimum, pas le double (`tests/bench/lib/measure.mjs:84`). Un échantillon gardé plus court incrémente `shortSamples` et reste dans la série (`tests/bench/lib/measure.mjs:209-210`). `gc` court après `prepare` et avant le chronomètre (`tests/bench/lib/measure.mjs:191-194`). La préparation, le contrôle et la libération restent hors du chronomètre (`tests/bench/lib/measure.mjs:192-200`). La valeur publiée est le temps du lot divisé par `k` (`tests/bench/lib/measure.mjs:91-93`). `import` n'est pas soumis à ce minimum. `schedule` est la rotation de mesure, inversée aux index impairs (`tests/bench/runtime-cost.mjs:891-893`).

## Contrôles

Un contrôle qui échoue empêche de garder la durée. Chaque objet du lot est contrôlé (`tests/bench/lib/measure.mjs:198`).

- `warm-resolve` : deux lots d'échauffement sont jetés (`tests/bench/lib/measure.mjs:135-137`). Chaque lot gardé a la somme des indices attendue. Une instance fausse donne `incorrect resolution` (`tests/bench/lib/measure.mjs:118`). Pour `multi`, un appel est `resolveAll` puis l'index. Le temps est divisé par la taille (`tests/bench/lib/measure.mjs:91-93`, `tests/bench/runtime-cost.mjs:541` et `tests/bench/runtime-cost.mjs:583`). `resolveAll` construit une liste neuve (`packages/core/src/generator/ResolveEmitter.ts:138-140`). En calibration, un lot plus court que le double du minimum augmente le nombre d'appels. En mesure, ce nombre reste fixe.
- `cold-resolve` : au moins 7 échantillons par processus. `k` conteneurs sont préparés hors du chronomètre, puis la première résolution de chacun est mesurée. `value` doit être l'index, sinon `incorrect resolution` (`tests/bench/runtime-cost.mjs:653-666`). Pour `multi`, c'est le premier `resolveAll` (ns par appel), sans division par la taille (`tests/bench/runtime-cost.mjs:544`).
- `create` : `k` constructions sont chronométrées, puis chaque objet est contrôlé et détruit hors du chronomètre. Un objet sans `resolve` ni `destroy` donne `create produced nothing` (`tests/bench/runtime-cost.mjs:107-110`).
- `createScope` : `k` scopes sont chronométrés sur un conteneur déjà ouvert, puis détruits hors du chronomètre. Un scope sans `destroy` donne `createScope produced nothing` (`tests/bench/runtime-cost.mjs:112-113`). Avant les échantillons, chaque singleton de scope est libéré exactement une fois (`tests/bench/lib/measure.mjs:164-167`).
- `initialize` : `k` conteneurs neufs sont préparés hors du chronomètre. Le lot chronomètre leur `initialize`. Ensuite `ready` doit valoir `true`, sinon `async service not ready` (`tests/bench/runtime-cost.mjs:98-100`). Pour `parent`, le chronomètre est `child.initialize()` (`tests/bench/runtime-cost.mjs:470-472`). Les deux services async sont vérifiés (`tests/bench/runtime-cost.mjs:474-476`).
- `destroy` : `k` conteneurs sont créés hors du chronomètre. Le lot chronomètre leur `destroy`, puis chaque instance résolue doit avoir `disposed === 1`, sinon `destroy did not dispose instance` (`tests/bench/runtime-cost.mjs:102-105`). Pour `parent`, la métrique est seulement `child.destroy()` (`tests/bench/runtime-cost.mjs:497-499`). Les instances du parent restent à 0 (`tests/bench/runtime-cost.mjs:501-503`).
- `import` : pas de contrôle de valeur. Un échantillon par processus, à cause du cache de modules (`tests/bench/runtime-worker.mjs:16-18`). Cinq processus sont exigés. Sept échantillons ne le sont pas (`scripts/ci/lib/performance-budget.mjs:70-71`). Ce n'est pas un lot.
- `heapAfterGc` : pas de contrôle de valeur. Ce n'est pas un lot.
- `build` : sept compilations par groupe, dans le processus parent, hors des workers (`tests/bench/runtime-cost.mjs:773-779`). Sous la taille 1000, cinq groupes. À 1000 et 5000, un seul groupe : la règle des cinq médianes ne s'applique pas (`scripts/ci/lib/performance-budget.mjs:65-67`, `scripts/ci/performance-budget.mjs:60-65`). Une compilation qui échoue remplit `error`. Elle ne produit pas d'échantillon.

## Rapport

`environment` porte `node`, `typescript`, `sha`, `dirty`, `cpu`, `cores`, `memory`, `os`, `flags`, `timerResolutionNs` (`tests/bench/runtime-cost.mjs:947-958`). `params` reprend la matrice, plus `sampleMinimumNs`, `k`, `multiResolveCount`, `buildGroups` et `caseOrder` (`tests/bench/runtime-cost.mjs:959-973`). `k` est un objet dont la clé est `shape|profile|mode|size` et la valeur le `k` de chaque métrique. `schedule` est la rotation de mesure. Chaque cas porte `shape`, `profile`, `mode`, `size`, `checksum`, `resolveCount`, et, sans erreur, `buildMs`, `module.raw`, `module.min`, `module.gzip`, et les métriques. Chaque métrique porte `unit`, `processes` (échantillons bruts), `processMedians`, `median`, `mad`. Les métriques de lot portent aussi `shortSamples` : le nombre d'échantillons gardés sous le minimum, sommé sur les processus (`tests/bench/runtime-cost.mjs:806-814`). `import`, `heapAfterGc` et `build` n'ont pas ce champ.

Unités : `warm-resolve` en ns/op. Pour `multi`, c'est une contribution de `resolveAll`. `import`, `create`, `cold-resolve`, `createScope`, `initialize`, `destroy` en ns. Pour `multi`, `cold-resolve` est un appel `resolveAll`. `heapAfterGc` en octets. `build` et `buildMs` en ms. Les tailles de module en octets.

## Budget

Un écart est un échec seulement si la médiane régresse de plus de 10 % et si le delta dépasse `2 × (MAD de base + MAD candidate)`. Si le bruit dépasse 10 % de la médiane de base, le verdict est `inconclusive`. Sinon `pass` (`scripts/ci/lib/performance-budget.mjs:24-26`). Les médianes viennent des échantillons de `processes`, pas du champ `processMedians` (`scripts/ci/performance-budget.mjs:30-32` et `scripts/ci/performance-budget.mjs:67-68`).

Moins de 5 médianes de processus, ou une médiane nulle ou négative, est refusé (`scripts/ci/lib/performance-budget.mjs:8`). Moins de 5 processus, ou moins de 7 échantillons hors `import` et hors l'exemption `build` des tailles 1000 et 5000, est refusé avec le message `at least 7 samples per process and 5 processes required` (`scripts/ci/lib/performance-budget.mjs:65-72`).

`node`, `typescript`, `cpu` et `flags` doivent être identiques. `params` aussi, hors `k` (`scripts/ci/lib/performance-budget.mjs:33-38`). Les messages sont `environment mismatch: node`, `environment mismatch: typescript`, `environment mismatch: cpu`, `environment mismatch: flags` et `params mismatch` (`scripts/ci/lib/performance-budget.mjs:51-58`). `k` est comparé cas par cas, seulement quand le cas a mesuré des deux côtés. Un `k` différent donne `params mismatch: k <shape|profile|mode|size>` (`scripts/ci/lib/performance-budget.mjs:40-49`). Un cas en erreur n'a pas de `k` dans le rapport (`tests/bench/runtime-cost.mjs:942-945`). Il ne bloque donc pas la comparaison des autres cas : il sort en `fail` (`scripts/ci/performance-budget.mjs:45-49`). Un rapport dont la base et le candidat n'ont aucun cas est refusé avec `report has no case` (`scripts/ci/lib/performance-budget.mjs:75-77`).

Un cas présent dans la base et absent du candidat est un échec. Un cas en erreur, ou une métrique absente d'un côté, est un échec (`scripts/ci/performance-budget.mjs:42-57`).

```bash
node scripts/ci/performance-budget.mjs --baseline <fichier> --candidate <fichier>
```

La commande lit les deux fichiers et n'en écrit aucun (`scripts/ci/performance-budget.mjs:1` et `:13-15`). La table sort sur stdout.

Codes de sortie du budget :

- `2` — arguments invalides (`scripts/ci/performance-budget.mjs:6-8`)
- `1` — rapport refusé, ou verdict résumé `fail` (`scripts/ci/performance-budget.mjs:21` et `scripts/ci/performance-budget.mjs:88`)
- `0` — verdict résumé `pass` ou `inconclusive` (`scripts/ci/performance-budget.mjs:88`)

Codes de sortie du banc :

- `0` — aucun cas en erreur
- `1` — au moins un cas a `error` (`tests/bench/runtime-cost.mjs:994`)

## CI

Le workflow `.github/workflows/benchmark.yml` est informatif. Il ne certifie pas une performance (`.github/workflows/benchmark.yml:8` et `:37-39`). Il construit d'abord les paquets, parce que `dist/` n'est pas versionné (`.gitignore:6`). Le cas CI est `flat`, `full`, `open`, taille 10, `NEOSYRINGE_BENCH_RESOLVE_COUNT=1000` (`.github/workflows/benchmark.yml:24-35`). Si la base versionnée existe, le banc reçoit `NEOSYRINGE_BENCH_K_FROM` vers ce fichier (`.github/workflows/benchmark.yml:32-34`). `set -o pipefail` fait échouer l'étape si le budget échoue. `continue-on-error` laisse le job continuer (`.github/workflows/benchmark.yml:39-41`). Sans fichier de base, la comparaison écrit `no baseline; comparison skipped` et cette branche sort en code 0 (`.github/workflows/benchmark.yml:44-45`).

## Banc de compilation

`tests/bench/compile-cost.mjs` ajoute une ligne `# environment` suivie du JSON machine (`tests/bench/compile-cost.mjs:434-444`). La ligne de mesures ajoute `samples_json` après `max` (`tests/bench/compile-cost.mjs:421`, `tests/bench/compile-cost.mjs:445`). Les neuf champs déjà imprimés restent `size`, `shape`, `profile`, `mode`, `tool`, `metric`, `median`, `min`, `max`.

## Baseline (stage A)

Mesure de départ du runtime produit de `ba192b457f0efa13149cc7f64a647c7d9b5c86b3`. Le banc est celui du commit `501c5033e767f04acbd8e07613f59a46de8733c9` ; aucun fichier de `packages/*/src` ne diffère entre ces deux commits. `dist/` a été construit (`pnpm build`) avant la campagne, arbre propre (`dirty: false` dans chaque rapport).

- Machine : Apple M4 Max, 16 cœurs, 64 Go, Darwin 27.2.0. Node v22.23.2, TypeScript 5.9.3, `--expose-gc`. Résolution d'horloge mesurée : 83 à 125 ns selon la campagne.
- Paramètres : 5 processus × 7 échantillons par métrique, 1 calibrage de k par cas, échantillon minimal 1 ms, `resolveCount` 100000. Pour `build`, 5 groupes × 7 à 10 et 100, 1 groupe × 7 à partir de 1000 (exemption documentée plus haut).
- Campagnes lancées une à la fois, dans l'ordre 10, 10 (A/A), 100, 1000, 5000. Charge moyenne au départ de chaque campagne : 3,1 ; 12,2 ; 18,6 ; 4,6 (`campaign.log`). La machine n'était pas isolée : ces chiffres ne sont pas une certification.
- Rapports bruts : `docs/benchmarks/data/runtime-ba192b4/`. Les chemins temporaires d'une pile d'erreur ont été remplacés par `<tmp>/` dans `base-s1000.json`.

### A/A (même commit, même machine)

Commande : `NEOSYRINGE_BENCH_SIZES=10`, puis la même avec `NEOSYRINGE_BENCH_K_FROM` vers le premier rapport, puis `node scripts/ci/performance-budget.mjs`. Résultat : 116 `pass`, 59 `inconclusive`, 5 `fail` sur 180 lignes, code de sortie 1 (`aa-s10-comparison.txt`). Les 5 `fail` ont un ratio entre 1,100 et 1,159 (`createScope` chain et diamond full open, `create` chain minimal open, `build` multi full open et closed). La règle de budget n'a pas été modifiée. Sur cette machine non isolée, un `fail` isolé doit être rejoué avant d'être attribué au code.

### Couverture et défaut trouvé

Tailles 10, 100 et 1000 : 20 cas chacune (5 formes × 2 profils × 2 modes). Taille 5000 : forme `flat` seulement (4 cas), par coût de campagne. `chain` `full` `open` 1000 échoue à l'exécution avec `RangeError: Maximum call stack size exceeded` dans `resolveLocal` : la résolution d'une chaîne profonde est récursive sur l'émetteur de référence. C'est un défaut produit, pas du banc ; il relève du topic 13.

### Médianes (± MAD relatif)

| Forme | Profil | Mode | Taille | gzip (o) | build | import | create | warm-resolve (/op) | cold-resolve | createScope | initialize | destroy |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| flat | full | open | 10 | 3663 | 71.56 ms ±2 % | 466.3 µs ±1 % | 202 ns ±2 % | 27.7 ns ±3 % | 55.6 ns ±2 % | 201 ns ±2 % | 262 ns ±1 % | 630 ns ±1 % |
| flat | full | closed | 10 | 3909 | 73.21 ms ±1 % | 482.5 µs ±1 % | 251 ns ±3 % | 32.0 ns ±5 % | 119 ns ±1 % | 250 ns ±1 % | 281 ns ±0 % | 637 ns ±1 % |
| flat | minimal | open | 10 | 3273 | 69.89 ms ±1 % | 419.2 µs ±4 % | 148 ns ±0 % | 25.4 ns ±1 % | 47.5 ns ±0 % | 150 ns ±1 % | 258 ns ±2 % | 603 ns ±2 % |
| flat | minimal | closed | 10 | 3362 | 69.13 ms ±1 % | 421.5 µs ±1 % | 343 ns ±1 % | 32.6 ns ±4 % | 98.2 ns ±1 % | 164 ns ±1 % | 275 ns ±0 % | 612 ns ±2 % |
| chain | full | open | 10 | 3710 | 72.29 ms ±2 % | 475.4 µs ±1 % | 201 ns ±2 % | 27.5 ns ±1 % | 357 ns ±0 % | 201 ns ±1 % | 259 ns ±1 % | 622 ns ±0 % |
| chain | full | closed | 10 | 3963 | 71.97 ms ±2 % | 488.1 µs ±2 % | 251 ns ±0 % | 32.5 ns ±3 % | 301 ns ±1 % | 252 ns ±1 % | 282 ns ±0 % | 637 ns ±1 % |
| chain | minimal | open | 10 | 3331 | 72.69 ms ±1 % | 425.9 µs ±2 % | 148 ns ±0 % | 25.1 ns ±1 % | 271 ns ±1 % | 152 ns ±1 % | 253 ns ±1 % | 594 ns ±1 % |
| chain | minimal | closed | 10 | 3419 | 73.85 ms ±0 % | 431.9 µs ±1 % | 346 ns ±0 % | 34.3 ns ±6 % | 284 ns ±1 % | 165 ns ±1 % | 273 ns ±1 % | 623 ns ±0 % |
| diamond | full | open | 10 | 3734 | 71.80 ms ±1 % | 480.5 µs ±3 % | 197 ns ±3 % | 27.6 ns ±0 % | 152 ns ±0 % | 202 ns ±2 % | 261 ns ±0 % | 636 ns ±1 % |
| diamond | full | closed | 10 | 3996 | 73.04 ms ±2 % | 495.9 µs ±1 % | 248 ns ±0 % | 31.6 ns ±5 % | 134 ns ±2 % | 250 ns ±0 % | 282 ns ±0 % | 646 ns ±1 % |
| diamond | minimal | open | 10 | 3359 | 69.68 ms ±3 % | 430.2 µs ±0 % | 148 ns ±0 % | 25.5 ns ±0 % | 117 ns ±2 % | 151 ns ±1 % | 253 ns ±1 % | 598 ns ±1 % |
| diamond | minimal | closed | 10 | 3446 | 71.24 ms ±1 % | 439.7 µs ±1 % | 341 ns ±1 % | 33.0 ns ±6 % | 126 ns ±0 % | 162 ns ±1 % | 273 ns ±0 % | 614 ns ±1 % |
| multi | full | open | 10 | 3675 | 72.93 ms ±1 % | 466.8 µs ±0 % | 197 ns ±2 % | 19.7 ns ±3 % | 525 ns ±4 % | 200 ns ±1 % | 257 ns ±1 % | 632 ns ±3 % |
| multi | full | closed | 10 | 3734 | 71.39 ms ±2 % | 477.8 µs ±1 % | 277 ns ±1 % | 10.4 ns ±1 % | 340 ns ±2 % | 278 ns ±1 % | 284 ns ±1 % | 624 ns ±1 % |
| multi | minimal | open | 10 | 3212 | 71.79 ms ±1 % | 417.1 µs ±1 % | 149 ns ±0 % | 7.8 ns ±5 % | 291 ns ±4 % | 151 ns ±0 % | 250 ns ±1 % | 598 ns ±2 % |
| multi | minimal | closed | 10 | 3253 | 71.41 ms ±1 % | 416.6 µs ±1 % | 227 ns ±2 % | 8.6 ns ±5 % | 300 ns ±3 % | 226 ns ±1 % | 268 ns ±1 % | 600 ns ±2 % |
| parent | full | open | 10 | 4116 | 74.67 ms ±1 % | 581.7 µs ±1 % | 98.6 ns ±1 % | 30.4 ns ±1 % | 160 ns ±1 % | 203 ns ±1 % | 630 ns ±0 % | 504 ns ±1 % |
| parent | full | closed | 10 | 4426 | 75.22 ms ±0 % | 607.1 µs ±0 % | 385 ns ±1 % | 37.2 ns ±1 % | 132 ns ±2 % | 309 ns ±1 % | 734 ns ±2 % | 558 ns ±1 % |
| parent | minimal | open | 10 | 3702 | 73.61 ms ±0 % | 495.2 µs ±1 % | 230 ns ±1 % | 26.7 ns ±0 % | 75.5 ns ±1 % | 153 ns ±2 % | 604 ns ±1 % | 456 ns ±1 % |
| parent | minimal | closed | 10 | 3829 | 74.29 ms ±1 % | 511.9 µs ±0 % | 347 ns ±1 % | 33.1 ns ±5 % | 113 ns ±4 % | 250 ns ±1 % | 669 ns ±1 % | 488 ns ±0 % |
| flat | full | open | 100 | 9249 | 119.90 ms ±7 % | 1.25 ms ±5 % | 228 ns ±7 % | 39.9 ns ±4 % | 59.8 ns ±2 % | 227 ns ±8 % | 278 ns ±7 % | 4.2 µs ±4 % |
| flat | full | closed | 100 | 11521 | 110.43 ms ±0 % | 1.48 ms ±2 % | 1.4 µs ±2 % | 50.1 ns ±5 % | 222 ns ±19 % | 1.4 µs ±4 % | 355 ns ±8 % | 11.5 µs ±8 % |
| flat | minimal | open | 100 | 8654 | 98.55 ms ±1 % | 1.08 ms ±1 % | 171 ns ±14 % | 60.5 ns ±2 % | 62.8 ns ±5 % | 172 ns ±13 % | 272 ns ±8 % | 3.9 µs ±5 % |
| flat | minimal | closed | 100 | 8927 | 99.13 ms ±1 % | 1.10 ms ±2 % | 1.7 µs ±3 % | 68.9 ns ±3 % | 184 ns ±17 % | 1.7 µs ±4 % | 337 ns ±7 % | 4.0 µs ±3 % |
| chain | full | open | 100 | 9632 | 116.40 ms ±2 % | 1.34 ms ±3 % | 52.9 ns ±4 % | 40.0 ns ±3 % | 11.7 µs ±2 % | 42.1 ns ±4 % | 273 ns ±4 % | 3.8 µs ±2 % |
| chain | full | closed | 100 | 11958 | 122.41 ms ±2 % | 1.51 ms ±0 % | 1.4 µs ±2 % | 50.0 ns ±5 % | 16.7 µs ±1 % | 1.4 µs ±4 % | 343 ns ±4 % | 4.0 µs ±3 % |
| chain | minimal | open | 100 | 9132 | 99.92 ms ±1 % | 1.08 ms ±0 % | 25.5 ns ±1 % | 56.9 ns ±1 % | 12.7 µs ±2 % | 155 ns ±3 % | 253 ns ±2 % | 3.7 µs ±2 % |
| chain | minimal | closed | 100 | 9405 | 97.17 ms ±3 % | 1.13 ms ±0 % | 1.4 µs ±2 % | 69.8 ns ±2 % | 13.0 µs ±2 % | 1.4 µs ±2 % | 344 ns ±5 % | 3.9 µs ±4 % |
| diamond | full | open | 100 | 9808 | 110.61 ms ±2 % | 1.30 ms ±3 % | 229 ns ±6 % | 38.7 ns ±1 % | 219 ns ±2 % | 229 ns ±3 % | 278 ns ±3 % | 3.9 µs ±3 % |
| diamond | full | closed | 100 | 12147 | 114.51 ms ±5 % | 1.51 ms ±2 % | 1.8 µs ±6 % | 50.4 ns ±4 % | 276 ns ±5 % | 1.7 µs ±2 % | 346 ns ±3 % | 4.0 µs ±0 % |
| diamond | minimal | open | 100 | 9240 | 98.62 ms ±2 % | 1.15 ms ±4 % | 166 ns ±10 % | 58.8 ns ±2 % | 144 ns ±2 % | 165 ns ±9 % | 261 ns ±5 % | 3.8 µs ±5 % |
| diamond | minimal | closed | 100 | 9513 | 100.17 ms ±3 % | 1.19 ms ±5 % | 1.7 µs ±5 % | 72.1 ns ±6 % | 262 ns ±10 % | 1.7 µs ±5 % | 347 ns ±10 % | 4.0 µs ±6 % |
| multi | full | open | 100 | 7884 | 110.14 ms ±3 % | 1.32 ms ±2 % | 41.6 ns ±4 % | 52.5 ns ±3 % | 14.8 µs ±3 % | 41.9 ns ±1 % | 271 ns ±4 % | 3.8 µs ±1 % |
| multi | full | closed | 100 | 8660 | 104.19 ms ±3 % | 1.34 ms ±3 % | 76.0 ns ±2 % | 28.4 ns ±2 % | 13.8 µs ±3 % | 332 ns ±17 % | 302 ns ±8 % | 3.9 µs ±6 % |
| multi | minimal | open | 100 | 7127 | 94.97 ms ±4 % | 1.16 ms ±6 % | 371 ns ±50 % | 41.1 ns ±32 % | 6.2 µs ±27 % | 263 ns ±25 % | 278 ns ±3 % | 3.8 µs ±4 % |
| multi | minimal | closed | 100 | 7165 | 93.92 ms ±5 % | 1.24 ms ±3 % | 61.2 ns ±4 % | 29.2 ns ±5 % | 12.4 µs ±4 % | 260 ns ±3 % | 298 ns ±4 % | 3.9 µs ±3 % |
| parent | full | open | 100 | 11030 | 115.59 ms ±3 % | 1.43 ms ±1 % | 102 ns ±2 % | 38.8 ns ±3 % | 173 ns ±18 % | 238 ns ±14 % | 737 ns ±2 % | 2.7 µs ±14 % |
| parent | full | closed | 100 | 13440 | 382.79 ms ±11 % | 1.57 ms ±1 % | 1.6 µs ±7 % | 56.3 ns ±13 % | 323 ns ±2 % | 971 ns ±8 % | 832 ns ±2 % | 2.4 µs ±0 % |
| parent | minimal | open | 100 | 9111 | 158.87 ms ±3 % | 1.19 ms ±2 % | 261 ns ±3 % | 58.1 ns ±2 % | 143 ns ±3 % | 179 ns ±7 % | 642 ns ±2 % | 2.3 µs ±1 % |
| parent | minimal | closed | 100 | 9318 | 146.48 ms ±10 % | 1.19 ms ±2 % | 1.5 µs ±1 % | 68.3 ns ±2 % | 277 ns ±6 % | 896 ns ±1 % | 806 ns ±1 % | 2.3 µs ±2 % |
| flat | full | open | 1000 | 57900 | 485.49 ms ±0 % | 9.31 ms ±0 % | 246 ns ±0 % | 1.7 µs ±1 % | 3.3 µs ±1 % | 254 ns ±1 % | 287 ns ±1 % | 226.8 µs ±3 % |
| flat | full | closed | 1000 | 82963 | 544.12 ms ±0 % | 10.94 ms ±1 % | 15.6 µs ±5 % | 350 ns ±0 % | 471 ns ±8 % | 15.8 µs ±2 % | 379 ns ±1 % | 222.2 µs ±1 % |
| flat | minimal | open | 1000 | 62840 | 373.36 ms ±0 % | 7.93 ms ±0 % | 97.5 ns ±2 % | 225 ns ±1 % | 2.9 µs ±2 % | 105 ns ±1 % | 277 ns ±2 % | 227.0 µs ±3 % |
| flat | minimal | closed | 1000 | 64929 | 375.23 ms ±0 % | 8.09 ms ±1 % | 14.4 µs ±2 % | 243 ns ±1 % | 414 ns ±5 % | 14.6 µs ±2 % | 376 ns ±2 % | 222.0 µs ±3 % |
| chain | full | open | 1000 | — | erreur : `RangeError: Maximum call stack size exceeded` ||||||||
| chain | full | closed | 1000 | 86388 | 570.44 ms ±0 % | 11.23 ms ±1 % | 17.9 µs ±2 % | 346 ns ±0 % | 436.1 µs ±0 % | 17.4 µs ±1 % | 381 ns ±0 % | 228.9 µs ±2 % |
| chain | minimal | open | 1000 | 65763 | 397.04 ms ±0 % | 8.59 ms ±0 % | 96.6 ns ±2 % | 234 ns ±2 % | 332.3 µs ±2 % | 107 ns ±0 % | 279 ns ±1 % | 220.0 µs ±3 % |
| chain | minimal | closed | 1000 | 68743 | 403.60 ms ±0 % | 8.47 ms ±1 % | 17.4 µs ±3 % | 251 ns ±2 % | 327.9 µs ±1 % | 17.2 µs ±2 % | 375 ns ±2 % | 219.8 µs ±3 % |
| diamond | full | open | 1000 | 63321 | 514.36 ms ±0 % | 10.07 ms ±1 % | 242 ns ±1 % | 1.7 µs ±2 % | 10.3 µs ±1 % | 255 ns ±1 % | 289 ns ±3 % | 224.8 µs ±5 % |
| diamond | full | closed | 1000 | 88486 | 565.35 ms ±0 % | 11.53 ms ±2 % | 15.4 µs ±4 % | 350 ns ±2 % | 731 ns ±10 % | 15.6 µs ±6 % | 383 ns ±3 % | 238.0 µs ±4 % |
| diamond | minimal | open | 1000 | 67408 | 392.56 ms ±0 % | 8.55 ms ±2 % | 98.9 ns ±2 % | 231 ns ±1 % | 3.1 µs ±2 % | 106 ns ±1 % | 280 ns ±1 % | 219.6 µs ±3 % |
| diamond | minimal | closed | 1000 | 70672 | 411.37 ms ±0 % | 8.70 ms ±0 % | 15.0 µs ±5 % | 245 ns ±1 % | 592 ns ±13 % | 15.0 µs ±4 % | 368 ns ±0 % | 230.1 µs ±7 % |
| multi | full | open | 1000 | 48050 | 464.62 ms ±0 % | 9.96 ms ±3 % | 41.9 ns ±1 % | 109 ns ±3 % | 338.7 µs ±8 % | 281 ns ±1 % | 285 ns ±2 % | 225.3 µs ±7 % |
| multi | full | closed | 1000 | 53361 | 450.04 ms ±0 % | 10.22 ms ±1 % | 75.5 ns ±2 % | 123 ns ±1 % | 326.2 µs ±1 % | 358 ns ±1 % | 310 ns ±2 % | 245.2 µs ±10 % |
| multi | minimal | open | 1000 | 43685 | 320.06 ms ±0 % | 8.07 ms ±1 % | 92.5 ns ±2 % | 99.7 ns ±1 % | 294.7 µs ±2 % | 104 ns ±2 % | 279 ns ±1 % | 219.0 µs ±3 % |
| multi | minimal | closed | 1000 | 43735 | 325.02 ms ±0 % | 8.06 ms ±1 % | 60.3 ns ±1 % | 102 ns ±1 % | 295.3 µs ±2 % | 293 ns ±1 % | 291 ns ±1 % | 223.7 µs ±4 % |
| parent | full | open | 1000 | 61741 | 451.96 ms ±0 % | 9.49 ms ±0 % | 98.6 ns ±1 % | 850 ns ±1 % | 1.8 µs ±0 % | 248 ns ±2 % | 664 ns ±3 % | 103.1 µs ±4 % |
| parent | full | closed | 1000 | 88262 | 506.20 ms ±0 % | 11.20 ms ±1 % | 15.7 µs ±2 % | 324 ns ±3 % | 959 ns ±2 % | 7.4 µs ±2 % | 948 ns ±4 % | 104.3 µs ±3 % |
| parent | minimal | open | 1000 | 66218 | 341.26 ms ±0 % | 8.87 ms ±2 % | 324 ns ±4 % | 163 ns ±1 % | 183 ns ±1 % | 103 ns ±4 % | 676 ns ±6 % | 104.9 µs ±4 % |
| parent | minimal | closed | 1000 | 68453 | 359.53 ms ±0 % | 8.72 ms ±1 % | 14.9 µs ±0 % | 184 ns ±1 % | 673 ns ±6 % | 7.1 µs ±0 % | 853 ns ±2 % | 104.9 µs ±2 % |
| flat | full | open | 5000 | 254499 | 3087.08 ms ±0 % | 45.41 ms ±1 % | 46.9 ns ±1 % | 11.3 µs ±0 % | 23.2 µs ±1 % | 163 ns ±2 % | 289 ns ±0 % | 1.49 ms ±5 % |
| flat | full | closed | 5000 | 374637 | 3578.39 ms ±0 % | 55.12 ms ±3 % | 129.8 µs ±2 % | 10.4 µs ±0 % | 21.0 µs ±2 % | 132.7 µs ±2 % | 400 ns ±2 % | 1.67 ms ±1 % |
| flat | minimal | open | 5000 | 282084 | 2738.84 ms ±0 % | 38.68 ms ±0 % | 101 ns ±1 % | 10.0 µs ±0 % | 20.7 µs ±1 % | 111 ns ±0 % | 281 ns ±0 % | 1.55 ms ±2 % |
| flat | minimal | closed | 5000 | 292909 | 2819.99 ms ±0 % | 39.45 ms ±2 % | 134.0 µs ±2 % | 10.2 µs ±1 % | 20.1 µs ±3 % | 135.3 µs ±2 % | 380 ns ±1 % | 1.57 ms ±1 % |
