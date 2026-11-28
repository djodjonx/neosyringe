#!/usr/bin/env node
// scripts/ci/consumer-types-scale.mjs
// Builds a consumer project outside the repo tsconfig, then typechecks it
// with scripts/ci/consumer-types.mjs.
// node scripts/ci/consumer-types-scale.mjs <size> [--bad start|middle|end] [--pack [<tarball|dir>]]
// --pack alone runs `pnpm pack` on packages/neosyringe, proves the tarball carries the build on disk,
// extracts it and typechecks the consumer against the extracted package. It does not build.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { PackError, resolveTypesEntry } from './lib/pack-archive.mjs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const harness = path.join(root, 'scripts/ci/consumer-types.mjs');
const sourceEntry = path.join(root, 'packages/neosyringe/src/index.ts');
const packageDir = path.join(root, 'packages/neosyringe');

let scratch;

// process.exit skips `finally`, so the temporary folder is removed here too.
function leave(code) {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
  process.exit(code);
}

function fail(message) {
  console.error(message);
  leave(1);
}

function argument(flag) {
  const index = process.argv.indexOf(flag);
  if (index < 0) return undefined;
  return process.argv[index + 1];
}

const size = Number(process.argv[2]);
const bad = argument('--bad');
const packIndex = process.argv.indexOf('--pack');
const packNext = packIndex < 0 ? undefined : process.argv[packIndex + 1];
// `--pack` alone asks for a fresh tarball. A value is a tarball or an extracted package folder.
const pack = packIndex < 0 ? undefined : packNext === undefined || packNext.startsWith('--') ? '' : packNext;
if (!Number.isInteger(size) || size < 1) fail(`size must be a positive integer, got ${process.argv[2] ?? ''}`);
if (bad !== undefined && bad !== 'start' && bad !== 'middle' && bad !== 'end') {
  fail(`--bad must be start, middle, or end, got ${bad ?? ''}`);
}

function badIndex(where) {
  if (where === 'start') return 0;
  if (where === 'end') return size - 1;
  return Math.floor(size / 2);
}

const dir = mkdtempSync(path.join(tmpdir(), 'neosyringe-scale-'));
scratch = dir;

/** Where the consumer finds the types: the source, an extracted tarball, or an extracted folder. */
function resolveEntry() {
  try {
    return resolveTypesEntry({ pack, packageDir, scratch: dir, sourceEntry });
  } catch (error) {
    if (error instanceof PackError) fail(error.message);
    throw error;
  }
}

const classes = [];
const rows = [];
let badLine = 0;
for (let index = 0; index < size; index += 1) {
  classes.push(`class S${index} { value = ${index}; }`);
}
const header = `import { defineBuilderConfig } from '@djodjonx/neosyringe';\n${classes.join('\n')}\nexport const container = defineBuilderConfig({\n  injections: [\n`;
const headerLines = header.split('\n').length;
for (let index = 0; index < size; index += 1) {
  const broken = bad !== undefined && index === badIndex(bad);
  if (broken) badLine = headerLines + index;
  const row = broken
    ? `{ token: S${index}, useFactory: true, dependencies: [], provider: () => 'bad' }`
    : `{ token: S${index} }`;
  rows.push(row);
}
const source = `${header}${rows.join(',\n')}\n  ],\n});\n`;

const tsconfig = (entry) => `{
  "compilerOptions": {
    "strict": true,
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "noEmit": true,
    "skipLibCheck": true,
    "types": [],
    "baseUrl": ".",
    "paths": {
      "@djodjonx/neosyringe": [${JSON.stringify(entry)}]
    }
  },
  "files": ["consumer.ts"]
}
`;

try {
  const { entry, label } = resolveEntry();
  if (!existsSync(entry)) fail(`missing types entry: ${entry}`);
  const consumer = path.join(dir, 'consumer');
  mkdirSync(consumer, { recursive: true });
  writeFileSync(path.join(consumer, 'tsconfig.json'), tsconfig(entry));
  writeFileSync(path.join(consumer, 'consumer.ts'), source);
  const result = spawnSync(process.execPath, [harness, consumer], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  if (output.includes('TS2589')) fail(`TS2589\n${output.split('\n').slice(0, 20).join('\n')}`);
  if (bad === undefined) {
    if (result.status !== 0) fail(output.split('\n').slice(0, 30).join('\n'));
    console.log(`ok size=${size} from=${label} types=${entry.startsWith(dir) ? path.relative(dir, entry) : path.relative(root, entry)}`);
    leave(0);
  }
  const hits = [...output.matchAll(/\((\d+),\d+\): error TS(\d+)/g)];
  const onEntry = hits.filter((hit) => Number(hit[1]) === badLine);
  const wanted = `S${badIndex(bad)}`;
  const named = [...output.matchAll(/Type '\{ token: typeof (S\d+);[^']*' is not assignable to type 'never'/g)].map((hit) => hit[1]);
  const namesEntry = named.length === 1 && named[0] === wanted;
  if (result.status === 0 || (onEntry.length === 0 && !namesEntry)) {
    fail(`bad factory at ${bad} expected a diagnostic on line ${badLine} for ${wanted}, saw ${hits.map((hit) => `TS${hit[2]}:${hit[1]}`).join(', ') || 'none'}; named ${named.join(',') || 'none'}`);
  }
  const code = onEntry[0]?.[2] ?? hits[0]?.[2] ?? '';
  console.log(`ok bad=${bad} line=${badLine} code=TS${code} from=${label}`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
