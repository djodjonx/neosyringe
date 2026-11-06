import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildWithVite, buildWithWebpack, errorText, type BundlerBuild } from './helpers/bundler-builds';
import { runBundle } from './helpers/t21-bundle';

// Real production builds of tests/e2e/fixtures/t21-closed. One build per fixture
// per bundler, shared by the asserts below. Needs a fresh `pnpm build`.

const fixtureDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/t21-closed');
const SENTINEL = 'T21_SENTINEL_UNREACHABLE';
const EFFECT = 'T21_EFFECT_REQUIRED';
const CLOSED_OPTION = "optimization: { mode: 'closed', roots: [pipeline], eager: [worker] },";

const MISSING_PROVIDER = `
import { defineBuilderConfig, useInterface } from '@djodjonx/neosyringe';

interface IFromA { id: number }

export const c = defineBuilderConfig({
  injections: [],
});

export function run() {
  return c.resolve(useInterface<IFromA>());
}
`;

function fixture(name: string): string {
  return readFileSync(path.join(fixtureDir, name), 'utf8');
}

function namesOf(value: unknown): unknown {
  if (value !== null && typeof value === 'object' && 'names' in value) return value.names;
  return undefined;
}

describe('T22 real bundlers', () => {
  let viteOpen: BundlerBuild;
  let viteClosed: BundlerBuild;
  let webpackOpen: BundlerBuild;
  let webpackClosed: BundlerBuild;
  let viteMissing: unknown;
  let webpackMissing: unknown;

  beforeAll(async () => {
    const app = fixture('app.ts');
    expect(app).toContain(CLOSED_OPTION);
    const heavy = fixture('heavy.ts');
    const openFiles = { 'app.ts': app.replace(CLOSED_OPTION, ''), 'heavy.ts': heavy };
    const closedFiles = { 'app.ts': app, 'heavy.ts': heavy };
    const missingFiles = { 'app.ts': MISSING_PROVIDER };

    viteOpen = await buildWithVite(openFiles);
    viteClosed = await buildWithVite(closedFiles);
    try {
      viteMissing = await buildWithVite(missingFiles);
    } catch (error) {
      viteMissing = error;
    }
    webpackOpen = await buildWithWebpack(openFiles);
    webpackClosed = await buildWithWebpack(closedFiles);
    try {
      webpackMissing = await buildWithWebpack(missingFiles);
    } catch (error) {
      webpackMissing = error;
    }
  });

  it('T22 vite open bundle returns names and keeps the sentinel', async () => {
    expect(namesOf(await runBundle(viteOpen.code))).toEqual(['auth', 'log']);
    expect(viteOpen.code).toContain(SENTINEL);
  });

  it('T22 webpack open bundle returns names and keeps the sentinel', async () => {
    expect(namesOf(await runBundle(webpackOpen.code))).toEqual(['auth', 'log']);
    expect(webpackOpen.code).toContain(SENTINEL);
  });

  it('T22 vite closed bundle drops the sentinel and runs the effect', async () => {
    expect(viteClosed.code).not.toContain(SENTINEL);
    expect(viteClosed.code).toContain(EFFECT);
    expect(await runBundle(viteClosed.code)).toEqual({
      names: ['auth', 'log'],
      workerStarts: 1,
      effects: [EFFECT],
    });
  });

  it('T22 webpack closed bundle drops the sentinel and runs the effect', async () => {
    expect(webpackClosed.code).not.toContain(SENTINEL);
    expect(webpackClosed.code).toContain(EFFECT);
    expect(await runBundle(webpackClosed.code)).toEqual({
      names: ['auth', 'log'],
      workerStarts: 1,
      effects: [EFFECT],
    });
  });

  it('T22 vite build rejects NEO_MISSING_PROVIDER', () => {
    expect(viteMissing).toBeInstanceOf(Error);
    const text = errorText(viteMissing);
    expect(text).toContain('NEO_MISSING_PROVIDER');
    expect(text).toContain('IFromA');
  });

  it('T22 webpack compile fails with NEO_MISSING_PROVIDER', () => {
    expect(webpackMissing).toBeInstanceOf(Error);
    const text = errorText(webpackMissing);
    expect(text).toContain('NEO_MISSING_PROVIDER');
    expect(text).toContain('IFromA');
  });
});
