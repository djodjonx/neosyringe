# @djodjonx/neosyringe-lsp

TypeScript Language Service Plugin for NeoSyringe. Provides real-time error detection in your IDE.

## Setup

Add to `tsconfig.json`:

```json
{
  "compilerOptions": {
    "plugins": [{ "name": "@djodjonx/neosyringe-lsp" }]
  }
}
```

## IDE Configuration

### VS Code ✅
Works automatically. Select "Use Workspace Version" for TypeScript.

### IntelliJ IDEA / WebStorm ⚠️
**Requires manual activation:**
1. Settings → Languages & Frameworks → TypeScript
2. Check "TypeScript Language Service"
3. Restart TypeScript Service

⚠️ IntelliJ Community Edition NOT supported.

**See [INTELLIJ.md](./INTELLIJ.md) for details.**

## Documentation

See [IDE Plugin Guide](https://djodjonx.github.io/neosyringe/guide/ide-plugin).
