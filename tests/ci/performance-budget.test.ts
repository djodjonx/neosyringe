import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { assertReport, compareBudget, distribution } from '../../scripts/ci/lib/performance-budget.mjs';
import type { BenchCase, BenchEnvironment, BenchReport, MetricReport } from '../../scripts/ci/lib/performance-budget.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const cli = path.join(root, 'scripts/ci/performance-budget.mjs');
const scratch: string[] = [];

const environment: BenchEnvironment = {
  node: 'v22.0.0',
  typescript: '5.9.3',
  sha: 'a'.repeat(40),
  dirty: false,
  cpu: 'test-cpu',
  cores: 4,
  memory: 1000,
  os: 'test',
  flags: '["--expose-gc"]',
  timerResolutionNs: 50_000,
};

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 't05-budget-'));
  scratch.push(dir);
  return dir;
}

function metric(value: number, processCount = 5, perProcess = 7): MetricReport {
  return {
    unit: 'ns/op',
    processes: Array.from({ length: processCount }, () => Array.from({ length: perProcess }, () => value)),
    processMedians: Array.from({ length: processCount }, () => value),
    median: value,
    mad: 0,
  };
}

function report(metrics: Readonly<Record<string, MetricReport>>, env: BenchEnvironment = environment): BenchReport {
  return {
    environment: env,
    params: {
      sizes: [10],
      shapes: ['flat'],
      profiles: ['full'],
      modes: ['open'],
      processes: 5,
      samples: 7,
      resolveCount: 1000,
      resolveBatches: 7,
    },
    cases: [{ shape: 'flat', profile: 'full', mode: 'open', size: 10, metrics }],
  };
}

function runCli(baseline: BenchReport, candidate: BenchReport): {
  status: number | null;
  stdout: string;
  stderr: string;
  before: Buffer;
  after: Buffer;
} {
  const dir = tempDir();
  const baselinePath = path.join(dir, 'baseline.json');
  const candidatePath = path.join(dir, 'candidate.json');
  writeFileSync(baselinePath, `${JSON.stringify(baseline)}\n`);
  writeFileSync(candidatePath, `${JSON.stringify(candidate)}\n`);
  const before = readFileSync(baselinePath);
  const run = spawnSync(process.execPath, [cli, '--baseline', baselinePath, '--candidate', candidatePath], {
    encoding: 'utf8',
    cwd: root,
  });
  return {
    status: run.status,
    stdout: run.stdout,
    stderr: run.stderr,
    before,
    after: readFileSync(baselinePath),
  };
}

afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('performance budget', () => {
  it('distribution guard', () => {
    expect(() => distribution([1, 2, 3, 4])).toThrow('five positive process medians required');
    expect(() => distribution([1, 2, 3, 4, 0])).toThrow('five positive process medians required');
  });

  it('artificial regression', () => {
    const run = runCli(
      report({ 'warm-resolve': metric(100) }),
      report({ 'warm-resolve': metric(125) }),
    );
    expect(run.status).toBe(1);
    expect(run.stdout).toContain('fail');
  });

  it('within noise', () => {
    const baseline = distribution([100, 100, 100, 100, 100]);
    const candidate = distribution([50, 100, 125, 150, 200]);
    const verdict = compareBudget(baseline, candidate);
    const delta = (candidate?.median ?? Number.NaN) - (baseline?.median ?? Number.NaN);
    expect(verdict?.ratio).toBe(1.25);
    expect(verdict !== undefined && delta <= verdict.noise).toBe(true);
    expect(verdict?.verdict).toBe('inconclusive');
  });

  it('no recalibration', () => {
    const run = runCli(
      report({ 'warm-resolve': metric(100) }),
      report({ 'warm-resolve': metric(125) }),
    );
    expect(run.status).toBe(1);
    expect(Buffer.compare(run.before, run.after)).toBe(0);
  });

  it('sample-count guard', () => {
    const shortProcesses = runCli(
      report({ 'warm-resolve': metric(100) }),
      report({ 'warm-resolve': metric(100, 4, 7) }),
    );
    expect(shortProcesses.status).toBe(1);
    expect(`${shortProcesses.stdout}\n${shortProcesses.stderr}`).toContain(
      'at least 7 samples per process and 5 processes required',
    );
    const shortSamples = runCli(
      report({ 'warm-resolve': metric(100) }),
      report({ 'warm-resolve': metric(100, 5, 6) }),
    );
    expect(shortSamples.status).toBe(1);
    expect(`${shortSamples.stdout}\n${shortSamples.stderr}`).toContain(
      'at least 7 samples per process and 5 processes required',
    );
  });

  it('environment mismatch', () => {
    const base = report({ 'warm-resolve': metric(100) });
    expect(() => assertReport(base, report({ 'warm-resolve': metric(100) }, { ...environment, node: 'other' })))
      .toThrow('environment mismatch: node');
    expect(() => assertReport(base, report({ 'warm-resolve': metric(100) }, { ...environment, cpu: 'other' })))
      .toThrow('environment mismatch: cpu');
    expect(() => assertReport(base, report({ 'warm-resolve': metric(100) }, { ...environment, flags: '[]' })))
      .toThrow('environment mismatch: flags');
  });

  it('import sample exemption', () => {
    const imported: MetricReport = {
      unit: 'ns',
      processes: Array.from({ length: 5 }, () => [1]),
      processMedians: [1, 1, 1, 1, 1],
      median: 1,
      mad: 0,
    };
    const names = assertReport(
      report({ import: imported, 'warm-resolve': metric(100) }),
      report({ import: imported, 'warm-resolve': metric(100) }),
    ) ?? [];
    expect([...names]).toContain('import');
  });

  it('typescript mismatch', () => {
    const base = report({ 'warm-resolve': metric(100) });
    expect(() => assertReport(base, report({ 'warm-resolve': metric(100) }, { ...environment, typescript: '0.0.0' })))
      .toThrow('environment mismatch: typescript');
  });

  it('params mismatch', () => {
    const base = report({ 'warm-resolve': metric(100) });
    const other: BenchReport = { ...base, params: { ...base.params, samples: 8 } };
    expect(() => assertReport(base, other)).toThrow('params mismatch');
  });

  it('params k mismatch', () => {
    const base = report({ 'warm-resolve': metric(100) });
    const left: BenchReport = { ...base, params: { ...base.params, k: { 'flat|full|open|10': { create: 64 } } } };
    const right: BenchReport = { ...base, params: { ...base.params, k: { 'flat|full|open|10': { create: 128 } } } };
    expect(() => assertReport(left, right)).toThrow('params mismatch');
  });

  it('an errored candidate case keeps the other cases compared', () => {
    const rowK = { create: 1000 };
    const caseOf = (size: number): BenchCase => ({
      shape: 'flat', profile: 'full', mode: 'open', size, metrics: { 'warm-resolve': metric(100) },
    });
    const base = report({});
    const baseline: BenchReport = {
      environment,
      params: { ...base.params, sizes: [10, 100], k: { 'flat|full|open|10': rowK, 'flat|full|open|100': rowK } },
      cases: [caseOf(10), caseOf(100)],
    };
    const candidate: BenchReport = {
      environment,
      params: { ...base.params, sizes: [10, 100], k: { 'flat|full|open|10': rowK } },
      cases: [caseOf(10), { shape: 'flat', profile: 'full', mode: 'open', size: 100, error: 'batch k exceeded' }],
    };
    const run = runCli(baseline, candidate);
    expect(run.status).toBe(1);
    expect(`${run.stdout}\n${run.stderr}`).not.toContain('params mismatch');
    const lines = run.stdout.split('\n');
    expect(lines).toContain('flat\tfull\topen\t10\twarm-resolve\t100\t100\t1.000\t0.000\tpass');
    expect(lines).toContain('flat\tfull\topen\t100\t-\t-\t-\t-\t-\tfail');
    expect(lines).toContain('verdict fail');
  });

  it('a different k for a measured case is refused', () => {
    const caseOf = (size: number): BenchCase => ({
      shape: 'flat', profile: 'full', mode: 'open', size, metrics: { 'warm-resolve': metric(100) },
    });
    const base = report({});
    const make = (width: number, second: BenchCase): BenchReport => ({
      environment,
      params: {
        ...base.params,
        sizes: [10, 100],
        k: { 'flat|full|open|10': { create: width }, 'flat|full|open|100': { create: 1000 } },
      },
      cases: [caseOf(10), second],
    });
    expect(() => assertReport(make(1000, caseOf(100)), make(10_000, caseOf(100))))
      .toThrow('params mismatch: k flat|full|open|10');
    const errored: BenchCase = { shape: 'flat', profile: 'full', mode: 'open', size: 100, error: 'batch k exceeded' };
    expect(() => assertReport(make(1000, caseOf(100)), make(10_000, errored)))
      .toThrow('params mismatch: k flat|full|open|10');
    expect(assertReport(make(1000, caseOf(100)), make(1000, errored))).toContain('warm-resolve');
  });

  it('empty report is refused', () => {
    const base = report({ 'warm-resolve': metric(100) });
    const empty: BenchReport = { ...base, cases: [] };
    const run = runCli(empty, empty);
    expect(run.status).toBe(1);
    expect(`${run.stdout}\n${run.stderr}`).toContain('report has no case');
  });

  it('missing baseline case fails', () => {
    const base = report({ 'warm-resolve': metric(100) });
    const run = runCli(base, { ...base, cases: [] });
    expect(run.status).toBe(1);
    expect(run.stdout).toContain('fail');
  });

  it('errored case fails', () => {
    const base = report({ 'warm-resolve': metric(100) });
    const item = base.cases[0];
    if (!item) throw new Error('missing case');
    const run = runCli(base, { ...base, cases: [{ ...item, error: 'compile failed' }] });
    expect(run.status).toBe(1);
    expect(run.stdout).toContain('fail');
  });

  it('missing metric fails', () => {
    const run = runCli(
      report({ 'warm-resolve': metric(100), create: metric(50) }),
      report({ 'warm-resolve': metric(100) }),
    );
    expect(run.status).toBe(1);
    expect(run.stdout).toContain('fail');
  });

  it('recomputes medians from processes', () => {
    const lied: MetricReport = {
      ...metric(200),
      processMedians: [100, 100, 100, 100, 100],
      median: 100,
      mad: 0,
    };
    const run = runCli(report({ 'warm-resolve': metric(100) }), report({ 'warm-resolve': lied }));
    expect(run.status).toBe(1);
  });

  it('large build is exempt from the five-median rule', () => {
    const warm = metric(100);
    const buildOf = (value: number): MetricReport => ({
      unit: 'ms',
      processes: [Array.from({ length: 7 }, () => value)],
      processMedians: [value],
      median: value,
      mad: 0,
    });
    const make = (buildMedian: number): BenchReport => ({
      environment,
      params: {
        sizes: [1000],
        shapes: ['flat'],
        profiles: ['full'],
        modes: ['open'],
        processes: 5,
        samples: 7,
        resolveCount: 1000,
        resolveBatches: 7,
      },
      cases: [{
        shape: 'flat',
        profile: 'full',
        mode: 'open',
        size: 1000,
        metrics: { 'warm-resolve': warm, build: buildOf(buildMedian) },
      }],
    });
    const run = runCli(make(10), make(40));
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('exempt');
    const small = report({ 'warm-resolve': warm, build: buildOf(10) });
    expect(() => assertReport(small, small)).toThrow('at least 7 samples per process and 5 processes required');
  });
});
