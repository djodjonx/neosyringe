import { describe, it, expect } from 'vitest';
import { getSimpleName } from '../../src/analyzer/utils/TokenUtils';

describe('getSimpleName', () => {
  it('strips 8-char hex hash suffix', () => {
    expect(getSimpleName('IEventBus_714d1af6')).toBe('IEventBus');
  });

  it('strips longer hex hash suffix (12 chars)', () => {
    expect(getSimpleName('ILogger_abcdef012345')).toBe('ILogger');
  });

  it('returns token as-is when no hash suffix', () => {
    expect(getSimpleName('UserService')).toBe('UserService');
  });

  it('extracts interface name from useInterface<T>() form', () => {
    expect(getSimpleName('useInterface<ILogger>()')).toBe('ILogger');
  });

  it('handles underscores in interface name', () => {
    expect(getSimpleName('My_Service_abc12345')).toBe('My_Service');
  });

  it('preserves token with non-hex suffix', () => {
    expect(getSimpleName('IService_v2')).toBe('IService_v2');
  });

  it('strips underscore+hash from type name inside useInterface<T>()', () => {
    // The split('_')[0] logic in getSimpleName strips everything after first _ in the type
    expect(getSimpleName('useInterface<ILogger_abc12345>()')).toBe('ILogger');
  });
});
