import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import * as ts from 'typescript';
import {
  SAMPLE_MINIMUM_FLOOR_NS,
  benchmarkResolve,
  calibrateCase,
  makeOrder,
  measureCase,
  sampleMinimumNs,
  summarize,
} from '../bench/lib/measure.mjs';
import type { BatchOp, BenchHarness, CheckResult, TimedResult } from '../bench/lib/measure.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const bench = path.join(root, 'tests/bench/runtime-cost.mjs');
const worker = path.join(root, 'tests/bench/runtime-worker.mjs');
const batchKNames = ['create', 'createScope', 'initialize', 'destroy', 'cold-resolve', 'warm-resolve'] as const;
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
  timerResolutionNs?: number;
}

interface RuntimeParams {
  sizes: number[];
  shapes: string[];
  profiles: string[];
  modes: string[];
  processes: number;
  samples: number;
  sampleMinimumNs?: number;
  k?: unknown;
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

function metricField(report: unknown, name: string, field: string): unknown {
  if (!isRecord(report) || !Array.isArray(report.cases)) return undefined;
  const item = report.cases[0];
  if (!isRecord(item) || !isRecord(item.metrics)) return undefined;
  const metric = item.metrics[name];
  if (!isRecord(metric)) return undefined;
  return metric[field];
}

function caseField(report: unknown, name: string): unknown {
  if (!isRecord(report) || !Array.isArray(report.cases)) return undefined;
  const item = report.cases[0];
  if (!isRecord(item)) return undefined;
  return item[name];
}

function idleBatch(): BatchOp {
  return {
    time(_state, k) {
      return Array.from({ length: k }, () => ({ ok: true }));
    },
    check() {},
  };
}

function isTimed(value: CheckResult | TimedResult): value is TimedResult {
  return 'metrics' in value && 'k' in value;
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

function fixedBatchK(width: number): Record<(typeof batchKNames)[number], number> {
  const row = {
    create: width,
    createScope: width,
    initialize: width,
    destroy: width,
    'cold-resolve': width,
    'warm-resolve': width,
  };
  return row;
}

function isWidthRow(value: unknown): value is Record<string, number> {
  if (!isRecord(value)) return false;
  return batchKNames.every((name) => {
    const width = value[name];
    return typeof width === 'number' && Number.isInteger(width) && width >= 1;
  });
}

function kTable(value: unknown): unknown {
  if (!isRecord(value) || !isRecord(value.params)) throw new Error('missing batch k');
  return value.params.k;
}

function doubleFlatK(value: unknown): void {
  if (!isRecord(value) || !isRecord(value.params) || !isRecord(value.params.k)) {
    throw new Error('missing batch k');
  }
  const row = value.params.k['flat|full|open|10'];
  if (!isWidthRow(row)) throw new Error('missing batch k');
  for (const name of batchKNames) {
    const width = row[name];
    if (width === undefined) throw new Error('missing batch k');
    const next = width * 2;
    if (next > 200_000) throw new Error('batch k exceeded');
    row[name] = next;
  }
}

const tinyBench = {
  NEOSYRINGE_BENCH_PROCESSES: '1',
  NEOSYRINGE_BENCH_SAMPLES: '1',
  NEOSYRINGE_BENCH_RESOLVE_BATCHES: '1',
  NEOSYRINGE_BENCH_RESOLVE_COUNT: '100',
};

function burnHarness(nsPerOp: number) {
  let virtualNs = 0;
  const now = () => virtualNs / 1e6;
  const burn = (ops: number) => {
    virtualNs += ops * nsPerOp;
  };
  const op = (): BatchOp => ({
    prepare() {},
    time(_state, k) {
      burn(k);
      return Array.from({ length: k }, () => ({ ok: true }));
    },
    check() {},
    release() {},
  });
  const createHarness = (): BenchHarness => ({
    shape: 'flat',
    size: 4,
    scopeDisposeCounts: () => [1],
    resolve(index) {
      burn(1);
      return { value: index };
    },
    heapAfterGc: () => 1,
    batches: {
      create: op(),
      createScope: op(),
      initialize: op(),
      destroy: op(),
      'cold-resolve': op(),
    },
  });
  return { now, createHarness };
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
    let tick = 0;
    const now = () => {
      tick += 1;
      return tick;
    };
    const resolve = (index: number) => ({ value: index });
    const once = benchmarkResolve({
      resolve, size: 4, count: 20, batches: 1, perCall: 1, now, minimumNs: 0,
    });
    const scaled = benchmarkResolve({
      resolve, size: 4, count: 20, batches: 1, perCall: 10, now, minimumNs: 0,
    });
    expect(once.median / scaled.median).toBe(10);
  });

