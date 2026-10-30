import { describe, it, expect } from 'vitest';
import { buildProjectHtml, buildStandaloneHtml } from '../src/html';
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

interface GraphNodeData {
  id: string;
  label: string;
  lifecycle: string;
  type: string;
  isRoot: boolean;
  isParent: boolean;
}

interface GraphEdgeData {
  source: string;
  target: string;
  optional: boolean;
}

interface ContainerData {
  name: string;
  appName: string | null;
  sourcePath: string | null;
  nodes: GraphNodeData[];
  edges: GraphEdgeData[];
  stats: {
    total: number;
    singleton: number;
    transient: number;
    factory: number;
    value: number;
    parent: number;
  };
}

interface ProjectData {
  name: string;
  containers: ContainerData[];
}

function readData(html: string): ProjectData[] {
  const match = html.match(/<script type="application\/json" id="neosyringe-data">([\s\S]*?)<\/script>/);
  if (match === null || match[1] === undefined) {
    throw new Error('missing neosyringe-data');
  }
  const parsed: unknown = JSON.parse(match[1]);
  if (!Array.isArray(parsed)) {
    throw new Error('neosyringe-data is not an array');
  }
  return parsed as ProjectData[];
}

function svc(
  tokenId: string,
  overrides: Partial<Omit<SerializableNode, 'tokenId'>> = {},
): SerializableNode {
  return {
    tokenId,
    lifecycle: overrides.lifecycle ?? 'singleton',
    type: overrides.type ?? 'explicit',
    dependencies: overrides.dependencies ?? [],
    optionalDependencies: overrides.optionalDependencies ?? [],
  };
}

function graph(overrides: Partial<SerializableGraph> & Pick<SerializableGraph, 'containerId'>): SerializableGraph {
  return { nodes: [], roots: [], ...overrides };
}

const DAGRE_SRC = 'https://cdn.jsdelivr.net/npm/dagre@0.8.5/dist/dagre.min.js';
const CYTOSCAPE_SRC = 'https://cdn.jsdelivr.net/npm/cytoscape@3.30.4/dist/cytoscape.min.js';
const CYTOSCAPE_DAGRE_SRC = 'https://cdn.jsdelivr.net/npm/cytoscape-dagre@2.5.0/cytoscape-dagre.js';

function one(graphs: SerializableGraph[]): ContainerData {
  const container = readData(buildProjectHtml([{ projectName: 'App', graphs }]))[0]?.containers[0];
  if (container === undefined) {
    throw new Error('expected one container');
  }
  return container;
}

