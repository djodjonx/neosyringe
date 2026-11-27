import { describe, expect, it } from 'vitest';
import * as light from '../src/serialize';

describe('G15 UI serialize source', () => {
  it('src/serialize.ts exports only the two functions', () => {
    expect(Object.keys(light).sort()).toEqual(['serializeGraph', 'serializeGraphWithErrors']);
  });
});