  it('cold resolve wrong instance', async () => {
    const harness: BenchHarness = {
      shape: 'flat',
      size: 1,
      coldIndex: 0,
      scopeDisposeCounts: () => [1],
      resolve: (index) => ({ value: index }),
      heapAfterGc: () => 1,
      batches: {
        create: idleBatch(),
        createScope: idleBatch(),
        initialize: idleBatch(),
        destroy: idleBatch(),
        'cold-resolve': {
          time(_state, k) {
            return Array.from({ length: k }, () => ({ value: 99 }));
          },
          check(item) {
            if (typeof item !== 'object' || item === null || !('value' in item) || item.value !== 0) {
              throw new Error('incorrect resolution');
            }
          },
        },
      },
    };
    const pending = measureCase({
      createHarness: () => harness,
      samples: 1,
      batches: 1,
      count: 1,
      minimumNs: 0,
    });
    expect(pending).toBeInstanceOf(Promise);
    await expect(pending).rejects.toThrow('incorrect resolution');
  });

  it('sample minimum is at least 1 ms and 1000 ticks', () => {
    expect(sampleMinimumNs(41.67)).toBe(SAMPLE_MINIMUM_FLOOR_NS);
    expect(sampleMinimumNs(2_000)).toBe(2_000_000);
    expect(() => sampleMinimumNs(0)).toThrow('positive timer resolution required');
  });

  it('batch size grows until the sample reaches the minimum', async () => {
    let virtualMs = 0;
    const stepMs = 0.01;
    const now = () => virtualMs;
    const op = (): BatchOp => ({
      time(_state, k) {
        const items = [];
        for (let index = 0; index < k; index += 1) {
          virtualMs += stepMs;
          items.push({ ok: true });
        }
        return items;
      },
      check(item) {
        if (typeof item !== 'object' || item === null || !('ok' in item) || item.ok !== true) {
          throw new Error('bad batch object');
        }
      },
    });
    const pending = measureCase({
      now,
      minimumNs: SAMPLE_MINIMUM_FLOOR_NS,
      samples: 2,
      batches: 1,
      count: 1,
      createHarness: () => ({
        shape: 'flat',
        size: 4,
        scopeDisposeCounts: () => [1],
        resolve: (index) => {
          virtualMs += stepMs;
          return { value: index };
        },
        heapAfterGc: () => 1,
        batches: {
          create: op(),
          createScope: op(),
          initialize: op(),
          destroy: op(),
          'cold-resolve': op(),
        },
      }),
    });
    const result = await pending;
    if (!isTimed(result)) throw new Error('missing metrics');
    const timed = ['create', 'createScope', 'initialize', 'destroy', 'cold-resolve'] as const;
    for (const name of timed) {
      const width = result.k[name];
      expect(width).toBeGreaterThan(1);
      for (const sample of result.metrics[name].samples) {
        expect(sample * width).toBeGreaterThanOrEqual(SAMPLE_MINIMUM_FLOOR_NS);
      }
    }
    const warmK = result.k['warm-resolve'];
    expect(warmK).toBeGreaterThan(1);
    for (const sample of result.metrics['warm-resolve'].samples) {
      expect(sample * warmK).toBeGreaterThanOrEqual(SAMPLE_MINIMUM_FLOOR_NS);
    }
  });

