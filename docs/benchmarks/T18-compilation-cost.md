# T18 — coût de compilation

Mesures du 2026-11-06. Pas un seuil de CI. Aucun fichier sous `.github/` n'est modifié.

## Décision

Le cache de graphes par contenu est retiré. Il gardait un graphe dont le `registrationNode` appartenait à un ancien `SourceFile`. Un aller-retour de texte (A, puis B, puis A) pouvait donc réutiliser ce graphe. `graphsForProgram` analyse à chaque appel. Le chemin plugin ne garde pas les graphes (`packages/unplugin/src/analysisCache.ts:115-118`). Un programme hôte garde une copie propre pour les autres fichiers de ce même `Program` (`packages/unplugin/src/analysisCache.ts:120-123`).

Aucune accélération due à ce cache n'a été montrée. Le retrait suit une mesure faite pendant que le cache existait encore. **Cette mesure est plus ancienne : elle date d'un round antérieur, elle n'a pas été rejouée, elle ne vient pas de la session de cette page et elle n'est dans aucun fichier `t3o-bench-*`.** Cellule 100, linéaire, plein, ouvert, unplugin :

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

Les tableaux « Taille 10 » à « Taille 5000 », la charge de la machine et la « Lecture » viennent de cette session : une seule machine, le 2026-11-06, depuis l'arbre de travail de la base 65f3521 (`git rev-parse HEAD`) plus les changements de cette branche. Le banc n'a pas changé. Deux blocs n'en viennent pas : la course cache allumé/éteint de « Décision » et les cinq durées de « Chaîne tsconfig ». Ce sont des mesures d'un round antérieur, non rejouées, signalées comme telles dans leur section.

- Node v22.23.2 (`node --version`)
- pnpm 10.19.0 (`pnpm --version`)
- TypeScript 5.9.3, exigé `^5.9.3` dans `packages/unplugin/package.json:52`
- `@djodjonx/neosyringe` 0.3.0 (`packages/neosyringe/package.json:3`)
- `@djodjonx/neosyringe-plugin` 0.6.1 (`packages/unplugin/package.json:3`)
- `@djodjonx/neosyringe-core` 3.2.0 (`packages/core/package.json:3`)
- CPU Apple M4 Max, 16 cœurs (`sysctl -n machdep.cpu.brand_string hw.ncpu`)
- RAM 68719476736 octets (`sysctl -n hw.memsize`)
- macOS 27.2 (`sw_vers`), Darwin 27.2.0 (`uname -a`)
- Répétitions : 1 chauffe, puis 5 mesures (`tests/bench/compile-cost.mjs:390-395`). Médiane, min et max des 5.
- Taille 5000 seulement : `NODE_OPTIONS=--max-old-space-size=8192`, une commande par cellule (forme, profil, mode), les deux outils ensemble.

`NO_COLOR` est ignoré quand `FORCE_COLOR` est posé. Ce message vient de Node. Il n'est pas un échec du banc.

## Charge de la machine

La machine n'était pas au repos : une autre session y tournait. `uptime` (load average 1, 5, 15 minutes) a été relevé avant et après chaque groupe. Les sorties brutes sont dans `.git/worktrees/perf-syringe-corrections-bundle-compression-bench/t3o-bench-*.txt`, hors de l'arbre.

