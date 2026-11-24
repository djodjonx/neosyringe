// Resolution kernel. A fresh process calls measureCase once.
// A wrong instance is refused before that batch is kept.
import { performance } from 'node:perf_hooks';

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

export function benchmarkResolve({ resolve, size, count = 100_000, batches = 7, perCall = 1 }) {
  if (!Number.isInteger(batches) || batches < 1) throw new Error('positive batches required');
  if (!Number.isInteger(perCall) || perCall < 1) throw new Error('positive sizes required');
  const order = makeOrder(size, count);
  const expected = order.reduce((sum, index) => sum + index, 0);
  const samples = [];
  for (let batch = -2; batch < batches; batch += 1) {
    let checksum = 0;
    const start = performance.now();
    for (const index of order) checksum += resolve(index).value;
    const elapsed = performance.now() - start;
    if (checksum !== expected) throw new Error('incorrect resolution');
    if (batch >= 0) samples.push((elapsed * 1e6) / (count * perCall));
  }
  return { metric: 'warm-resolve', unit: 'ns/op', ...summarize(samples) };
}

export function verifyScopeRelease(counts) {
  if (!Array.isArray(counts) || counts.length === 0 || counts.some((count) => count !== 1)) {
    throw new Error('scope singleton not disposed exactly once');
  }
}

async function repeat(count, run) {
  const samples = [];
  for (let index = 0; index < count; index += 1) samples.push(await run());
  return samples;
}

async function timeCase(harness, input, scopeCounts, parentCounts) {
  const samples = input.samples ?? 7;
  const batches = input.batches ?? 7;
  const count = input.count ?? 100_000;
  const resolve = harness.resolve;
  const warm = benchmarkResolve({
    resolve,
    size: harness.size,
    count,
    batches,
    perCall: harness.resolvePerCall ?? 1,
  });
  const coldIndex = harness.coldIndex ?? harness.size - 1;
  const cold = [];
  for (let index = 0; index < samples; index += 1) {
    // recreate() builds the next container. settle() releases that container once.
    if (typeof harness.recreate === 'function') await harness.recreate();
    const started = performance.now();
    const instance = resolve(coldIndex);
    const elapsed = performance.now() - started;
    if (!instance || instance.value !== coldIndex) throw new Error('incorrect resolution');
    if (typeof harness.settle === 'function') await harness.settle();
    cold.push(elapsed * 1e6);
  }
  const created = await repeat(samples, () => harness.timeCreate());
  const createdScope = await repeat(samples, () => harness.timeCreateScope());
  const initialized = await repeat(samples, () => harness.timeInitialize());
  const destroyed = await repeat(samples, () => harness.timeDestroy());
  const heap = await repeat(samples, () => harness.heapAfterGc());
  return {
    scopeCounts,
    parentCounts,
    metrics: {
      create: { unit: 'ns', samples: created },
      'warm-resolve': { unit: 'ns/op', samples: warm.samples },
      'cold-resolve': { unit: 'ns', samples: cold },
      createScope: { unit: 'ns', samples: createdScope },
      initialize: { unit: 'ns', samples: initialized },
      destroy: { unit: 'ns', samples: destroyed },
      heapAfterGc: { unit: 'bytes', samples: heap },
    },
  };
}

function isPromise(value) {
  return typeof value === 'object' && value !== null && typeof value.then === 'function';
}

function parentCountsOf(counts) {
  const parentCounts = [...counts];
  if (parentCounts.length === 0 || parentCounts.some((count) => count !== 0)) {
    throw new Error('parent instance disposed by child destroy');
  }
  return parentCounts;
}

function afterParent(harness, input, scopeCounts, parentCounts) {
  if (typeof harness.resolve !== 'function') return { scopeCounts, parentCounts };
  return timeCase(harness, input, scopeCounts, parentCounts);
}

function afterScope(harness, input, scopeCounts) {
  verifyScopeRelease(scopeCounts);
  if (harness.shape !== 'parent') return afterParent(harness, input, scopeCounts, []);
  if (typeof harness.parentDisposeCounts !== 'function') {
    throw new Error('parent instance disposed by child destroy');
  }
  const pending = harness.parentDisposeCounts();
  if (isPromise(pending)) {
    return pending.then((counts) => afterParent(harness, input, scopeCounts, parentCountsOf(counts)));
  }
  return afterParent(harness, input, scopeCounts, parentCountsOf(pending));
}

function begin(harness, input) {
  const pending = harness.scopeDisposeCounts();
  if (isPromise(pending)) return pending.then((counts) => afterScope(harness, input, counts));
  return afterScope(harness, input, pending);
}

export function measureCase(input) {
  const created = input.createHarness();
  if (isPromise(created)) return created.then((harness) => begin(harness, input));
  return begin(created, input);
}