  it('one bad object in a batch is refused', async () => {
    let virtualMs = 0;
    const stepMs = 0.01;
    const now = () => virtualMs;
    const good = (): BatchOp => ({
      time(_state, k) {
        for (let index = 0; index < k; index += 1) virtualMs += stepMs;
        return Array.from({ length: k }, () => ({ ok: true }));
      },
      check() {},
    });
    const pending = measureCase({
      now,
      minimumNs: SAMPLE_MINIMUM_FLOOR_NS,
      samples: 1,
      batches: 1,
      count: 1,
      createHarness: () => ({
        shape: 'flat',
        size: 2,
        scopeDisposeCounts: () => [1],
        resolve: (index) => {
          virtualMs += stepMs;
          return { value: index };
        },
        heapAfterGc: () => 1,
        batches: {
          create: {
            time(_state, k) {
              const items = [];
              for (let index = 0; index < k; index += 1) {
                virtualMs += stepMs;
                items.push({ ok: !(k > 1 && index === k - 1) });
              }
              return items;
            },
            check(item) {
              if (typeof item !== 'object' || item === null || !('ok' in item) || item.ok !== true) {
                throw new Error('bad batch object');
              }
            },
          },
          createScope: good(),
          initialize: good(),
          destroy: good(),
          'cold-resolve': good(),
        },
      }),
    });
    await expect(pending).rejects.toThrow('bad batch object');
  });

  it('a batch length mismatch is refused', async () => {
    const pending = measureCase({
      minimumNs: 0,
      samples: 1,
      batches: 1,
      count: 1,
      createHarness: () => ({
        shape: 'flat',
        size: 1,
        scopeDisposeCounts: () => [1],
        resolve: (index) => ({ value: index }),
        heapAfterGc: () => 1,
        batches: {
          create: {
            time() {
              return [];
            },
            check() {},
          },
          createScope: idleBatch(),
          initialize: idleBatch(),
          destroy: idleBatch(),
          'cold-resolve': idleBatch(),
        },
      }),
    });
    await expect(pending).rejects.toThrow('batch length mismatch');
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
    expect(report.environment.timerResolutionNs).toBeGreaterThan(0);
    expect(report.params.sampleMinimumNs).toBeGreaterThanOrEqual(SAMPLE_MINIMUM_FLOOR_NS);
    if (!isRecord(report.params.k)) throw new Error('missing batch k');
    const row = report.params.k['flat|full|open|10'];
    if (!isRecord(row)) throw new Error('missing batch k');
    for (const name of ['create', 'createScope', 'initialize', 'destroy', 'cold-resolve', 'warm-resolve']) {
      const value = row[name];
      if (typeof value !== 'number') throw new Error(`missing batch k ${name}`);
      expect(value).toBeGreaterThan(0);
    }
    expect(metricRows(report, 'warm-resolve')?.[0]?.length).toBe(7);
    expect(metricRows(report, 'build')?.length).toBe(5);
    expect(metricRows(report, 'build')?.[0]?.length).toBe(7);
    expect(metricRows(report, 'initialize')?.[0]?.length).toBe(7);
    const warmK = row['warm-resolve'];
    if (typeof warmK !== 'number') throw new Error('missing batch k warm-resolve');
    expect(warmK).toBeGreaterThanOrEqual(1000);
    expect(caseField(report, 'resolveCount')).toBe(warmK);
    expect(caseField(report, 'error')).toBeUndefined();
    expect(typeof metricField(report, 'create', 'shortSamples')).toBe('number');
  }, 180_000);

