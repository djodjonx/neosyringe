import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { beforeAll, describe, expect, it } from 'vitest';

// scripts/measure-t17-size.mjs --json: size of the generated container (raw, minified, gzip, brotli)
// and of an open vs a closed bundle. The script reads packages/core/dist and packages/unplugin/dist:
// it needs a fresh `pnpm build`. No wall clock: only byte counts.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const script = path.join(repoRoot, 'scripts/measure-t17-size.mjs');
const run = promisify(execFile);

const VARIANTS = ['reference-full', 'optimized-full', 'optimized-minimal'] as const;
const METRICS = ['raw', 'minified', 'gzip', 'brotli'] as const;
const SENTINEL = 'T21_SENTINEL_UNREACHABLE';

type Metric = (typeof METRICS)[number];
type Sizes = Record<Metric, number>;

interface Report {
  node: string;
  compression: { input: string; gzipLevel: number; brotliQuality: number };
  variants: Record<(typeof VARIANTS)[number], Sizes>;
  sentinel: string;
  bundle: {
    open: Sizes & { containsSentinel: boolean };
    closed: Sizes & { containsSentinel: boolean };
    delta: Sizes;
  };
  run: { open: unknown; closed: unknown; equal: boolean };
}

async function measure(args: readonly string[] = ['--json']): Promise<string> {
  const { stdout } = await run(process.execPath, [script, ...args], { cwd: repoRoot, maxBuffer: 16 * 1024 * 1024 });
  return stdout;
}

const CONFIGS = ['open-debug-off', 'open-debug-on', 'closed-debug-off', 'closed-debug-on'] as const;

interface BreakdownPart {
  container: string;
  total: number;
  categories: Record<string, number>;
}

interface BreakdownRow {
  total: number;
  categories: Record<string, number>;
  parts: BreakdownPart[];
}

interface Breakdown {
  categories: string[];
  graphs: Array<{ label: string; providers: number; containers: number; configs: Record<(typeof CONFIGS)[number], BreakdownRow> }>;
}

