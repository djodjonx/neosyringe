import { describe, it, expect, afterEach } from 'vitest';
import { resolveDebugFlag } from '../../src/generator/DebugConfig';

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

  it('defaults to true outside production when nothing is passed', () => {
    process.env.NODE_ENV = 'development';
    expect(resolveDebugFlag(undefined)).toBe(true);
  });

  it('respects an explicit value outside production', () => {
    process.env.NODE_ENV = 'test';
    expect(resolveDebugFlag(false)).toBe(false);
    expect(resolveDebugFlag(true)).toBe(true);
  });
});