| groupe | durée (`time -p`) | uptime avant | uptime après |
| --- | --- | --- | --- |
| taille 10 | non chronométré | 1.94 2.06 2.91 | 2.03 2.07 2.91 |
| taille 100 | 21.35 s | 2.02 2.07 2.91 | 2.48 2.17 2.92 |
| taille 1000 | 237.65 s | 2.48 2.17 2.92 | 2.14 2.23 2.76 |
| 5000 linear full open | 260.99 s | 2.13 2.23 2.76 | 2.14 2.26 2.63 |
| 5000 linear full closed | 271.81 s | 2.19 2.27 2.63 | 2.39 2.24 2.50 |
| 5000 linear minimal open | 228.79 s | 2.39 2.24 2.50 | 2.79 2.41 2.50 |
| 5000 linear minimal closed | 245.14 s | 2.73 2.41 2.50 | 2.60 2.55 2.54 |
| 5000 diamond full open | 555.29 s | 2.60 2.55 2.54 | 6.91 11.31 7.20 |
| 5000 diamond full closed | 545.97 s | 6.76 11.21 7.19 | 2.64 5.63 6.41 |
| 5000 diamond minimal open | 531.46 s | 2.43 5.54 6.37 | 33.52 24.15 14.21 |
| 5000 diamond minimal closed | 551.96 s | 31.08 23.80 14.14 | 8.04 13.73 13.20 |

Avant les groupes de taille 10, 100 et 1000 et avant les quatre groupes 5000 `linear`, le `load1` valait entre 1,94 et 2,73. Avant les quatre groupes 5000 `diamond`, il valait entre 2,43 et 31,08 (6,76 pour diamond full closed, 31,08 pour diamond minimal closed). Rien n'a donc tourné sur une machine à vide. Les quatre commandes 5000 en forme `diamond` (huit cellules, marquées « haute » dans la colonne `charge` du tableau 5000) ont tourné pendant que la charge montait jusqu'à 33,52 : lisez-les comme indicatives. Les écarts min–max énormes (par exemple `first_ms` min–max 16402,5–94457,6 pour diamond minimal open, transformer) viennent probablement de là, pas du code : la charge n'a pas été isolée comme cause. Elles n'ont pas été relancées, et une relance sur une machine au repos est nécessaire avant de s'y fier.

## Commande

`bench:compile` (`package.json:27`) lance `node tests/bench/compile-cost.mjs`.

Le banc empaquette `packages/unplugin/src` avec esbuild 0.27.2 (`packages/unplugin/package.json:48`) sous `os.tmpdir()` (`tests/bench/compile-cost.mjs:210-212`). Le répertoire est effacé à la fin et sur SIGINT ou SIGTERM (`tests/bench/compile-cost.mjs:436-440`, `tests/bench/compile-cost.mjs:463-465`).

Profil et mode sont des littéraux dans le `defineBuilderConfig` généré (`tests/bench/compile-cost.mjs:10-11`). Le parseur lit le profil (`packages/core/src/analyzer/parsers/ConfigParser.ts:657-673`) et refuse le mode fermé hors validation stricte (`packages/core/src/analyzer/parsers/ConfigParser.ts:788-794`). L'analyseur est strict par défaut (`packages/core/src/analyzer/Analyzer.ts:185`). L'émetteur optimisé sert au profil `minimal` ou au mode `closed` (`packages/core/src/generator/Generator.ts:201-203`).

`linear` : N conteneurs, chacun n'injecte que `Shared`. `diamond` : `Left` et `Right` injectent `Shared`, N feuilles injectent les deux (`tests/bench/compile-cost.mjs:14-15`).

`first_ms` est le premier passage. `leaf_ms` réécrit une feuille puis retransforme tous les fichiers. `shared_ms` réécrit le contrat puis retransforme tout (`tests/bench/compile-cost.mjs:356-360`). `code_bytes` et `gzip` (`code_gzip_bytes`) additionnent les textes générés (`tests/bench/compile-cost.mjs:266-274`) ; le gzip est celui de `gzipSync` au niveau par défaut. `resolve_first_ms` est le premier `resolve` du dernier fichier généré (`tests/bench/compile-cost.mjs:362`, `tests/bench/compile-cost.mjs:312-319`). `rss_bytes` est le plus haut RSS du processus pendant les trois passages (`tests/bench/compile-cost.mjs:248-256`, `tests/bench/compile-cost.mjs:399`). Il inclut ce que le processus tenait déjà : chaque commande est un processus, donc le RSS d'une cellule contient l'historique des cellules qui la précèdent dans la même commande.

