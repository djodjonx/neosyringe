# T18 — coût de compilation

Mesures du 2026-11-06. Pas un seuil de CI. Aucun fichier sous `.github/` n'est modifié.

## Décision

Le cache de graphes par contenu est retiré. Il gardait un graphe dont le `registrationNode` appartenait à un ancien `SourceFile`. Un aller-retour de texte (A, puis B, puis A) pouvait donc réutiliser ce graphe. `graphsForProgram` analyse à chaque appel. Le chemin plugin ne garde pas les graphes (`packages/unplugin/src/analysisCache.ts:115-118`). Un programme hôte garde une copie propre pour les autres fichiers de ce même `Program` (`packages/unplugin/src/analysisCache.ts:120-123`).

Aucune accélération due à ce cache n'a été montrée. Le retrait suit une mesure faite pendant que le cache existait encore. Cellule 100, linéaire, plein, ouvert, unplugin :

- cache allumé, `first_ms` 61,9 (58,4–66,0), `leaf_ms` 44,5 (43,4–47,0), `shared_ms` 56,1 (51,8–57,2)
- cache éteint, `first_ms` 56,9 (53,9–58,6), `leaf_ms` 52,1 (48,4–52,5), `shared_ms` 50,5 (47,3–51,3)

La médiane du premier passage allumé (61,9) dépassait le maximum éteint (58,6). Cette course n'est pas rejouable : ce code n'est plus dans l'arbre, et la commande livrée n'a plus de colonne éteinte.

Ce qui reste sert la correction et l'isolement, pas un gain de performance :

- la chaîne `extends` est lue par le texte, avec `readDirectory` vide (`packages/unplugin/src/analysisCache.ts:45-55`)
- le tampon de tsconfig compare ce texte (`packages/unplugin/src/session.ts:311-312`)
- le cache de déclarations reste par instance (`packages/unplugin/src/buildEndUsages.ts:78-80`)
- le graphe d'un programme hôte est cloné avant réemploi (`packages/unplugin/src/session.ts:554-555`)
- `buildEnd` et `watchChange` (suppression) lâchent le dernier graphe (`packages/unplugin/src/index.ts:154`, `packages/unplugin/src/index.ts:181`)

Le coût d'un transform complet par rapport à fc0bbb9 n'a pas été mesuré. La section plus bas ne mesure que la lecture de config.

## Ce qui est vraiment réutilisé

Trois chemins, pas un cache de graphes partagé entre fichiers du plugin :

- Même texte : `rememberSource` rend le `SourceFile` déjà parsé (`packages/unplugin/src/session.ts:484-486`). Après l'édition d'une feuille, les autres feuilles ne sont pas reparsées. Le test T18-A04 tient `filesParsed` à 5, puis à 6 quand le contrat partagé change. `graphsBuilt` monte quand même, parce que chaque transform relance l'analyse.
- Programme hôte : le transformer crée un `SessionState` (`packages/unplugin/src/transformer.ts:84-93`) et le passe à chaque fichier du même programme (`packages/unplugin/src/transformer.ts:95-110`). Le second fichier ne relance pas `extractAll` (`packages/unplugin/src/session.ts:554-555`). Le test T18-A04b tient `graphsBuilt`.
- Plugin Vite, même fichier une deuxième fois : le graphe est reconstruit, et `state.graphs` n'est pas gardé (`packages/unplugin/src/analysisCache.ts:115-118`). Le test T18-A04b2 exige `graphsBuilt` augmenté de 1, avec le même code et la même carte. Ce n'est pas un hit de cache.

Le banc n'a pas de colonne on/off. Il n'y a plus d'interrupteur (`tests/bench/compile-cost.mjs:22-23`, `tests/bench/compile-cost.mjs:39-44`).

## Machine et versions

- Node v24.7.0
- TypeScript 5.9.3, exigé `^5.9.3` dans `packages/unplugin/package.json:52`
- `@djodjonx/neosyringe` 0.3.0 (`packages/neosyringe/package.json:3`)
- `@djodjonx/neosyringe-plugin` 0.6.1 (`packages/unplugin/package.json:3`)
- `@djodjonx/neosyringe-core` 3.2.0 (`packages/core/package.json:3`)
- CPU Apple M4 Max, 16 cœurs
- RAM 68719476736 octets
- Darwin 27.2.0
- Répétitions : 1 chauffe, puis 5 mesures (`tests/bench/compile-cost.mjs:390-395`). Médiane, min et max des 5.

