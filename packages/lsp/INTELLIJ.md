# IntelliJ IDEA / WebStorm Setup

## ⚠️ Limitation Connue : Pas de Surlignage des Erreurs

**Les erreurs NeoSyringe ne sont pas surlignées dans l'éditeur IntelliJ/WebStorm.**

Cela est dû à l'architecture de JetBrains qui utilise son propre moteur PSI (Program Structure Interface) pour afficher les erreurs, et non les diagnostics du tsserver.

> 📄 Voir `INTELLIJ-DEBUG-REPORT.md` pour l'analyse technique complète.

---

## Ce qui Fonctionne ✅

### 1. Tooltips Enrichis

Quand vous survolez un symbole près d'une erreur NeoSyringe, le tooltip affiche l'avertissement :

```typescript
export const appContainer = defineBuilderConfig({
  injections: [
    { token: useInterface<IUserRepository>(), provider: ... },
    { token: useInterface<IUserRepository>(), provider: ... },
         ▲
         └── Survolez ici pour voir :
             "⚠️ [NeoSyringe] Duplicate registration: 'useInterface<IUserRepository>()' is already registered."
  ]
});
```

### 2. Analyse en Arrière-Plan

Le plugin détecte les erreurs dans les fichiers contenant `defineBuilderConfig` ou `definePartialConfig`. Les erreurs sont loggées dans les logs du serveur TypeScript.

---

## Ce qui ne Fonctionne Pas ❌

- ❌ Surlignage des erreurs dans la marge de l'éditeur
- ❌ Erreurs dans le panneau "Problems"
- ❌ Lignes ondulées rouges sous le code erroné

---

## Alternatives Recommandées

### 1. Utiliser VS Code (Recommandé)

VS Code supporte pleinement les plugins TypeScript Language Service. Les erreurs NeoSyringe s'affichent comme les erreurs TypeScript natives.

### 2. Utiliser le CLI NeoSyringe

```bash
# Vérification ponctuelle
npx neosyringe check

# Mode watch (avec nodemon)
npx nodemon --exec "npx neosyringe check" --watch "src/**/*.ts"
```

### 3. Intégration CI/CD

Ajoutez la vérification dans votre pipeline :

```yaml
# GitHub Actions
- name: NeoSyringe Check
  run: npx neosyringe check --strict
```

### 4. Script npm

```json
{
  "scripts": {
    "di:check": "neosyringe check",
    "di:watch": "nodemon --exec 'npm run di:check' --watch 'src/**/*.ts'"
  }
}
```

---

## Configuration Requise dans IntelliJ

Même si le surlignage ne fonctionne pas, assurez-vous que ces options sont activées pour le support de base :

1. **Settings > Languages & Frameworks > TypeScript**
   - ✅ Enable TypeScript language service
   - ✅ Enable service-powered type engine
   - ✅ Show project errors

2. **TypeScript version** : Pointez vers le TypeScript du projet, pas "Bundled"

---

## Débogage

Pour activer les logs détaillés du serveur TypeScript :

```bash
export TSS_LOG="-level verbose -file /path/to/project/.log-debug"
open -a "IntelliJ IDEA.app"
```

Cherchez ensuite dans les logs :
- `[NeoSyringe INFO]` - Logs de notre plugin
- `[INTELLIJ-GETPROGRAM]` - Détection des erreurs
- `[INTELLIJ-HOOK]` - Enrichissement des tooltips

---

## Pourquoi ça ne Fonctionne Pas ?

IntelliJ utilise une architecture hybride :

1. **Moteur PSI** (Java) : Analyse le code et affiche les erreurs visuelles
2. **tsserver** (Node.js) : Fournit les types et l'autocomplétion

Les plugins TypeScript comme NeoSyringe ne peuvent enrichir que le tsserver, pas le moteur PSI. C'est pourquoi les tooltips fonctionnent (via `quickinfo`) mais pas le surlignage (via PSI).

Pour afficher des erreurs personnalisées dans la marge, il faudrait créer un **plugin IntelliJ natif en Java/Kotlin**.

---

## Rapport de Bug JetBrains

Si vous souhaitez que JetBrains améliore le support des plugins TypeScript, vous pouvez voter ou créer un ticket sur :
https://youtrack.jetbrains.com/issues/WEB

Demandez le support des diagnostics personnalisés via `getSemanticDiagnostics()` pour les plugins TypeScript.

---

## Ressources