Format des tableaux : temps en millisecondes, médiane (min–max) des 5 répétitions. Dans les tableaux, le séparateur décimal reste le point, comme dans les sorties brutes, pour qu'on puisse y chercher une valeur ; la prose utilise la virgule. `rss_bytes`, `code_bytes` et `gzip` sont la médiane. `resolve_later_ms` vaut 0,000 ou 0,001 dans toutes les cellules (valeurs brutes : 0.000 ou 0.001) et n'est pas répété dans les tableaux.

## Taille 10

```sh
NEOSYRINGE_BENCH_SIZES=10 NEOSYRINGE_BENCH_REPS=5 node tests/bench/compile-cost.mjs
```

Sortie brute : `t3o-bench-s10.txt`. Exit 0.

| size | shape | profile | mode | tool | first_ms | leaf_ms | shared_ms | rss_bytes | code_bytes | gzip | resolve_first_ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 10 | linear | full | open | unplugin | 13.7 (11.6–17.9) | 10.7 (8.6–12.7) | 9.4 (8.0–11.1) | 204439552 | 109040 | 27713 | 0.111 (0.088–0.120) |
| 10 | linear | full | open | transformer | 11.0 (9.9–11.6) | 10.1 (8.2–11.4) | 9.6 (9.2–13.1) | 267878400 | 109040 | 27719 | 0.084 (0.081–0.100) |
| 10 | linear | full | closed | unplugin | 9.9 (8.9–10.8) | 8.0 (6.9–9.1) | 7.6 (7.0–8.2) | 270008320 | 104420 | 25444 | 0.096 (0.080–0.115) |
| 10 | linear | full | closed | transformer | 9.3 (8.8–11.6) | 9.0 (8.6–11.3) | 9.3 (8.5–13.1) | 333463552 | 104420 | 25450 | 0.098 (0.081–0.108) |
| 10 | linear | minimal | open | unplugin | 9.2 (8.8–9.9) | 5.7 (5.6–5.8) | 6.9 (6.5–7.3) | 347570176 | 58120 | 17023 | 0.076 (0.066–0.079) |
| 10 | linear | minimal | open | transformer | 6.5 (5.8–7.1) | 6.2 (5.5–7.5) | 5.9 (5.2–6.5) | 348585984 | 58120 | 17029 | 0.069 (0.066–0.079) |
| 10 | linear | minimal | closed | unplugin | 8.6 (8.3–12.9) | 6.5 (6.4–6.8) | 5.7 (5.5–7.4) | 348897280 | 60310 | 17876 | 0.082 (0.069–0.083) |
| 10 | linear | minimal | closed | transformer | 7.1 (6.4–7.5) | 6.7 (5.3–7.0) | 6.0 (5.5–6.4) | 354549760 | 60310 | 17877 | 0.084 (0.074–0.090) |
| 10 | diamond | full | open | unplugin | 13.2 (12.6–13.9) | 10.5 (10.0–11.7) | 10.7 (9.8–12.1) | 355844096 | 139608 | 34478 | 0.111 (0.094–0.115) |
| 10 | diamond | full | open | transformer | 11.6 (9.9–13.1) | 10.7 (9.9–10.8) | 10.2 (9.9–10.5) | 356253696 | 139608 | 34486 | 0.100 (0.094–0.114) |
| 10 | diamond | full | closed | unplugin | 13.0 (12.5–13.3) | 10.4 (10.2–11.5) | 10.2 (9.8–11.4) | 356679680 | 136294 | 32024 | 0.123 (0.109–0.136) |
| 10 | diamond | full | closed | transformer | 11.3 (10.7–15.0) | 11.1 (9.6–13.0) | 10.8 (9.7–12.0) | 356564992 | 136294 | 32040 | 0.134 (0.119–0.167) |
| 10 | diamond | minimal | open | unplugin | 12.0 (11.4–13.4) | 10.1 (9.2–12.1) | 9.8 (8.8–11.4) | 356925440 | 78754 | 21829 | 0.094 (0.087–0.096) |
| 10 | diamond | minimal | open | transformer | 9.3 (8.0–9.7) | 8.4 (8.0–11.8) | 8.5 (7.8–10.4) | 356843520 | 78754 | 21838 | 0.097 (0.096–0.105) |
| 10 | diamond | minimal | closed | unplugin | 12.5 (11.7–14.4) | 10.3 (9.7–11.1) | 10.9 (9.1–11.8) | 356925440 | 80147 | 22658 | 0.100 (0.097–0.106) |
| 10 | diamond | minimal | closed | transformer | 8.1 (7.9–9.8) | 7.6 (7.5–8.5) | 8.0 (7.5–9.6) | 357105664 | 80147 | 22658 | 0.099 (0.090–0.101) |

