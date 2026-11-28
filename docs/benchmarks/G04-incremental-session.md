# G04 — session de compilation incrémentale du plugin

Topic 04 de la livraison globale, étage G. Pas un seuil de CI. Les chiffres viennent d'une seule machine (Apple M4 Max, 16 cœurs, 64 Go, Node v22.23.2, TypeScript 5.9.3). La base 60cdc30 est mesurée sur la même machine, avec les mêmes commandes, à partir d'une copie `git archive` de ses sources (`tests/bench/g04-soak.mjs:11`). **Sur un tsconfig de beaucoup de racines dont un conteneur n'importe qu'un fichier, le candidat est plus lent que la base, à froid et à chaud** : voir « Grand tsconfig, petite fermeture ». Un rebuild d'esbuild reparse tous les fichiers du projet, ce que la base ne fait pas : voir « Rebuild façon esbuild ».

## Décision

Un plugin garde une `ProjectSession` par instance de plugin, projet, options du compilateur et **environnement** du bundler : `state.projects` est une table nom d'environnement vers un emplacement (clé, session, config, mode des racines), `state.project` n'est que la session du dernier transform (`packages/unplugin/src/session.ts:111-123`, `packages/unplugin/src/session.ts:530-563`, `packages/unplugin/src/projectSession.ts:67`). Elle tient :

- les **overlays** : le texte que le bundler a transformé, pour chaque fichier TypeScript, pas seulement le dernier (`packages/unplugin/src/index.ts:175`, `packages/unplugin/src/projectSession.ts:156`). Un texte égal au texte du disque n'est pas un overlay : un build de N fichiers ne fait pas N révisions ;
- les `SourceFile` déjà analysés, gardés d'un `Program` au suivant quand le texte et la clé de parse sont les mêmes (`packages/unplugin/src/projectSession.ts:423`, `packages/unplugin/src/projectSession.ts:34`) ;
- un seul `Program`, construit à partir de **toutes** les racines du tsconfig (`packages/core/src/resolveProjectConfig.ts:30-35`, `packages/unplugin/src/session.ts:553`) et de chaque fichier que le plugin a transformé. Même révision, même objet (`packages/unplugin/src/projectSession.ts:289`).

