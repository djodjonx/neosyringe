// One case, one process. The import sample is taken once: Node caches the module.
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { calibrateCase, measureCase, sampleMinimumNs, timerResolutionNs } from './lib/measure.mjs';

const modulePath = process.argv[2];
if (!modulePath) throw new Error('missing module');

const samples = Number(process.env.NEOSYRINGE_BENCH_SAMPLES || 7);
const batches = Number(process.env.NEOSYRINGE_BENCH_RESOLVE_BATCHES || 7);
const preset = process.env.NEOSYRINGE_BENCH_BATCH_K || '';
const calibrate = process.env.NEOSYRINGE_BENCH_CALIBRATE === '1';
const minimumText = process.env.NEOSYRINGE_BENCH_MINIMUM_NS || '';
if (!calibrate && !preset) throw new Error('missing batch k');

const started = performance.now();
const loaded = await import(pathToFileURL(modulePath).href);
const importNs = (performance.now() - started) * 1e6;
if (typeof loaded.createHarness !== 'function') throw new Error('missing createHarness');
const count = Number(loaded.benchResolveCount ?? process.env.NEOSYRINGE_BENCH_RESOLVE_COUNT ?? 100_000);
if (!Number.isInteger(count) || count < 1) throw new Error('positive sizes required');
const resolutionNs = timerResolutionNs();
const fromEnv = Number(minimumText);
const minimumNs = Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : sampleMinimumNs(resolutionNs);
const fixedK = preset ? JSON.parse(preset) : undefined;
if (calibrate) {
  const found = await calibrateCase({
    createHarness: loaded.createHarness,
    samples,
    batches,
    count,
    now: () => performance.now(),
    minimumNs,
    fixedK,
  });
  if (!found.k) throw new Error('missing batch k');
  process.stdout.write(`${JSON.stringify({
    flags: process.execArgv,
    timerResolutionNs: resolutionNs,
    sampleMinimumNs: minimumNs,
    k: found.k,
  })}\n`);
} else {
  const measured = await measureCase({
    createHarness: loaded.createHarness,
    samples,
    batches,
    count,
    now: () => performance.now(),
    minimumNs,
    fixedK,
  });
  if (!measured.metrics || !measured.k) throw new Error('missing metrics');
  process.stdout.write(`${JSON.stringify({
    flags: process.execArgv,
    count: measured.k['warm-resolve'],
    timerResolutionNs: resolutionNs,
    sampleMinimumNs: minimumNs,
    k: measured.k,
    metrics: {
      import: { unit: 'ns', samples: [importNs] },
      ...measured.metrics,
    },
  })}\n`);
}