## Taille 100

```sh
NEOSYRINGE_BENCH_SIZES=100 NEOSYRINGE_BENCH_REPS=5 node tests/bench/compile-cost.mjs
```

Sortie brute : `t3o-bench-s100.txt`. Exit 0. 21,35 s.

| size | shape | profile | mode | tool | first_ms | leaf_ms | shared_ms | rss_bytes | code_bytes | gzip | resolve_first_ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 100 | linear | full | open | unplugin | 78.8 (69.4–107.4) | 73.8 (57.5–83.8) | 68.8 (62.0–82.0) | 335872000 | 1091120 | 277611 | 0.096 (0.084–0.105) |
| 100 | linear | full | open | transformer | 63.0 (61.6–67.4) | 61.0 (59.8–63.1) | 60.8 (59.7–63.5) | 410370048 | 1091120 | 277609 | 0.095 (0.093–0.103) |
| 100 | linear | full | closed | unplugin | 69.5 (65.0–83.6) | 57.5 (55.0–62.4) | 59.6 (53.9–62.7) | 439697408 | 1045460 | 255052 | 0.101 (0.097–0.111) |
| 100 | linear | full | closed | transformer | 63.3 (61.2–65.7) | 60.7 (60.5–72.4) | 61.8 (61.3–64.9) | 542326784 | 1045460 | 255081 | 0.108 (0.099–0.130) |
| 100 | linear | minimal | open | unplugin | 56.9 (55.2–61.1) | 48.7 (46.0–49.3) | 47.7 (45.7–52.1) | 554516480 | 582100 | 170744 | 0.080 (0.078–0.087) |
| 100 | linear | minimal | open | transformer | 41.7 (41.4–43.7) | 40.9 (40.7–45.3) | 40.8 (40.4–44.5) | 554663936 | 582100 | 170803 | 0.080 (0.075–0.084) |
| 100 | linear | minimal | closed | unplugin | 63.2 (57.6–67.7) | 51.4 (47.1–59.9) | 49.1 (47.5–54.1) | 555040768 | 604090 | 179358 | 0.085 (0.081–0.137) |
| 100 | linear | minimal | closed | transformer | 45.0 (43.7–47.1) | 43.2 (42.5–44.8) | 42.5 (41.3–46.8) | 555188224 | 604090 | 179349 | 0.086 (0.082–0.093) |
| 100 | diamond | full | open | unplugin | 86.9 (86.7–95.4) | 78.4 (75.3–79.4) | 76.0 (75.8–80.1) | 555220992 | 1200168 | 295580 | 0.116 (0.115–0.158) |
| 100 | diamond | full | open | transformer | 74.5 (71.9–79.2) | 74.6 (71.4–79.5) | 73.7 (72.2–74.7) | 557121536 | 1200168 | 295633 | 0.128 (0.122–0.133) |
| 100 | diamond | full | closed | unplugin | 91.2 (89.8–95.5) | 81.3 (78.5–86.4) | 81.5 (79.5–89.1) | 557301760 | 1175614 | 275224 | 0.130 (0.125–0.139) |
| 100 | diamond | full | closed | transformer | 77.7 (74.7–81.5) | 75.7 (74.2–77.4) | 75.3 (73.6–87.6) | 557350912 | 1175614 | 275363 | 0.137 (0.131–0.144) |
| 100 | diamond | minimal | open | unplugin | 85.6 (83.6–86.1) | 77.4 (74.6–79.1) | 76.2 (74.6–77.9) | 588611584 | 683374 | 188248 | 0.104 (0.101–0.111) |
| 100 | diamond | minimal | open | transformer | 54.6 (54.3–57.0) | 55.6 (53.9–66.0) | 57.0 (53.9–60.2) | 588742656 | 683374 | 188327 | 0.104 (0.100–0.123) |
| 100 | diamond | minimal | closed | unplugin | 88.6 (87.9–93.0) | 80.3 (78.2–82.9) | 80.6 (78.5–81.1) | 588775424 | 693407 | 195010 | 0.114 (0.105–0.126) |
| 100 | diamond | minimal | closed | transformer | 57.4 (56.4–62.2) | 56.4 (55.5–62.3) | 57.3 (56.8–58.4) | 574128128 | 693407 | 195173 | 0.107 (0.103–0.108) |

