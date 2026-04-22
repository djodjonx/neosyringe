#!/usr/bin/env node
// scripts/update-examples.mjs
// Updates @djodjonx package versions in example package.json files
// by reading .release-please-manifest.json as the source of truth.
import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const manifest = JSON.parse(
  readFileSync(resolve(root, '.release-please-manifest.json'), 'utf8')
);

const VERSION_MAP = {
  '@djodjonx/neosyringe':        manifest['packages/neosyringe'],
  '@djodjonx/neosyringe-lsp':    manifest['packages/lsp'],
  '@djodjonx/neosyringe-plugin': manifest['packages/unplugin'],
  '@djodjonx/neosyringe-cli':    manifest['packages/cli'],
};

const EXAMPLES = [
  resolve(root, 'examples/nuxt/package.json'),
  resolve(root, 'examples/nestjs/package.json'),
];

let changed = false;

for (const pkgPath of EXAMPLES) {
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  let updated = false;

  for (const [name, version] of Object.entries(VERSION_MAP)) {
    if (pkg.dependencies?.[name] && pkg.dependencies[name] !== version) {
      pkg.dependencies[name] = version;
      updated = true;
    }
    if (pkg.devDependencies?.[name] && pkg.devDependencies[name] !== version) {
      pkg.devDependencies[name] = version;
      updated = true;
    }
  }

  if (updated) {
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
    console.log(`✅ Updated ${pkgPath.replace(root + '/', '')}`);
    changed = true;
  } else {
    console.log(`— No changes in ${pkgPath.replace(root + '/', '')}`);
  }
}

if (!changed) {
  console.log('All examples are already up to date.');
}