describe('T17 size measure script', () => {
  let first = '';
  let second = '';
  let report: Report;
  let breakdown: Breakdown;

  beforeAll(async () => {
    // One after the other: the script bundles in a fixed directory per checkout, two runs of this checkout at once would clobber each other.
    // The test asserts no exact byte count: the sizes depend on the absolute path of the checkout.
    first = await measure();
    second = await measure();
    // The script must print one JSON object and nothing else: the table text is off in --json.
    expect(first.trimStart().startsWith('{')).toBe(true);
    report = JSON.parse(first) as Report;
    breakdown = JSON.parse(await measure(['--breakdown', '--json'])) as Breakdown;
  }, 120_000);

  it('T17-SIZE-P1 json lists the three variants with raw, minified, gzip, brotli and the levels', () => {
    expect(Object.keys(report.variants)).toEqual([...VARIANTS]);
    for (const variant of VARIANTS) {
      expect(Object.keys(report.variants[variant]).sort()).toEqual([...METRICS].sort());
    }
    expect(report.compression).toEqual({ input: 'minified', gzipLevel: 9, brotliQuality: 11 });
    expect(Object.keys(report.bundle.open).sort()).toEqual([...METRICS, 'containsSentinel'].sort());
    expect(Object.keys(report.bundle.closed).sort()).toEqual([...METRICS, 'containsSentinel'].sort());
    expect(Object.keys(report.bundle.delta).sort()).toEqual([...METRICS].sort());
  });

  it('T17-SIZE-P2 gzip and brotli are positive and smaller than raw', () => {
    const rows: Sizes[] = [...VARIANTS.map((variant) => report.variants[variant]), report.bundle.open, report.bundle.closed];
    expect(rows).toHaveLength(5);
    for (const row of rows) {
      expect(row.gzip).toBeGreaterThan(0);
      expect(row.brotli).toBeGreaterThan(0);
      expect(row.gzip).toBeLessThan(row.raw);
      expect(row.brotli).toBeLessThan(row.raw);
      expect(row.gzip).toBeLessThan(row.minified);
      expect(row.brotli).toBeLessThan(row.minified);
    }
  });

  it('T17-SIZE-P3 closed bundle drops the heavy sentinel and the delta is open minus closed', () => {
    const { open, closed, delta } = report.bundle;
    expect(report.sentinel).toBe(SENTINEL);
    expect(open.containsSentinel).toBe(true);
    expect(closed.containsSentinel).toBe(false);
    expect(closed.raw).toBeLessThan(open.raw);
    for (const metric of METRICS) {
      expect(delta[metric]).toBe(open[metric] - closed[metric]);
    }
    // The generated heavy provider is 500 methods of seeded literals (about 29 KB raw at the first run):
    // the closed bundle must lose most of it, not a few bytes.
    expect(delta.raw).toBeGreaterThan(20_000);
    expect(delta.gzip).toBeGreaterThan(1_000);
    expect(report.run.equal).toBe(true);
  });

  it('T17-SIZE-P4 two runs print the same json', () => {
    expect(JSON.parse(second)).toEqual(report);
    expect(second).toBe(first);
  });

  it('T17-SIZE-P5 --breakdown lists categories whose bytes sum to the class size, for four graph sizes and several small containers', () => {
    expect(breakdown.categories).toEqual(expect.arrayContaining(['creators', 'user-code']));
    const graphs = breakdown.graphs;
    expect(graphs.map((graph) => graph.label)).toEqual(['small', 'medium', 'large', 'many-small', 'above-threshold']);
    expect(graphs.map((graph) => graph.providers)).toEqual([3, 12, 48, 3, 200]);
    expect(graphs.map((graph) => graph.containers)).toEqual([1, 1, 1, 6, 1]);
    for (const graph of graphs) {
      for (const config of CONFIGS) {
        const row = graph.configs[config];
        expect(Object.keys(row.categories), `${graph.label} ${config}`).toEqual(breakdown.categories);
        const sum = Object.values(row.categories).reduce((total, bytes) => total + bytes, 0);
        expect(sum, `${graph.label} ${config}`).toBe(row.total);
        // Every member of the class has a category: nothing is folded into a neighbour, and the fixture has no import.
        expect(row.categories['other-members'], `${graph.label} ${config}`).toBe(0);
        expect(row.categories.imports, `${graph.label} ${config}`).toBe(0);
        for (const id of ['creators', 'user-code', 'accessors', 'factory-policy', 'resolve', 'lifecycle', 'events', 'runtime-helpers', 'state', 'class-shell', 'glue', 'debug-metadata']) {
          expect(row.categories[id], `${graph.label} ${config} ${id}`).toBeGreaterThan(0);
        }
        // The copied user factories are fixture text, not NeoSyringe code: they are their own category, and they are smaller than the creators around them.
        expect(row.categories['user-code'], `${graph.label} ${config} user-code`).toBeLessThan(row.categories.creators ?? 0);
      }
    }
    // The same text as the optimized-full row of --json (open, debug off): the categories cut that text, they do not measure another.
    const medium = graphs[1]?.configs['open-debug-off'];
    expect(medium?.total).toBe(report.variants['optimized-full'].raw);
    // Several small containers: each one is generated and categorized on its own, the row is the sum of the measured parts.
    for (const config of CONFIGS) {
      for (const graph of graphs) {
        const row = graph.configs[config];
        expect(row.parts, `${graph.label} ${config} parts`).toHaveLength(graph.containers);
        expect(row.parts.reduce((total, part) => total + part.total, 0), `${graph.label} ${config} total`).toBe(row.total);
        for (const id of breakdown.categories) {
          expect(row.parts.reduce((total, part) => total + (part.categories[id] ?? 0), 0), `${graph.label} ${config} ${id}`).toBe(row.categories[id]);
        }
        for (const part of row.parts) {
          const sum = Object.values(part.categories).reduce((total, bytes) => total + bytes, 0);
          expect(sum, `${graph.label} ${config} ${part.container}`).toBe(part.total);
          // The per-container categories are present in every container, not once for the file.
          for (const id of ['lifecycle', 'runtime-helpers', 'resolve', 'class-shell', 'creators', 'user-code']) {
            expect(part.categories[id], `${graph.label} ${config} ${part.container} ${id}`).toBeGreaterThan(0);
          }
        }
      }
      const many = graphs[3]?.configs[config];
      // Distinct containers: distinct names and distinct sizes, not one text counted again.
      expect(new Set(many?.parts.map((part) => part.container)).size, `many-small ${config} names`).toBe(6);
      expect(new Set(many?.parts.map((part) => part.total)).size, `many-small ${config} totals`).toBe(6);
    }
  });

  it('T17-SIZE-P6 --breakdown: debug metadata grows with the graph and only with debug on, closed drops the open dispatch tables', () => {
    expect(breakdown.categories).toEqual(expect.arrayContaining(['debug-metadata']));
    const [small, medium, large, , above] = breakdown.graphs;
    expect(above?.label).toBe('above-threshold');
    for (const graph of [small, medium, large, above]) {
      if (!graph) throw new Error('graph missing');
      for (const mode of ['open', 'closed'] as const) {
        const off = graph.configs[`${mode}-debug-off`];
        const on = graph.configs[`${mode}-debug-on`];
        expect(on.total, `${graph.label} ${mode}`).toBeGreaterThan(off.total);
        expect(on.categories['debug-metadata'], `${graph.label} ${mode}`).toBeGreaterThan(off.categories['debug-metadata'] ?? 0);
        // Debug adds the metadata and nothing else.
        expect(on.total - off.total, `${graph.label} ${mode}`).toBe((on.categories['debug-metadata'] ?? 0) - (off.categories['debug-metadata'] ?? 0));
      }
    }
    // The graphs small, medium and large hold 3, 12 and 48 providers (scripts/measure-t17-size.mjs:240-242), at most DISPATCH_LINEAR_MAX
    // (packages/core/src/generator/dispatchEmitter.ts:37): their open output has no table to drop, only the linear cases.
    // Where it has one, the closed output holds strictly less; it is never more.
    for (const graph of [small, medium, large]) {
      if (!graph) throw new Error('graph missing');
      const openTables = graph.configs['open-debug-off'].categories['dispatch-tables'] ?? 0;
      const closedTables = graph.configs['closed-debug-off'].categories['dispatch-tables'] ?? 0;
      expect(closedTables, graph.label).toBeLessThanOrEqual(openTables);
      if (openTables > 0) expect(closedTables, graph.label).toBeLessThan(openTables);
    }
    // The graph above the threshold (200 providers, more than DISPATCH_LINEAR_MAX) is where the open output has its table: it must hold bytes,
    // and the closed output, whose three roots are linear cases, must hold strictly less.
    expect(above?.providers).toBe(200);
    const aboveOpen = above?.configs['open-debug-off'].categories['dispatch-tables'] ?? 0;
    const aboveClosed = above?.configs['closed-debug-off'].categories['dispatch-tables'] ?? 0;
    expect(aboveOpen, 'above-threshold open').toBeGreaterThan(0);
    expect(aboveClosed, 'above-threshold closed').toBeLessThan(aboveOpen);
    const bytes = (graph: Breakdown['graphs'][number] | undefined, id: string): number => graph?.configs['open-debug-on'].categories[id] ?? 0;
    for (const id of ['creators', 'accessors', 'factory-policy', 'debug-metadata']) {
      expect(bytes(small, id), id).toBeLessThan(bytes(medium, id));
      expect(bytes(medium, id), id).toBeLessThan(bytes(large, id));
    }
  });
});