## Taille 1000

```sh
NEOSYRINGE_BENCH_SIZES=1000 NEOSYRINGE_BENCH_REPS=5 node tests/bench/compile-cost.mjs
```

Sortie brute : `t3o-bench-s1000.txt`. Exit 0. 237,65 s.

| size | shape | profile | mode | tool | first_ms | leaf_ms | shared_ms | rss_bytes | code_bytes | gzip | resolve_first_ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1000 | linear | full | open | unplugin | 572.8 (564.3–713.6) | 499.6 (490.1–517.9) | 491.8 (482.9–513.2) | 709509120 | 10919120 | 2773257 | 0.100 (0.082–0.108) |
| 1000 | linear | full | open | transformer | 791.8 (775.9–826.4) | 817.6 (783.2–878.0) | 794.7 (772.5–834.9) | 1761722368 | 10919120 | 2774000 | 0.100 (0.088–0.123) |
| 1000 | linear | full | closed | unplugin | 582.6 (570.9–584.6) | 509.6 (507.1–525.6) | 507.0 (502.1–518.3) | 1739735040 | 10468460 | 2546697 | 0.103 (0.102–0.115) |
| 1000 | linear | full | closed | transformer | 826.6 (819.9–877.8) | 832.4 (828.6–855.6) | 849.3 (831.4–881.0) | 1741996032 | 10468460 | 2547528 | 0.104 (0.100–0.113) |
| 1000 | linear | minimal | open | unplugin | 544.5 (541.1–597.9) | 476.6 (469.4–507.1) | 475.6 (470.4–489.1) | 1812250624 | 5830900 | 1704234 | 0.080 (0.078–0.087) |
| 1000 | linear | minimal | open | transformer | 606.7 (598.7–616.7) | 611.5 (604.8–630.8) | 600.5 (593.1–612.7) | 1813479424 | 5830900 | 1705122 | 0.080 (0.079–0.080) |
| 1000 | linear | minimal | closed | unplugin | 560.5 (552.7–569.0) | 493.1 (487.6–497.0) | 492.3 (482.7–506.5) | 1825472512 | 6051790 | 1788905 | 0.090 (0.086–0.102) |
| 1000 | linear | minimal | closed | transformer | 647.2 (642.5–678.1) | 660.5 (637.2–664.3) | 654.8 (650.0–677.4) | 1826570240 | 6051790 | 1789236 | 0.088 (0.084–0.094) |
| 1000 | diamond | full | open | unplugin | 866.1 (851.1–883.6) | 784.9 (776.8–790.2) | 788.8 (764.4–807.0) | 1832714240 | 11812968 | 2908897 | 0.120 (0.115–0.125) |
| 1000 | diamond | full | open | transformer | 1080.7 (1072.9–1108.3) | 1080.3 (1062.0–1110.3) | 1058.1 (1049.3–1100.4) | 1838514176 | 11812968 | 2909562 | 0.117 (0.115–0.123) |
| 1000 | diamond | full | closed | unplugin | 904.4 (891.5–953.4) | 817.5 (816.4–829.7) | 818.9 (809.3–829.0) | 1890041856 | 11581414 | 2708685 | 0.131 (0.131–0.142) |
| 1000 | diamond | full | closed | transformer | 1161.9 (1109.3–1178.8) | 1113.1 (1103.8–1181.3) | 1128.2 (1112.5–1203.2) | 1977565184 | 11581414 | 2708915 | 0.131 (0.130–0.156) |
| 1000 | diamond | minimal | open | unplugin | 848.9 (841.6–901.2) | 768.9 (761.1–825.0) | 765.1 (761.8–797.8) | 1984266240 | 6738574 | 1855566 | 0.104 (0.103–0.112) |
| 1000 | diamond | minimal | open | transformer | 874.4 (865.8–885.1) | 877.6 (853.9–899.3) | 874.5 (867.9–888.1) | 1988362240 | 6738574 | 1855832 | 0.105 (0.099–0.211) |
| 1000 | diamond | minimal | closed | unplugin | 880.3 (874.2–891.7) | 794.5 (789.9–807.7) | 793.3 (791.8–806.7) | 1984708608 | 6835907 | 1920138 | 0.110 (0.107–0.118) |
| 1000 | diamond | minimal | closed | transformer | 917.8 (909.5–939.1) | 912.3 (909.6–923.6) | 945.6 (916.1–957.9) | 1989181440 | 6835907 | 1921441 | 0.109 (0.108–0.131) |

