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
pnpm version
```

Cette commande :
- Applique les changesets
- Met à jour les versions dans les `package.json`
- Met à jour les CHANGELOGs
- Met à jour `pnpm-lock.yaml`

### 3. Commit et push

```bash
git add .
git commit -m "chore: version packages"
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
- **Vous demandera votre code 2FA de npm pendant la publication**

**Important** : `changeset publish` gère automatiquement le 2FA de manière interactive. Il vous demandera votre code OTP pendant la publication de chaque package.

### 5. Créer un tag git et push

```bash
git push --follow-tags
```

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
