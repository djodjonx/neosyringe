# Verdaccio — Local Registry for Example Development

Verdaccio acts as a local npm registry proxy. Use it to test examples with
package versions that haven't been published to npm yet.

## Workflow

### 1. Start Verdaccio

```bash
pnpm verdaccio:start
```

Verdaccio runs on http://localhost:4873. Keep this terminal open.

### 2. Build and publish packages locally

In a second terminal:

```bash
pnpm verdaccio:publish
```

### 3. Install dependencies in an example

```bash
cd examples/nuxt
pnpm install --registry http://localhost:4873
pnpm dev
```

### 4. Invalidate cache after a package change

To force Verdaccio to re-fetch or re-publish a new version:

```bash
# Invalidate all @djodjonx packages
pnpm verdaccio:invalidate

# Invalidate a specific package (note the -- to pass the argument)
pnpm verdaccio:invalidate -- @djodjonx/neosyringe-plugin
```

Then republish: `pnpm verdaccio:publish`

## Notes

- Verdaccio is for **local development only**. Committed examples use official npm versions.
- Do not commit `.verdaccio-storage/` (it is in `.gitignore`).
- The registry proxies unknown packages through to npmjs.org automatically.
