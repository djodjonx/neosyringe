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

async function measure(): Promise<string> {
  const { stdout } = await run(process.execPath, [script, '--json'], { cwd: repoRoot, maxBuffer: 16 * 1024 * 1024 });
  return stdout;
}

describe('T17 size measure script', () => {
  let first = '';
  let second = '';
  let report: Report;

  beforeAll(async () => {
    // One after the other: the script bundles in a fixed directory per checkout, two runs of this checkout at once would clobber each other.
    // The test asserts no exact byte count: the sizes depend on the absolute path of the checkout.
    first = await measure();
    second = await measure();
    // The script must print one JSON object and nothing else: the table text is off in --json.
    expect(first.trimStart().startsWith('{')).toBe(true);
    report = JSON.parse(first) as Report;
  }, 60_000);

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
});
