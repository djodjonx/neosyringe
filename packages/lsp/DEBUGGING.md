# Débogage du Plugin LSP NeoSyringe dans IntelliJ/WebStorm

Le plugin s'exécute à l'intérieur du processus `tsserver` (TypeScript Language Service) géré par votre IDE. Voici toutes les méthodes pour débugger.

---

## Méthode 1 : Logs intégrés IntelliJ (Le plus simple)

IntelliJ a son propre système de logs pour le TypeScript Service.

### Activer les logs TypeScript dans IntelliJ

1. Allez dans **Help** → **Diagnostic Tools** → **Debug Log Settings...**
2. Ajoutez cette ligne :
   ```
   #com.intellij.lang.typescript
   ```
3. Cliquez **OK** et redémarrez l'IDE.
4. Les logs apparaîtront dans **Help** → **Show Log in Finder** (macOS) ou **Show Log in Explorer** (Windows).

### Trouver le fichier log

Le fichier `idea.log` se trouve généralement ici :
- **macOS** : `~/Library/Logs/JetBrains/IntelliJIdea2024.X/idea.log`
- **Windows** : `%APPDATA%\JetBrains\IntelliJIdea2024.X\log\idea.log`
- **Linux** : `~/.cache/JetBrains/IntelliJIdea2024.X/log/idea.log`

```bash
# macOS - Surveiller les logs en temps réel
tail -f ~/Library/Logs/JetBrains/IntelliJIdea*/idea.log | grep -i "neosyringe\|typescript\|plugin"
```

---

## Méthode 2 : Variable d'environnement TSS_LOG

Cette méthode force TypeScript Server à écrire ses propres logs.

### macOS

```bash
# Fermez IntelliJ d'abord, puis :
export TSS_LOG="-level verbose -file /tmp/tsserver.log"

# Lancez IntelliJ depuis le terminal
open -a "IntelliJ IDEA.app"
# ou pour WebStorm :
open -a "WebStorm.app"
# ou utilisez le script shell :
/Applications/IntelliJ\ IDEA.app/Contents/MacOS/idea
```

### Windows (PowerShell)

```powershell
$env:TSS_LOG="-level verbose -file C:\temp\tsserver.log"
& "C:\Program Files\JetBrains\IntelliJ IDEA 2024.X\bin\idea64.exe"
```

### Surveiller les logs

```bash
# Dans un autre terminal
tail -f /tmp/tsserver.log | grep "NeoSyringe"
```

---

## Méthode 3 : Console de développement IntelliJ

1. Appuyez sur `Cmd+Shift+A` (macOS) ou `Ctrl+Shift+A` (Windows/Linux)
2. Tapez **"Internal Actions"** et activez-le (si pas déjà fait)
3. Puis cherchez **"Show Log in Console"**

Cela affiche les logs directement dans l'IDE.

---

## Méthode 4 : Débogage avec Breakpoints (Avancé)

### Étape 1 : Activer le mode debug de tsserver

1. `Cmd+Shift+A` → tapez **"Registry..."**
2. Cherchez `typescript.service.node.arguments`
3. Ajoutez : `--inspect=9229`
4. Appliquez et fermez

### Étape 2 : Redémarrer le service TypeScript

- Cliquez sur la version TypeScript en bas à droite de l'IDE
- Sélectionnez **"Restart TypeScript Service"**

### Étape 3 : Attacher le debugger

**Option A - Via IntelliJ :**
1. **Run** → **Edit Configurations...** → **+** → **Attach to Node.js/Chrome**
2. Host: `localhost`, Port: `9229`
3. Lancez cette configuration

**Option B - Via Chrome DevTools :**
1. Ouvrez Chrome
2. Allez à `chrome://inspect`
3. Cliquez sur **"Open dedicated DevTools for Node"**
4. Le processus tsserver devrait apparaître

### Étape 4 : Ajouter des breakpoints

Ouvrez le fichier source du plugin et ajoutez des breakpoints :
- `packages/lsp/src/index.ts`
- `packages/core/src/analyzer/Analyzer.ts`

---

## Méthode 5 : Ajouter des logs temporaires dans le code

Si rien ne fonctionne, ajoutez des `console.log` dans le code du plugin :

```typescript
// Dans packages/lsp/src/index.ts
function create(info: ts.server.PluginCreateInfo) {
  // Ces logs iront dans idea.log
  info.project.projectService.logger.info(">>> NEOSYRINGE: Plugin loaded!");
  
  // ...
}
```

Puis rebuilder :
```bash
cd packages/lsp && pnpm build
```

---

## Méthode 6 : Vérifier que le plugin est chargé

### Vérifications préalables

1. **Vérifiez le tsconfig.json** du projet :
   ```json
   {
     "compilerOptions": {
       "plugins": [
         { "name": "@djodjonx/neosyringe-lsp" }
       ]
     }
   }
   ```

2. **Vérifiez que le package est installé** :
   ```bash
   ls node_modules/@djodjonx/neosyringe-lsp
   ```

3. **Vérifiez la version de TypeScript** :
   - Le plugin nécessite TypeScript >= 5.0
   - IntelliJ doit utiliser la version du projet (pas la version bundled)
   - Settings → Languages & Frameworks → TypeScript → **TypeScript package** doit pointer vers `node_modules/typescript`

4. **Redémarrez complètement l'IDE** (pas juste le service TS)

---

## Méthode 7 : Test isolé avec tsserver en CLI

Vous pouvez lancer tsserver manuellement pour tester :

```bash
cd /chemin/vers/votre/projet

# Lancer tsserver avec logs
TSS_LOG="-level verbose -file /tmp/tsserver.log" \
  node_modules/.bin/tsserver
```

Puis envoyez des commandes JSON via stdin pour tester le plugin.

---

## Résumé des commandes utiles

```bash
# Logs IntelliJ
tail -f ~/Library/Logs/JetBrains/IntelliJIdea*/idea.log | grep -i typescript

# Logs tsserver
tail -f /tmp/tsserver.log | grep NeoSyringe

# Vérifier les processus tsserver
ps aux | grep tsserver

# Rebuilder le plugin après modification
cd packages/lsp && pnpm build
```

---

## Problèmes courants

| Symptôme | Solution |
|----------|----------|
| Plugin non chargé | Vérifier `tsconfig.json` et `node_modules` |
| Pas de logs | Activer `TSS_LOG` ou les logs IntelliJ |
| Erreurs silencieuses | Regarder `idea.log` pour les exceptions Java |
| IntelliJ Community | Non supporté, utiliser Ultimate ou WebStorm |

