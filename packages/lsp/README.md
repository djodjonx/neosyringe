# @djodjonx/neosyringe-lsp

TypeScript Language Service Plugin for NeoSyringe. Provides the same analysis as the build in your IDE, on each TypeScript program update. No latency is promised.

Each diagnostic carries the stable `NEO_*` code in its message, and the dependency chain and the targeted fix as related information (`Dependency chain: A -> B`, `Fix: ...`), the same lines the CLI prints. Whether an editor shows related information is up to the editor.

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
