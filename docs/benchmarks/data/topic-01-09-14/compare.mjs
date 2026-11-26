// Informative: per case and metric, median base vs candidate, ratio, and the budget rule flag.
import { readFileSync } from 'node:fs';
const [, , basePath, candPath] = process.argv;
const load = (p) => JSON.parse(readFileSync(p, 'utf8'));
const key = (c) => `${c.shape}|${c.profile}|${c.mode}|${c.size}`;
const base = new Map(load(basePath).cases.map((c) => [key(c), c]));
const rows = [];
for (const c of load(candPath).cases) {
  const b = base.get(key(c));
  if (!b) continue;
  if (b.error || c.error) { rows.push([key(c), 'error', b.error ? 'base: ' + String(b.error).slice(0, 60) : '-', c.error ? 'cand: ' + String(c.error).slice(0, 60) : '-']); continue; }
  for (const m of ['cold-resolve', 'warm-resolve', 'create', 'createScope', 'initialize', 'destroy']) {
    const bm = b.metrics?.[m], cm = c.metrics?.[m];
    if (!bm || !cm) continue;
    const ratio = cm.median / bm.median;
    const worse = cm.median > bm.median * 1.1 && cm.median - bm.median > 2 * (bm.mad + cm.mad);
    const better = bm.median > cm.median * 1.1 && bm.median - cm.median > 2 * (bm.mad + cm.mad);
    rows.push([key(c), m, bm.median.toFixed(1), cm.median.toFixed(1), ratio.toFixed(2), worse ? 'WORSE' : better ? 'better' : '~']);
  }
  const bs = b.module, cs = c.module;
  if (bs && cs) rows.push([key(c), 'min bytes', bs.min, cs.min, (cs.min / bs.min).toFixed(2), '']);
}
for (const r of rows) console.log(r.join('\t'));
