import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const historicalDir = path.join(root, 'audit/historical');
const resultsDir = path.join(root, 'audit/results');
const treeDir = path.join(root, '.audit-tree-shaking');

const scripts = [
  'audit-runtime.mjs',
  'audit-edge-cases.mjs',
  'audit-types.mjs',
  'audit-devtools.mjs',
  'audit-tree-shaking.mjs',
];

function digestOf(filename) {
  return createHash('sha256').update(readFileSync(path.join(historicalDir, filename))).digest('hex');
}

const manifest = readFileSync(path.join(historicalDir, 'SHA256SUMS'), 'utf8');
for (const filename of scripts) {
  const digest = digestOf(filename);
  if (!manifest.includes(`${digest}  ${filename}`)) {
    process.stderr.write(`digest mismatch: ${filename} ${digest}\n`);
    process.exit(1);
  }
}

if (existsSync(treeDir)) {
  process.stderr.write('abort: .audit-tree-shaking already exists\n');
  process.exit(1);
}

for (const filename of scripts) {
  const destination = path.join(root, filename);
  if (existsSync(destination) && statSync(destination).size > 0) {
    process.stderr.write(`abort: ${filename} already exists\n`);
    process.exit(1);
  }
}

mkdirSync(resultsDir, { recursive: true });

function parsedValues(stdout) {
  const values = [];
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        values.push(JSON.stringify(JSON.parse(trimmed)));
        continue;
      } catch {
        // keep the raw line below
      }
    }
    values.push(trimmed);
  }
  return values;
}

function qualify(status, stdout) {
  const sentence = `exit ${status} n'est pas une réussite du contrat ; comparer la sortie à audit/BASELINE.md`;
  const values = parsedValues(stdout);
  if (values.length === 0) return sentence;
  return `${sentence} | ${values.join(' | ')}`;
}

for (const filename of scripts) {
  const destination = path.join(root, filename);
  const existed = existsSync(destination);
  let created = false;
  let status = 1;
  let stdout = '';
  let stderr = '';
  try {
    copyFileSync(path.join(historicalDir, filename), destination);
    created = !existed;
    const child = spawnSync(process.execPath, [filename], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    status = child.status === null ? 1 : child.status;
    stdout = child.stdout ?? '';
    stderr = child.stderr ?? '';
    if (child.error) stderr += `${child.error.message}\n`;
    if (child.signal) stderr += `signal ${child.signal}\n`;
  } finally {
    if (created) {
      try { unlinkSync(destination); } catch { /* already gone */ }
    }
    if (existsSync(treeDir)) {
      rmSync(treeDir, { recursive: true, force: true });
    }
  }

  const body = [
    `node: ${process.version}`,
    `command: node ${filename}`,
    'cwd: .',
    `exit: ${status}`,
    `qualification: ${qualify(status, stdout)}`,
    '--- stdout ---',
    stdout,
    '--- stderr ---',
    stderr,
  ].join('\n');
  writeFileSync(path.join(resultsDir, filename.replace(/\.mjs$/, '.txt')), body);
}
