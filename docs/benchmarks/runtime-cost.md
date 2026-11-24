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

to be filled by the measurement campaign
