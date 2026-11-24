// Compares two runtime reports. Reads both files and writes nothing.
import { readFileSync } from 'node:fs';
import { assertReport, compareBudget, distribution } from './lib/performance-budget.mjs';

const args = process.argv.slice(2);
if (args.length !== 4 || args[0] !== '--baseline' || args[2] !== '--candidate') {
  console.error('usage: node scripts/ci/performance-budget.mjs --baseline <file> --candidate <file>');
  process.exit(2);
}

const baselinePath = args[1];
const candidatePath = args[3];
const baselineText = readFileSync(baselinePath);
const baseline = JSON.parse(baselineText.toString('utf8'));
const candidate = JSON.parse(readFileSync(candidatePath, 'utf8'));

try {
  assertReport(baseline, candidate);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

function caseKey(item) {
  return `${item.shape}|${item.profile}|${item.mode}|${item.size}`;
}

function medianOf(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function mediansFromProcesses(metric) {
  return (metric.processes ?? []).map((row) => medianOf(row));
}

const baselineCases = new Map((baseline.cases ?? []).map((item) => [caseKey(item), item]));
const candidateCases = new Map((candidate.cases ?? []).map((item) => [caseKey(item), item]));
let summary = 'pass';
const rows = [['shape', 'profile', 'mode', 'size', 'metric', 'baseline', 'candidate', 'ratio', 'noise', 'verdict']];
const note = (item, metric) => {
  rows.push([item.shape, item.profile, item.mode, String(item.size), metric, '-', '-', '-', '-', 'fail']);
  summary = 'fail';
};
for (const item of baseline.cases ?? []) {
  if (!candidateCases.has(caseKey(item))) note(item, '-');
}
for (const item of candidate.cases ?? []) {
  const other = baselineCases.get(caseKey(item));
  if (!other || item.error || other.error) {
    note(item, '-');
    continue;
  }
  const names = new Set([...Object.keys(other.metrics ?? {}), ...Object.keys(item.metrics ?? {})]);
  for (const name of names) {
    const left = other.metrics?.[name];
    const right = item.metrics?.[name];
    if (!left || !right) {
      note(item, name);
      continue;
    }
    // Sizes 1000 and 5000 publish one build group. The five-median rule does not apply.
    if (name === 'build' && Number(item.size) >= 1000) {
      rows.push([
        item.shape, item.profile, item.mode, String(item.size), name,
        '-', '-', '-', '-', 'exempt',
      ]);
      continue;
    }
    const leftDist = distribution(mediansFromProcesses(left));
    const rightDist = distribution(mediansFromProcesses(right));
    const verdict = compareBudget(leftDist, rightDist);
    if (verdict.verdict === 'fail') summary = 'fail';
    else if (verdict.verdict === 'inconclusive' && summary !== 'fail') summary = 'inconclusive';
    rows.push([
      item.shape,
      item.profile,
      item.mode,
      String(item.size),
      name,
      String(leftDist.median),
      String(rightDist.median),
      verdict.ratio.toFixed(3),
      verdict.noise.toFixed(3),
      verdict.verdict,
    ]);
  }
}
for (const row of rows) process.stdout.write(`${row.join('\t')}\n`);
process.stdout.write(`verdict ${summary}\n`);
process.exit(summary === 'fail' ? 1 : 0);
