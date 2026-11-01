#!/usr/bin/env node
// scripts/ci/check-dist.mjs
// Fails when a published package declares an entry that is not on disk.
// Private packages are skipped (the VS Code extension is not an npm publish).
// A package with only a bin, and no main, is still checked.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.argv[2] ?? process.cwd());

function packageDirs(start) {
  const packagesDir = path.join(start, 'packages');
  if (existsSync(packagesDir) && statSync(packagesDir).isDirectory()) {
    return readdirSync(packagesDir)
      .map((name) => path.join(packagesDir, name))
      .filter((dir) => existsSync(path.join(dir, 'package.json')));
  }
  if (!existsSync(path.join(start, 'package.json'))) {
    console.error(`missing package.json in ${start}`);
    process.exit(1);
  }
  return [start];
}

function collectPaths(node, out) {
  if (typeof node === 'string') {
    if (node.startsWith('.')) out.push(node);
    return;
  }
  if (node && typeof node === 'object') {
    for (const value of Object.values(node)) collectPaths(value, out);
  }
}

function binEntries(pkg) {
  const rels = [];
  if (typeof pkg.bin === 'string') rels.push(pkg.bin);
  else if (pkg.bin && typeof pkg.bin === 'object') {
    for (const value of Object.values(pkg.bin)) {
      if (typeof value === 'string') rels.push(value);
    }
  }
  return rels;
}

function packageEntries(pkg) {
  const rels = [];
  for (const field of ['main', 'module', 'types']) {
    if (typeof pkg[field] === 'string') rels.push(pkg[field]);
  }
  collectPaths(pkg.exports, rels);
  return rels;
}

const missing = [];

function requireFile(dir, rel) {
  const file = path.join(dir, rel);
  if (!existsSync(file)) missing.push(file);
}

for (const dir of packageDirs(root)) {
  const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
  if (pkg.private === true) continue;
  for (const rel of binEntries(pkg)) requireFile(dir, rel);
  for (const rel of packageEntries(pkg)) requireFile(dir, rel);
}

if (missing.length > 0) {
  for (const file of missing) console.error(`missing dist entry: ${file}`);
  process.exit(1);
}
