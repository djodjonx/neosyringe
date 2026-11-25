import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CORPUS, fixtureFiles, type CorpusFixture } from '../helpers/t03c1-corpus';
import { dumpFiles, type FixtureDump } from '../helpers/t03c1-dump';
import { DIVERGENCES, type Divergence } from './t03c1-divergences';

interface Golden {
  baseSha: string;
  fixtures: Record<string, FixtureDump>;
}

const GOLDEN: Golden = JSON.parse(readFileSync(path.join(__dirname, 't03c1-golden.base.json'), 'utf8'));

function normalized(dump: FixtureDump): unknown {
  return JSON.parse(JSON.stringify(dump));
}

function actualOf(fixture: CorpusFixture): unknown {
  return normalized(dumpFiles(fixtureFiles(fixture), fixture.validation ?? 'strict'));
}

function readPath(root: unknown, steps: readonly (string | number)[]): unknown {
  let current = root;
  for (const step of steps) {
    if (current === null || typeof current !== 'object') throw new Error(`path ${steps.join('.')} leaves the dump`);
    current = Reflect.get(current, step);
  }
  return current;
}

function writePath(root: unknown, steps: readonly (string | number)[], value: unknown): void {
  const parent = readPath(root, steps.slice(0, -1));
  const last = steps[steps.length - 1];
  if (parent === null || typeof parent !== 'object' || last === undefined) {
    throw new Error(`path ${steps.join('.')} leaves the dump`);
  }
  Reflect.set(parent, last, value);
}

/** The golden with the listed divergences applied. A stale `old` fails here, not silently. */
function expectedOf(name: string): unknown {
  const golden = GOLDEN.fixtures[name];
  if (!golden) throw new Error(`no golden for ${name}`);
  const expected = normalized(golden);
  for (const divergence of DIVERGENCES.filter((entry) => entry.fixture === name)) {
    expect(readPath(expected, divergence.path), `${divergence.id}: old value`).toEqual(divergence.old);
    writePath(expected, divergence.path, divergence.next);
  }
  return expected;
}

const cache = new Map<string, unknown>();
function cachedActual(fixture: CorpusFixture): unknown {
  let actual = cache.get(fixture.name);
  if (actual === undefined) {
    actual = actualOf(fixture);
    cache.set(fixture.name, actual);
  }
  return actual;
}

describe('T03 C1 parity with the base analyzer on the corpus', () => {
  it('P5 the golden was captured from base da6641b', () => {
    expect(GOLDEN.baseSha).toBe('da6641b');
    expect(Object.keys(GOLDEN.fixtures)).toEqual(CORPUS.map((fixture) => fixture.name));
  });

  for (const fixture of CORPUS) {
    it(`P5 ${fixture.name}: graphs, diagnostics, chains and positions equal base`, () => {
      expect(cachedActual(fixture)).toEqual(expectedOf(fixture.name));
    });
  }

  for (const divergence of DIVERGENCES) {
    const fixture = CORPUS.find((entry) => entry.name === divergence.fixture);
    it(`P5 divergence ${divergence.id}: ${divergence.reason}`, () => {
      if (!fixture) throw new Error(`unknown fixture ${divergence.fixture}`);
      expect(readPath(cachedActual(fixture), divergence.path)).toEqual(divergence.next);
    });
  }
});

export type { Divergence };
