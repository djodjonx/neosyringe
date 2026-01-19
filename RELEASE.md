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
