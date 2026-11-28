// Experiment: retained bytes per initialized box (k boxes kept alive, heapUsed after gc).
import path from 'node:path'; import { pathToFileURL } from 'node:url';
const k = Number(process.env.K || 20000);
for (const file of process.argv.slice(2)) {
  const m = await import(pathToFileURL(path.resolve(file)).href + '?x=' + Math.random());
  const h = await m.createHarness();
  globalThis.gc(); globalThis.gc();
  const before = process.memoryUsage().heapUsed;
  const boxes = await h.batches['cold-resolve'].prepare(k);
  globalThis.gc(); globalThis.gc();
  const after = process.memoryUsage().heapUsed;
  console.log(path.basename(file), 'bytes/box', ((after - before) / k).toFixed(0));
  await h.batches['cold-resolve'].release(boxes);
}
