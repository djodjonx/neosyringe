# Guide de Publication (Release)

## Prérequis

1. Être connecté à npm : `npm login`
2. Avoir configuré le 2FA sur votre compte npm
3. Être sur la branche `main` avec un dépôt propre

## Processus de publication

### 1. Créer un changeset

Après avoir fait des modifications, créez un changeset pour documenter les changements :

```bash
pnpm changeset
```

Suivez les instructions interactives :
- Sélectionnez les packages qui ont changé
- Choisissez le type de version (major, minor, patch)
- Ajoutez un résumé des changements

### 2. Mettre à jour les versions

Quand vous êtes prêt à publier, mettez à jour les versions :

```bash
pnpm version-packages
```

Cette commande :
- Applique les changesets
- Met à jour les versions dans les `package.json`
- Met à jour les CHANGELOGs
- Met à jour `pnpm-lock.yaml`
- **Crée automatiquement un commit git avec les changements**

### 3. Push les changements de version

```bash
git push
```

### 4. Publier sur npm

```bash
pnpm release
```

Cette commande :
- Synchronise le README
- Build tous les packages
- Publie sur npm avec `changeset publish`
- **Crée les tags git pour chaque package publié avec `changeset tag`**
- **Push automatiquement les tags vers le dépôt distant**
- **Vous demandera votre code 2FA de npm pendant la publication**

**Important** : 
- `changeset publish` gère automatiquement le 2FA de manière interactive. Il vous demandera votre code OTP pendant la publication de chaque package.
- Les exemples (comme `examples/nuxt`) ne sont PAS publiés sur npm, ils restent dans le repo avec des versions fixes pour CodeSandbox.

## Workflow complet en résumé

```bash
# 1. Créer un changeset après vos modifications
pnpm changeset

# 2. Mettre à jour les versions (crée un commit auto)
pnpm version-packages

# 3. Push le commit de version
git push

# 4. Publier et créer les tags (demande 2FA, push auto des tags)
pnpm release
```

Les tags seront au format `@djodjonx/package-name@version` (ex: `@djodjonx/neosyringe@0.1.2`).

## Publication avec Token (CI/CD)

Si vous souhaitez automatiser la publication via GitHub Actions :

1. Créez un token npm d'automatisation (Automation token) sur npmjs.com
2. Ajoutez-le comme secret `NPM_TOKEN` dans votre repo GitHub
3. Décommentez la ligne dans `.npmrc` et utilisez `${NPM_TOKEN}`

## Résolution des problèmes

### Erreur 2FA lors de la publication

Si vous obtenez une erreur 2FA :

1. Assurez-vous d'être connecté : `npm whoami`
2. Si déconnecté, reconnectez-vous : `npm login`
3. Vérifiez que votre 2FA fonctionne sur npmjs.com
4. Relancez `pnpm release`

### Les versions ne sont pas remplacées

Les dépendances `workspace:*` sont **automatiquement remplacées** par les versions réelles lors de `changeset publish`. Vous n'avez rien à faire manuellement.

### Annuler une publication

Si vous avez publié par erreur :

```bash
npm unpublish @djodjonx/package-name@version
```

**Attention** : Vous avez seulement 72h pour unpublish un package.

## Distribution npm et manifeste de tokens (T15)

### Matrice de support

Vérifié sur ce dépôt :

- Le lockfile ne contient que `typescript@5.9.3` (`pnpm-lock.yaml:4259`, importeur `packages/core` `pnpm-lock.yaml:86`). `scripts/ci/consumer-dist.mjs` lit cette version et typecheck avec le `tsc` du consommateur.
- esbuild 0.27.2 et rollup 4.55.2 viennent de l'importeur `packages/unplugin` (`pnpm-lock.yaml:151-155`). Le script les installe depuis le registre et les charge depuis le `node_modules` du consommateur.
- Le job CI `test` déclare Node 20 et Node 22 (`.github/workflows/ci.yml:15`).
- Les jobs `e2e`, `consumer-types` et `distribution` déclarent Node 22 seulement (`.github/workflows/ci.yml:67`, `.github/workflows/ci.yml:83`, `.github/workflows/ci.yml:102`).
- `@djodjonx/neosyringe` a `"sideEffects": false` (`packages/neosyringe/package.json:6`). L'audit des fichiers publiés (`tests/ci/side-effects-audit.test.ts:74-87`) parcourt `dist` en entier. Il refuse un énoncé exécutable au sommet d'un `.mjs` et d'un `.cjs`. Un `require(...)`, un `exports.x =` et un `Object.defineProperty(exports, ...)` sont le patron CJS, pas un effet. Le bundle consommateur (esbuild, et rollup via `sideEffects` lu dans `scripts/ci/consumer-dist.mjs:435-442`) laisse tomber un import inutilisé, garde un fichier listé, et laisse tomber un fichier à effet non listé.
- `@djodjonx/neosyringe-plugin` n'a pas de champ `sideEffects`. `createUnplugin` s'exécute à l'import (`packages/unplugin/src/index.ts:57`). L'audit refuse `sideEffects: false` sur ce paquet.
- `@djodjonx/neosyringe-ui` n'a pas de champ `sideEffects` (`packages/ui/package.json:1-14`).
- `@djodjonx/neosyringe-lsp` n'annonce que `require` (`packages/lsp/package.json:9-13`). Il n'y a pas de condition `import`.
- Bundle runtime mesuré le 2026-11-01 : esbuild 232 octets, rollup 1374 octets. Le plafond est 3072 (`scripts/ci/consumer-dist.mjs:36-38`). On ne le relève pas. Le bundle ne contient pas `typescript`, `ts.createProgram`, `ScriptTarget`, `@djodjonx/neosyringe-ui` ni `buildStandaloneHtml`.