`NO_COLOR` est ignoré quand `FORCE_COLOR` est posé. Ce message vient de Node. Il n'est pas un échec du banc.

## Commande

`bench:compile` (`package.json:26`) lance `node tests/bench/compile-cost.mjs`.

Le banc empaquette `packages/unplugin/src` avec esbuild 0.27.2 (`packages/unplugin/package.json:48`) sous `os.tmpdir()` (`tests/bench/compile-cost.mjs:210-212`). Le répertoire est effacé à la fin et sur SIGINT ou SIGTERM (`tests/bench/compile-cost.mjs:436-440`, `tests/bench/compile-cost.mjs:463-465`).

Profil et mode sont des littéraux dans le `defineBuilderConfig` généré (`tests/bench/compile-cost.mjs:10-11`). Le parseur lit le profil (`packages/core/src/analyzer/parsers/ConfigParser.ts:657-673`) et refuse le mode fermé hors validation stricte (`packages/core/src/analyzer/parsers/ConfigParser.ts:788-794`). L'analyseur est strict par défaut (`packages/core/src/analyzer/Analyzer.ts:185`). L'émetteur optimisé sert au profil `minimal` ou au mode `closed` (`packages/core/src/generator/Generator.ts:201-203`).

`linear` : N conteneurs, chacun n'injecte que `Shared`. `diamond` : `Left` et `Right` injectent `Shared`, N feuilles injectent les deux (`tests/bench/compile-cost.mjs:14-15`).

`first_ms` est le premier passage. `leaf_ms` réécrit une feuille puis retransforme tous les fichiers. `shared_ms` réécrit le contrat puis retransforme tout (`tests/bench/compile-cost.mjs:356-360`). `code_bytes` et `code_gzip_bytes` additionnent les textes générés (`tests/bench/compile-cost.mjs:266-274`). `resolve_first_ms` est le premier `resolve` du dernier fichier généré, `resolve_later_ms` un resolve suivant (`tests/bench/compile-cost.mjs:362`, `tests/bench/compile-cost.mjs:312-319`). `rss_bytes` est le plus haut RSS du processus pendant les trois passages (`tests/bench/compile-cost.mjs:248-256`, `tests/bench/compile-cost.mjs:399`). Il inclut ce que le processus tenait déjà.

## Taille 10 — ce code

Exit 0. Une seule colonne : il n'y a plus de cache. Temps en millisecondes, format médiane (min–max). `code_bytes` et `gzip` sont la médiane. Le gzip varie de quelques dizaines d'octets entre min et max.

| size | shape | profile | mode | tool | first_ms | code_bytes | gzip | resolve_first_ms | resolve_later_ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 10 | linear | full | open | unplugin | 10.6 (9.1–13.8) | 109040 | 27848 | 0.089 (0.088–0.098) | 0.000 (0.000–0.000) |
| 10 | linear | full | open | transformer | 7.7 (7.4–12.9) | 109040 | 27855 | 0.093 (0.085–0.103) | 0.000 (0.000–0.000) |
| 10 | linear | full | closed | unplugin | 8.3 (7.8–8.6) | 104420 | 25465 | 0.096 (0.086–0.104) | 0.000 (0.000–0.000) |
| 10 | linear | full | closed | transformer | 7.4 (7.3–10.1) | 104420 | 25472 | 0.099 (0.094–0.104) | 0.000 (0.000–0.000) |
| 10 | linear | minimal | open | unplugin | 9.7 (6.7–10.9) | 58120 | 17056 | 0.078 (0.070–0.087) | 0.000 (0.000–0.000) |
| 10 | linear | minimal | open | transformer | 5.3 (5.2–10.1) | 58120 | 17067 | 0.075 (0.068–0.083) | 0.000 (0.000–0.000) |
| 10 | linear | minimal | closed | unplugin | 7.1 (6.7–7.5) | 60310 | 17889 | 0.078 (0.075–0.086) | 0.000 (0.000–0.000) |
| 10 | linear | minimal | closed | transformer | 5.8 (5.5–8.5) | 60310 | 17896 | 0.086 (0.075–0.088) | 0.000 (0.000–0.000) |
| 10 | diamond | full | open | unplugin | 11.2 (10.9–13.5) | 139608 | 34677 | 0.115 (0.107–0.122) | 0.001 (0.000–0.001) |
| 10 | diamond | full | open | transformer | 12.3 (9.0–15.4) | 139608 | 34681 | 0.107 (0.104–0.144) | 0.000 (0.000–0.000) |
| 10 | diamond | full | closed | unplugin | 11.1 (10.9–14.2) | 136294 | 32062 | 0.130 (0.113–0.137) | 0.000 (0.000–0.001) |
| 10 | diamond | full | closed | transformer | 12.0 (11.9–12.6) | 136294 | 32058 | 0.132 (0.122–0.145) | 0.000 (0.000–0.001) |
| 10 | diamond | minimal | open | unplugin | 10.9 (10.8–13.2) | 78754 | 21831 | 0.108 (0.102–0.114) | 0.000 (0.000–0.000) |
| 10 | diamond | minimal | open | transformer | 6.9 (6.8–10.3) | 78754 | 21837 | 0.097 (0.095–0.106) | 0.000 (0.000–0.000) |
| 10 | diamond | minimal | closed | unplugin | 10.8 (10.6–15.5) | 80147 | 22642 | 0.104 (0.096–0.105) | 0.000 (0.000–0.000) |
| 10 | diamond | minimal | closed | transformer | 7.2 (7.0–10.6) | 80147 | 22637 | 0.102 (0.101–0.118) | 0.000 (0.000–0.000) |

