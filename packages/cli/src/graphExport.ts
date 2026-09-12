import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { DependencyGraph } from '@djodjonx/neosyringe-core/analyzer';
import { serializeGraph, graphToMermaid, buildStandaloneHtml } from '@djodjonx/neosyringe-ui';

const DEFAULT_HTML_FILENAME = 'neosyringe-graph.html';

/**
 * Writes a standalone HTML graph file.
 * @returns Absolute path of the written file
 */
export function exportGraphHtml(
  graphs: DependencyGraph[],
  outputPath: string | true,
  cwd: string
): string {
  const serialized = graphs.map(serializeGraph);
  const html = buildStandaloneHtml(serialized);
  const filePath = resolve(cwd, outputPath === true ? DEFAULT_HTML_FILENAME : outputPath);
  writeFileSync(filePath, html, 'utf-8');
  return filePath;
}

/**
 * Returns Mermaid diagrams for all graphs, one per container, separated by newlines.
 */
export function exportMermaid(graphs: DependencyGraph[]): string {
  return graphs
    .map(g => {
      const header = `## ${g.containerName ?? g.containerId}`;
      return `${header}\n\n${graphToMermaid(serializeGraph(g))}`;
    })
    .join('\n\n---\n\n');
}
