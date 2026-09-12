import type { SerializableGraph } from './types';
import { graphToMermaid } from './mermaid';

const MERMAID_CDN = 'https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js';

/**
 * Builds a self-contained HTML page that renders one Mermaid diagram per graph.
 * Suitable for writing to disk (CLI --graph) or serving from a dev-server.
 */
export function buildStandaloneHtml(graphs: SerializableGraph[]): string {
  const diagrams = graphs.map(g => ({
    name: g.containerName ?? g.containerId,
    mermaid: graphToMermaid(g),
  }));

  const sections = diagrams
    .map(
      d => `  <section>
    <h2>${escapeHtml(d.name)}</h2>
    <div class="graph-wrapper">
      <pre class="mermaid">${d.mermaid}</pre>
    </div>
  </section>`
    )
    .join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src https://cdn.jsdelivr.net 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:;">
  <title>NeoSyringe — Dependency Graph</title>
  <script src="${MERMAID_CDN}"></script>
  <style>
    body { font-family: system-ui, sans-serif; background: #1a1a2e; color: #e0e0e0; margin: 0; padding: 24px; }
    h1 { color: #64b5f6; margin-bottom: 0; }
    h2 { color: #90caf9; margin-top: 32px; }
    .graph-wrapper { background: #fff; border-radius: 8px; padding: 20px; overflow: auto; }
    section { margin-bottom: 40px; }
  </style>
</head>
<body>
  <h1>NeoSyringe — Dependency Graph</h1>
${sections}
  <script>mermaid.initialize({ startOnLoad: true, theme: 'default' });</script>
</body>
</html>`;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
