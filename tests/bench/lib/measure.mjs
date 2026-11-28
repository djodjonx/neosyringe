// Resolution kernel. A fresh process calls measureCase once.
// A wrong instance is refused before that batch is kept.
// create, createScope, initialize, destroy and cold-resolve time k operations.
// prepare, gc, check and release stay outside the clock.
// Calibration (calibrateCase) picks k until one probe lasts twice the minimum.
// Its samples are not kept. A prescribed k is checked like a kept sample:
// one probe under the minimum is an error, a probe at or above it keeps k.
// Measurement at a fixed k never grows it. Two warmup batches are discarded.
// A kept sample under the minimum is counted in shortSamples.
import { performance } from 'node:perf_hooks';

export const SAMPLE_MINIMUM_TICKS = 1000;
export const SAMPLE_MINIMUM_FLOOR_NS = 1_000_000;
const BATCH_CAP = 10_000_000;
const WARMUP_BATCHES = 2;

export function makeOrder(size, count, seed = 0x12345678) {
  if (!Number.isInteger(size) || size < 1 || !Number.isInteger(count) || count < 1) {
    throw new Error('positive sizes required');
  }
  let state = seed >>> 0 || 1;
  return Uint32Array.from({ length: count }, () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) % size;
  });
}

export function summarize(samples) {
  if (!samples.length || samples.some((value) => !Number.isFinite(value))) {
    throw new Error('finite samples required');
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return {
    median: sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2,
    min: sorted[0],
    max: sorted.at(-1),
    samples: [...samples],
  };
}

export function timerResolutionNs(now = () => performance.now()) {
  let previous = now();
  let best = 0;
  for (let sample = 0; sample < 20; sample += 1) {
    let next = now();
    let guard = 0;
    while (next === previous) {
      next = now();
      guard += 1;
      if (guard > 100_000) throw new Error('positive timer resolution required');
    }
    const delta = next - previous;
    if (delta > 0 && (best === 0 || delta < best)) best = delta;
    previous = next;
  }
  if (!(best > 0)) throw new Error('positive timer resolution required');
  return best * 1e6;
}

export function sampleMinimumNs(resolutionNs) {
  if (!Number.isFinite(resolutionNs) || resolutionNs <= 0) {
    throw new Error('positive timer resolution required');
  }
  return Math.max(SAMPLE_MINIMUM_FLOOR_NS, Math.ceil(resolutionNs * SAMPLE_MINIMUM_TICKS));
}

function nextK(current, elapsedNs, minimumNs) {
  let snapped;
  if (!(elapsedNs > 0)) snapped = Math.max(current * 10, 10);
  else {
    const perOp = elapsedNs / current;
    const needed = Math.ceil((minimumNs * 2) / perOp);
    snapped = 10 ** Math.ceil(Math.log10(Math.max(needed, 1)));
    if (snapped <= current) snapped = current * 10;
  }
  return Math.min(snapped, BATCH_CAP);
}

function fits(elapsedNs, minimumNs, slack) {
  if (!(minimumNs > 0)) return true;
  return elapsedNs >= (slack ? minimumNs * 2 : minimumNs);
}

function assertCovers(elapsedNs, minimumNs) {
  if (!fits(elapsedNs, minimumNs, false)) throw new Error('batch k exceeded');
}

function perOpNs(elapsedNs, width, perCall) {
  return elapsedNs / (width * perCall);
}

export function benchmarkResolve({
  resolve,
  size,
  count = 100_000,
  batches = 7,
  perCall = 1,
  now = () => performance.now(),
  minimumNs = 0,
  fixedCount,
  lockCount = false,
}) {
  if (!Number.isInteger(batches) || batches < 1) throw new Error('positive batches required');
  if (!Number.isInteger(perCall) || perCall < 1) throw new Error('positive sizes required');
  let used = fixedCount ?? count;
  if (!Number.isInteger(used) || used < 1) throw new Error('positive sizes required');
  const run = (width) => {
    const order = makeOrder(size, width);
    let expected = 0;
    for (const index of order) expected += index;
    let checksum = 0;
    const started = now();
    for (const index of order) checksum += resolve(index).value;
    const elapsedNs = (now() - started) * 1e6;
    if (checksum !== expected) throw new Error('incorrect resolution');
    return elapsedNs;
  };
  if (lockCount) {
    const elapsed = run(used);
    assertCovers(elapsed, minimumNs);
    return {
      metric: 'warm-resolve',
      unit: 'ns/op',
      ...summarize([perOpNs(elapsed, used, perCall)]),
      count: used,
      shortSamples: 0,
    };
  }
  if (fixedCount !== undefined) {
    const samples = [];
    let shortSamples = 0;
    for (let batch = -WARMUP_BATCHES; batch < batches; batch += 1) {
      const elapsed = run(used);
      if (batch < 0) continue;
      if (!fits(elapsed, minimumNs, false)) shortSamples += 1;
      samples.push(perOpNs(elapsed, used, perCall));
    }
    return { metric: 'warm-resolve', unit: 'ns/op', ...summarize(samples), count: used, shortSamples };
  }
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const samples = [];
    let shortNs;
    for (let batch = -WARMUP_BATCHES; batch < batches; batch += 1) {
      const elapsed = run(used);
      if (!fits(elapsed, minimumNs, true)) {
        shortNs = elapsed;
        break;
      }
      if (batch >= 0) samples.push(perOpNs(elapsed, used, perCall));
    }
    if (shortNs === undefined) {
      return { metric: 'warm-resolve', unit: 'ns/op', ...summarize(samples), count: used, shortSamples: 0 };
    }
    const grown = nextK(used, shortNs, minimumNs);
    if (grown <= used) throw new Error('batch could not reach the minimum duration');
    used = grown;
  }
  throw new Error('batch could not reach the minimum duration');
}

