# Topics 02 et 13

Mesures de cette étape. Un processus `tsc` neuf par case. Machine Apple M4 Max (arm64), Node v24.7.0, TypeScript 5.9.3 (`node_modules/typescript/package.json`). Le commit de départ est `1934d9cd504dbac389d95b0d26d954af7ab3dbeb`. La colonne « après » est l'arbre de travail non commité sur ce commit.

## A02-6 — coût du typage public

Commande, une fois par case :

```bash
node node_modules/typescript/bin/tsc --noEmit --extendedDiagnostics --pretty false -p <tsconfig temporaire>
```

Le projet temporaire est hors du `tsconfig` du dépôt. Il contient un `consumer.ts` de N classes et N inscriptions passées à `defineBuilderConfig`. « Avant » pointe vers une copie de `packages/neosyringe/src/types.ts` lue par `git show 1934d9c:packages/neosyringe/src/types.ts`, réexportée par un `index.ts` temporaire. « Après » pointe vers `packages/neosyringe/src/index.ts`. Plafond de 90 s par case. Aucune case n'a atteint le plafond.

Le garde récursif est remplacé par un type mappé (`packages/neosyringe/src/types.ts:232-249`).

| N | Variante | statut | TS2589 | Check time | Instantiations | Mémoire |
| --- | --- | --- | --- | --- | --- | --- |
| 100 | avant | 0 | non | 0.05s | 44170 | 95013K |
| 100 | après | 0 | non | 0.05s | 3464 | 74767K |
| 1000 | avant | 2 | oui | 0.95s | 4037318 | 992636K |
| 1000 | après | 0 | non | 0.10s | 27764 | 99905K |
| 10000 | avant | 2 | oui | 3.69s | 5000293 | 1027798K |
| 10000 | après | 0 | non | 0.65s | 270764 | 272886K |

Pas de régression de temps. À N=100 le temps de vérification est le même. À 1000 et 10000, la variante après est plus courte.

## A13-5 — profondeur de `resolve`, remis au topic 01

Mesure de cette étape, un processus `node` neuf par sonde (`spawnSync(process.execPath)`, pile par défaut, sans `--stack-size`). Le module est produit par l'Analyzer et le Generator, puis exécuté dans cet enfant. Même machine, même Node v24.7.0. Le test ne provoque pas le `RangeError` : il verrouille une profondeur au plus égale à la moitié du dernier succès.

| Émetteur | dernier succès | premier `RangeError` | profondeur verrouillée |
| --- | --- | --- | --- |
| reference | 317 | 318 | 158 |
| optimized | 2766 | 2767 | 1383 |

L'émetteur ouvert complet est la référence (`packages/core/src/generator/Generator.ts:116-119`). Le choix automatique confirme la même règle (`packages/core/src/generator/Generator.ts:220-223`). Le saut de la référence est `create_*` puis `resolve` puis `resolveLocal` (`packages/core/src/generator/Generator.ts:535`). L'accesseur direct optimisé est `packages/core/src/generator/ResolveEmitter.ts:286`. Son jumeau `_get_` est `packages/core/src/generator/ResolveEmitter.ts:291`.

La recherche de cycle de cette étape est itérative (`packages/core/src/generator/cycleSearch.ts:48`, appelée depuis `packages/core/src/generator/GraphValidator.ts:171` et `packages/core/src/analyzer/validators/CycleValidator.ts:29`). Les arêtes d'un membre passent par un ensemble (`packages/core/src/generator/cycleSearch.ts:26`). Aucun compteur ne prétend mesurer ce travail : le test W4 ne vérifie que la déduplication et l'ordre d'insertion des arêtes. Le débordement mesuré avant le remplacement itératif, sur un programme réel en anneau de 5000, venait de la recherche récursive. `generate` levait alors une erreur de `TopologicalSorter`, pas un `RangeError`. À froid, pointe en premier : `GraphValidator` tenait 3000 et échouait à 4000. `CycleValidator` tenait 2000 et échouait à 3000.

L'ordre stable est un tas sur l'index initial (`packages/core/src/generator/LifecycleEmitter.ts:42-46`). Chaque comparaison du tas passe par un seul assistant compté (`packages/core/src/generator/minHeap.ts:55-56`). Pour 10000 étapes indépendantes, mesure : 226682 comparaisons, 20000 visites, 20000 opérations de tas. Le test P29 plafonne les comparaisons à `2 * (V + E) * ceil(log2(V + 1))`, soit 280000 ; un balayage linéaire par `pop` en compterait environ 50 millions. La destruction place déjà le dépendant avant sa dépendance (`packages/core/src/generator/LifecycleEmitter.ts:422`). Le correctif de la profondeur d'appel reste au topic 01.

## A13-2 — ancre et nombre des diagnostics de cycle

Les valeurs « avant » viennent des validateurs de `1934d9c`, rechargés tels quels dans un test jetable (supprimé), sur les mêmes programmes que les tests W5, W6 et P23 (`packages/core/tests/generator/t13-deep-graph.test.ts`). Une erreur de cycle est ancrée sur la source de l'arête de retour : le dernier nœud avant le retour au départ (`packages/core/src/generator/GraphValidator.ts:175`, `packages/core/src/analyzer/validators/CycleValidator.ts:35`). `CycleValidator` garde la politique de `1934d9c` : graphe par jeton, une erreur par cycle distinct, et une erreur par contribution du jeton multi (`packages/core/src/analyzer/validators/CycleValidator.ts:24-67`).

