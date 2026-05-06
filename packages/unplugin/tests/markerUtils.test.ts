import { describe, it, expect } from 'vitest';
import { hasNeoSyringeMarkers } from '../src/markerUtils';

describe('hasNeoSyringeMarkers', () => {
  it('returns true when code contains defineBuilderConfig', () => {
    expect(hasNeoSyringeMarkers("const c = defineBuilderConfig({})")).toBe(true);
  });

  it('returns true when code contains useInterface', () => {
    expect(hasNeoSyringeMarkers("const t = useInterface<ILogger>()")).toBe(true);
  });

  it('returns false when code contains neither marker', () => {
    expect(hasNeoSyringeMarkers("const x = 42;")).toBe(false);
  });

  it('returns true when code contains both markers', () => {
    const code = "const t = useInterface<ILogger>(); const c = defineBuilderConfig({})";
    expect(hasNeoSyringeMarkers(code)).toBe(true);
  });
});