  it('P29 the dispatch threshold reaches the generated code and the report, and a bad value is refused', () => {
    const dir = tempDir();
    const written = (value: string | undefined): unknown => {
      const reportPath = path.join(dir, `dispatch-${value ?? 'unset'}.json`);
      const env = value === undefined ? tinyBench : { ...tinyBench, NEOSYRINGE_BENCH_DISPATCH_LINEAR_MAX: value };
      const run = runBench(reportPath, env);
      expect(run.status, run.stderr).toBe(0);
      return readJson(reportPath);
    };
    const moduleBytes = (report: unknown): number => {
      const module = isRecord(report) && Array.isArray(report.cases) && isRecord(report.cases[0]) ? report.cases[0].module : undefined;
      if (!isRecord(module) || typeof module.raw !== 'number') throw new Error('missing module size');
      return module.raw;
    };
    // scripts/ci/lib/performance-budget.mjs:34-38,51-58 compares `params` minus `k` and four fields of `environment`: nothing else.
    const comparable = (report: unknown): string => {
      if (!isRecord(report) || !isRecord(report.params)) throw new Error('missing params');
      const rest = { ...report.params };
      delete rest.k;
      return JSON.stringify(rest);
    };
    const echoed = (report: unknown): unknown => (isRecord(report) ? report.config : undefined);
    const always = written('0');
    const never = written('Infinity');
    const unset = written(undefined);
    expect(echoed(always)).toEqual({ dispatchLinearMax: '0' });
    expect(echoed(never)).toEqual({ dispatchLinearMax: 'Infinity' });
    expect(echoed(unset)).toBeUndefined();
    // Ten providers: the linear cases are a smaller module than the table.
    expect(moduleBytes(never)).toBeLessThan(moduleBytes(always));
    expect(comparable(always)).toBe(comparable(unset));
    expect(comparable(never)).toBe(comparable(unset));
    for (const bad of ['abc', '-1', '1.5']) {
      const run = runBench(path.join(dir, `bad-${bad}.json`), { ...tinyBench, NEOSYRINGE_BENCH_DISPATCH_LINEAR_MAX: bad });
      expect(run.status, bad).not.toBe(0);
      expect(run.stderr, bad).toContain('NEOSYRINGE_BENCH_DISPATCH_LINEAR_MAX');
    }
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

  it('a fixed k records a short sample', async () => {
    const clock = burnHarness(1000);
    const result = await measureCase({
      now: clock.now,
      gc: () => {},
      minimumNs: SAMPLE_MINIMUM_FLOOR_NS,
      samples: 2,
      batches: 2,
      count: 10,
      fixedK: fixedBatchK(10),
      createHarness: clock.createHarness,
    });
    if (!isTimed(result)) throw new Error('missing metrics');
    expect(result.k.create).toBe(10);
    expect(result.k['warm-resolve']).toBe(10);
    expect(result.metrics.create.samples).toHaveLength(2);
    expect(result.metrics.create.shortSamples).toBe(2);
    expect(result.metrics['warm-resolve'].samples).toHaveLength(2);
    expect(result.metrics['warm-resolve'].shortSamples).toBe(2);
  });

  it('gc runs after prepare and before the timer', async () => {
    const events: string[] = [];
    let virtualMs = 0;
    const now = () => virtualMs;
    const op = (name: string): BatchOp => ({
      prepare() {
        events.push(`${name}:prepare`);
      },
      time(_state, k) {
        events.push(`${name}:time`);
        virtualMs += 0.01;
        return Array.from({ length: k }, () => ({ ok: true }));
      },
      check() {
        events.push(`${name}:check`);
      },
      release() {
        events.push(`${name}:release`);
      },
    });
    await measureCase({
      now,
      gc: () => {
        events.push('gc');
      },
      minimumNs: 0,
      samples: 1,
      batches: 1,
      count: 1,
      fixedK: fixedBatchK(1),
      createHarness: () => ({
        shape: 'flat',
        size: 2,
        scopeDisposeCounts: () => [1],
        resolve: (index) => ({ value: index }),
        heapAfterGc: () => 1,
        batches: {
          create: op('create'),
          createScope: op('createScope'),
          initialize: op('initialize'),
          destroy: op('destroy'),
          'cold-resolve': op('cold-resolve'),
        },
      }),
    });
    const start = events.indexOf('create:prepare');
    expect(events.slice(start, start + 5)).toEqual([
      'create:prepare',
      'gc',
      'create:time',
      'create:check',
      'create:release',
    ]);
  });

  it('a measurement worker without k is refused', () => {
    const env = { ...process.env };
    delete env.NEOSYRINGE_BENCH_BATCH_K;
    delete env.NEOSYRINGE_BENCH_CALIBRATE;
    const run = spawnSync(process.execPath, [worker, path.join(root, 'package.json')], {
      encoding: 'utf8',
      cwd: root,
      env,
    });
    expect(run.status).not.toBe(0);
    expect(`${run.stdout}\n${run.stderr}`).toContain('missing batch k');
  });

  it('prescribed k is stable across a snap boundary', async () => {
    const input = {
      minimumNs: SAMPLE_MINIMUM_FLOOR_NS,
      samples: 1,
      batches: 1,
      count: 1,
    };
    const slow = burnHarness(2100);
    const fast = burnHarness(1900);
    const aloneSlow = await calibrateCase({ ...input, now: slow.now, createHarness: slow.createHarness });
    const aloneFast = await calibrateCase({ ...input, now: fast.now, createHarness: fast.createHarness });
    expect(aloneSlow.k.create).toBe(1000);
    expect(aloneFast.k.create).toBe(10_000);
    expect(aloneSlow.k['warm-resolve']).toBe(1000);
    expect(aloneFast.k['warm-resolve']).toBe(10_000);
    const prescribed = fixedBatchK(10_000);
    const lockedSlow = await calibrateCase({
      ...input,
      now: slow.now,
      createHarness: slow.createHarness,
      fixedK: prescribed,
    });
    const lockedFast = await calibrateCase({
      ...input,
      now: fast.now,
      createHarness: fast.createHarness,
      fixedK: prescribed,
    });
    expect(lockedSlow.k).toEqual(lockedFast.k);
    expect(lockedSlow.k.create).toBe(10_000);
    expect(lockedFast.k['warm-resolve']).toBe(10_000);
  });

  it('a locked k whose probe covers the minimum once is kept', async () => {
    for (const nsPerOp of [1900, 1000]) {
      const clock = burnHarness(nsPerOp);
      const input = {
        now: clock.now,
        minimumNs: SAMPLE_MINIMUM_FLOOR_NS,
        samples: 1,
        batches: 1,
        count: 1,
        fixedK: fixedBatchK(1000),
        createHarness: clock.createHarness,
      };
      const found = await calibrateCase(input);
      expect(found.k).toEqual(fixedBatchK(1000));
      const fresh = burnHarness(nsPerOp);
      const result = await measureCase({ ...input, now: fresh.now, createHarness: fresh.createHarness });
      if (!isTimed(result)) throw new Error('missing metrics');
      expect(result.k).toEqual(fixedBatchK(1000));
      expect(result.metrics.create.shortSamples).toBe(0);
      expect(result.metrics['warm-resolve'].shortSamples).toBe(0);
    }
  });

  it('a prescribed k that is too small is refused', async () => {
    const clock = burnHarness(900);
    const pending = calibrateCase({
      now: clock.now,
      minimumNs: SAMPLE_MINIMUM_FLOOR_NS,
      samples: 1,
      batches: 1,
      count: 1,
      fixedK: fixedBatchK(1000),
      createHarness: clock.createHarness,
    });
    await expect(pending).rejects.toThrow('batch k exceeded');
  });

  it('K_FROM keeps params.k', () => {
    const dir = tempDir();
    const firstPath = path.join(dir, 'a.json');
    const secondPath = path.join(dir, 'b.json');
    const first = runBench(firstPath, tinyBench);
    expect(first.status).toBe(0);
    const report = readJson(firstPath);
    doubleFlatK(report);
    writeFileSync(firstPath, `${JSON.stringify(report)}\n`);
    const second = runBench(secondPath, { ...tinyBench, NEOSYRINGE_BENCH_K_FROM: firstPath });
    expect(second.status).toBe(0);
    const again = readJson(secondPath);
    expect(kTable(again)).toEqual(kTable(report));
  }, 180_000);

  it('K_FROM rejects a k that cannot reach the minimum', () => {
    const dir = tempDir();
    const source = path.join(dir, 'k.json');
    const reportPath = path.join(dir, 'out.json');
    writeFileSync(source, `${JSON.stringify({ params: { k: { 'flat|full|open|10': fixedBatchK(1) } } })}\n`);
    const run = runBench(reportPath, { ...tinyBench, NEOSYRINGE_BENCH_K_FROM: source });
    expect(run.status).toBe(1);
    expect(String(caseField(readJson(reportPath), 'error'))).toContain('batch k exceeded');
  }, 180_000);

  it('K_FROM missing case is an error', () => {
    const dir = tempDir();
    const source = path.join(dir, 'k.json');
    const reportPath = path.join(dir, 'out.json');
    writeFileSync(source, `${JSON.stringify({ params: { k: {} } })}\n`);
    const run = runBench(reportPath, { ...tinyBench, NEOSYRINGE_BENCH_K_FROM: source });
    expect(run.status).toBe(1);
    expect(String(caseField(readJson(reportPath), 'error'))).toContain('missing batch k');
  }, 180_000);
});