| Programme | Validateur | avant (1934d9c) | après |
| --- | --- | --- | --- |
| `ClassA` ↔ `ClassB` | les deux | 1 erreur sur `{ token: ClassB }`, 7:41 | identique, `tokenId` `ClassB_4f284aa5` pour `GraphValidator`, racine de projet fixée à `/virtual` par le test (sans cela, le hash dépend de `process.cwd()`) |
| `A → B → C → A` et `C → B` | les deux | 2 erreurs, toutes deux sur `{ token: C }`, 8:50 | identique |
| `A → M → A`, `M` multi à 2 contributions | `CycleValidator` | 2 erreurs, une par contribution de `M` (11:11 et 12:11) | identique |
| `A → M → A`, `M` multi à 2 contributions | `GraphValidator` | aucune (les nœuds multi n'étaient pas parcourus) | 1 erreur, première contribution de `M` (11:11) |
| `M` multi à 3 contributions, 2 dépendent de `M` | `CycleValidator` | 3 erreurs (8:11, 9:11, 10:11) | identique |
| `M` multi à 3 contributions, 2 dépendent de `M` | `GraphValidator` | aucune | 2 erreurs (8:11, 9:11) |
| `B` demande deux fois `A` dans son constructeur, `A` demande `B` | `GraphValidator` | 2 erreurs identiques | 1 erreur : les arêtes d'un membre sont dédoublonnées (`packages/core/src/generator/cycleSearch.ts:26`) |

La dernière ligne est une différence connue et voulue : un doublon de dépendance ne produit plus un doublon de diagnostic. `CycleValidator` n'en produisait qu'un déjà.

## Unions et tableaux élargis

Le garde d'`injections` regarde chaque position d'un tuple, et le type d'élément d'un tableau élargi (`packages/neosyringe/src/types.ts:232-249`). Une fabrique mal typée dans un tableau élargi est donc refusée. `1934d9c` laissait passer tout tableau dont la longueur n'est pas connue. Mesure : `tsc --noEmit` sur un projet jetable, avant (copie de `types.ts` de `1934d9c`) et après. `BadF` renvoie `string` pour un jeton `Port`. `GoodF` renvoie `Port`.

| Forme de `injections` | avant | après |
| --- | --- | --- |
| `BadF[]` | acceptée | refusée, TS2769 |
| `readonly BadF[]` | acceptée | refusée, TS2769 |
| `[...BadF[], { token: Svc }]` | acceptée | refusée, TS2769 |
| `[GoodF, ...BadF[]]` | acceptée | refusée, TS2769 |
| `GoodF[]` | acceptée | acceptée |
| `Injection[]` annoté | acceptée | acceptée |
| `(BadF \| GoodF)[]` | acceptée | acceptée (limite connue) |
| `[BadF \| GoodF]` | acceptée | acceptée (limite connue) |

Raison : le refus ne touche que des configurations dont la fabrique renvoie vraiment le mauvais type. L'audit interdit de relâcher un garde, pas de le resserrer. Le type mappé est la forme du pack de spécifications.

Limite restante : un élément qui est une union `BadF | GoodF` cache le membre fautif. `EnsureFactory` se distribue sur l'union et garde le membre valide (`packages/neosyringe/src/types.ts:225`). Les formes `(BadF | GoodF)[]` et `[BadF | GoodF]` restent acceptées. Le test W8 les fige.

Note de migration : une configuration dont une fabrique a le mauvais type, rangée dans un tableau élargi, ne compile plus. Typer la fabrique correctement, ou annoter le tableau `Injection[]` si le type de retour est bon.

Site du diagnostic pour un tuple tenu dans une variable (`const tuple = [bad] as const; defineBuilderConfig({ injections: tuple })`) : TS2769 sur le nom de l'appel (colonne 21 dans le test W9), et non plus sur l'argument (colonne 41 avec `1934d9c`). Le test W9 fige ce site.

## A02-1 — depuis l'archive

`--pack` sans valeur lance `pnpm pack` sur `packages/neosyringe`, vérifie que l'archive porte le build du disque, la décompresse et compile le consommateur contre le paquet décompressé (`scripts/ci/consumer-types-scale.mjs`). Avec une valeur, `--pack` accepte une archive `.tgz` ou un dossier déjà décompressé. Le script ne construit rien. L'étape CI vient après `pnpm build` dans le job `consumer-types` (`.github/workflows/ci.yml:100-110`).

```bash
node scripts/ci/consumer-types-scale.mjs 1000 --pack <archive>.tgz
node scripts/ci/consumer-types-scale.mjs 10000 --pack <archive>.tgz
```

Sortie, archive faite par `pnpm pack` dans `packages/neosyringe` :

```text
ok size=1000 from=archive djodjonx-neosyringe-0.3.0.tgz types=extracted/package/dist/index.d.mts
ok size=10000 from=archive djodjonx-neosyringe-0.3.0.tgz types=extracted/package/dist/index.d.mts
```

Les tests W12 et W13 (`tests/ci/consumer-types-scale.test.ts`) font le même parcours. Ils fabriquent l'archive eux-mêmes et la passent au script. Le garde de date de `--pack` seul (le `dist` doit être plus récent que `src`) n'est exercé que par la CI.

## Limite connue pour l'étape C

`cyclePaths` copie le chemin à chaque arête de retour (`packages/core/src/generator/cycleSearch.ts:81`). Sur un graphe cyclique qui a beaucoup d'arêtes de retour, la mémoire est quadratique. La copie `[...stack]` de `1934d9c` avait la même forme. Non traité dans cette étape.
