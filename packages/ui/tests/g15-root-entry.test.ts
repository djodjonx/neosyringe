import { describe, expect, it } from 'vitest';
import * as root from '../src/index';

describe('G15 UI root entry', () => {
  it('root entry keeps html, mermaid and serialize exports', () => {
    const expected = [
      'buildProjectHtml',
      'buildStandaloneHtml',
      'buildWebviewScript',
      'graphToMermaid',
      'serializeGraph',
      'serializeGraphWithErrors',
    ];
    expect(Object.keys(root).sort()).toEqual(expected);
    for (const name of expected) expect(typeof Reflect.get(root, name), name).toBe('function');
  });
});