## Taille 5000

Huit commandes, une par couple (forme, profil, mode), chacune avec les deux outils : seize cellules, tournées en exit 0. Les quatre commandes `diamond` (huit cellules) ont tourné sous charge ; la colonne `charge` les marque (`haute`), les quatre commandes `linear` sont marquées `≈2` (`load1` entre 2,13 et 2,73 avant le lancement). Le gabarit de chaque commande :

```sh
NEOSYRINGE_BENCH_SIZES=5000 NEOSYRINGE_BENCH_REPS=5 NEOSYRINGE_BENCH_SHAPES=<forme> NEOSYRINGE_BENCH_PROFILES=<profil> NEOSYRINGE_BENCH_MODES=<mode> NODE_OPTIONS=--max-old-space-size=8192 node tests/bench/compile-cost.mjs
```

Les huit valeurs de `<forme> <profil> <mode>` sont celles des lignes du tableau. Sorties brutes : `t3o-bench-s5000-<forme>-<profil>-<mode>.txt`. Pic de RSS du processus entier (`/usr/bin/time -l`, « maximum resident set size », en octets) : linear full open 5506433024, linear full closed 5500108800, linear minimal open 3867279360, linear minimal closed 4603510784, diamond full open 5427970048, diamond full closed 5577474048, diamond minimal open 4352917504, diamond minimal closed 4870668288. Les cellules `diamond` ont tourné sous charge : voir « Charge de la machine ».

