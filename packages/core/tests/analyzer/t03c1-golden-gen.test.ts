import { writeFileSync } from 'node:fs';
import { describe, it } from 'vitest';
import { CORPUS, fixtureFiles } from '../helpers/t03c1-corpus';
import { dumpFiles, type FixtureDump } from '../helpers/t03c1-dump';

/**
 * Golden generator. It is skipped unless T03C1_GOLDEN_OUT names an output file.
 * It was run ONCE, on base da6641b, in a throw-away worktree with only the helper files copied in.
 * The golden is never regenerated to make P5 pass.
 */
const OUT = process.env.T03C1_GOLDEN_OUT;
const BASE_SHA = process.env.T03C1_BASE_SHA ?? 'unknown';

describe.skipIf(OUT === undefined)('T03 C1 golden capture from base', () => {
  it('writes the golden JSON', () => {
    const fixtures: Record<string, FixtureDump> = {};
    for (const fixture of CORPUS) {
      fixtures[fixture.name] = dumpFiles(fixtureFiles(fixture), fixture.validation ?? 'strict');
    }
    writeFileSync(OUT ?? '', `${JSON.stringify({ baseSha: BASE_SHA, fixtures }, null, 2)}\n`);
  });
});
