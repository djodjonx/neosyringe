// CI budget. A median regresses only when it is both relatively and absolutely outside the noise.
function median(sorted) {
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function distribution(samples) {
  if (samples.length < 5 || samples.some((value) => !Number.isFinite(value) || value <= 0)) {
    throw new Error('five positive process medians required');
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const center = median(sorted);
  return {
    median: center,
    mad: median(sorted.map((value) => Math.abs(value - center)).sort((a, b) => a - b)),
    samples: [...samples],
  };
}

export function compareBudget(baseline, candidate) {
  const ratio = candidate.median / baseline.median;
  const noise = 2 * (baseline.mad + candidate.mad);
  const delta = candidate.median - baseline.median;
  if (ratio > 1.1 && delta > noise) return { verdict: 'fail', ratio, noise };
  if (noise > baseline.median * 0.1) return { verdict: 'inconclusive', ratio, noise };
  return { verdict: 'pass', ratio, noise };
}

export function caseKey(item) {
  return `${item.shape}|${item.profile}|${item.mode}|${item.size}`;
}

// k is compared per case below: an errored case has no k.
function comparableParams(params) {
  const rest = { ...params };
  delete rest.k;
  return JSON.stringify(rest);
}

function assertBatchK(baseline, candidate) {
  const left = baseline.params?.k ?? {};
  const right = candidate.params?.k ?? {};
  const measured = new Map((baseline.cases ?? []).filter((item) => !item.error).map((item) => [caseKey(item), item]));
  for (const item of candidate.cases ?? []) {
    const key = caseKey(item);
    if (item.error || !measured.has(key)) continue;
    if (JSON.stringify(left[key]) !== JSON.stringify(right[key])) throw new Error(`params mismatch: k ${key}`);
  }
}

function assertEnvironment(baseline, candidate) {
  if (baseline.environment.node !== candidate.environment.node) throw new Error('environment mismatch: node');
  if (baseline.environment.typescript !== candidate.environment.typescript) {
    throw new Error('environment mismatch: typescript');
  }
  if (baseline.environment.cpu !== candidate.environment.cpu) throw new Error('environment mismatch: cpu');
  if (baseline.environment.flags !== candidate.environment.flags) throw new Error('environment mismatch: flags');
  if (comparableParams(baseline.params) !== comparableParams(candidate.params)) throw new Error('params mismatch');
}

function assertMetric(name, metric, size) {
  const processes = metric.processes ?? [];
  const short = processes.some((row) => !Array.isArray(row) || row.length < 7);
  // Sizes 1000 and 5000 keep one group of 7 parent compiles. A 5×7 rebuild is too slow.
  if (name === 'build' && size >= 1000) {
    if (processes.length < 1 || short) throw new Error('at least 7 samples per process and 5 processes required');
    return;
  }
  if (processes.length < 5) throw new Error('at least 7 samples per process and 5 processes required');
  // import runs once per process: the module cache blocks a second sample.
  if (name === 'import') return;
  if (short) throw new Error('at least 7 samples per process and 5 processes required');
}

export function assertReport(baseline, candidate) {
  if ((baseline.cases ?? []).length === 0 && (candidate.cases ?? []).length === 0) {
    throw new Error('report has no case');
  }
  assertEnvironment(baseline, candidate);
  assertBatchK(baseline, candidate);
  const names = [];
  for (const report of [baseline, candidate]) {
    for (const item of report.cases ?? []) {
      if (item.error) continue;
      for (const [name, metric] of Object.entries(item.metrics ?? {})) {
        assertMetric(name, metric, item.size);
        names.push(name);
      }
    }
  }
  return names;
}
