import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { neoSyringePlugin } from '../src/index';

vi.mock('typescript', async (importOriginal) => {
  const actual = await importOriginal<typeof import('typescript')>();
  return {
    ...actual,
    findConfigFile: vi.fn().mockReturnValue('/project/tsconfig.json'),
    readConfigFile: vi.fn().mockReturnValue({ config: {} }),
    parseJsonConfigFileContent: vi.fn().mockReturnValue({ options: {}, fileNames: [], errors: [] }),
  };
});

/**
 * Regression test: a bare class token (`{ token: SomeClass }`, not an
 * interface token) registered in a `useContainer` parent used to be
 * impossible to wire into a child — FactoryEmitter had no way to reference
 * the parent's class from the child's generated code, and failed the build
 * with a clear error instead of silently emitting `undefined`.
 *
 * The generator now captures the class's symbol from the parent's
 * registration and emits an explicit namespace import in the child's
 * generated code (getForeignImport), so `this.resolve(TheClass)` correctly
 * references the exact same class value the parent's own resolveLocal()
 * compares by identity — even though the child file itself only ever
 * `import type`s that class (see child-root.ts: SharedRepo is never in the
 * child's own runtime scope).
 */
describe('Plugin — cross-file bare class token wiring', () => {
  const FIXTURES_DIR = path.join(__dirname, '__fixtures__', 'cross-file-class-token');
  const CHILD_FILE = path.join(FIXTURES_DIR, 'child-root.ts');

  beforeEach(() => vi.clearAllMocks());

  function makeTransform() {
    const plugin = neoSyringePlugin.vite();
    // @ts-expect-error - testing specific method
    return plugin.transform as (code: string, id: string) => string | undefined;
  }

  it('wires the auto-wired consumer to the cross-file class token via an explicit import, not undefined', () => {
    const transform = makeTransform();
    const childCode = fs.readFileSync(CHILD_FILE, 'utf8');

    const result = transform(childCode, CHILD_FILE) ?? childCode;

    expect(result).not.toContain('new ConsumerA(undefined)');
    // Referenced through an explicit namespace import of the parent's file, not a bare
    // "SharedRepo" identifier (which would be a ReferenceError — the child file only
    // ever imports the *type*, never the runtime value).
    expect(result).toMatch(/import \* as __neo_Import_\d+ from '\.\/parent-root';/);
    expect(result).toMatch(/new ConsumerA\(this\.resolve\(__neo_Import_\d+\.SharedRepo\)\)/);
  });

  it('does not throw building the child', () => {
    const transform = makeTransform();
    const childCode = fs.readFileSync(CHILD_FILE, 'utf8');
    expect(() => transform(childCode, CHILD_FILE)).not.toThrow();
  });
});
