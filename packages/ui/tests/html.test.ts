import { describe, it, expect } from 'vitest';
import { buildStandaloneHtml } from '../src/html';
import type { SerializableGraph, SerializableNode } from '../src/types';

const node: SerializableNode = {
  tokenId: 'TestService',
  lifecycle: 'singleton',
  type: 'explicit',
  dependencies: [],
  optionalDependencies: [],
};

const graphWithNode: SerializableGraph = {
  containerId: 'App',
  containerName: 'AppContainer',
  nodes: [node],
  roots: ['TestService'],
};

describe('buildStandaloneHtml', () => {
  it('returns a full HTML document', () => {
    const html = buildStandaloneHtml([graphWithNode]);
    expect(html).toMatch(/^<!DOCTYPE html>/);
    expect(html).toContain('</html>');
  });

  it('includes Cytoscape CDN script', () => {
    const html = buildStandaloneHtml([graphWithNode]);
    expect(html).toContain('cytoscape');
    expect(html).toContain('cdn.jsdelivr.net');
  });

  it('includes the container name as heading', () => {
    const html = buildStandaloneHtml([graphWithNode]);
    expect(html).toContain('AppContainer');
  });

  it('includes a graph container element', () => {
    const html = buildStandaloneHtml([graphWithNode]);
    expect(html).toContain('id="cy-inner"');
  });

  it('renders all graphs when multiple are passed', () => {
    const g2: SerializableGraph = { ...graphWithNode, containerId: 'Second', containerName: 'SecondContainer' };
    const html = buildStandaloneHtml([graphWithNode, g2]);
    expect(html).toContain('AppContainer');
    expect(html).toContain('SecondContainer');
  });

  it('falls back to containerId when containerName is absent', () => {
    const g: SerializableGraph = { containerId: 'RawId', nodes: [node], roots: [] };
    const html = buildStandaloneHtml([g]);
    expect(html).toContain('RawId');
  });

  it('excludes empty containers', () => {
    const empty: SerializableGraph = { containerId: 'Empty', containerName: 'ShouldBeHidden', nodes: [], roots: [] };
    const html = buildStandaloneHtml([graphWithNode, empty]);
    expect(html).not.toContain('ShouldBeHidden');
    expect(html).toContain('AppContainer');
  });

  it('declares DATA in the inlined script (no scriptUri) — buildMainJs() alone references DATA as a global', () => {
    const html = buildStandaloneHtml([graphWithNode]);
    expect(html).toContain("const DATA = JSON.parse(document.getElementById('neosyringe-data')");
  });
});