| size | shape | profile | mode | tool | first_ms | leaf_ms | shared_ms | rss_bytes | code_bytes | gzip | resolve_first_ms | charge |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 5000 | linear | full | open | unplugin | 2949.4 (2907.7–3321.0) | 2601.7 (2567.8–2657.6) | 2605.2 (2593.7–2727.5) | 1778860032 | 54631120 | 13869908 | 0.095 (0.086–0.101) | ≈2 |
| 5000 | linear | full | open | transformer | 12253.1 (9502.8–12576.4) | 10617.3 (9772.2–13307.2) | 10856.3 (10668.6–12460.2) | 5490835456 | 54631120 | 13872893 | 0.097 (0.095–0.100) | ≈2 |
| 5000 | linear | full | closed | unplugin | 3046.3 (3023.6–3288.5) | 2698.5 (2642.8–2713.5) | 2708.9 (2668.8–2839.9) | 1760706560 | 52404460 | 12737042 | 0.110 (0.100–0.130) | ≈2 |
| 5000 | linear | full | closed | transformer | 12652.9 (11334.3–12909.5) | 10991.3 (9810.0–13319.3) | 11366.4 (11072.1–13006.5) | 5475680256 | 52404460 | 12735306 | 0.108 (0.102–0.116) | ≈2 |
| 5000 | linear | minimal | open | unplugin | 2865.5 (2850.4–3082.7) | 2479.1 (2464.7–2507.5) | 2474.1 (2468.3–2513.3) | 1134067712 | 29198900 | 8523800 | 0.067 (0.063–0.073) | ≈2 |
| 5000 | linear | minimal | open | transformer | 8993.2 (8573.4–9789.2) | 9664.7 (8385.7–10502.9) | 10421.0 (8940.9–11343.4) | 3840917504 | 29198900 | 8522702 | 0.083 (0.081–0.084) | ≈2 |
| 5000 | linear | minimal | closed | unplugin | 2941.7 (2869.1–3128.3) | 2567.1 (2520.9–2818.7) | 2567.0 (2538.5–2740.4) | 1170817024 | 30307790 | 8946683 | 0.078 (0.075–0.082) | ≈2 |
| 5000 | linear | minimal | closed | transformer | 10270.4 (9433.1–11000.7) | 10603.8 (9684.8–12115.8) | 10671.9 (9547.8–11717.5) | 4129718272 | 30307790 | 8950382 | 0.086 (0.083–0.094) | ≈2 |
| 5000 | diamond | full | open | unplugin | 4698.5 (4495.5–4870.3) | 4168.7 (4070.5–4232.1) | 4247.2 (4096.8–5445.2) | 1986002944 | 59012968 | 14514666 | 0.120 (0.105–0.123) | haute |
| 5000 | diamond | full | open | transformer | 23726.3 (20899.6–31355.1) | 19443.2 (17317.9–49418.0) | 20312.4 (18560.6–68164.3) | 5341937664 | 59012968 | 14516595 | 0.124 (0.112–0.143) | haute |
| 5000 | diamond | full | closed | unplugin | 4754.6 (4648.7–5401.7) | 4383.2 (4198.0–4558.6) | 4577.6 (4252.8–13340.1) | 1997799424 | 57885414 | 13515232 | 0.139 (0.134–0.152) | haute |
| 5000 | diamond | full | closed | transformer | 23823.5 (19677.4–28569.0) | 20710.4 (16614.1–30340.5) | 20388.8 (20086.6–23575.4) | 5551800320 | 57885414 | 13520105 | 0.130 (0.128–0.148) | haute |
| 5000 | diamond | minimal | open | unplugin | 4372.0 (4321.9–4690.2) | 3930.8 (3899.4–3985.2) | 3969.7 (3918.2–4020.8) | 1318453248 | 33690574 | 9252701 | 0.086 (0.083–0.101) | haute |
| 5000 | diamond | minimal | open | transformer | 19727.6 (16402.5–94457.6) | 16890.4 (14790.3–39286.5) | 22878.5 (16497.6–27602.2) | 4173660160 | 33690574 | 9255938 | 0.107 (0.100–0.129) | haute |
| 5000 | diamond | minimal | closed | unplugin | 5512.7 (4661.2–8380.8) | 4850.2 (4115.5–5251.0) | 4493.4 (4099.4–5107.6) | 1348157440 | 34179907 | 9574813 | 0.091 (0.088–0.105) | haute |
| 5000 | diamond | minimal | closed | transformer | 22001.7 (19796.3–30367.9) | 26990.1 (17230.1–38171.1) | 20584.8 (18501.8–47585.9) | 3876159488 | 34179907 | 9580202 | 0.106 (0.104–0.115) | haute |

