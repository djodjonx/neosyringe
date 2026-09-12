# Graph Visualization

Visualize your dependency injection graph across three surfaces: a standalone HTML export from the CLI, a live browser panel in your Vite dev-server, and a VSCode WebView extension.

## CLI — Static HTML Export

Generate a self-contained HTML page from the command line:

```bash
neosyringe-check --graph                    # writes neosyringe-graph.html
neosyringe-check --graph out/graph.html     # custom output path
```

Open the file in any browser. The diagram is rendered with [Mermaid](https://mermaid.js.org/) — no server required, no external dependencies beyond the CDN script.

### Node colors

| Color | Meaning |
|-------|---------|
| 🟢 Green | Singleton service |
| 🔵 Blue | Transient service |
| 🟠 Orange | Factory registration |
| ⚫ Grey | Value registration |

Solid arrows = required dependency. Dashed arrows = optional dependency.

### Raw Mermaid output

```bash
neosyringe-check --mermaid
```

Prints Mermaid flowchart syntax to stdout — useful for embedding in Markdown docs or feeding into other tools.

---

## Vite Devtools — Live Browser Panel

When using the Vite build plugin, enable the devtools middleware to get a live graph in your browser alongside your app:

### Setup

```typescript
// vite.config.ts
import { neoSyringePlugin } from '@djodjonx/neosyringe-plugin'

export default defineConfig({
  plugins: [
    neoSyringePlugin.vite({ devtools: true })
  ]
})
```

Then open **`http://localhost:5173/__neosyringe/`** while the dev-server is running.

::: info Development only
The `devtools` option has no effect in production builds (`NODE_ENV=production`). It is safe to leave enabled in your config — it only activates the middleware during `vite dev`.
:::

### Available routes

| Route | Returns |
|-------|---------|
| `/__neosyringe/` | Interactive HTML visualization |
| `/__neosyringe/data.json` | Raw `SerializableGraph[]` JSON |

### HMR support

The graph updates automatically when you save a container file. Each file's graph is stored separately and replaced on re-transform, so you always see the current state without stale entries.

---

## VSCode Extension

The VSCode extension provides a persistent WebView panel that shows your dependency graph and auto-refreshes on every file save.

### Installation

Install the `.vsix` file from the repository:

```bash
code --install-extension packages/vscode-extension/neosyringe-vscode-0.1.0.vsix
```

Or build from source:

```bash
cd packages/vscode-extension
node esbuild.mjs
npx @vscode/vsce package --no-dependencies
code --install-extension neosyringe-vscode-0.1.0.vsix
```

### Usage

**Via Command Palette:**

1. Open Command Palette (`Cmd+Shift+P` / `Ctrl+Shift+P`)
2. Run: **`NeoSyringe: Show Dependency Graph`**

**Via CodeLens:**

A `$(type-hierarchy) Show Dependency Graph` lens appears above every `defineBuilderConfig` call in your code. Click it to open the panel.

### Behavior

- The panel opens to the side of your current editor (`ViewColumn.Beside`)
- On every **file save**, the analyzer re-runs and the panel refreshes
- If no `defineBuilderConfig` is found in the workspace, a "No containers found" message is shown
- Analysis errors (e.g. invalid `tsconfig.json`) display an error page inside the panel instead of crashing

### Requirements

- VSCode `^1.85.0`
- A `tsconfig.json` in the workspace root

---

## Shared renderer

All three surfaces use the same `@djodjonx/neosyringe-ui` package internally:

```
@djodjonx/neosyringe-ui
  ├── serializeGraph()       strips AST references → JSON-serializable graph
  ├── graphToMermaid()       SerializableGraph → Mermaid flowchart syntax
  └── buildStandaloneHtml()  wraps diagrams in a self-contained HTML page
```

This means the visual output is identical whether you use the CLI, the Vite devtools, or the VSCode extension.
