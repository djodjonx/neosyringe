// One alias-bench case, one process (like runtime-worker.mjs): no other case ever shares its `resolve` call site or its
// JIT state. The module is the compiled container the parent wrote; nothing is timed before the functional check passed.
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';

const [modulePath, tokenName, lifecycle, name] = process.argv.slice(2);
if (!modulePath || !tokenName || !lifecycle || !name) throw new Error('usage: alias-worker.mjs <module> <token export> <lifecycle> <case name>');
const samples = Number(process.env.NEOSYRINGE_BENCH_SAMPLES || 5);
const count = Number(process.env.NEOSYRINGE_BENCH_COUNT || 1_000_000);
const warmup = 2;

const loaded = createRequire(import.meta.url)(modulePath);
const { box } = loaded;
const token = loaded[tokenName];
const target = loaded.Engine;

/** Nothing is timed before the container answers what a read of the target answers. */
function check() {
  const viaToken = box.resolve(token);
  const direct = box.resolve(target);
  if (viaToken === null || typeof viaToken !== 'object' || viaToken.id !== 'engine') throw new Error(`${name}: not an Engine`);
  if (lifecycle === 'singleton' && viaToken !== direct) throw new Error(`${name}: not the object of the target`);
  if (lifecycle === 'transient' && (viaToken === direct || box.resolve(token) === viaToken)) {
    throw new Error(`${name}: a transient must be a new object at every read`);
  }
}

function batch() {
  let sink;
  const started = performance.now();
  for (let index = 0; index < count; index += 1) sink = box.resolve(token);
  const elapsed = performance.now() - started;
  if (sink === undefined) throw new Error(`${name}: a read answered nothing`);
  return (elapsed * 1e6) / count;
}

check();
for (let index = 0; index < warmup; index += 1) batch();
const taken = [];
for (let index = 0; index < samples; index += 1) taken.push(batch());
process.stdout.write(`${JSON.stringify({ name, samples: taken })}\n`);