## Lecture

Ces phrases ne reprennent que des médianes des tableaux ci-dessus. Prose en virgule décimale.

- linear, full, open, unplugin, `first_ms` : 13,7 ms à 10, 78,8 ms à 100, 572,8 ms à 1000, 2949,4 ms à 5000.
- Même cellule, outil transformer : 11,0 à 10, 63,0 à 100, 791,8 à 1000, 12253,1 à 5000.
- À 5000, dans les quatre paires `linear` (full open, full closed, minimal open, minimal closed), le `first_ms` de l'outil transformer est plus haut que celui d'unplugin. Les quatre paires `diamond` vont dans le même sens, mais elles ont tourné sous charge : voir « Charge de la machine ».
- Le `rss_bytes` des deux outils n'est pas comparé. Dans une commande, unplugin tourne avant transformer dans le même processus (`tests/bench/compile-cost.mjs:41`, `tests/bench/compile-cost.mjs:447`), et le RSS d'une cellule garde l'historique des cellules précédentes (voir « Commande »). L'ordre d'exécution et l'historique du processus brouillent cette comparaison.
- À 5000, `code_bytes` est identique entre les deux outils pour une même cellule.
- Aucune de ces lignes ne tire un gain ou une promesse : un seul ordinateur, une session, 5 répétitions.

## Chaîne tsconfig, commit fc0bbb9

`tests/bench/compile-cost.mjs` n'existe pas dans fc0bbb9 (`git cat-file -e fc0bbb9:tests/bench/compile-cost.mjs` échoue). Le banc complet n'a pas été relancé sur ce commit. Le coût d'un transform complet contre ce commit n'a pas été mesuré.

fc0bbb9 tamponnait le tsconfig avec `statSync` (`git show fc0bbb9:packages/unplugin/src/session.ts`, fonction `tsconfigFileStamp`). Le code actuel lit le texte de la chaîne et ne fait plus ce `statSync`. **Les cinq durées ci-dessous sont une mesure plus ancienne, d'un round antérieur : elles n'ont pas été rejouées, ne viennent pas de la session de cette page et ne sont dans aucun fichier `t3o-bench-*`.** Mesure isolée, 200 fichiers, `include` `**/*.ts`, 5 chauffes puis 20 échantillons, médiane :

- `statSync` : 0,003 ms (0,002–0,012)
- parse avec `readDirectory` vide : 0,097 ms (0,064–0,170)
- parse avec `ts.sys.readDirectory` : 0,515 ms (0,462–0,593)

Le même parse sur un `include` d'un seul fichier : 0,063 ms avec `readDirectory` vide, 0,187 ms avec le scan. Ce n'est pas le temps d'un transform. C'est seulement la lecture de config.

## Seuils

Aucun seuil n'est proposé. La médiane `first_ms` à 100 fichiers, linéaire, plein, ouvert, unplugin, est 78,8 ms (69,4–107,4) dans la session de cette page, sur une machine dont le `load1` valait 2,02 avant le groupe de taille 100. L'écart min–max de `first_ms` d'une cellule va de 2,3 ms à 38,0 ms à 100 fichiers (38,0 ms pour linear full open unplugin). À 5000, il va de 0,2 s (unplugin, linear minimal open : 232,3 ms) à 78,1 s (transformer, diamond minimal open, sous charge). Le RSS mélange l'historique du processus. Un chiffre de cet ordinateur n'est pas une porte de CI.

Les phrases « sous 30 ms / 200 ms / 8 s / 10 s » ne sont pas des seuils retenus. Ce document ne les transforme pas en gate.
