# Rapport de Débogage : Plugin NeoSyringe LSP sur IntelliJ

**Date** : 11 février 2026  
**Statut** : Partiellement fonctionnel - Tooltips OK, Surlignage KO

---

## 1. Résumé du Problème

Le plugin NeoSyringe LSP fonctionne parfaitement sur **VS Code** mais les erreurs ne sont **pas surlignées dans l'éditeur** sur **IntelliJ IDEA / WebStorm**, bien que :
- ✅ Le plugin soit correctement chargé
- ✅ Les erreurs soient détectées
- ✅ Les tooltips enrichis s'affichent au survol
- ✅ Les événements `semanticDiag` soient envoyés

---

## 2. Architecture JetBrains Découverte

### 2.1 Le Plugin `tsc-ide-plugin`

IntelliJ injecte un plugin global `tsc-ide-plugin` situé dans :
```
/Applications/IntelliJ IDEA.app/Contents/plugins/javascript-plugin/jsLanguageServicesImpl/typescript/node_modules/tsc-ide-plugin/
```

**Fichiers clés :**
- `index.js` - Point d'entrée, décore le LanguageService
- `ide-commands.js` - Enregistre les commandes propriétaires `ide*`
- `ide-get-element-type.js` - Implémente `ideGetElementType`, `ideGetTypeProperty`, etc.
- `ide-project-service.js` - Gère le graphe d'importation des projets

### 2.2 Commandes Propriétaires

IntelliJ n'utilise **PAS** les commandes standard du protocole tsserver (`geterr`, `semanticDiagnosticsSync`). Il utilise des commandes propriétaires :

| Commande | Fréquence | Description |
|----------|-----------|-------------|
| `ideGetElementType` | ~50+ appels | Obtenir le type d'un symbole |
| `ideGetTypeProperty` | ~15+ appels | Obtenir les propriétés d'un type |
| `ideGetCompletionSymbols` | Variable | Autocomplétion |
| `quickinfo` | Rare | Tooltip (appelle `getQuickInfoAtPosition`) |

### 2.3 Flux de Diagnostic dans IntelliJ

```
┌─────────────────────┐
│  IntelliJ IDE       │
│  (Moteur PSI Java)  │  ◄── Affiche les erreurs via PSI, PAS via tsserver
└─────────┬───────────┘
          │
          │ Commandes ide* (JSON-RPC)
          ▼
┌─────────────────────┐
│   tsc-ide-plugin    │  ◄── Intercepte les commandes, décore le LanguageService
└─────────┬───────────┘
          │
          ▼
┌─────────────────────┐
│  Notre Plugin       │  ◄── Décoration en place du LanguageService
│  @neosyringe-lsp    │
└─────────┬───────────┘
          │
          ▼
┌─────────────────────┐
│     tsserver        │
│  (TypeScript LS)    │
└─────────────────────┘
```

**Point clé** : IntelliJ utilise son propre moteur **PSI** (Program Structure Interface) pour afficher les erreurs dans l'éditeur, pas les diagnostics du tsserver.

---

## 3. Solutions Tentées

### 3.1 Proxy sur le LanguageService ❌

**Approche** : Retourner un `Proxy` qui wrappe `info.languageService`

**Problème** : `tsc-ide-plugin` utilise `info.languageService` directement et retourne cette référence, ignorant notre proxy :
```javascript
// Dans tsc-ide-plugin/index.js
info.languageService.ideProjectId = info.project.ideProjectId;
(0, get_element_type_ts_server_1.decorateLanguageService)(info.languageService);
return info.languageService; // ← Ignore notre proxy
```

### 3.2 Décoration en Place du LanguageService ✅ (Partiel)

**Approche** : Modifier `info.languageService` en place plutôt que retourner un proxy

```typescript
// Au lieu de:
const proxy = new Proxy(info.languageService, {...});
return proxy;

// On fait:
info.languageService.getSemanticDiagnostics = function(fileName) {...};
return info.languageService;
```

**Résultat** : 
- ✅ `getQuickInfoAtPosition` est intercepté (tooltips enrichis)
- ✅ `getProgram` est intercepté (analyse en arrière-plan)
- ❌ `getSemanticDiagnostics` n'est JAMAIS appelé par IntelliJ

### 3.3 Enregistrement de Protocol Handlers ❌

**Approche** : Enregistrer des handlers pour `semanticDiagnosticsSync`, `geterr`, etc.

**Problème** : Les handlers sont déjà enregistrés par TypeScript lui-même :
```
[INTELLIJ] Could not register handler for semanticDiagnosticsSync: Protocol handler already exists
[INTELLIJ] Could not register handler for geterr: Protocol handler already exists
```

### 3.4 Envoi d'Événements `semanticDiag` ✅ (Envoyés mais ignorés)

**Approche** : Utiliser `session.event()` pour envoyer des diagnostics proactivement

```typescript
(session as any).event({
  file: fileName,
  diagnostics: formattedDiagnostics
}, 'semanticDiag');
```

**Résultat** : L'événement est correctement formaté et envoyé :
```json
{
  "type": "event",
  "event": "semanticDiag",
  "body": {
    "file": "/path/to/container.ts",
    "diagnostics": [{
      "start": { "line": 55, "offset": 7 },
      "end": { "line": 55, "offset": 45 },
      "text": "[NeoSyringe] Duplicate registration...",
      "code": 9998,
      "category": "error"
    }]
  }
}
```

**Problème** : IntelliJ **ignore** cet événement car il n'a pas initié de demande `geterr`.

### 3.5 Interception de `getProgram` ✅