Déclaré seulement, non vérifié sur d'autres versions :

- Le pair `typescript` est `>=5.0.0` (`packages/core/package.json:35`, `packages/unplugin/package.json:40`, `packages/cli/package.json:25`, `packages/lsp/package.json:29`).
- Aucun paquet publié ne déclare `engines.node`. L'extension VS Code déclare `engines.vscode` (`packages/vscode-extension/package.json:11-13`).
- Cette machine a exécuté le contrôle avec Node v24.7.0. La CI déclare 20 et 22. Node 24 n'est pas une promesse de support.

### Protocole du manifeste, version 1

Le manifeste est généré. On ne l'édite pas à la main (`packages/core/src/analyzer/shared/tokensManifest.ts:7`).

Le `package.json` du producteur pointe le fichier avec `neosyringe.tokensManifest` (`packages/core/src/analyzer/shared/tokensManifest.ts:215-218`).

Champs du fichier : `schemaVersion` (nombre, la valeur du protocole est 1), `packageName`, `contractVersion`, `tokens` (`packages/core/src/analyzer/shared/tokensManifest.ts:23-28`).

Chaque token : `exportPath`, `exportName`, `runtimeKey`, `descriptor`, et `typeExport` optionnel `{exportPath, exportName}` (`packages/core/src/analyzer/shared/tokensManifest.ts:15-21`).

`contractVersion` est une valeur explicite. Ce n'est pas la version du `package.json` (`packages/core/src/generator/tokensManifest.ts:19-20`, `packages/core/src/generator/tokensManifest.ts:258`). Le CLI la demande avec `--contract-version` (`packages/cli/src/report.ts:42-43`, `packages/cli/src/tokensManifest.ts:34-36`).

`exportPath` est le chemin du `.d.ts` émis : `declarationDir` s'il existe, sinon `outDir`, à partir de `rootDir` (`packages/core/src/generator/tokensManifest.ts:31-47`). Le descripteur et la `runtimeKey` utilisent le dossier du tsconfig, le même que le build (`packages/cli/src/tokensManifest.ts:47`, `packages/core/src/generator/tokensManifest.ts:253-254`). `exportPath` reste relatif à la racine du paquet.

L'émission de déclarations est par fichier. Après le calcul, chaque `exportPath` doit exister sur le disque et exporter le nom (`packages/core/src/generator/tokensManifest.ts:23-24`, `packages/core/src/generator/tokensManifest.ts:150-161`). Un `.d.ts` regroupé n'est pas accepté. Lancez l'étape du manifeste après l'émission des déclarations. `export { X }` et `export { X as Y }` sont listés. `export default` et un token tenu dans un objet exporté échouent avec un message nommé (`packages/core/src/generator/tokensManifest.ts:219`, `packages/core/src/generator/tokensManifest.ts:221`).

La commande, sur le binaire installé, est `neosyringe-check --project <tsconfig> --tokens-manifest <fichier> --contract-version <valeur>`. Le CLI importe `resolveProjectConfig` depuis `@djodjonx/neosyringe-core/analyzer` et `writeTokensManifest` depuis `@djodjonx/neosyringe-core/generator` (`packages/cli/src/tokensManifest.ts:4-5`). Ces symboles sont exportés (`packages/core/src/analyzer/index.ts:2`, `packages/core/src/generator/index.ts:2`).

### Ce qu'un consommateur peut résoudre

Route du type : `useInterface<T>()` quand `T` est un type exporté, non générique, listé dans `typeExport` (`packages/core/src/analyzer/shared/tokensManifest.ts:358-379`).

Route du symbole : un `export const` est relié par `(exportPath, exportName)` et réutilise `runtimeKey` (`packages/core/src/analyzer/shared/tokensManifest.ts:381-408`). Un token spécialisé listé, comme `Repo<User>`, passe par cette route.