```sh
NEOSYRINGE_BENCH_SIZES=10 NEOSYRINGE_BENCH_REPS=5 node tests/bench/compile-cost.mjs
```

## Taille 100 — tour précédent, colonne on

Ces chiffres ne sont pas rejoués. Ils viennent de la colonne `on` du tour précédent, avant le retrait du hash d'analyse, du `statSync` de tsconfig et du second clone de graphe sur le chemin plugin. La colonne `off` est supprimée : c'était le même chemin. Aucun gain n'est tiré de l'écart entre les deux.

| size | shape | profile | mode | tool | first_ms | code_bytes | gzip | resolve_first_ms | resolve_later_ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 100 | linear | full | open | unplugin | 58.7 (57.3–62.9) | 1091120 | 278599 | 0.093 (0.088–0.099) | 0.000 (0.000–0.000) |
| 100 | linear | full | open | transformer | 56.7 (55.2–61.6) | 1091120 | 278637 | 0.091 (0.088–0.094) | 0.000 (0.000–0.000) |
| 100 | linear | full | closed | unplugin | 59.6 (57.8–60.9) | 1045460 | 254688 | 0.096 (0.092–0.109) | 0.000 (0.000–0.001) |
| 100 | linear | full | closed | transformer | 58.3 (57.8–59.8) | 1045460 | 254683 | 0.096 (0.092–0.111) | 0.000 (0.000–0.001) |
| 100 | linear | minimal | open | unplugin | 52.7 (50.3–53.4) | 582100 | 170591 | 0.076 (0.074–0.096) | 0.000 (0.000–0.000) |
| 100 | linear | minimal | open | transformer | 39.5 (37.7–41.2) | 582100 | 170584 | 0.077 (0.071–0.088) | 0.000 (0.000–0.000) |
| 100 | linear | minimal | closed | unplugin | 54.9 (52.3–58.0) | 604090 | 178891 | 0.081 (0.077–0.090) | 0.000 (0.000–0.000) |
| 100 | linear | minimal | closed | transformer | 43.4 (39.6–44.2) | 604090 | 178861 | 0.078 (0.077–0.096) | 0.000 (0.000–0.000) |
| 100 | diamond | full | open | unplugin | 83.4 (83.0–83.8) | 1200168 | 297099 | 0.111 (0.107–0.126) | 0.000 (0.000–0.001) |
| 100 | diamond | full | open | transformer | 71.2 (68.5–72.0) | 1200168 | 297070 | 0.110 (0.109–0.116) | 0.000 (0.000–0.000) |
| 100 | diamond | full | closed | unplugin | 86.8 (85.9–89.7) | 1175614 | 275320 | 0.123 (0.118–0.135) | 0.000 (0.000–0.000) |
| 100 | diamond | full | closed | transformer | 72.8 (70.6–74.4) | 1175614 | 275347 | 0.124 (0.121–0.154) | 0.000 (0.000–0.001) |
| 100 | diamond | minimal | open | unplugin | 81.6 (81.0–84.6) | 683374 | 188155 | 0.097 (0.097–0.112) | 0.000 (0.000–0.000) |
| 100 | diamond | minimal | open | transformer | 53.0 (51.9–54.9) | 683374 | 188138 | 0.098 (0.095–0.108) | 0.000 (0.000–0.000) |
| 100 | diamond | minimal | closed | unplugin | 85.4 (85.2–87.5) | 693407 | 194614 | 0.100 (0.099–0.122) | 0.000 (0.000–0.000) |
| 100 | diamond | minimal | closed | transformer | 55.0 (54.7–57.9) | 693407 | 194656 | 0.100 (0.096–0.115) | 0.000 (0.000–0.000) |

