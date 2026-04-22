#!/usr/bin/env bash
# scripts/verdaccio/invalidate.sh
# Delete Verdaccio local storage to force a re-fetch from npm.
set -euo pipefail

STORAGE=".verdaccio-storage"

if [ -d "$STORAGE" ]; then
  if [ -n "${1:-}" ]; then
    PKG_PATH="$STORAGE/$1"
    if [ -d "$PKG_PATH" ]; then
      rm -rf "$PKG_PATH"
      echo "✅ Package $1 invalidated from $STORAGE"
    else
      echo "⚠ Package $1 not found in $STORAGE"
    fi
  else
    rm -rf "$STORAGE/@djodjonx"
    echo "✅ All @djodjonx packages invalidated from $STORAGE"
  fi
else
  echo "⚠ Storage $STORAGE not found — Verdaccio has never run here."
fi