`transform` fait `update`, `addRoot`, `revalidate`, puis `snapshot()` et `scoped(fichier)` (`packages/unplugin/src/session.ts:900-904`). `buildEnd` lit le même `Program` **quand chaque fichier d'usage est déjà tenu** par la session de son environnement (racine du tsconfig, fichier importé, ou fichier transformé). Un fichier qui n'a qu'un appel `resolve(` n'atteint jamais `compileWith` (`transform` s'arrête sans marqueur : `packages/unplugin/src/index.ts:182`) : `buildEnd` l'ajoute comme racine (`packages/unplugin/src/buildEndUsages.ts:109`), et si la session ne le tient pas, la révision change et un nouveau `Program` incrémental est construit. La reconstruction parallèle de `buildEndUsages` est supprimée. Sans session (un fichier d'usage sans fichier marqueur, ou un appelant qui ne tient que des textes), une session éphémère est construite à partir des textes, jamais `ts.createProgram` sur un hôte à part (`packages/unplugin/src/buildEndUsages.ts:119`).

Le cache de graphes par texte reste retiré. Les graphes d'un fichier sont analysés une fois par fichier et par `Program`, rangés dans un `SnapshotCache` qui meurt avec l'objet qu'il suit (`packages/unplugin/src/analysisCache.ts:131-143`, `packages/unplugin/src/invalidation.ts:8`). Un transform ne copie que les graphes de son fichier.

### Analyse par fichier : la vue

Le `Program` couvre toutes les racines (c'est l'acceptation du topic). L'**analyse** d'un transform ne les couvre pas. Le collecteur de l'analyse parcourt les fichiers que `program.getSourceFiles()` lui donne (`packages/core/src/analyzer/collectors/ConfigCollector.ts:80`). `ProjectSession.scoped(entrée)` rend donc le `Program` de la révision vu à travers les fichiers que l'entrée importe, elle comprise : mêmes vérificateur de types, racines et overlays, seul `getSourceFiles` change (`packages/unplugin/src/projectSession.ts:343-362`). La fermeture est celle que la sonde parcourt (les arêtes notées pendant la résolution : `packages/unplugin/src/projectSession.ts:304-309`). Les graphes et les diagnostics du fichier sont lus sur cette vue (`packages/unplugin/src/session.ts:929`, `packages/unplugin/src/session.ts:944`).

Conséquences :

- une édition d'une feuille du conteneur X analyse les conteneurs que X importe, pas les autres (test G04-P16 : `packages/unplugin/tests/g04-session.test.ts:566`) ;
- un parent ou un partiel d'un autre fichier est dans la fermeture de ses enfants : il reste résolu après un changement (test G04-P17 : `packages/unplugin/tests/g04-session.test.ts:600`) ;
- le TypeScript d'un paquet (un conteneur partagé en source, un paquet d'espace de travail) est une arête comme un fichier du projet ; ses déclarations n'en sont pas (`packages/unplugin/src/projectSession.ts:469`, test G04-P18 : `packages/unplugin/tests/g04-session.test.ts:624`) ;
- le plugin garde l'analyse du **dernier** fichier seulement : un build de N fichiers tient une analyse, pas N (`packages/unplugin/src/analysisCache.ts:134`). Le compteur `containersAnalysed` additionne les conteneurs que les analyses ont collectés (`packages/unplugin/src/analysisCache.ts:138`).

Limites :

- la fermeture ne suit que les noms de module résolus : un fichier qui n'est atteint que par une référence `/// <reference path>` n'est pas noté comme arête (seules les résolutions de noms de module le sont : `packages/unplugin/src/projectSession.ts:461`) ;
- `buildEnd` analyse **toutes** les racines, une fois par build : `usageReport` lit les diagnostics de chaque fichier d'usage sur le `Program` entier (`packages/unplugin/src/buildEndUsages.ts:41-49`). c'est un coût par appel de `buildEnd`, pas par transform ;
- le coût qui reste proportionnel au nombre de racines est celui du `Program` lui-même (analyse syntaxique, liaison, vérificateur), pas celui de l'analyse : voir « Coût du `Program` de toutes les racines ».

### Racines : `all` ou `entry`

Un fichier que le tsconfig ne liste pas (`include` / `files`) n'est pas dans le projet. Tant que la session n'a vu que de tels fichiers, elle ne tient que ces fichiers, comme le plugin l'a toujours fait. Le premier fichier que le tsconfig liste lui donne toutes les racines, définitivement (`packages/unplugin/src/session.ts:530-543`). Le mode est un champ de l'emplacement de l'environnement (`roots`), pas de l'instance. Un événement du watcher ne recalcule les racines que d'une session en mode `all` (`packages/unplugin/src/session.ts:664`, tests G04-P22 et G04-U44) : dans le mode `entry`, une création, une suppression ou un `package.json` ne charge pas les racines du tsconfig.

**Limite : l'ordre des transforms.** Le mode suit ce que la session a vu. Un fichier que le tsconfig ne liste pas, analysé après un fichier listé, voit les globaux de toutes les racines ; analysé en premier, dans une instance neuve, il ne les voit pas. La différence ne compte que lorsqu'une racine déclare des globaux que ce fichier utilise (`packages/unplugin/src/session.ts:120`).

Pourquoi : `packages/unplugin/tests/t01-symboles.test.ts` transforme des fichiers temporaires avec `cwd` à la racine du dépôt, donc avec le tsconfig du dépôt. Avec toutes les racines, la suite `t01-symboles` durait 27,27 s et 4 tests dépassaient le délai de 5 s sous charge. Avec ce mode, 2,79 s (mesures `vitest`, même machine, charge non isolée).

## Modèle d'invalidation

| événement | effet | où |
| --- | --- | --- |
| édition d'un fichier que la session tient | `dropOverlay` + `invalidateFiles([fichier])` | `packages/unplugin/src/session.ts:658-659` |
| création, suppression | `invalidateEnvironment` ; les racines sont recalculées pour une session en mode `all` ; une suppression passe par `remove` ; chaque session ouverte reçoit l'événement | `packages/unplugin/src/session.ts:643-666` |
| `package.json`, `tsconfig*.json`, `jsconfig.json` | `invalidateEnvironment` (+ racines recalculées en mode `all`) | `packages/unplugin/src/invalidation.ts:43` |
| édition d'un fichier inconnu de la session (webpack n'émet que `update` et `delete`) | `invalidateEnvironment`, raison `unknown-file` | `packages/unplugin/src/invalidation.ts:64` |
| options du compilateur changées | nouvelle session pour **cet environnement** ; l'ancienne est fermée, ses overlays passent à la nouvelle ; les autres environnements ne bougent pas ; le magasin de déclarations n'est pas vidé | `packages/unplugin/src/session.ts:549-562` |
| liste des racines changée | `invalidateEnvironment`, raison `roots` | `packages/unplugin/src/projectSession.ts:208-214` |
| `buildStart` | relecture de tous les fichiers de toutes les sessions (une époque par build) | `packages/unplugin/src/index.ts:161` |

