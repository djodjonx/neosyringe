import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { attributeErrors, type AnalysisError, type DependencyGraph } from '@djodjonx/neosyringe-core/analyzer';
import { serializeGraph, serializeGraphWithErrors, graphToMermaid, buildStandaloneHtml, type SerializableGraph } from '@djodjonx/neosyringe-ui';

const DEFAULT_HTML_FILENAME = 'neosyringe-graph.html';

/**
 * Serializes every graph for the devtools. With `errors`, each graph carries the
 * diagnostics attributed to it (see `attributeErrors` in core); without, its config-level errors.
 */
export function serializeGraphs(graphs: DependencyGraph[], errors?: AnalysisError[]): SerializableGraph[] {
  if (errors === undefined) return graphs.map(graph => serializeGraph(graph));
  const owned = attributeErrors(graphs, errors);
  return graphs.map(graph => serializeGraphWithErrors(graph, owned.get(graph)));
}

/**
 * Writes a standalone HTML graph file.
 * `errors` are the analyzer errors (`extractAllErrors()`); each graph shows the ones attributed to it.
 * @returns Absolute path of the written file
 */
export function exportGraphHtml(
  graphs: DependencyGraph[],
  outputPath: string | true,
  cwd: string,
  errors?: AnalysisError[],
): string {
  const html = buildStandaloneHtml(serializeGraphs(graphs, errors));
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
