import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { assertDistFresh, executeFixture } from './helpers/execute-fixture';

// `constructed` in the result counts constructions during this run only.
// A second run() on the same module reports 0: the singleton already exists.
const VALID_SERVICE = `
import { defineBuilderConfig } from '@djodjonx/neosyringe';

let constructed = 0;

class Service {
  constructor() {
    constructed += 1;
  }
}

export const c = defineBuilderConfig({
  injections: [{ token: Service }],
});

export function run() {
  const before = constructed;
  const first = c.resolve(Service);
  const second = c.resolve(Service);
  return { same: first === second, constructed: constructed - before };
}
`;

const MISSING_CONSTRUCTOR_DEPENDENCY = `
import { defineBuilderConfig } from '@djodjonx/neosyringe';

class MissingDependency {}
class Service {
  constructor(public dep: MissingDependency) {}
}

export const c = defineBuilderConfig({
  injections: [{ token: Service }],
});

export function run() {
  return c.resolve(Service);
}
`;

const NO_MARKERS = `
export function run() {
  return { plain: true };
}
`;

const LOAD_THROWS = `
throw new Error('module body failed');

export function run() {
  return 1;
}
`;

const PROVIDER_THROWS = `
import { defineBuilderConfig } from '@djodjonx/neosyringe';

class Service {
  constructor() {
    throw new Error('provider exploded');
  }
}

export const c = defineBuilderConfig({
  injections: [{ token: Service }],
});

export function run() {
  return c.resolve(Service);
}
`;

const PROGRAM_A = `
import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';

interface IFromA { id: number }
class Impl implements IFromA { id = 1; }

export const c = defineBuilderConfig({
  injections: [{ token: useInterface<IFromA>(), provider: Impl }],
});

export function run() {
  return c.resolve(useInterface<IFromA>()).id;
}
`;

const PROGRAM_B = `
import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';

interface IFromA { id: number }

export const c = defineBuilderConfig({
  injections: [],
});

export function run() {
  return c.resolve(useInterface<IFromA>());
}
`;

const PUBLISHED_SHA256 = [
  ['audit-runtime.mjs', '9543b1ac4b2526268218fa4831b692408432b15ab8472fa4a77672893b35ef8e'],
  ['audit-edge-cases.mjs', '0097a31e1f6124e57201cec3e08aa8a9c89b344fe61294a9505722e6b956b199'],
  ['audit-types.mjs', 'cf62e8e137115d930c66f4fa07db5608cdcaae185c3a8cf365aa793f0ac551d7'],
  ['audit-devtools.mjs', 'a30b036455076b80e6155570e45638ff84a651ab9a54be74c6af79f0d4a52b45'],
  ['audit-tree-shaking.mjs', 'fd014a6c22f47f9aa8855707f739f84292012ca7f15e0b9aed9ddecbc8e5004c'],
] as const;

describe('T00 reference harness', () => {
  it('T00-A01', async () => {
    const outcome = await executeFixture(VALID_SERVICE);
    expect(outcome.phase).toBe('ok');
    expect(outcome.phase === 'ok' ? outcome.value : undefined).toEqual({ same: true, constructed: 1 });
  });

  it('T00-A02', async () => {
    const missingConstructor = await executeFixture(MISSING_CONSTRUCTOR_DEPENDENCY);
    expect(missingConstructor.phase).toBe('build');
    expect(missingConstructor.phase === 'build' ? missingConstructor.diagnostic : '').toMatch(/Missing injection/);

    const provider = await executeFixture(PROVIDER_THROWS);
    expect(provider.phase).toBe('runtime');
    expect(provider.phase === 'runtime' ? provider.error : '').toMatch(/provider exploded/);
  });

  it('T00-no-markers', async () => {
    const outcome = await executeFixture(NO_MARKERS);
    expect(outcome.phase).toBe('ok');
    expect(outcome.phase === 'ok' ? outcome.value : undefined).toEqual({ plain: true });
    expect(outcome.phase === 'ok' ? outcome.transformed : true).toBe(false);
  });

  it('T00-load-throw', async () => {
    const outcome = await executeFixture(LOAD_THROWS);
    expect(outcome.phase).toBe('runtime');
    expect(outcome.phase === 'runtime' ? outcome.error : '').toMatch(/module body failed/);
    expect(outcome.phase === 'runtime' ? outcome.stage : '').toBe('load');
  });

  it('T00-run-throw', async () => {
    const outcome = await executeFixture(PROVIDER_THROWS);
    expect(outcome.phase).toBe('runtime');
    expect(outcome.phase === 'runtime' ? outcome.error : '').toMatch(/provider exploded/);
    expect(outcome.phase === 'runtime' ? outcome.stage : '').toBe('run');
  });

  it('T00-second-call', async () => {
    const first = await executeFixture(VALID_SERVICE);
    const second = await executeFixture(VALID_SERVICE);
    expect(first.phase === 'ok' ? first.value : undefined).toEqual({ same: true, constructed: 1 });
    expect(second.phase === 'ok' ? second.value : undefined).toEqual({ same: true, constructed: 1 });
  });

  it('T00-dist-check', () => {
    const missing = path.join(tmpdir(), 't00-missing-dist.mjs');
    expect(() => assertDistFresh(missing, tmpdir())).toThrow(/pnpm build/);
  });

  it('T00-dist-check (staleness)', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 't00-dist-'));
    const srcDir = path.join(dir, 'src');
    const srcFile = path.join(srcDir, 'index.ts');
    const distFile = path.join(dir, 'dist', 'index.mjs');
    try {
      mkdirSync(srcDir, { recursive: true });
      mkdirSync(path.dirname(distFile), { recursive: true });
      writeFileSync(srcFile, 'export {}\n');
      writeFileSync(distFile, '');
      const older = new Date('2020-01-01T00:00:00Z');
      const newer = new Date('2024-01-01T00:00:00Z');
      utimesSync(distFile, older, older);
      utimesSync(srcFile, newer, newer);
      expect(() => assertDistFresh(distFile, srcDir)).toThrow(/pnpm build/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('T00-A05', async () => {
    const programA = await executeFixture(PROGRAM_A);
    const programB = await executeFixture(PROGRAM_B);
    expect(programA.phase).toBe('ok');
    expect(programA.phase === 'ok' ? programA.value : undefined).toBe(1);
    expect(programB.phase).toBe('build');
    const diagnostic = programB.phase === 'build' ? programB.diagnostic : '';
    expect(diagnostic).toContain('useInterface<IFromA>');
    expect(diagnostic).toContain('is not registered in any container');
  });

  it('T00-digests', () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
    const manifest = readFileSync(path.join(root, 'audit/historical/SHA256SUMS'), 'utf8');
    for (const [filename, published] of PUBLISHED_SHA256) {
      const bytes = readFileSync(path.join(root, 'audit/historical', filename));
      const digest = createHash('sha256').update(bytes).digest('hex');
      expect(digest).toBe(published);
      expect(manifest).toContain(`${digest}  ${filename}`);
    }
  });
});
