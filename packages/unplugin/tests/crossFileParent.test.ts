import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { neoSyringePlugin } from '../src/index';

// Minimal tsconfig mock (same pattern as multiContainer.test.ts)
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
 * Regression tests for the reported bug: a `useContainer` parent defined in a
 * *different file* from the child is accepted silently (no build error — the
 * validator sees the interface token in `parentProvidedTokens`), but the
 * generated factory for the auto-wired consumer used to call
 * `new ConsumerA(undefined)` instead of delegating to the parent, because
 * FactoryEmitter only ever looked at the child's own `graph.nodes`.
 *
 * Real files on disk are required here (not in-memory strings): the plugin
 * resolves `useContainer`'s cross-file target via the TypeScript checker,
 * which needs to actually load and bind `parent-root.ts` as a real module.
 */
describe('Plugin — cross-file useContainer wiring', () => {
  const FIXTURES_DIR = path.join(__dirname, '__fixtures__', 'cross-file-parent');
  const PARENT_FILE = path.join(FIXTURES_DIR, 'parent-root.ts');
  const CHILD_FILE = path.join(FIXTURES_DIR, 'child-root.ts');

  beforeEach(() => vi.clearAllMocks());

  function makeTransform() {
    const plugin = neoSyringePlugin.vite();
    // @ts-expect-error - testing specific method
    return plugin.transform as (code: string, id: string) => string | undefined;
  }

  it('wires the auto-wired consumer to the cross-file parent via this.resolve(), not undefined', () => {
    const transform = makeTransform();
    const childCode = fs.readFileSync(CHILD_FILE, 'utf8');

    const result = transform(childCode, CHILD_FILE) ?? childCode;

    expect(result).not.toContain('new ConsumerA(undefined)');
    expect(result).toMatch(/new ConsumerA\(this\.resolve\("Logger_[a-f0-9]+"\)\)/);
  });

  it('does not throw a build error for the cross-file parent scenario (matches the working direct-resolve case)', () => {
    const transform = makeTransform();
    const childCode = fs.readFileSync(CHILD_FILE, 'utf8');
    expect(() => transform(childCode, CHILD_FILE)).not.toThrow();
  });

  it('sanity check: the parent file alone still transforms independently', () => {
    const transform = makeTransform();
    const parentCode = fs.readFileSync(PARENT_FILE, 'utf8');
    const result = transform(parentCode, PARENT_FILE) ?? parentCode;
    expect(result).not.toContain('defineBuilderConfig(');
  });
});
