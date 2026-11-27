# CLI Validator

Validate your dependency graph in CI/CD pipelines.

## Installation

Install the CLI package:

::: code-group

```bash [pnpm]
pnpm add -D @djodjonx/neosyringe-cli
```

```bash [npm]
npm install -D @djodjonx/neosyringe-cli
```

```bash [yarn]
yarn add -D @djodjonx/neosyringe-cli
```

:::

## Usage

Run in your project root (where `tsconfig.json` is located):

```bash
npx neosyringe-check
# or
pnpm exec neosyringe-check
```

### Options

```bash
neosyringe-check [options]

Options:
  -p, --project <path>   Path to tsconfig.json (default: auto-detected in cwd)
  --json                 Machine-readable output for CI (see below)
  --graph [path]         Write a standalone HTML visualization of the dependency graph
                         (default filename: neosyringe-graph.html)
  --mermaid              Print Mermaid flowchart syntax to stdout
```

## Output

### Success

```
Analyzing project: /path/to/tsconfig.json
🔍 Validating all dependency containers...
✅ Validation passed! No errors found.
```

### Errors found

```
Analyzing project: /path/to/tsconfig.json
🔍 Validating all dependency containers...

❌ Validation failed — 1 error(s) found:

container.ts:4:57 error NEO_MISSING_PROVIDER
Missing injection: 'ILogger' required by 'UserService' is not registered in this builder nor its parents/extends
Dependency chain: UserService -> ILogger
Fix: Register 'ILogger' in the same container as 'UserService', in a parent container (useContainer) or in an extended partial.
```

Each error is one block, with a blank line between blocks:

1. `<file>:<line>:<column> <severity> <code>`: the position of the registration in your source, and the stable `NEO_*` code (the error type when an error has no code yet). See the [Error Reference](/api/errors) for what each code means.
2. The message.
3. `Dependency chain: A -> B`, when the analyzer recorded one. A missing provider lists the consumer then the missing token. A cycle lists the whole cycle.
4. `Fix: <hint>`, one targeted fix, when the error has a code.

::: warning The text format changed
The text used to be one line per error, `<file>:<line>:<column>  [<type>]  <message>`. A script that read that line must read the new first line (`<file>:<line>:<column> <severity> <code>`), or better, use `--json`. The JSON schema did not change: see below.
:::

### `--json` — machine-readable output for CI

```bash
neosyringe-check --json
```

Prints a single JSON object to stdout instead of the human-readable format, and suppresses the `Analyzing project...` / `🔍 Validating...` lines:

```json
{
  "schemaVersion": 1,
  "ok": false,
  "errorCount": 1,
  "errors": [
    {
      "code": "NEO_MISSING_PROVIDER",
      "severity": "error",
      "file": "container.ts",
      "line": 4,
      "column": 57,
      "type": "missing",
      "message": "Missing injection: 'ILogger' required by 'UserService' is not registered in this builder nor its parents/extends",
      "token": "ILogger",
      "chain": ["UserService", "ILogger"],
      "hint": "Register 'ILogger' in the same container as 'UserService', in a parent container (useContainer) or in an extended partial."
    }
  ]
}
```

`code`, `chain` and `hint` are fields: read them, do not parse the message. `hint` is the sentence the text report prints after `Fix:`. It is absent when the error has no code. `hint` was added without removing or renaming a field, so `schemaVersion` stays `1`. The language service plugin reports the same code at the same position, and puts the chain and the fix in the related information of the diagnostic.

On success: `{"schemaVersion":1,"ok":true,"errorCount":0,"errors":[]}`. A fatal error before analysis even starts (e.g. no `tsconfig.json` found) instead produces `{"schemaVersion":1,"ok":false,"errorCount":0,"errors":[],"fatal":"<message>"}`.

```bash
# Example: fail the build and show only the messages
neosyringe-check --json | jq -e '.ok or (.errors[] | .message)'
```

### `--graph` — export graph as HTML

```bash
neosyringe-check --graph                    # writes neosyringe-graph.html
neosyringe-check --graph out/graph.html     # custom output path
```

Generates a standalone HTML file with an interactive Mermaid diagram of your dependency graph. Open it in any browser — no server required.

Nodes are color-coded by type:
- 🟢 **Green** — singleton services
- 🔵 **Blue** — transient services
- 🟠 **Orange** — factory registrations
- ⚫ **Grey** — value registrations

Solid arrows = required dependencies, dashed arrows = optional dependencies.

::: tip Combine with validation
`--graph` runs alongside normal validation. You get both a visual output and the usual error report in one command.
:::

### `--mermaid` — print raw Mermaid syntax

```bash
neosyringe-check --mermaid
```

Prints Mermaid flowchart syntax to stdout. Useful for embedding in Markdown documentation or feeding into other tools.

```bash
# Append to a markdown file
neosyringe-check --mermaid >> docs/architecture.md
```

See also: [Graph Visualization](/guide/graph-visualization) for the VSCode extension and Vite devtools.

### `doctor` — check the environment

```bash
neosyringe-check doctor [--json] [-p, --project <path>]
```