export function verifyScopeRelease(counts) {
  if (!Array.isArray(counts) || counts.length === 0 || counts.some((count) => count !== 1)) {
    throw new Error('scope singleton not disposed exactly once');
  }
}

function isPromise(value) {
  return typeof value === 'object' && value !== null && typeof value.then === 'function';
}

function fixedOf(fixedK, name) {
  if (fixedK === undefined) return undefined;
  const value = fixedK[name];
  if (!Number.isInteger(value) || value < 1) throw new Error('positive sizes required');
  return value;
}

function opOf(batches, name) {
  const op = batches?.[name];
  if (!op || typeof op.time !== 'function' || typeof op.check !== 'function') throw new Error('missing batch');
  return op;
}

function gcOf(gc) {
  return gc ?? (() => { globalThis.gc?.(); });
}

async function takeBatch(op, k, now, gc) {
  const state = typeof op.prepare === 'function' ? await op.prepare(k) : undefined;
  gc();
  const started = now();
  const items = await op.time(state, k);
  const elapsedNs = (now() - started) * 1e6;
  if (!Array.isArray(items) || items.length !== k) throw new Error('batch length mismatch');
  for (let index = 0; index < items.length; index += 1) await op.check(items[index], index);
  if (typeof op.release === 'function') await op.release(state, items);
  return elapsedNs;
}

async function measureFixed(op, sampleCount, now, minimumNs, k, gc) {
  const samples = [];
  let shortSamples = 0;
  for (let batch = -WARMUP_BATCHES; batch < sampleCount; batch += 1) {
    const elapsed = await takeBatch(op, k, now, gc);
    if (batch < 0) continue;
    if (!fits(elapsed, minimumNs, false)) shortSamples += 1;
    samples.push(elapsed / k);
  }
  return { k, samples, shortSamples };
}

async function searchK(op, now, minimumNs, gc, locked) {
  if (locked !== undefined) {
    const elapsed = await takeBatch(op, locked, now, gc);
    assertCovers(elapsed, minimumNs);
    return locked;
  }
  let k = 1;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const elapsed = await takeBatch(op, k, now, gc);
    if (fits(elapsed, minimumNs, true)) return k;
    const grown = nextK(k, elapsed, minimumNs);
    if (grown <= k) throw new Error('batch could not reach the minimum duration');
    k = grown;
  }
  throw new Error('batch could not reach the minimum duration');
}

async function collectSamples(op, sampleCount, now, minimumNs, fixed, gc) {
  if (fixed !== undefined) return measureFixed(op, sampleCount, now, minimumNs, fixed, gc);
  let k = 1;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const kept = [];
    let shortNs;
    while (kept.length < sampleCount) {
      const elapsed = await takeBatch(op, k, now, gc);
      if (!fits(elapsed, minimumNs, true)) {
        shortNs = elapsed;
        break;
      }
      kept.push(elapsed / k);
    }
    if (shortNs === undefined) return { k, samples: kept, shortSamples: 0 };
    const grown = nextK(k, shortNs, minimumNs);
    if (grown <= k) throw new Error('batch could not reach the minimum duration');
    k = grown;
  }
  throw new Error('batch could not reach the minimum duration');
}

async function repeat(count, run) {
  const samples = [];
  for (let index = 0; index < count; index += 1) samples.push(await run());
  return samples;
}

function timedMetric(unit, row) {
  return { unit, samples: row.samples, shortSamples: row.shortSamples ?? 0 };
}