**Approche** : Intercepter `getProgram()` car c'est appelé par toutes les commandes `ide*`

**Résultat** : L'analyse est déclenchée et les erreurs sont détectées :
```
[INTELLIJ-GETPROGRAM] Found 1 NeoSyringe error(s) in /path/to/container.ts
```

---

## 4. Ce qui Fonctionne

| Fonctionnalité | VS Code | IntelliJ |
|----------------|:-------:|:--------:|
| Plugin chargé | ✅ | ✅ |
| Analyse des fichiers | ✅ | ✅ |
| Détection des erreurs | ✅ | ✅ |
| Logs de diagnostic | ✅ | ✅ |
| Événements `semanticDiag` | ✅ | ✅ (envoyés) |
| **Tooltip enrichi** | ✅ | ✅ |
| **Surlignage dans l'éditeur** | ✅ | ❌ |
| **Panneau Problems** | ✅ | ❌ |

---

## 5. Cause Racine

**IntelliJ n'utilise PAS `getSemanticDiagnostics` pour afficher les erreurs dans l'éditeur.**

Il utilise son propre moteur **PSI** (Program Structure Interface) écrit en Java pour :
- Parser le code TypeScript
- Analyser les types
- Afficher les erreurs dans la marge

Le tsserver est utilisé uniquement pour :
- Obtenir des informations de type (`ideGetElementType`)
- Autocomplétion
- Tooltips (`quickinfo`)

---

## 6. Logs de Référence

### Activation du Plugin
```
Info 109  [21:17:32.759] [NeoSyringe INFO] [INTELLIJ] Session detection: found (IntelliJ/WebStorm)
Info 110  [21:17:32.759] [NeoSyringe INFO] !!! NEOSYRINGE LSP ACTIVATED (In-Place Decoration Mode) !!!
```

### Détection des Erreurs
```
Info 236  [21:20:27.510] [NeoSyringe INFO] === [NeoSyringe] Analysis of /path/to/container.ts ===
Info 236  [21:20:27.515] [NeoSyringe INFO] Extracted 1 config(s), 1 error(s)
Info 236  [21:20:27.524] [NeoSyringe INFO] [INTELLIJ-GETPROGRAM] Found 1 NeoSyringe error(s)
```

### Tooltip Enrichi
```
Info 1190 [21:17:35.231] [NeoSyringe INFO] [INTELLIJ-HOOK] Enriching tooltip with 1 warning(s)
"documentation": "⚠️ [NeoSyringe] Duplicate registration: 'useInterface<IUserRepository>()' is already registered."
```

### Événement Envoyé (mais ignoré)
```
Info 237  [21:20:27.524] event:
    {
      "event": "semanticDiag",
      "body": {
        "file": "/path/to/container.ts",
        "diagnostics": [{ "line": 55, "text": "[NeoSyringe] Duplicate registration..." }]
      }
    }
Info 238  [21:20:27.524] [NeoSyringe INFO] [INTELLIJ-EVENT] Sent semanticDiag event with 1 diagnostic(s)
```

---

## 7. Commandes pour Activer les Logs TSS_LOG

```bash
# Fermer IntelliJ
# Puis lancer avec les logs activés :
export TSS_LOG="-level verbose -file /Users/jonathan/projects/neo-syringe/examples/nuxt/.log-debug"
open -a "IntelliJ IDEA.app"
```

---

## 8. Fichiers Modifiés

### `packages/lsp/src/index.ts`

Modifications clés :
1. **Décoration en place** au lieu de Proxy
2. **Interception de `getProgram()`** pour déclencher l'analyse
3. **Enrichissement de `getQuickInfoAtPosition()`** pour les tooltips
4. **Envoi d'événements `semanticDiag`** via la session

### `packages/lsp/INTELLIJ.md`

Documentation mise à jour sur les limitations et alternatives.

---

## 9. Pistes à Explorer

### 9.1 Option "Show project errors" dans IntelliJ

Vérifier si cette option (Settings > Languages & Frameworks > TypeScript) déclenche l'appel à `geterr` ou `semanticDiagnosticsSync`.

### 9.2 Plugin IntelliJ Natif

Créer un plugin Java/Kotlin qui :
- Lit les diagnostics générés par notre plugin TS
- Les injecte dans le système PSI d'IntelliJ

### 9.3 External Annotator

IntelliJ a un système d'**External Annotators** qui permet d'ajouter des annotations externes. Un plugin natif pourrait utiliser cette API.

### 9.4 File Watcher + Fichier de Sortie

Notre plugin pourrait écrire les diagnostics dans un fichier JSON que IntelliJ pourrait lire via un plugin de surveillance.

### 9.5 Vérifier si Angular Language Service fonctionne

Angular a un plugin TS qui affiche des erreurs dans IntelliJ. Étudier comment ils font.

---

## 10. Conclusion

Le plugin NeoSyringe LSP fonctionne techniquement sur IntelliJ (les erreurs sont détectées et les événements sont envoyés), mais **IntelliJ ignore les diagnostics du tsserver** pour l'affichage dans l'éditeur car il utilise son propre moteur PSI.

**Solutions viables :**
1. ✅ **Utiliser VS Code** - Support complet
2. ✅ **Utiliser le CLI** - `npx neosyringe check`
3. ✅ **Tooltips** - Survoler les symboles pour voir les erreurs
4. 🔄 **Plugin IntelliJ natif** - À développer

---

## 11. Références

- Analyse technique fournie par l'utilisateur sur l'architecture JetBrains
- Code source de `tsc-ide-plugin` dans IntelliJ
- Logs TSS_LOG collectés pendant le débogage
- Documentation TypeScript Language Service Plugins