`invalidateEnvironment` relit tous les textes et **ne réutilise pas l'ancien `Program`** (`packages/unplugin/src/projectSession.ts:227-236`, `packages/unplugin/src/projectSession.ts:294`). Sans cela, TypeScript réutilise la résolution réussie d'un fichier dont le `SourceFile` est le même, d'un `Program` à l'autre (`packages/unplugin/node_modules/typescript/lib/typescript.js:127534-127541`) : l'importateur n'a pas changé, sa résolution reste celle d'avant. Les tests G04-P3 et G04-P6 échouent quand l'ancien `Program` est gardé : P3 crée un `.ts` qui masque un import résolu vers un `.d.ts`, P6 retarge les `exports` d'un paquet. P3 crée ses fichiers **hors** des racines du tsconfig, exprès : avec `include: ['**/*.ts']`, la mutation qui garde l'ancien `Program` survivait à P3, la création ajoutant alors une racine.

Chaque invalidation est comptée par genre et raison, bornée par le nombre de raisons distinctes, pas par le nombre d'éditions (`packages/unplugin/src/projectSession.ts:139-139`). Les raisons sont des chaînes : `update`, `probe`, `probe-manifest`, `probe-delete`, `create`, `delete`, `package-json`, `config`, `roots`, `unknown-file`, `build-start`.

### Fraîcheur sans événement : la sonde

Des tests existants (T18-A01, T18-A02b, T18-A04) changent le disque et relancent un transform sans aucun appel de hook (`packages/unplugin/tests/t18-cache-invalidation.test.ts:238`, `packages/unplugin/tests/t18-cache-invalidation.test.ts:315`, `packages/unplugin/tests/t18-cache-invalidation.test.ts:503`). Une session qui n'apprend que par événements les casserait. `revalidate(entrée)` relit donc, à chaque transform, le texte disque :

- des fichiers que l'entrée atteint par ses imports (la fermeture, notée pendant la résolution : `packages/unplugin/src/projectSession.ts:304-309`, `packages/unplugin/src/projectSession.ts:461`) ;
- des fichiers de déclaration **du projet** que la fermeture atteint (un `types.d.ts` importé) : leur `SourceFile` vit dans le magasin de déclarations, pas dans les sources de la session ; la sonde compare le texte du disque à l'estampille du magasin (`packages/unplugin/src/projectSession.ts:263-270`, tests G04-P20 et G04-U46). Les fichiers de lib de l'installation TypeScript et les `.d.ts` de `node_modules` ne sont pas sondés ;
- des racines qui sont des scripts, `.ts` ou `.d.ts` (déclarations ambiantes, `declare module`, globaux) (`packages/unplugin/src/projectSession.ts:328`, tests G04-P21 et G04-U47) ;
- du `package.json` et du manifeste de jetons des paquets qui portent la clé `neosyringe` (l'analyse lit ces manifestes avec le système de fichiers, hors du `Program` : `packages/core/src/analyzer/shared/tokensManifest.ts:207-221` ; la session les note à chaque build : `packages/unplugin/src/projectSession.ts:331`).

Une entrée que le `Program` n'a jamais lue n'a pas de fermeture connue : tous les fichiers de projet tenus, déclarations comprises, sont sondés une fois (`packages/unplugin/src/projectSession.ts:254`). Un fichier qui a un overlay n'est pas sondé : son texte n'est pas celui du disque, exprès. Un fichier déjà invalidé n'est pas relu, et rien n'est sondé quand tout est déjà invalidé (`packages/unplugin/src/projectSession.ts:248-248`).

Quand rien n'a changé, la sonde ne construit **aucun** nouveau `Program` : `programsBuilt` reste à 1 (test G04-U9, G04-U35).

Limites : un fichier qui n'est ni dans la fermeture de l'entrée ni une racine script, et qui change sans événement, n'est vu qu'à la prochaine époque (`buildStart`) ou au prochain événement. Un `package.json` sans clé `neosyringe` n'est pas sondé : seul un événement le voit.

## Fermeture

`closeProjectSession` ferme toutes les sessions ouvertes (une par environnement), libère les sources, les overlays, le `Program` et les graphes (`packages/unplugin/src/session.ts:677-686`). Elle est appelée :

- à `buildEnd` quand le build n'est pas un build en watch (`packages/unplugin/src/index.ts:244`) ;
- à `closeBundle` hors watch, et à `closeWatcher` (`packages/unplugin/src/index.ts:278-287`, `packages/unplugin/src/index.ts:291-300`).

Webpack et esbuild n'ont pas de `closeBundle` : `grep -n closeBundle` ne trouve aucune occurrence dans le fichier d'unplugin, qui ne mappe que `buildEnd` (esbuild : `node_modules/.pnpm/unplugin@2.3.11/node_modules/unplugin/dist/index.js:218-219` ; webpack : `node_modules/.pnpm/unplugin@2.3.11/node_modules/unplugin/dist/index.js:782-783`). Sans `closeBundle`, c'est `buildEnd` qui ferme la session quand aucun signe de watch n'est connu. Le signe de watch est `this.meta.watchMode` à `buildStart` (Rollup, Vite) ou un appel de `watchChange` (`packages/unplugin/src/index.ts:70`, `packages/unplugin/src/index.ts:159`, `packages/unplugin/src/index.ts:266`). Webpack n'appelle `watchChange` qu'avant une reconstruction (`node_modules/.pnpm/unplugin@2.3.11/node_modules/unplugin/dist/index.js:772-777`) : en watch webpack, la première construction ferme la session, la suivante en rouvre une froide, puis elle reste ouverte. Esbuild : unplugin n'y appelle pas `watchChange` (`grep -n watchChange` ne trouve que les lignes 576-582, 772-777 et 918-923 du même fichier, celles de Farm, de webpack et de rspack), donc sa session se ferme à la fin de chaque build.

Les sources de lib et de déclaration appartiennent à l'instance de plugin. Elles survivent à un build **et à l'ouverture d'une nouvelle session** : `projectFor` ne vide pas le magasin (`packages/unplugin/src/session.ts:550-552`), parce que `parsedAs` contrôle la forme du parse et l'estampille contrôle le texte (`packages/unplugin/src/projectSession.ts:441-451`). Seul `closeWatcher` les libère (`packages/unplugin/src/session.ts:685`). Test G04-P23 : après un `buildEnd` non watch, le nouveau build reçoit le même objet `SourceFile` pour la lib. Les `SourceFile` du **projet** ne survivent pas : la session les libère à la fermeture.

En watch, les fichiers d'usage (marqueur ou `resolve`) restent connus d'un build à l'autre, par environnement : une dépendance changée peut casser un fichier que personne n'a touché (`packages/unplugin/src/index.ts:130`). Un fichier dont le texte ne porte plus ni marqueur ni appel `resolve` quitte cette liste au transform suivant (`packages/unplugin/src/index.ts:180`, test G04-P24).

## Environnements

Une session par nom d'environnement Vite 6+ (`this.environment.name`), `''` quand le bundler n'en nomme pas (`packages/unplugin/src/session.ts:94`, `packages/unplugin/src/session.ts:530-563`, `packages/unplugin/src/index.ts:74`). Dans Vite 6+, `client` et `ssr` partagent l'instance du plugin et leurs transforms s'entrelacent : chacun garde sa session, son `Program`, ses overlays et ses racines, et alterner ne reconstruit rien et ne ferme rien (tests G04-U43 pour les compteurs et la fermeture, G04-P19 pour la non-pollution et l'absence de reparse).

- Les overlays d'un environnement ne passent jamais à un autre : un texte donné avant l'ouverture d'une session attend dans `environmentOverlays` (`pendingOverlays` pour le bundler qui n'a pas de nom) (`packages/unplugin/src/session.ts:569-580`) ; `trackSourceText` envoie le texte à la session de son environnement (`packages/unplugin/src/session.ts:616-624`). Le report des overlays (`carry`) n'a lieu que d'une session à la suivante **du même environnement**, quand les options du compilateur changent (`packages/unplugin/src/session.ts:549-562`).
- Un événement du watcher ne porte pas d'environnement : toutes les sessions le reçoivent (`packages/unplugin/src/session.ts:643-666`, test G04-U44).
- `buildEnd` vérifie chaque environnement sur sa session et ses textes ; le même message n'est rapporté qu'une fois (`packages/unplugin/src/index.ts:224-234`).
- Le magasin de déclarations est partagé entre les environnements : deux environnements aux options différentes (un `target` différent) se disputent la même entrée, que `parsedAs` écarte, donc la lib est reparsée à chaque alternance. Le résultat reste juste, mais le gain de reprise n'existe que pour des options identiques.

## Topologies hors support

- **Références de projets** (`references` dans le tsconfig racine) : la session analyse le projet racine seulement. L'avis `[NeoSyringe] tsconfig "references" are not followed by the incremental session; only the root project is analysed.` est émis une fois par instance de plugin, par `this.warn` ou `console.warn` (`packages/unplugin/src/session.ts:500`, `packages/unplugin/src/session.ts:1077`). Le test G04-P15 vérifie l'avis, son unicité, et que le projet racine se transforme (`packages/unplugin/tests/g04-session.test.ts:547`). Rien n'est déduit de `oldProgram` : les redirections source/déclaration ne sont pas qualifiées.
- **workspace-consumer** (paquets pnpm liés par lien symbolique) : remis à l'étage H (topic 08). La session identifie un fichier par `path.resolve` sans `realpath` (`packages/unplugin/src/projectSession.ts:110-112`) ; seul `analysisCache` fait `realpath` (`packages/unplugin/src/analysisCache.ts:39`). Deux chemins du même fichier par un lien sont deux fichiers pour la session.
- **Serveur de dev Vite** : à la fermeture du serveur, Vite appelle `buildEnd` puis `closeBundle`, avec un contexte dont `meta.watchMode` vaut `true` (`node_modules/.pnpm/vite@7.3.1_@types+node@25.0.9_jiti@2.6.1_lightningcss@1.33.0_terser@5.51.2_yaml@2.8.2/node_modules/vite/dist/node/chunks/config.js:28594-28597`), et n'appelle jamais `closeWatcher` (`node_modules/.pnpm/vite@7.3.1_@types+node@25.0.9_jiti@2.6.1_lightningcss@1.33.0_terser@5.51.2_yaml@2.8.2/node_modules/vite/dist/node/chunks/config.js:28828-28829` ; `grep -n closeWatcher` sur ce fichier ne trouve aucune occurrence). La session du serveur de dev n'est donc jamais fermée par le plugin : elle vit autant que l'instance du plugin, c'est-à-dire autant que le serveur. `buildEnd` n'est appelé que pour l'environnement `client` sauf `perEnvironmentStartEndDuringDev` (même fichier, ligne 28828), donc la vérification d'usage de fin de build du serveur ne passe que par les textes de cet environnement.
- **Dérive sans événement hors fermeture** : voir « Limites » de la sonde.
- **Plugin jamais fermé** : un hôte qui ne rappelle jamais `buildEnd` ni `closeBundle` garde la session tant que l'instance vit.

## Mesures

Commandes (depuis la racine) :

```
pnpm bench:g04                                                     # cold 100, warm 100, soak 1000, close
NEOSYRINGE_G04_MODE=multi pnpm bench:g04                           # M = 50 et 200 conteneurs indépendants
NEOSYRINGE_G04_MODE=rebuild pnpm bench:g04                         # rebuild façon esbuild, 100 conteneurs
NEOSYRINGE_G04_MODE=bigroots pnpm bench:g04                        # 386 racines, une fermeture d'un fichier
NEOSYRINGE_G04_MODE=soak NEOSYRINGE_G04_EDITS=5000 pnpm bench:g04  # courbe mémoire
NEOSYRINGE_BENCH_SIZES=100 NEOSYRINGE_BENCH_TOOLS=unplugin node tests/bench/compile-cost.mjs
```

Pour mesurer une autre copie du plugin (la base 60cdc30 par exemple), `NEOSYRINGE_G04_SRC` désigne un dossier qui contient `packages/unplugin/src` : `git archive 60cdc30 packages/unplugin/src | tar -x -C <dossier>`. Les lignes JSON sont lues par la même sortie pour les deux copies, un compteur que la base n'a pas vaut 0 (`tests/bench/g04-soak.mjs:11`).

La sortie est en lignes JSON : des nombres seulement, pas de texte source. Charge de la machine (`uptime`, moyennes 1, 5, 15 minutes) :

| groupe | avant | après |
| --- | --- | --- |
| `bigroots` base, 3 exécutions | 1,32 6,22 10,56 | 1,32 6,22 10,56 |
| `bigroots` candidat, 2 premières exécutions | 1,33 6,56 10,78 | 1,33 6,56 10,78 |
| `bigroots` candidat, 3 exécutions après l'essai | 1,42 5,40 9,98 | 1,39 5,33 9,93 |
| `rebuild`, candidat, base et round 2, avec lib `es5` | 1,08 5,85 10,33 | 1,16 5,78 10,28 |
| `bigroots`, essai du cache de résolution, 3 exécutions | 1,46 5,48 10,04 | 1,46 5,48 10,04 |
| `pnpm bench:g04` (cold, warm, soak 1000, close) | 2,67 5,20 9,65 | 2,54 5,13 9,60 |
| `NEOSYRINGE_G04_MODE=multi` | 2,41 5,06 9,55 | 2,41 5,06 9,55 |
| `compile-cost.mjs` taille 100, outil unplugin | 2,10 4,86 9,40 | 1,93 4,73 9,30 |

`uptime` ne rafraîchit pas ses moyennes en moins de quelques secondes : plusieurs groupes affichent la même valeur avant et après. La moyenne sur 1 minute était de 1 à 3 pendant ces mesures, donc la machine n'était pas au repos. Chaque chiffre est un ordre de grandeur ; un chiffre isolé n'est pas une comparaison.

### Grand tsconfig, petite fermeture : les deux métriques régressent

Le topic demande un `Program` de toutes les racines. Sur un tsconfig qui liste beaucoup de fichiers, dont un conteneur n'en importe qu'un, la base ne paie qu'une racine par transform ; le candidat paie tout le projet. **Le premier transform et chaque édition sont plus lents que sur la base.** Il n'y a pas de gain à chaud sur cette topologie.

Mesure du round 3 (`NEOSYRINGE_G04_MODE=bigroots`) : 386 racines `r<i>.ts` de 49 lignes, chacune importe un fichier `h<i>.ts` de 49 lignes (776 fichiers), un conteneur `app.ts` qui n'importe que `contract.ts`. Premier transform, puis cinq éditions de `contract.ts` (watch, un événement par édition), médiane des cinq. Trois exécutions de la base, cinq du candidat (la machine : voir plus haut).

| code | premier transform | édition, médiane de 5 |
| --- | --- | --- |
| base 60cdc30 | 40, 40, 42 ms | 3,4 ; 3,2 ; 3,2 ms |
| candidat | 363, 364, 367, 367, 372 ms | 5,6 ; 6,1 ; 6,2 ; 6,6 ; 7,0 ms |

Le premier transform est environ neuf fois plus lent, l'édition environ deux fois. Sur l'autre topologie mesurée au round 2 (386 racines et 1029 fichiers : les sources et les tests du dépôt, plus un conteneur d'un fichier), le rapport était plus grand, mesuré en exécutions isolées sur une machine chargée (charge 2 à 3) : base, premier transform 42 ms et éditions de 3 à 4 ms ; candidat, 852 à 858 ms et 25 à 33 ms (environ ×20 et ×8) (rapport d'étape du round 2, hors dépôt). Ces chiffres-là ne sont pas refaits : le script était jetable.

Le coût vient du `Program` de toutes les racines, pas de l'analyse (mesure du round 2, script jetable, 386 racines, 1029 fichiers) :

| `Program` | racines | fichiers | `createProgram` | vérificateur de types | analyse de la vue du conteneur |
| --- | --- | --- | --- | --- | --- |
| une racine (l'entrée) | 1 | 5 | 14 ms | 6 ms | 7 ms |
| toutes les racines | 386 | 1029 | 615 à 618 ms | 160 à 168 ms | 1 ms |

Le compromis est réel : plus le tsconfig liste de racines, plus le premier transform et chaque édition paient la taille du projet ; en échange l'analyse ne paie que la fermeture du fichier et `buildEnd` lit le même `Program`. Le seuil acceptable est la décision du mainteneur.

#### Essai : garder l'hôte du compilateur et le cache de résolution entre deux snapshots (non retenu)

L'API watch de TypeScript garde l'hôte et un `ModuleResolutionCache` d'un `Program` au suivant. L'essai : `snapshot` construit l'hôte (`getSourceFile`, `readFile`, `fileExists`, `resolveModuleNameLiterals` et son `ts.createModuleResolutionCache`) une fois, et le garde jusqu'à `invalidateEnvironment`. Toute la suite de tests du paquet restait verte (84 tests de `g04-session`, `g04-units` et `t18`). Mesure sur la même topologie `bigroots`, trois exécutions :

| code | premier transform | édition, médiane de 5 |
| --- | --- | --- |
| candidat (hôte neuf à chaque snapshot) | 363 à 372 ms | 5,6 à 7,0 ms |
| essai (hôte et cache gardés) | 362, 378, 369 ms | 6,1 ; 7,2 ; 6,4 ms |

Pas de gain, dans le bruit. Le coût de l'édition n'est donc pas la résolution de modules : TypeScript réutilise déjà les résolutions de l'ancien `Program` pour les fichiers non modifiés (`packages/unplugin/node_modules/typescript/lib/typescript.js:127534-127541`). Le premier transform ne change pas non plus (362 à 378 ms contre 363 à 372 ms) : il paie le `createProgram` et le vérificateur de toutes les racines (615 et 160 ms sur l'autre topologie).  Le code de l'essai n'est pas gardé : la session construit toujours un hôte neuf par snapshot (`packages/unplugin/src/projectSession.ts:292`).

### Rebuild façon esbuild : le magasin de déclarations survit à la session

esbuild n'a pas de `closeBundle` ni de `watchChange` : la session se ferme à chaque `buildEnd` et la suivante repart de zéro. Les sources de lib et de déclaration, elles, appartiennent à l'instance de plugin et doivent survivre (`packages/unplugin/src/session.ts:677`). Au round 2, `projectFor` vidait ce magasin à chaque nouvelle session : chaque rebuild reparsait aussi toutes les libs (finding I1). Le round 3 ne le vide plus (test G04-P23 : le `SourceFile` de la lib est le même objet d'un build au suivant).

Mesure (`NEOSYRINGE_G04_MODE=rebuild`, `NEOSYRINGE_G04_LIB=1` : le tsconfig utilise la lib `es5` au lieu de `noLib`). Une instance de plugin, six builds : `buildStart`, un transform de chacun des 100 conteneurs, `buildEnd`, sans événement ni `closeBundle` ; une feuille est éditée entre deux builds. Le build 0 est à froid ; la médiane porte sur les builds 1 à 5. Trois exécutions de chaque code.

| code | froid | rebuild, médiane (ms) | fichiers du projet reparsés par rebuild |
| --- | --- | --- | --- |
| base 60cdc30 | 277, 277, 274 | 127, 132, 129 | 1 |
| candidat du round 2 (magasin vidé) | 206, 200, 200 | 94, 94, 94 | 105 |
| candidat du round 3 | 202, 202, 202 | 87, 88, 88 | 105 |

Sans lib (`noLib`, l'autre configuration du banc) : base 231, 232 / 117, 114 ms ; round 2, 179, 179 / 89, 87 ms ; round 3, 180, 178 / 85, 88 ms. Deux constats : un rebuild coûte moins cher qu'à la base (environ 87 ms contre 130 ms avec la lib `es5`), le candidat construisant un seul `Program` pour les 100 transforms (`programsBuilt` : 1 au froid) ; et le candidat reparse les **105 fichiers du projet** à chaque rebuild, la base en reparse un, parce que la session close à `buildEnd` libère les `SourceFile` du projet. La reprise des lib gagne environ 7 ms par rebuild avec la lib `es5` (94 ms au round 2, 87 ms au round 3). Le nombre de fichiers reparsés par rebuild d'esbuild est une limite assumée : la session ne vit pas au-delà d'un build quand l'hôte ne dit pas qu'il est en watch.

### Froid et chaud, taille 100 (100 conteneurs, chacun avec la feuille `contract.ts`)

| mesure | valeur |
| --- | --- |
| froid : 100 transforms + `buildEnd` | 178 ms (164 + 13) |
| froid : `Program` construits, sources parsées, analyses, conteneurs analysés | 1, 109, 100, 100 |
| froid : RSS ajouté | 34 Mo |
| chaud, édition d'une feuille (médiane de 5) | 1,7 ms ; 1 `Program`, 1 source reparsée, 108 réutilisées, 1 analyse, 1 conteneur analysé |
| chaud, changement de type d'une dépendance (médiane de 5) | 1,4 ms ; 1 `Program`, 1 source reparsée, 108 réutilisées, 1 analyse, 1 conteneur analysé |

L'édition locale ne reconstruit pas les conteneurs sans dépendance sémantique : `graphsBuilt` monte de 1, et `containersAnalysed` de 1, pas de 100.

### Conteneurs indépendants : M = 50 et 200 (`NEOSYRINGE_G04_MODE=multi`)

M fichiers conteneurs, chacun avec sa classe et une feuille à lui. Froid : chaque conteneur transformé, puis `buildEnd`. Chaud : édition de la feuille du conteneur X, transform de X, médiane de 5 éditions sur cinq conteneurs différents. Aucune transformation n'a échoué ni rien généré de faux (`wrongTransforms` : 0).

| M | froid, transforms + `buildEnd` | froid, `Program`, sources parsées, analyses, conteneurs analysés | chaud, médiane | conteneurs analysés par édition |
| --- | --- | --- | --- | --- |
| 50 | 125 ms (117 + 8) | 1, 104, 50, 50 | 1,8 ms | 1, 1, 1, 1, 1 |
| 200 | 229 ms (210 + 19) | 1, 404, 200, 200 | 2,5 ms | 1, 1, 1, 1, 1 |

Par édition : 1 `Program`, 1 source reparsée, 1 analyse. Le nombre de conteneurs analysés suit ce que X importe (1), pas M. Mesure de la base au round 2 (une exécution, machine chargée) : M = 50 froid 174 ms, édition 1,5 ms ; M = 200 froid 314 ms, édition 1,1 ms.

### Soak, 1000 éditions, 20 fichiers

Cinq genres d'édition en rotation : feuille, type de dépendance, création puis suppression, `paths` du tsconfig, `exports` d'un `package.json`. Chaque édition est comparée au résultat d'une instance de plugin neuve sur le même arbre (code ou message d'erreur, égalité stricte).

| mesure | valeur |
| --- | --- |
| écarts avec l'instance neuve | 0 sur 1000 |
| durée | 6 s |
| tas après gc, médiane du premier quart / du dernier quart | 43,7 Mo / 46,7 Mo (+3,0 Mo) |
| invalidations | `files:update` 400, `environment:package-json` 200, `environment:create` 100, `environment:delete` 100, `environment:roots` 100 |

La série des tas (un échantillon toutes les 50 éditions) est 43,9 ; 43,3 ; 43,6 ; 43,7 ; 44,0 ; 44,1 ; 44,3 ; 44,5 ; 44,6 ; 44,7 ; 46,1 ; 46,2 ; 46,4 ; 45,1 ; 45,3 ; 45,3 ; 46,7 ; 46,9 ; 46,9 ; 45,8 Mo : elle monte par paliers et redescend, elle ne croît pas sans fin. Au round 2 la croissance mesurée était de +2,0 Mo ; la différence d'un Mo entre les deux rounds n'est pas expliquée. Un profil mémoire à 5000 éditions reste à faire par le mainteneur.

### Fermeture et références retenues

Sonde `WeakRef` sur le `Program`, trois `SourceFile` du projet et la session :

| moment | Program | 3 SourceFile | session |
| --- | --- | --- | --- |
| avant `buildEnd` + `closeBundle` (la sonde doit voir les objets) | retenu | retenus | retenue |
| après | libéré | libérés | libérée |

Le magasin de déclarations n'est pas dans cette sonde : il survit exprès (voir plus haut).

### `compile-cost.mjs`, taille 100, unplugin, candidat seul (médianes de 5, ms)

| forme | profil | mode | `first_ms` | `leaf_ms` | `shared_ms` | RSS (Mo) |
| --- | --- | --- | --- | --- | --- | --- |
| linear | full | open | 70,6 | 52,2 | 59,0 | 235 |
| linear | full | closed | 65,0 | 48,6 | 52,0 | 263 |
| linear | minimal | open | 57,0 | 43,6 | 46,1 | 338 |
| linear | minimal | closed | 56,3 | 43,4 | 45,4 | 350 |
| diamond | full | open | 83,0 | 65,9 | 69,8 | 352 |
| diamond | full | closed | 84,6 | 67,5 | 71,4 | 352 |
| diamond | minimal | open | 81,0 | 65,3 | 67,9 | 385 |
| diamond | minimal | closed | 81,5 | 65,4 | 69,3 | 385 |

Chaque passe transforme les 100 fichiers du projet (`tests/bench/compile-cost.mjs:350`). Dans la forme `diamond`, chaque feuille importe deux conteneurs communs (`tests/bench/compile-cost.mjs:133`) : leur analyse est refaite à chaque feuille, puisque chaque feuille analyse sa fermeture. C'est le prix de l'analyse par fichier sur un build complet ; il est payé en échange d'un coût d'édition qui ne dépend plus du nombre de conteneurs. Au round 2, les mêmes cellules `minimal closed` donnaient, base contre candidat (deux exécutions, machine chargée) : diamond 147,6 / 134,8 / 136,3 contre 99,6 / 80,0 / 83,9 ; linear 97,1 / 84,9 / 89,2 contre 60,8 / 46,9 / 49,8.

## Ce que ce round ne fait pas

- Taille 1000 et 5000 (froid, chaud), soak 5000 avec profil mémoire.
- `pnpm test:e2e` : la porte de l'orchestrateur du round 2 l'a lancé (297 tests verts, snapshots inchangés ; pas de numéro de run cité) ; ce round ne l'a pas relancé (pas de `pnpm build` : le `dist` est celui du round 2).
- Les références de projets ne sont pas suivies. Le workspace-consumer est à l'étage H.
- La reprise des `SourceFile` du projet entre deux builds d'esbuild (105 fichiers reparsés par rebuild) n'est pas faite : elle demande de garder la session après `buildEnd` hors watch, ce que le plugin ne fait pas (`packages/unplugin/src/index.ts:244`).
## Orchestrator's compile run, size 100 (base `60cdc30` against `2a64e2d`)

Run alone on the machine with `NEOSYRINGE_BENCH_SIZES=100 node tests/bench/compile-cost.mjs` in a built checkout of `60cdc30`, then in the candidate tree at `2a64e2d` (the compile path is the same at `50ff410`: round 6 of stage F changes one emitted argument). Node v22.23.2, TypeScript 5.9.3, Apple M4 Max x16, 5 repetitions after 1 warm-up, medians. Load averages (1, 5, 15 min): 2.54 2.57 3.14 at the start, 2.30 2.50 3.08 at the end. `rss` is the peak of the process that runs every cell, in MiB (not a per-cell figure).

| size 100: shape profile mode tool | first_ms | leaf_ms | rss (MiB) |
| --- | --- | --- | --- |
| diamond full closed transformer | 105.8 → 105.4 | 109.1 → 102.1 | 598 → 494 |
| diamond full closed unplugin | 132.0 → 88.7 | 118.5 → 71.2 | 581 → 494 |
| diamond full open transformer | 100.0 → 95.5 | 101.1 → 96.2 | 544 → 493 |
| diamond full open unplugin | 127.4 → 83.1 | 114.1 → 66.6 | 544 → 492 |
| diamond minimal closed transformer | 96.7 → 91.2 | 93.9 → 90.1 | 621 → 524 |
| diamond minimal closed unplugin | 128.4 → 87.2 | 115.6 → 71.3 | 621 → 524 |
| diamond minimal open transformer | 89.5 → 84.6 | 89.2 → 85.8 | 621 → 524 |
| diamond minimal open unplugin | 123.6 → 82.1 | 114.4 → 66.0 | 621 → 524 |
| linear full closed transformer | 79.7 → 80.0 | 79.7 → 78.0 | 539 → 456 |
| linear full closed unplugin | 99.3 → 63.4 | 84.9 → 49.5 | 486 → 456 |
| linear full open transformer | 82.2 → 80.8 | 79.2 → 77.0 | 431 → 450 |
| linear full open unplugin | 114.8 → 74.1 | 98.8 → 56.4 | 339 → 236 |
| linear minimal closed transformer | 69.4 → 66.4 | 68.6 → 66.7 | 542 → 492 |
| linear minimal closed unplugin | 84.8 → 56.0 | 74.9 → 42.4 | 541 → 491 |
| linear minimal open transformer | 63.7 → 62.6 | 63.3 → 61.2 | 540 → 491 |
| linear minimal open unplugin | 85.6 → 54.8 | 74.2 → 41.0 | 540 → 458 |

The plugin (`unplugin`) is 0.55 to 0.68 of the base on every cell (one Program over the roots instead of one per transform). The ts-patch transformer (`transformer`), which does not run the session, stays at 0.94 to 1.00. This fixture has one container per project; the large-tsconfig cost measured above (`bigroots`) still holds for a project with many roots and a small closure.