À taille 100, linéaire, unplugin, le plein ouvert faisait 1 091 120 octets (gzip 278 599) et le minimal ouvert 582 100 octets (gzip 170 591). Le plein fermé faisait 1 045 460 octets (gzip 254 688), le minimal fermé 604 090 octets (gzip 178 891). Le premier `resolve` restait sous 0,14 ms. Le suivant était à 0,000 ms sur cette horloge. Ces octets sont ceux de la colonne `on` ci-dessus.

## Taille 1000 — tour précédent, colonne on

Pas rejouée. Même réserve que la taille 100 : colonne `on` d'avant ce tour. La colonne `off` (546,3 ms) est retirée.

| first_ms | leaf_ms | shared_ms | code_bytes | gzip | resolve_first_ms | resolve_later_ms |
| --- | --- | --- | --- | --- | --- | --- |
| 576.3 (558.3–615.5) | 523.5 (506.9–528.3) | 515.6 (501.7–531.5) | 10919120 | 2787099 | 0.092 (0.090–0.111) | 0.000 (0.000–0.001) |

`rss_bytes` médian de cette colonne : 840 810 496.

Les autres cellules 1000 du tour d'avant (diamant, transformer, autres profils) ne sont pas répétées. Elles décrivaient le code qui hachait chaque fichier et parcourait `include`. Elles ne décrivent pas ce code.

```sh
NEOSYRINGE_BENCH_SIZES=1000 NEOSYRINGE_BENCH_REPS=5 NEOSYRINGE_BENCH_TOOLS=unplugin NEOSYRINGE_BENCH_SHAPES=linear NEOSYRINGE_BENCH_PROFILES=full NEOSYRINGE_BENCH_MODES=open node tests/bench/compile-cost.mjs
```

## Taille 5000 — non exécutée

```sh
NEOSYRINGE_BENCH_SIZES=5000 NEOSYRINGE_BENCH_REPS=5 node tests/bench/compile-cost.mjs
```

Cette commande prend les défauts du banc : deux formes, deux profils, deux modes, deux outils, un seul chemin, soit 16 cellules (`tests/bench/compile-cost.mjs:41-44`). Chaque cellule fait 1 chauffe et 5 répétitions, et chaque répétition trois passages. Le premier passage mesuré à 1000 fichiers, au tour précédent, a une médiane de 576,3 ms. Cinq fois plus de fichiers, puis 16 cellules, dépasse 10 minutes. La commande n'a pas été lancée. 576,3 ms n'est pas une mesure de ce tour.

## Chaîne tsconfig, commit fc0bbb9

`tests/bench/compile-cost.mjs` n'existe pas dans fc0bbb9 (`git cat-file -e fc0bbb9:tests/bench/compile-cost.mjs` échoue). Le banc complet n'a pas été relancé sur ce commit. Le coût d'un transform complet contre ce commit n'a pas été mesuré.

fc0bbb9 tamponnait le tsconfig avec `statSync` (`git show fc0bbb9:packages/unplugin/src/session.ts`, fonction `tsconfigFileStamp`). Le code actuel lit le texte de la chaîne et ne fait plus ce `statSync`. Mesure isolée, 200 fichiers, `include` `**/*.ts`, 5 chauffes puis 20 échantillons, médiane :

- `statSync` : 0,003 ms (0,002–0,012)
- parse avec `readDirectory` vide : 0,097 ms (0,064–0,170)
- parse avec `ts.sys.readDirectory` : 0,515 ms (0,462–0,593)

Le même parse sur un `include` d'un seul fichier : 0,063 ms avec `readDirectory` vide, 0,187 ms avec le scan. Ce n'est pas le temps d'un transform. C'est seulement la lecture de config.

## Seuils

Aucun seuil n'est proposé. La médiane `first_ms` à 100 fichiers, linéaire, plein, ouvert, unplugin, était 58,7 ms (57,3–62,9) sur cette machine, colonne `on` du tour précédent, pas une mesure de ce tour. L'écart min–max d'une cellule est de plusieurs millisecondes. Le RSS mélange l'historique du processus. Un chiffre de cet ordinateur n'est pas une porte de CI.

Les phrases « sous 30 ms / 200 ms / 8 s / 10 s » ne sont pas des seuils retenus. Ce document ne les transforme pas en gate.
