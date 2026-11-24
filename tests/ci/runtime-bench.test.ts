import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import * as ts from 'typescript';
import { benchmarkResolve, makeOrder, measureCase, summarize } from '../bench/lib/measure.mjs';
import type { BenchHarness, CheckResult } from '../bench/lib/measure.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const bench = path.join(root, 'tests/bench/runtime-cost.mjs');
const scratch: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 't05-runtime-'));
  scratch.push(dir);
  return dir;
}

function asCheck(value: CheckResult | Promise<unknown>): CheckResult | undefined {
  if (typeof value !== 'object' || value === null || value instanceof Promise) return undefined;
  if (!('scopeCounts' in value) || !Array.isArray(value.scopeCounts)) return undefined;
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNumberArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'number');
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

interface RuntimeEnvironment {
  node: string;
  typescript: string;
  sha: string;
  dirty: boolean;
  cpu: string;
}

interface RuntimeParams {
  sizes: number[];
  shapes: string[];
  profiles: string[];
  modes: string[];
  processes: number;
  samples: number;
}

interface RuntimeReport {
  environment: RuntimeEnvironment;
  params: RuntimeParams;
}

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function isRuntimeReport(value: unknown): value is RuntimeReport {
  if (!isRecord(value) || !isRecord(value.environment) || !isRecord(value.params)) return false;
  const env = value.environment;
  const params = value.params;
  return typeof env.node === 'string'
    && typeof env.typescript === 'string'
    && typeof env.sha === 'string'
    && typeof env.dirty === 'boolean'
    && typeof env.cpu === 'string'
    && isNumberArray(params.sizes)
    && isStringArray(params.shapes)
    && isStringArray(params.profiles)
    && isStringArray(params.modes)
    && typeof params.processes === 'number'
    && typeof params.samples === 'number';
}

function metricRows(report: unknown, name: string): number[][] | undefined {
  if (!isRecord(report) || !Array.isArray(report.cases)) return undefined;
  const item = report.cases[0];
  if (!isRecord(item) || !isRecord(item.metrics)) return undefined;
  const metric = item.metrics[name];
  if (!isRecord(metric) || !Array.isArray(metric.processes)) return undefined;
  const rows: number[][] = [];
  for (const row of metric.processes) {
    if (!isNumberArray(row)) return undefined;
    rows.push(row);
  }
  return rows;
}

function caseField(report: unknown, name: string): unknown {
  if (!isRecord(report) || !Array.isArray(report.cases)) return undefined;
  const item = report.cases[0];
  if (!isRecord(item)) return undefined;
  return item[name];
}

function scheduleKeys(report: unknown): string[] | undefined {
  if (!isRecord(report) || !Array.isArray(report.schedule)) return undefined;
  const keys: string[] = [];
  for (const item of report.schedule) {
    if (!isRecord(item) || typeof item.process !== 'number' || typeof item.shape !== 'string') return undefined;
    keys.push(`${item.process}:${item.shape}`);
  }
  return keys;
}

function runBench(reportPath: string, env: Record<string, string>) {
  return spawnSync(process.execPath, [bench], {
    encoding: 'utf8',
    cwd: root,
    env: {
      ...process.env,
      NEOSYRINGE_BENCH_SIZES: '10',
      NEOSYRINGE_BENCH_SHAPES: 'flat',
      NEOSYRINGE_BENCH_PROFILES: 'full',
      NEOSYRINGE_BENCH_MODES: 'open',
      NEOSYRINGE_BENCH_PROCESSES: '5',
      NEOSYRINGE_BENCH_SAMPLES: '7',
      NEOSYRINGE_BENCH_RESOLVE_COUNT: '1000',
      NEOSYRINGE_BENCH_RESOLVE_BATCHES: '7',
      NEOSYRINGE_BENCH_REPORT: reportPath,
      ...env,
    },
  });
}

afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('runtime bench', () => {
  it('benchmarkResolve wrong instance', () => {
    expect(() => benchmarkResolve({
      resolve: () => ({ value: 0 }),
      size: 2,
      count: 8,
      batches: 1,
    })).toThrow('incorrect resolution');
  });

  it('makeOrder guards', () => {
    expect(() => makeOrder(0, 1)).toThrow('positive sizes required');
    expect(() => makeOrder(1, 0)).toThrow('positive sizes required');
    expect(() => makeOrder(1.5, 1)).toThrow('positive sizes required');
  });

  it('summarize', () => {
    expect(summarize([1, 2, 3])?.median).toBe(2);
    expect(summarize([1, 2])?.median).toBe(1.5);
    expect(() => summarize([])).toThrow('finite samples required');
    expect(() => summarize([NaN])).toThrow('finite samples required');
  });

  it('positive batches', () => {
    expect(() => benchmarkResolve({
      resolve: (index) => ({ value: index }),
      size: 1,
      count: 1,
      batches: 0,
    })).toThrow('positive batches required');
  });

  it('perCall guard', () => {
    expect(() => benchmarkResolve({
      resolve: (index) => ({ value: index }),
      size: 1,
      count: 1,
      batches: 1,
      perCall: 0,
    })).toThrow('positive sizes required');
  });

  it('warm resolve divides by perCall', () => {
    const resolve = (index: number) => {
      let sum = index;
      for (let cursor = 0; cursor < 400; cursor += 1) sum += cursor;
      return { value: index + (sum < 0 ? 1 : 0) };
    };
    const once = benchmarkResolve({ resolve, size: 4, count: 4000, batches: 1, perCall: 1 });
    const scaled = benchmarkResolve({ resolve, size: 4, count: 4000, batches: 1, perCall: 10 });
    expect(once?.median).toBeGreaterThan(0);
    expect(scaled?.median).toBeGreaterThan(0);
    expect((once?.median ?? 0) / (scaled?.median ?? 1)).toBeGreaterThan(5);
  });

  it('cold resolve wrong instance', async () => {
    let cold = false;
    const harness: BenchHarness = {
      shape: 'flat',
      size: 1,
      coldIndex: 0,
      scopeDisposeCounts: () => [1],
      resolve: (index) => ({ value: cold ? 99 : index }),
      recreate() {
        cold = true;
      },
      timeCreate: () => 1,
      timeCreateScope: () => 1,
      timeInitialize: () => 1,
      timeDestroy: () => 1,
      heapAfterGc: () => 1,
    };
    const pending = measureCase({
      createHarness: () => harness,
      samples: 1,
      batches: 1,
      count: 1,
    });
    expect(pending).toBeInstanceOf(Promise);
    await expect(pending).rejects.toThrow('incorrect resolution');
  });

  it('scope release check', () => {
    const ok = asCheck(measureCase({
      createHarness: () => ({ shape: 'flat', size: 2, scopeDisposeCounts: () => [1, 1] }),
    }));
    expect(ok?.scopeCounts).toEqual([1, 1]);
    expect(() => measureCase({
      createHarness: () => ({ shape: 'flat', size: 1, scopeDisposeCounts: () => [0] }),
    })).toThrow('scope singleton not disposed exactly once');
    expect(() => measureCase({
      createHarness: () => ({ shape: 'flat', size: 1, scopeDisposeCounts: () => [2] }),
    })).toThrow('scope singleton not disposed exactly once');
  });

  it('parent borrow check', () => {
    expect(() => measureCase({
      createHarness: () => ({
        shape: 'parent',
        size: 2,
        scopeDisposeCounts: () => [1],
        parentDisposeCounts: () => [1],
      }),
    })).toThrow('parent instance disposed by child destroy');
  });

  it('report environment', () => {
    const dir = tempDir();
    const reportPath = path.join(dir, 'runtime-report.json');
    const run = runBench(reportPath, {});
    expect(run.status).toBe(0);
    const report = readJson(reportPath);
    if (!isRuntimeReport(report)) throw new Error('invalid runtime report');
    expect(report.environment.node).toBe(process.version);
    expect(report.environment.typescript).toBe(ts.version);
    expect(report.environment.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(typeof report.environment.dirty).toBe('boolean');
    expect(report.environment.cpu.length).toBeGreaterThan(0);
    expect(report.params).toMatchObject({
      sizes: [10],
      shapes: ['flat'],
      profiles: ['full'],
      modes: ['open'],
      processes: 5,
      samples: 7,
    });
    expect(metricRows(report, 'warm-resolve')?.[0]?.length).toBe(7);
    expect(metricRows(report, 'build')?.length).toBe(5);
    expect(metricRows(report, 'build')?.[0]?.length).toBe(7);
    expect(metricRows(report, 'initialize')?.[0]?.length).toBe(7);
    expect(caseField(report, 'resolveCount')).toBe(1000);
    expect(caseField(report, 'error')).toBeUndefined();
  }, 180_000);

  it('compile failure is reported', () => {
    const dir = tempDir();
    const reportPath = path.join(dir, 'runtime-report.json');
    const run = runBench(reportPath, { NEOSYRINGE_BENCH_BROKEN: '1' });
    expect(run.status).toBe(1);
    const report = readJson(reportPath);
    expect(typeof caseField(report, 'error')).toBe('string');
    expect(String(caseField(report, 'error')).length).toBeGreaterThan(0);
  }, 180_000);

  it('case order alternates by process', () => {
    const dir = tempDir();
    const reportPath = path.join(dir, 'runtime-report.json');
    const run = runBench(reportPath, {
      NEOSYRINGE_BENCH_SHAPES: 'flat,chain',
      NEOSYRINGE_BENCH_RESOLVE_COUNT: '200',
    });
    expect(run.status).toBe(0);
    expect(scheduleKeys(readJson(reportPath))).toEqual([
      '0:flat', '0:chain',
      '1:chain', '1:flat',
      '2:flat', '2:chain',
      '3:chain', '3:flat',
      '4:flat', '4:chain',
    ]);
  }, 180_000);
});
