// One case, one process. The import sample is taken once: Node caches the module.
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { measureCase } from './lib/measure.mjs';

const modulePath = process.argv[2];
if (!modulePath) throw new Error('missing module');

const samples = Number(process.env.NEOSYRINGE_BENCH_SAMPLES || 7);
const batches = Number(process.env.NEOSYRINGE_BENCH_RESOLVE_BATCHES || 7);

const started = performance.now();
const loaded = await import(pathToFileURL(modulePath).href);
const importNs = (performance.now() - started) * 1e6;
if (typeof loaded.createHarness !== 'function') throw new Error('missing createHarness');
const count = Number(loaded.benchResolveCount ?? process.env.NEOSYRINGE_BENCH_RESOLVE_COUNT ?? 100_000);
if (!Number.isInteger(count) || count < 1) throw new Error('positive sizes required');
const measured = await measureCase({
  createHarness: loaded.createHarness,
  samples,
  batches,
  count,
});
if (!measured.metrics) throw new Error('missing metrics');
process.stdout.write(`${JSON.stringify({
  flags: process.execArgv,
  count,
  metrics: {
    import: { unit: 'ns', samples: [importNs] },
    ...measured.metrics,
  },
})}\n`);
