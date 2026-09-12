import { describe, it, expect } from 'vitest';
import { buildStandaloneHtml } from '../src/html';
import type { SerializableGraph } from '../src/types';

const emptyGraph: SerializableGraph = {
  containerId: 'App',
  containerName: 'AppContainer',
  nodes: [],
  roots: [],
};

describe('buildStandaloneHtml', () => {
  it('returns a full HTML document', () => {
    const html = buildStandaloneHtml([emptyGraph]);
    expect(html).toMatch(/^<!DOCTYPE html>/);
    expect(html).toContain('</html>');
  });

  it('includes Mermaid CDN script', () => {
    const html = buildStandaloneHtml([emptyGraph]);
    expect(html).toContain('mermaid');
    expect(html).toContain('cdn.jsdelivr.net');
  });

  it('includes the container name as heading', () => {
    const html = buildStandaloneHtml([emptyGraph]);
    expect(html).toContain('AppContainer');
  });

  it('includes a <pre class="mermaid"> block', () => {
    const html = buildStandaloneHtml([emptyGraph]);
    expect(html).toContain('class="mermaid"');
  });

  it('renders all graphs when multiple are passed', () => {
    const g2: SerializableGraph = { ...emptyGraph, containerId: 'Second', containerName: 'SecondContainer' };
    const html = buildStandaloneHtml([emptyGraph, g2]);
    expect(html).toContain('AppContainer');
    expect(html).toContain('SecondContainer');
  });

  it('falls back to containerId when containerName is absent', () => {
    const g: SerializableGraph = { containerId: 'RawId', nodes: [], roots: [] };
    const html = buildStandaloneHtml([g]);
    expect(html).toContain('RawId');
  });
});