- `INTELLIJ-DEBUG-REPORT.md` - Rapport technique complet de débogage
- [TypeScript Language Service Plugin API](https://github.com/microsoft/TypeScript/wiki/Writing-a-Language-Service-Plugin)
- [JetBrains YouTrack](https://youtrack.jetbrains.com/issues/WEB)

## Alternatives Recommandées

### Option 1 : Utiliser VS Code (Recommandé)

VS Code utilise nativement le TypeScript Language Service et tous les plugins fonctionnent parfaitement :

```bash
code examples/nuxt
```

Les erreurs NeoSyringe apparaîtront directement dans l'éditeur.

### Option 2 : Utiliser le CLI NeoSyringe

Exécutez la validation en ligne de commande :

```bash
# Vérification unique
npx neosyringe check

# Mode watch (vérification continue)
npx neosyringe check --watch
```

### Option 3 : Intégration CI/CD

Ajoutez la vérification dans votre pipeline pour capturer les erreurs avant le merge :

```yaml
# .github/workflows/ci.yml
- name: Check NeoSyringe DI configuration
  run: npx neosyringe check --fail-on-error
```

### Option 4 : Script de Watch Externe

Créez un script qui surveille les changements et affiche les erreurs :

```bash
# watch-neosyringe.sh
npx nodemon --watch 'src/**/*.ts' --exec 'npx neosyringe check'
```

---

## Détails Techniques

### Pourquoi ça ne fonctionne pas ?

1. **Architecture d'IntelliJ** : IntelliJ utilise son propre moteur PSI (Program Structure Interface) pour l'analyse statique, pas le tsserver.

2. **Commandes propriétaires** : IntelliJ envoie des commandes comme `ideGetElementType` et `ideGetTypeProperty` au lieu de `getSemanticDiagnostics`.

3. **Plugin tsc-ide-plugin** : IntelliJ injecte son propre plugin (`tsc-ide-plugin`) qui intercepte toutes les requêtes et bypass les plugins utilisateur.

4. **IdeProjectService** : Ce composant vérifie si le fichier appartient au graphe d'importation du projet. Si non, il génère une `FileOutsideOfImportGraphException` et bloque la requête.

5. **JSLanguageServiceQueue** : Cette file d'attente priorise les requêtes interactives (autocomplétion, navigation) sur les diagnostics pour préserver la réactivité UI.

6. **Substitution Synchrone** : IntelliJ peut utiliser `getSemanticDiagnosticsSync` au lieu de la version asynchrone standard, ce qui peut bypasser les hooks des plugins.

### Architecture du pont tsc-ide-plugin

```
┌─────────────────┐      ┌──────────────────┐      ┌─────────────────┐
│  IntelliJ IDE   │ IPC  │  tsc-ide-plugin  │      │    tsserver     │
│  (Java/Kotlin)  │◄────►│  (JavaScript)    │◄────►│  (TypeScript)   │
└─────────────────┘      └──────────────────┘      └─────────────────┘
         │                        │                        │
         │                        ▼                        │
         │               ┌──────────────────┐              │
         │               │ IdeProjectService │              │
         │               │ (Validation)      │              │
         │               └──────────────────┘              │
         │                        │                        │
         │                        ▼                        │
         │               ┌──────────────────┐              │
         │               │ Commandes ide*   │              │
         │               │ (propriétaires)  │              │
         │               └──────────────────┘              │
         │                                                 │
         └─────── Les plugins TS standards sont ───────────┘
                       ignorés pour les diagnostics
```

### Logs de référence

Quand vous activez les logs TSS_LOG, vous verrez :
- `[NeoSyringe INFO] !!! NEOSYRINGE LSP ACTIVATED (Proxy Mode) !!!` ✅ Plugin chargé
- Aucun appel à `getSemanticDiagnostics` ❌ IntelliJ n'utilise pas cette méthode

---

## Vérification que le Plugin est Chargé

Pour vérifier que le plugin est bien chargé (même s'il ne peut pas afficher les diagnostics) :

```bash
# 1. Fermez IntelliJ
# 2. Lancez depuis le terminal avec TSS_LOG
export TSS_LOG="-level verbose -file /tmp/tsserver.log"
open -a "IntelliJ IDEA.app"

# 3. Dans un autre terminal
grep "NEOSYRINGE LSP ACTIVATED" /tmp/tsserver.log
```

---

## Configuration du Plugin (pour référence)

Même si les diagnostics ne s'affichent pas dans IntelliJ, le plugin est correctement chargé. La configuration reste :

```json
// tsconfig.json
{
  "compilerOptions": {
    "plugins": [
      { "name": "@djodjonx/neosyringe-lsp" }
    ]
  }
}
```

Le plugin fonctionnera correctement dans VS Code, et vous pouvez utiliser le CLI pour IntelliJ.

---

## Rapport de Bug JetBrains

Si vous souhaitez que JetBrains améliore le support des plugins TypeScript, vous pouvez voter ou créer un ticket sur :
https://youtrack.jetbrains.com/issues/WEB

Demandez le support des diagnostics personnalisés via `getSemanticDiagnostics()` pour les plugins TypeScript.

---

## Perspectives Futures : TypeScript Native (tsgo)

JetBrains travaille sur l'intégration de **TypeScript Native Previews** basé sur `tsgo` (TypeScript compilé en Go). Cette nouvelle architecture, disponible en préversion dans IntelliJ 2025.2+, pourrait simplifier l'intégration des plugins en éliminant les couches JavaScript intermédiaires.

Cependant, à l'heure actuelle (février 2026), le "Service-Powered Type Engine" est temporairement désactivé avec tsgo jusqu'à la version finale de TS7.

---

## Voir aussi

- [DEBUGGING.md](./DEBUGGING.md) - Guide de débogage complet
- [README.md](./README.md) - Documentation principale du plugin LSP

