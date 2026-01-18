# CLI Validator

Validate your dependency graph in CI/CD pipelines.

## Installation

The CLI is included with the main package:

```bash
npx neosyringe
# or
pnpm exec neo-syringe
```

## Usage

Run in your project root (where `tsconfig.json` is located):

```bash
neo-syringe
```

### Options

```bash
neo-syringe [options]

Options:
  -p, --project <path>   Path to tsconfig.json (default: "./tsconfig.json")
  -h, --help             Display help
  -v, --version          Display version
```

## Output

### Success

```
🔍 Analyzing project: /path/to/tsconfig.json
   Found 45 services.
🛡️  Validating graph...
✅ Validation passed! No circular dependencies or missing bindings found.
```

### Circular Dependency Detected

```
🔍 Analyzing project: /path/to/tsconfig.json
   Found 12 services.
🛡️  Validating graph...
❌ Validation failed!

Error: Circular dependency detected: A -> B -> C -> A
```

### Missing Binding

```
🔍 Analyzing project: /path/to/tsconfig.json
   Found 8 services.
🛡️  Validating graph...
❌ Validation failed!

Error: Missing binding: 'UserService' depends on 'ILogger', but no provider registered.
```

### Duplicate Registration

```
🔍 Analyzing project: /path/to/tsconfig.json
   Found 15 services.
🛡️  Validating graph...
❌ Validation failed!

Error: Duplicate registration: 'ILogger' is already registered in the parent container.
Use 'scoped: true' to override the parent's registration intentionally.
```

## Exit Codes

| Code | Meaning |
|------|---------|
| 0 | Validation passed |
| 1 | Validation failed |
| 2 | Configuration error |

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
        run: pnpm exec neo-syringe
```

### GitLab CI

```yaml
# .gitlab-ci.yml
validate:
  stage: test
  script:
    - pnpm install
    - pnpm exec neo-syringe
```

### npm scripts

Add to `package.json`:

```json
{
  "scripts": {
    "validate": "neo-syringe",
    "prebuild": "neo-syringe",
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
    "prebuild": "neo-syringe",
    "build": "vite build"
  }
}
```

### Run in PR Checks

Add validation to your PR workflow:

```yaml
- name: Validate Dependencies
  run: pnpm exec neo-syringe
  # Fails the PR if validation fails
```

### Use with Husky

Validate on pre-push:

```bash
# .husky/pre-push
pnpm exec neo-syringe
```

