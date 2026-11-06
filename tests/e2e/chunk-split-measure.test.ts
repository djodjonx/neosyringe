import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { beforeAll, describe, expect, it } from 'vitest';

// scripts/measure-chunk-split.mjs --json: per-chunk bytes of an esbuild ESM split.
// The script reads packages/unplugin/dist. No wall clock: each it only reads the JSON.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const script = path.join(repoRoot, 'scripts/measure-chunk-split.mjs');
const run = promisify(execFile);

const IDS = ['open-full', 'open-minimal', 'closed-full', 'closed-minimal', 'control-static'] as const;
const SPLIT = ['open-full', 'open-minimal', 'closed-full', 'closed-minimal'] as const;
const ENV_KEYS = ['node', 'zlib', 'os', 'cpu', 'esbuild', 'typescript', 'neosyringe'] as const;

interface Chunk {
  role: 'initial' | 'deferred';
  entry: boolean;
  raw: number;
  minified: number;
  gzip: number;
  brotli: number;
  containsSentinel: boolean;
  containsMarker: boolean;
}

interface Scenario {
  mode: string;
  profile: string;
  result: { tag: string; marker: string };
  rawResult: { tag: string; marker: string };
  chunks: Chunk[];
}

interface Report {
  command: string;
  bundler: string;
  env: Record<(typeof ENV_KEYS)[number], string>;
  compression: { input: string; gzipLevel: number; brotliQuality: number };
  scenarios: Record<(typeof IDS)[number], Scenario>;
}

async function measure(): Promise<string> {
  const { stdout } = await run(process.execPath, [script, '--json'], { cwd: repoRoot, maxBuffer: 16 * 1024 * 1024 });
  return stdout;
}

describe('chunk split measure script', () => {
  let first = '';
  let second = '';
  let report: Report;

  beforeAll(async () => {
    // One after the other: the script builds in a fixed directory per checkout.
    first = await measure();
    second = await measure();
    expect(first.trimStart().startsWith('{')).toBe(true);
    report = JSON.parse(first) as Report;
  }, 120_000);

  it('CHUNK-SPLIT-P1 json lists 4 scenarios plus control, chunk fields, levels and env', () => {
    expect(Object.keys(report.scenarios)).toEqual([...IDS]);
    expect(report.command).toBe('node scripts/measure-chunk-split.mjs --json');
    expect(report.bundler).toBe('esbuild');
    expect(report.compression).toEqual({ input: 'minified', gzipLevel: 9, brotliQuality: 11 });
    expect(Object.keys(report.env).sort()).toEqual([...ENV_KEYS].sort());
    for (const key of ENV_KEYS) expect(report.env[key]).toEqual(expect.any(String));
    expect(report.env.zlib.length).toBeGreaterThan(0);
    for (const id of IDS) {
      expect(report.scenarios[id].chunks.length).toBeGreaterThan(0);
      for (const chunk of report.scenarios[id].chunks) {
        expect(chunk).toEqual(expect.objectContaining({
          role: expect.stringMatching(/^(initial|deferred)$/),
          raw: expect.any(Number),
          minified: expect.any(Number),
          gzip: expect.any(Number),
          brotli: expect.any(Number),
        }));
      }
    }
  });

  it('CHUNK-SPLIT-P2 each split scenario has one initial entry chunk and at least one deferred chunk', () => {
    for (const id of SPLIT) {
      const chunks = report.scenarios[id].chunks;
      expect(chunks.filter((chunk) => chunk.entry && chunk.role === 'initial')).toHaveLength(1);
      expect(chunks.filter((chunk) => chunk.role === 'deferred').length).toBeGreaterThanOrEqual(1);
    }
  });

  it('CHUNK-SPLIT-P3 sentinel only in deferred, container marker only in initial', () => {
    for (const id of SPLIT) {
      const chunks = report.scenarios[id].chunks;
      const deferred = chunks.filter((chunk) => chunk.role === 'deferred');
      const initial = chunks.filter((chunk) => chunk.role === 'initial');
      expect(deferred.length).toBeGreaterThan(0);
      expect(initial.length).toBeGreaterThan(0);
      expect(deferred.every((chunk) => chunk.containsSentinel && !chunk.containsMarker)).toBe(true);
      expect(initial.every((chunk) => chunk.containsMarker && !chunk.containsSentinel)).toBe(true);
    }
  });

  it('CHUNK-SPLIT-P4 static control has zero deferred chunks and the sentinel in the initial chunk', () => {
    const chunks = report.scenarios['control-static'].chunks;
    expect(chunks.filter((chunk) => chunk.role === 'deferred')).toHaveLength(0);
    expect(chunks.some((chunk) => chunk.role === 'initial' && chunk.containsSentinel)).toBe(true);
  });

  it('CHUNK-SPLIT-P5 gzip and brotli are positive and smaller than raw', () => {
    for (const id of IDS) {
      for (const chunk of report.scenarios[id].chunks) {
        expect(chunk.raw).toBeGreaterThan(0);
        expect(chunk.minified).toBeGreaterThan(0);
        expect(chunk.gzip).toBeGreaterThan(0);
        expect(chunk.brotli).toBeGreaterThan(0);
        expect(chunk.gzip).toBeLessThan(chunk.raw);
        expect(chunk.brotli).toBeLessThan(chunk.raw);
      }
    }
    for (const id of SPLIT) {
      const chunks = report.scenarios[id].chunks;
      const initial = chunks.find((chunk) => chunk.role === 'initial');
      const deferred = chunks.find((chunk) => chunk.role === 'deferred');
      expect(initial?.gzip).not.toBe(deferred?.gzip);
      expect(initial?.brotli).not.toBe(deferred?.brotli);
    }
  });

  it('CHUNK-SPLIT-P6 executed results are equal and the heavy provider ran', () => {
    const expected = {
      tag: 'CHUNK_SPLIT_HEAVY',
      marker: 'CHUNK_SPLIT_CONTAINER',
    };
    for (const id of IDS) {
      expect(report.scenarios[id].result).toEqual(expected);
      expect(report.scenarios[id].rawResult).toEqual(expected);
    }
  });

  it('CHUNK-SPLIT-P7 two runs print the same json', () => {
    expect(second).toBe(first);
  });
});
