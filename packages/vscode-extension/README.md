# NeoSyringe — VSCode Extension

Visualize your [NeoSyringe](https://github.com/djodjonx/neosyringe) dependency injection graph directly in VSCode.

## Features

- **Interactive graph panel** — opens beside your editor with a Mermaid diagram of all your DI containers
- **CodeLens** — a _Show Dependency Graph_ lens appears above every `defineBuilderConfig` call
- **Auto-refresh** — the graph updates automatically on every file save
- **Color-coded nodes** — singletons in green, transient in blue, factories in orange, values in grey
- **Optional dependencies** — shown as dashed arrows

## Usage

### Command Palette

1. Open Command Palette (`Cmd+Shift+P` / `Ctrl+Shift+P`)
2. Run **NeoSyringe: Show Dependency Graph**

### CodeLens

Click the `$(type-hierarchy) Show Dependency Graph` lens that appears above any `defineBuilderConfig` call in your code.

## Requirements

- VSCode `^1.85.0`
- A `tsconfig.json` in the workspace root
- A NeoSyringe project with at least one `defineBuilderConfig` call

## Installation

### From Open VSX (recommended)

Search **NeoSyringe** in the Extensions panel, or download the `.vsix` from [GitHub Releases](https://github.com/djodjonx/neosyringe/releases) and install via:

```
Extensions → ··· → Install from VSIX...
```

### From command line

```bash
curl -L "https://open-vsx.org/api/djodjonx/neosyringe-vscode/latest/file/djodjonx.neosyringe-vscode-latest.vsix" \
  -o neosyringe-vscode.vsix
code --install-extension neosyringe-vscode.vsix
```

## Related

- [NeoSyringe](https://www.npmjs.com/package/@djodjonx/neosyringe) — the DI library
- [CLI Validator](https://www.npmjs.com/package/@djodjonx/neosyringe-cli) — `neosyringe-check --graph`
- [Vite Plugin](https://www.npmjs.com/package/@djodjonx/neosyringe-plugin) — `devtools: true` for browser devtools