describe('buildProjectHtml', () => {
  it('adds a ghost node when a dependency is missing from the graph', () => {
    const container = one([graph({
      containerId: 'C',
      nodes: [svc('UserService', { dependencies: ['a1b2c3d4_Missing'] })],
    })]);
    expect(container.nodes).toContainEqual({
      id: 'a1b2c3d4_Missing',
      label: 'Missing',
      lifecycle: 'singleton',
      type: 'parent',
      isRoot: false,
      isParent: true,
    });
    expect(container.stats.parent).toBe(1);
    expect(container.edges).toContainEqual({
      source: 'UserService',
      target: 'a1b2c3d4_Missing',
      optional: false,
    });
  });

  it('creates one ghost when two nodes share a missing dependency', () => {
    const container = one([graph({
      containerId: 'C',
      nodes: [
        svc('A', { dependencies: ['a1b2c3d4_Missing'] }),
        svc('B', { dependencies: ['a1b2c3d4_Missing'] }),
      ],
    })]);
    expect(container.nodes.filter(n => n.id === 'a1b2c3d4_Missing')).toHaveLength(1);
  });

  it('creates no ghost when the dependency exists in the graph', () => {
    const container = one([graph({
      containerId: 'C',
      nodes: [svc('A', { dependencies: ['B'] }), svc('B')],
    })]);
    expect(container.nodes).toHaveLength(2);
    expect(container.nodes.map(n => n.id)).toEqual(['A', 'B']);
  });

  it('prefers exportedVariableName over containerName', () => {
    const container = one([graph({
      containerId: 'raw-id',
      containerName: 'AppContainer',
      exportedVariableName: 'appContainer',
      nodes: [svc('S')],
    })]);
    expect(container.name).toBe('appContainer');
    expect(container.appName).toBe('AppContainer');
  });

  it('propagates sourceFileName to sourcePath', () => {
    const projects = readData(buildProjectHtml([{
      projectName: 'App',
      graphs: [
        graph({
          containerId: 'with-file',
          containerName: 'Named',
          sourceFileName: '/src/app.ts',
          nodes: [svc('S')],
        }),
        graph({
          containerId: 'no-file',
          exportedVariableName: 'bare',
          nodes: [svc('T')],
        }),
      ],
    }]));
    const containers = projects[0]?.containers ?? [];
    expect(containers.map(c => c.sourcePath)).toEqual(['/src/app.ts', null]);
    expect(containers.map(c => c.appName)).toEqual(['Named', null]);
  });

  it('sets isRoot only for tokens listed as roots', () => {
    const container = one([graph({
      containerId: 'C',
      nodes: [svc('RootSvc'), svc('ChildSvc')],
      roots: ['RootSvc'],
    })]);
    expect(container.nodes.find(n => n.id === 'RootSvc')?.isRoot).toBe(true);
    expect(container.nodes.find(n => n.id === 'ChildSvc')?.isRoot).toBe(false);
  });

  it('sets optional true only on optional dependency edges', () => {
    const container = one([graph({
      containerId: 'C',
      nodes: [
        svc('A', { dependencies: ['Opt', 'Req'], optionalDependencies: ['Opt'] }),
        svc('Opt'),
        svc('Req'),
      ],
    })]);
    expect(container.edges).toEqual([
      { source: 'A', target: 'Opt', optional: true },
      { source: 'A', target: 'Req', optional: false },
    ]);
  });

  it('strips leading and trailing hex hashes from labels', () => {
    const container = one([graph({
      containerId: 'C',
      nodes: [
        svc('a1b2c3d4_UserService'),
        svc('UserService_d6f15683'),
        svc('ab_User'),
        svc('User_12ab'),
        svc('zzzzzzzz_Keep'),
      ],
    })]);
    expect(container.nodes.map(n => n.label)).toEqual([
      'UserService',
      'UserService',
      'ab_User',
      'User_12ab',
      'zzzzzzzz_Keep',
    ]);
  });

  it('counts lifecycles and excludes parent nodes from the total', () => {
    const container = one([graph({
      containerId: 'C',
      nodes: [
        svc('Single', { lifecycle: 'singleton', type: 'explicit' }),
        svc('Temp', { lifecycle: 'transient', type: 'explicit' }),
        svc('Maker', { lifecycle: 'singleton', type: 'factory' }),
        svc('Const', { lifecycle: 'transient', type: 'value' }),
        svc('FromParent', { lifecycle: 'singleton', type: 'parent' }),
      ],
    })]);
    expect(container.stats).toEqual({
      total: 4,
      singleton: 2,
      transient: 2,
      factory: 1,
      value: 1,
      parent: 1,
    });
  });

  it('uses cspSource in the CSP script-src', () => {
    const graphs = [{ projectName: 'App', graphs: [graph({ containerId: 'C', nodes: [svc('S')] })] }];
    const withCsp = buildProjectHtml(graphs, undefined, 'https://vscode.example');
    const without = buildProjectHtml(graphs);
    expect(withCsp).toContain('script-src https://cdn.jsdelivr.net https://vscode.example;');
    expect(withCsp).not.toContain("script-src https://cdn.jsdelivr.net 'unsafe-inline'");
    expect(without).toContain("script-src https://cdn.jsdelivr.net 'unsafe-inline';");
  });

  it('loads the main script from scriptUri', () => {
    const graphs = [{ projectName: 'App', graphs: [graph({ containerId: 'C', nodes: [svc('S')] })] }];
    const external = buildProjectHtml(graphs, undefined, undefined, 'https://ext.example/webview.js');
    const inline = buildProjectHtml(graphs);
    expect(external).toContain('<script src="https://ext.example/webview.js"></script>');
    expect(external).not.toContain('const DATA = JSON.parse');
    expect(inline).toContain("const DATA = JSON.parse(document.getElementById('neosyringe-data')");
    expect(inline).not.toContain('<script src="https://ext.example/webview.js"></script>');
  });

  it('emits the cytoscape CDN scripts only when cytoscapeUri is absent', () => {
    const graphs = [{ projectName: 'App', graphs: [graph({ containerId: 'C', nodes: [svc('S')] })] }];
    const localUri = 'https://local.example/cy.js';
    const local = buildProjectHtml(graphs, undefined, undefined, undefined, localUri);
    const cdn = buildProjectHtml(graphs);
    const localTag = `<script src="${localUri}"></script>`;
    expect(local.split(localTag)).toHaveLength(2);
    expect(local).not.toContain(`<script src="${DAGRE_SRC}"></script>`);
    expect(local).not.toContain(`<script src="${CYTOSCAPE_SRC}"></script>`);
    expect(local).not.toContain(`<script src="${CYTOSCAPE_DAGRE_SRC}"></script>`);
    expect(cdn).toContain(`<script src="${DAGRE_SRC}"></script>`);
    expect(cdn).toContain(`<script src="${CYTOSCAPE_SRC}"></script>`);
    expect(cdn).toContain(`<script src="${CYTOSCAPE_DAGRE_SRC}"></script>`);
    expect(cdn).not.toContain(localTag);
  });

  it('drops projects that contain no graphs', () => {
    const html = buildProjectHtml([
      { projectName: 'Filled', graphs: [graph({ containerId: 'One', nodes: [svc('S')] })] },
      { projectName: 'EmptyProject', graphs: [] },
      { projectName: 'AlsoFilled', graphs: [graph({ containerId: 'Two', nodes: [svc('T')] })] },
    ]);
    const empty = buildProjectHtml([]);
    expect(readData(html).map(p => p.name)).toEqual(['Filled', 'AlsoFilled']);
    expect(readData(html).flatMap(p => p.containers.map(c => c.name))).toEqual(['One', 'Two']);
    expect(html).toContain('2 packages · 2 containers');
    expect(readData(empty)).toEqual([]);
    expect(empty).toContain('0 packages · 0 containers');
  });
});
