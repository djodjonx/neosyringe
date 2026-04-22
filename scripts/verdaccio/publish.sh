#!/usr/bin/env bash
# scripts/verdaccio/publish.sh
# Build and publish all @djodjonx packages to local Verdaccio.
set -euo pipefail

REGISTRY="http://localhost:4873"

echo "→ Build packages..."
pnpm build

echo "→ Publishing to Verdaccio ($REGISTRY)..."
pnpm -r --filter './packages/**' publish \
  --registry "$REGISTRY" \
  --no-git-checks \
  --force

echo "✅ Packages published to $REGISTRY"
echo ""
echo "To install in an example:"
echo "  cd examples/nuxt && pnpm install --registry $REGISTRY"