async function timeCase(harness, input, scopeCounts, parentCounts) {
  const sampleCount = input.samples ?? 7;
  const batches = input.batches ?? 7;
  const count = input.count ?? 100_000;
  const now = input.now ?? (() => performance.now());
  const minimumNs = input.minimumNs ?? 0;
  const gc = gcOf(input.gc);
  const resolve = harness.resolve;
  const warm = benchmarkResolve({
    resolve,
    size: harness.size,
    count,
    batches,
    perCall: harness.resolvePerCall ?? 1,
    now,
    minimumNs,
    fixedCount: fixedOf(input.fixedK, 'warm-resolve'),
  });
  const ops = harness.batches;
  const cold = await collectSamples(opOf(ops, 'cold-resolve'), sampleCount, now, minimumNs, fixedOf(input.fixedK, 'cold-resolve'), gc);
  const created = await collectSamples(opOf(ops, 'create'), sampleCount, now, minimumNs, fixedOf(input.fixedK, 'create'), gc);
  const createdScope = await collectSamples(opOf(ops, 'createScope'), sampleCount, now, minimumNs, fixedOf(input.fixedK, 'createScope'), gc);
  const initialized = await collectSamples(opOf(ops, 'initialize'), sampleCount, now, minimumNs, fixedOf(input.fixedK, 'initialize'), gc);
  const destroyed = await collectSamples(opOf(ops, 'destroy'), sampleCount, now, minimumNs, fixedOf(input.fixedK, 'destroy'), gc);
  const heap = await repeat(sampleCount, () => harness.heapAfterGc());
  return {
    scopeCounts,
    parentCounts,
    k: {
      create: created.k,
      createScope: createdScope.k,
      initialize: initialized.k,
      destroy: destroyed.k,
      'cold-resolve': cold.k,
      'warm-resolve': warm.count,
    },
    metrics: {
      create: timedMetric('ns', created),
      'warm-resolve': timedMetric('ns/op', warm),
      'cold-resolve': timedMetric('ns', cold),
      createScope: timedMetric('ns', createdScope),
      initialize: timedMetric('ns', initialized),
      destroy: timedMetric('ns', destroyed),
      heapAfterGc: { unit: 'bytes', samples: heap },
    },
  };
}

async function calibrateTimed(harness, input, scopeCounts, parentCounts) {
  const count = input.count ?? 100_000;
  const now = input.now ?? (() => performance.now());
  const minimumNs = input.minimumNs ?? 0;
  const gc = gcOf(input.gc);
  const locked = input.fixedK !== undefined;
  const warm = benchmarkResolve({
    resolve: harness.resolve,
    size: harness.size,
    count,
    batches: 1,
    perCall: harness.resolvePerCall ?? 1,
    now,
    minimumNs,
    fixedCount: fixedOf(input.fixedK, 'warm-resolve'),
    lockCount: locked,
  });
  const ops = harness.batches;
  const cold = await searchK(opOf(ops, 'cold-resolve'), now, minimumNs, gc, fixedOf(input.fixedK, 'cold-resolve'));
  const created = await searchK(opOf(ops, 'create'), now, minimumNs, gc, fixedOf(input.fixedK, 'create'));
  const createdScope = await searchK(opOf(ops, 'createScope'), now, minimumNs, gc, fixedOf(input.fixedK, 'createScope'));
  const initialized = await searchK(opOf(ops, 'initialize'), now, minimumNs, gc, fixedOf(input.fixedK, 'initialize'));
  const destroyed = await searchK(opOf(ops, 'destroy'), now, minimumNs, gc, fixedOf(input.fixedK, 'destroy'));
  return {
    scopeCounts,
    parentCounts,
    k: {
      create: created,
      createScope: createdScope,
      initialize: initialized,
      destroy: destroyed,
      'cold-resolve': cold,
      'warm-resolve': warm.count,
    },
  };
}

function parentCountsOf(counts) {
  const parentCounts = [...counts];
  if (parentCounts.length === 0 || parentCounts.some((count) => count !== 0)) {
    throw new Error('parent instance disposed by child destroy');
  }
  return parentCounts;
}

function afterParent(harness, input, scopeCounts, parentCounts, calibrate) {
  if (typeof harness.resolve !== 'function') return { scopeCounts, parentCounts };
  if (calibrate) return calibrateTimed(harness, input, scopeCounts, parentCounts);
  return timeCase(harness, input, scopeCounts, parentCounts);
}

function afterScope(harness, input, scopeCounts, calibrate) {
  verifyScopeRelease(scopeCounts);
  if (harness.shape !== 'parent') return afterParent(harness, input, scopeCounts, [], calibrate);
  if (typeof harness.parentDisposeCounts !== 'function') {
    throw new Error('parent instance disposed by child destroy');
  }
  const pending = harness.parentDisposeCounts();
  if (isPromise(pending)) {
    return pending.then((counts) => afterParent(harness, input, scopeCounts, parentCountsOf(counts), calibrate));
  }
  return afterParent(harness, input, scopeCounts, parentCountsOf(pending), calibrate);
}

function begin(harness, input, calibrate) {
  const pending = harness.scopeDisposeCounts();
  if (isPromise(pending)) return pending.then((counts) => afterScope(harness, input, counts, calibrate));
  return afterScope(harness, input, pending, calibrate);
}

export function measureCase(input) {
  const created = input.createHarness();
  if (isPromise(created)) return created.then((harness) => begin(harness, input, false));
  return begin(created, input, false);
}

export function calibrateCase(input) {
  const created = input.createHarness();
  if (isPromise(created)) return created.then((harness) => begin(harness, input, true));
  return begin(created, input, true);
}
