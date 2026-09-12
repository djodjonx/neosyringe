import type { SerializableGraph, SerializableNode } from './types';

/** Replaces characters that are invalid in Mermaid node IDs. */
function sanitizeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_]/g, '_');
}

function nodeClass(node: SerializableNode): string {
  if (node.type === 'factory') return 'factory';
  if (node.type === 'value') return 'value';
  return node.lifecycle; // 'singleton' | 'transient'
}

/**
 * Converts a SerializableGraph to a Mermaid flowchart string.
 *
 * Node styles:
 *   singleton → green   transient → blue   factory → orange   value → grey
 * Solid arrows = required deps, dashed = optional deps.
 */
export function graphToMermaid(graph: SerializableGraph): string {
  const lines: string[] = [
    'flowchart TD',
    '  classDef singleton fill:#4CAF50,color:#fff,stroke:#388E3C',
    '  classDef transient fill:#2196F3,color:#fff,stroke:#1565C0',
    '  classDef factory fill:#FF9800,color:#fff,stroke:#E65100',
    '  classDef value fill:#9E9E9E,color:#fff,stroke:#616161',
  ];

  for (const node of graph.nodes) {
    const sid = sanitizeId(node.tokenId);
    const label = `${node.tokenId}\\n[${node.lifecycle}]`;
    lines.push(`  ${sid}["${label}"]:::${nodeClass(node)}`);
  }

  for (const node of graph.nodes) {
    const sid = sanitizeId(node.tokenId);
    for (const dep of node.dependencies) {
      const arrow = node.optionalDependencies.includes(dep) ? '-.->' : '-->';
      lines.push(`  ${sid} ${arrow} ${sanitizeId(dep)}`);
    }
  }

  return lines.join('\n');
}
