import { describe, it, expect } from 'vitest';
import { parseArgs } from '../src/report';

describe('parseArgs — graph flags', () => {
  it('parses --graph with no value as true', () => {
    const args = parseArgs(['--graph']);
    expect(args.graph).toBe(true);
  });

  it('parses --graph with a path', () => {
    const args = parseArgs(['--graph', 'out/graph.html']);
    expect(args.graph).toBe('out/graph.html');
  });

  it('parses --mermaid flag', () => {
    const args = parseArgs(['--mermaid']);
    expect(args.mermaid).toBe(true);
  });

  it('graph is false by default', () => {
    const args = parseArgs([]);
    expect(args.graph).toBe(false);
    expect(args.mermaid).toBe(false);
  });

  it('parses existing --json flag alongside --graph', () => {
    const args = parseArgs(['--json', '--graph']);
    expect(args.json).toBe(true);
    expect(args.graph).toBe(true);
  });
});
