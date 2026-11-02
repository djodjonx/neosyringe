import { describe, it, expect, afterEach } from 'vitest';
import { resolveDebugFlag, resolveTestOverridesFlag } from '../../src/generator/DebugConfig';

describe('resolveDebugFlag', () => {
  const originalNodeEnv = process.env.NODE_ENV;
  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  it('forces false in production regardless of the explicit value', () => {
    process.env.NODE_ENV = 'production';
    expect(resolveDebugFlag(true)).toBe(false);
    expect(resolveDebugFlag(false)).toBe(false);
    expect(resolveDebugFlag(undefined)).toBe(false);
  });

  it('defaults to false outside production when nothing is passed (opt-in, not opt-out)', () => {
    process.env.NODE_ENV = 'development';
    expect(resolveDebugFlag(undefined)).toBe(false);
  });

  it('is false outside production when explicitly set to false', () => {
    process.env.NODE_ENV = 'test';
    expect(resolveDebugFlag(false)).toBe(false);
  });

  it('is true outside production only when explicitly set to true', () => {
    process.env.NODE_ENV = 'test';
    expect(resolveDebugFlag(true)).toBe(true);
  });
});

describe('resolveTestOverridesFlag', () => {
  const originalNodeEnv = process.env.NODE_ENV;
  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  it('defaults to false', () => {
    process.env.NODE_ENV = 'test';
    expect(resolveTestOverridesFlag(undefined)).toBe(false);
    expect(resolveTestOverridesFlag(false)).toBe(false);
  });

  it('is true outside production only when explicitly set to true', () => {
    process.env.NODE_ENV = 'test';
    expect(resolveTestOverridesFlag(true)).toBe(true);
  });

  it('throws in production when explicitly enabled', () => {
    process.env.NODE_ENV = 'production';
    expect(() => resolveTestOverridesFlag(true)).toThrow(
      'NEO_TEST_API_DISABLED: testOverrides cannot be enabled when NODE_ENV is production',
    );
    expect(resolveTestOverridesFlag(false)).toBe(false);
  });
});