`doctor` reads the environment and never your application: it resolves no service, writes no file, and prints no config value, secret, factory source or environment value, only check ids, versions, file names and its own sentences. It runs five checks:

| Check | What it reads | `error` when |
|-------|---------------|--------------|
| `typescript` | the nearest `node_modules/typescript`, compared with the `typescript` peer range of the resolved `@djodjonx/neosyringe-plugin` and of the CLI | it is absent or outside that range |
| `neosyringe-packages` | the version of each NeoSyringe package found, and each `@djodjonx/*` dependency it declares, looked up from the real path of the package that declares it (`packages/cli/src/doctor.ts:225`) | a found dependency is outside the declared range |
| `package-exports` | every `exports`, `main`, `module`, `types` and `bin` target of those packages | a target is not on disk (`unknown` when the packages name none: nothing was checked, `packages/cli/src/doctor.ts:394`) |
| `tsconfig` | the tsconfig used (`--project`, else the nearest `tsconfig.json`) | it is missing or has errors |
| `integration` | the text of `vite`, `rollup`, `webpack`, `rspack` or `nuxt` config files in the working directory | never |

An example (the versions and counts are illustrative):

```
NeoSyringe doctor
ok       typescript: typescript 5.9.3 (node_modules/typescript) satisfies >=5.0.0 by @djodjonx/neosyringe-plugin, >=5.0.0 by @djodjonx/neosyringe-cli.
ok       neosyringe-packages: @djodjonx/neosyringe@0.3.0, @djodjonx/neosyringe-plugin@0.6.1. Read from the real path of each package: @djodjonx/neosyringe-plugin needs @djodjonx/neosyringe-core 0.6.1, resolved 0.6.1 (node_modules/.pnpm/...).
ok       package-exports: all 12 export targets of 2 package(s) are on disk.
ok       tsconfig: tsconfig.json is read (14 file(s) included).
unknown  integration: vite.config.ts does not show a literal neoSyringePlugin.<bundler>() call (...): whether the plugin is declared is not proven.
  Fix: Write the call literally in the plugins of the config, or check a build.

Result: 0 error, 0 warning, 1 unknown. Exit code 0. Unknown means doctor could not prove it: it is not a success.
```

- `ok`, `warning`, `ERROR` and `unknown` are printed as they are. A check `doctor` cannot prove is `unknown`: it never becomes `ok` by default.
- `neosyringe-packages` looks a dependency up the way Node does: from the real path of the package that declares it, so a package symlinked into a store (pnpm) is read next to the store and not from your project folder. A declared dependency that cannot be found from there is `unknown`, not `ok`. A range or a version that doctor cannot compare is `unknown` too: a partial range with `~`, `<=` or `>` (`~5`), a hyphen range, `workspace:*`, and any pre-release version (`packages/cli/src/doctor.ts:103`, `:138`).
- `integration` reads the config file as text and does not run it. `ok` means **declared in `<file>`**: a literal `neoSyringePlugin.<bundler>(` call is there. It does not prove that the plugin runs in a build. A config that builds its plugin list dynamically, or only names the package, is `unknown`. A known config file that never mentions the plugin is a `warning`. No known config file is `unknown` (an esbuild script and a ts-patch setup are not inspected).
- `--json` prints `{ "schemaVersion": 1, "ok", "exitCode", "checks": [{ "id", "status", "message", "remedy"? }] }`. `ok` is true when no check is an error.
- A flag other than `--json`, `--project` and `--help` is a usage error (exit 2).

## Exit Codes

| Code | Meaning |
|------|---------|
| 0 | Validation passed. For `doctor`: no check is an `error` (`warning` and `unknown` are printed and do not fail) |
| 1 | Validation failed, or a fatal error occurred before validation could run (missing/invalid tsconfig). For `doctor`: a check is an `error` |
| 2 | A usage error: a flag misused, or an argument `doctor` does not take |

## CI/CD Integration

### GitHub Actions

```yaml
# .github/workflows/ci.yml
name: CI

on: [push, pull_request]

jobs:
  validate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      
      - uses: pnpm/action-setup@v4
      
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'pnpm'
      
      - run: pnpm install --frozen-lockfile
      
      - name: Validate DI Graph
        run: pnpm exec neosyringe-check
```

### GitLab CI

```yaml
# .gitlab-ci.yml
validate:
  stage: test
  script:
    - pnpm install
    - pnpm exec neosyringe-check
```

### npm scripts

Add to `package.json`:

```json
{
  "scripts": {
    "validate": "neosyringe-check",
    "prebuild": "neosyringe-check",
    "ci": "pnpm lint && pnpm validate && pnpm test"
  }
}
```

## Best Practices

### Run Before Build

Validate before building to catch errors early:

```json
{
  "scripts": {
    "prebuild": "neosyringe-check",
    "build": "vite build"
  }
}
```

### Run in PR Checks

Add validation to your PR workflow:

```yaml
- name: Validate Dependencies
  run: pnpm exec neosyringe-check
  # Fails the PR if validation fails
```

### Use with Husky

Validate on pre-push:

```bash
# .husky/pre-push
pnpm exec neosyringe-check
```