Refus, avant une mauvaise résolution, code `NEO_TOKEN_BOUNDARY_UNSUPPORTED` (`packages/core/src/analyzer/errors/NeoTokenError.ts:8`) : manifeste absent, `schemaVersion` autre que 1, `runtimeKey` contradictoire, token non listé, `contractVersion` différente (`packages/core/src/analyzer/shared/tokensManifest.ts:41-46`, `packages/core/src/analyzer/shared/TokenResolverService.ts:440-466`).

Le message garde le code et le motif, puis le nom du paquet, le sujet, et le remède : publier le token avec `neosyringe-check --tokens-manifest <file> --contract-version <v>` et le référencer dans `package.json` `neosyringe.tokensManifest` (`packages/core/src/analyzer/shared/tokensManifest.ts:54-68`).

`Analyzer.extractAllErrors()` remonte ce diagnostic. Un paquet qui n'est pas un producteur, et dont le `package.json` n'a pas le champ `neosyringe.tokensManifest`, garde l'origine `pkg/` (`packages/core/src/analyzer/shared/tokensManifest.ts:329-336`). Un producteur (`dependencies` ou `peerDependencies` sur `@djodjonx/neosyringe`, pas `devDependencies`) sans ce champ, ou un const `useInterface` (`InterfaceToken`) sans ce champ, est refusé `manifest-absent` (`packages/core/src/analyzer/shared/tokensManifest.ts:293-298`, `packages/core/src/analyzer/shared/tokensManifest.ts:329-334`). Si le champ est présent, les refus de schéma, de clé, de liste et de contrat restent.

La lecture du manifeste est mise en cache sur l'instance de `TokenResolverService`, pas en global. Un échec y reste aussi, jusqu'au programme suivant (`packages/core/src/analyzer/shared/TokenResolverService.ts:43`, `packages/core/src/analyzer/shared/tokensManifest.ts:176-199`).

Une spécialisation générique demandée par le type, et non par le symbole exporté, est refusée (`packages/core/src/analyzer/shared/tokensManifest.ts:351`, `packages/core/src/analyzer/shared/tokensManifest.ts:371`).

Deux copies avec le même nom de paquet, la même `contractVersion` et le même descriptor partagent la clé. Une autre `contractVersion` est refusée (`packages/core/src/analyzer/shared/TokenResolverService.ts:444-449`). La même `runtimeKey` réclamée par un autre paquet, ou par une déclaration locale, est `NEO_TOKEN_COLLISION` et nomme les deux propriétaires (`packages/core/src/analyzer/shared/TokenResolverService.ts:40-41`, `packages/core/src/analyzer/shared/TokenResolverService.ts:458-463`). Le format de la clé du producteur ne change pas.

### Migration : plus d'export racine pour core

`@djodjonx/neosyringe-core` n'a plus `main`, `module`, `types`, ni l'export `"."`. Les exports commencent à `./analyzer` (`packages/core/package.json:7-8`).

tsdown n'émet pas de fichier racine (`packages/core/tsdown.config.ts:4-8`). Il n'existe pas de `packages/core/src/index.ts`.

Cet export racine n'a jamais résolu : les fichiers `dist/index.*` n'étaient pas produits. Importez un sous-chemin (`./analyzer`, `./generator` ou `./context`).

L'ancienne liste d'exception de `check-dist` est supprimée (`tests/ci/check-dist.test.ts:21`).

Un paquet tiers sans champ `neosyringe.tokensManifest` se résout encore avec l'origine `pkg/`. Seul un producteur sans manifeste, ou un paquet dont le manifeste est illisible ou contradictoire, est refusé. Deux propriétaires pour la même clé runtime (`NEO_TOKEN_COLLISION`) ne partagent plus un fournisseur en silence (`packages/core/src/analyzer/shared/TokenResolverService.ts:72-80`).

### Contrôle du paquet installé

`scripts/ci/consumer-dist.mjs` ne lance pas de build. Il exige un `dist` déjà construit (`scripts/ci/consumer-dist.mjs:3`).

Il emballe les paquets non privés. Il installe ces archives, plus `typescript`, `esbuild` et `rollup` aux versions du lockfile, avec `npm install` (`--prefer-offline`, puis un second essai sans ce drapeau). Il n'utilise pas le magasin pnpm du dépôt. `tsc`, esbuild et rollup viennent du `node_modules` du consommateur.

Il lance le binaire `neosyringe-check` à travers le lien symbolique `node_modules/.bin`. L'entrée compare les chemins réels, donc le lien exécute `main` (`packages/cli/src/index.ts:143-159`). Si `realpath` échoue, les chemins bruts sont comparés (`packages/cli/src/index.ts:147`).

Il rejoue un producteur : compilation des déclarations, manifeste écrit par le CLI installé, archive installée, clé lue par l'analyseur installé, puis la même clé après déplacement du dossier.

Le job `distribution` le lance après `check-dist` (`.github/workflows/ci.yml:110-111`).

