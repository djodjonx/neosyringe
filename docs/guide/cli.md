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

  container.ts:4:57  [missing]  Missing injection: 'ILogger' required by 'UserService' is not registered in this builder nor its parents/extends
```

Each line is `<file>:<line>:<column>  [<type>]  <message>` — `type` is one of `missing`, `cycle`, `type-mismatch`, `duplicate` (see the [Error Reference](/api/errors) for what each one means).

### `--json` — machine-readable output for CI

```bash
neosyringe-check --json
```

Prints a single JSON object to stdout instead of the human-readable format, and suppresses the `Analyzing project...` / `🔍 Validating...` lines:

```json
{
  "ok": false,
  "errorCount": 1,
  "errors": [
    {
      "file": "container.ts",
      "line": 4,
      "column": 57,
      "type": "missing",
      "message": "Missing injection: 'ILogger' required by 'UserService' is not registered in this builder nor its parents/extends"
    }
  ]
}
```

On success: `{"ok":true,"errorCount":0,"errors":[]}`. A fatal error before analysis even starts (e.g. no `tsconfig.json` found) instead produces `{"ok":false,"errorCount":0,"errors":[],"fatal":"<message>"}`.

```bash
# Example: fail the build and show only the messages
neosyringe-check --json | jq -e '.ok or (.errors[] | .message)'
```

## Exit Codes

| Code | Meaning |
|------|---------|
| 0 | Validation passed |
| 1 | Validation failed, or a fatal error occurred before validation could run (missing/invalid tsconfig) |

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