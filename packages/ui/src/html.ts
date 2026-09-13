import type { SerializableGraph } from './types';

const CYTOSCAPE_CDN = 'https://cdn.jsdelivr.net/npm/cytoscape@3.30.4/dist/cytoscape.min.js';
const DAGRE_CDN = 'https://cdn.jsdelivr.net/npm/dagre@0.8.5/dist/dagre.min.js';
const CYTOSCAPE_DAGRE_CDN = 'https://cdn.jsdelivr.net/npm/cytoscape-dagre@2.5.0/cytoscape-dagre.js';
/**
 * A named group of graphs for one project/package.
 */
export interface ProjectGraphs {
  projectName: string;
  graphs: SerializableGraph[];
}

/** Generates a random nonce for CSP. */
function getNonce(): string {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) text += possible.charAt(Math.floor(Math.random() * possible.length));
  return text;
}

/** Returns the most readable name for a container. */
function containerDisplayName(g: SerializableGraph): string {
  return g.exportedVariableName ?? g.containerName ?? g.containerId;
}

/** Strips hash prefixes/suffixes from token IDs (e.g. `a1b2c3d4_UserService` or `UserService_d6f15683` → `UserService`). */
function stripHash(id: string): string {
  return id
    .replace(/^[a-f0-9]{6,}_/, '')   // remove leading hash prefix
    .replace(/_[a-f0-9]{6,}$/, '');  // remove trailing hash suffix
}

/**
 * Builds a self-contained HTML page that renders one Cytoscape diagram per graph.
 * Suitable for writing to disk (CLI --graph) or serving from a dev-server.
 */
export function buildStandaloneHtml(graphs: SerializableGraph[]): string {
  return buildProjectHtml([{ projectName: 'Containers', graphs }]);
}

/**
 * Builds a full-featured HTML page with sidebar navigation by project,
 * tabbed containers, interactive Cytoscape graph, stats bar and legend.
 * 
 * @param scriptUri - If provided, the main JS is loaded from this URI (VSCode WebView).
 *                    If omitted, the JS is inlined (CLI/browser use).
 */
export function buildProjectHtml(projects: ProjectGraphs[], nonce?: string, cspSource?: string, scriptUri?: string, cytoscapeUri?: string): string {
  const nonEmpty = projects.filter(p => p.graphs.length > 0);
  const totalContainers = nonEmpty.reduce((s, p) => s + p.graphs.length, 0);
  const totalPackages = nonEmpty.length;

  const projectData = nonEmpty.map(p => ({
    name: p.projectName,
    containers: p.graphs
      .filter(g => g.nodes.length > 0) // skip empty containers
      .map(g => {
        const nodeIds = new Set(g.nodes.map(n => n.tokenId));

        const nodes = g.nodes.map(n => ({
          id: n.tokenId,
          label: stripHash(n.tokenId),
          lifecycle: n.lifecycle,
          type: n.type,
          isRoot: g.roots.includes(n.tokenId),
          isParent: n.type === 'parent',
        }));

        // Add ghost nodes for dependencies that don't exist in this graph
        const ghostIds = new Set<string>();
        for (const n of g.nodes) {
          for (const dep of n.dependencies) {
            if (!nodeIds.has(dep) && !ghostIds.has(dep)) {
              ghostIds.add(dep);
              nodes.push({ id: dep, label: stripHash(dep), lifecycle: 'singleton', type: 'parent', isRoot: false, isParent: true });
            }
          }
        }

        const edges = g.nodes.flatMap(n =>
          n.dependencies.map(dep => ({
            source: n.tokenId,
            target: dep,
            optional: n.optionalDependencies.includes(dep),
          }))
        );

        const localNodes = g.nodes.filter(n => n.type !== 'parent');
        return {
          name: containerDisplayName(g),
          appName: g.containerName ?? null,
          sourcePath: g.sourceFileName ?? null,
          nodes,
          edges,
          stats: {
            total: localNodes.length,
            singleton: localNodes.filter(n => n.lifecycle === 'singleton').length,
            transient: localNodes.filter(n => n.lifecycle === 'transient').length,
            factory: localNodes.filter(n => n.type === 'factory').length,
            value: localNodes.filter(n => n.type === 'value').length,
            parent: g.nodes.filter(n => n.type === 'parent').length + ghostIds.size,
          },
        };
      }),
  }));

  const dataJson = JSON.stringify(projectData)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e');

  const n = nonce ?? getNonce();

  // When a scriptUri is provided (VSCode WebView), load JS as external file.
  // Otherwise inline it (CLI/browser).
  const scriptSrc = cspSource
    ? `https://cdn.jsdelivr.net ${cspSource}`
    : `https://cdn.jsdelivr.net 'unsafe-inline'`;

  // Inline path (CLI/browser) must declare `DATA` itself by reading the JSON
  // script tag below — buildMainJs() alone assumes `DATA` already exists as a
  // global, which is only true for the VSCode WebView path (buildWebviewScript
  // is loaded as a separate <script src>, after the JSON tag has parsed).
  const mainScript = scriptUri
    ? `<script src="${scriptUri}"></script>`
    : `<script>${buildWebviewScript()}</script>`;

  const dataScript = `<script type="application/json" id="neosyringe-data">${dataJson}</script>`;

  // CDN scripts OR local bundle
  const cytoscapeScripts = cytoscapeUri
    ? `<script src="${cytoscapeUri}"></script>`
    : `<script src="${DAGRE_CDN}"></script>\n  <script src="${CYTOSCAPE_CDN}"></script>\n  <script src="${CYTOSCAPE_DAGRE_CDN}"></script>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src ${scriptSrc}; style-src 'unsafe-inline'; img-src data: blob:;">
  <title>NeoSyringe — Dependency Graph</title>
  ${cytoscapeScripts}
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#1e1e2e;color:#cdd6f4;height:100vh;display:flex;flex-direction:column;overflow:hidden}
    .topbar{background:#181825;border-bottom:1px solid #313244;padding:8px 16px;display:flex;align-items:center;gap:10px;flex-shrink:0}
    .topbar-logo{width:22px;height:22px;background:linear-gradient(135deg,#89b4fa,#cba6f7);border-radius:6px;display:flex;align-items:center;justify-content:center;font-size:11px;color:#1e1e2e;font-weight:900;flex-shrink:0}
    .topbar-title{font-size:13px;font-weight:600;color:#cdd6f4}
    .topbar-meta{font-size:11px;color:#585b70;margin-left:auto}
    .btn{background:#313244;border:none;color:#89b4fa;padding:4px 10px;border-radius:4px;font-size:11px;cursor:pointer;transition:background .15s}
    .btn:hover{background:#45475a}
    .layout{display:flex;flex:1;overflow:hidden}
    .sidebar{width:210px;background:#181825;border-right:1px solid #313244;display:flex;flex-direction:column;overflow:hidden;flex-shrink:0}
    .sidebar-label{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:#585b70;padding:12px 14px 6px}
    .pkg-item{padding:6px 12px 6px 14px;font-size:12px;cursor:pointer;display:flex;align-items:center;gap:7px;border-left:2px solid transparent;color:#a6adc8;user-select:none}
    .pkg-item:hover{background:#252535;color:#cdd6f4}
    .pkg-item.active{background:#252535;border-left-color:#89b4fa;color:#cdd6f4}
    .pkg-name{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px}
    .pkg-badge{background:#313244;color:#89b4fa;font-size:10px;padding:1px 6px;border-radius:10px;flex-shrink:0}
    .pkg-item.active .pkg-badge{background:#89b4fa22}
    .legend{margin-top:auto;padding:12px 14px;border-top:1px solid #313244}
    .legend-title{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:#585b70;margin-bottom:8px}
    .legend-row{display:flex;align-items:center;gap:6px;font-size:11px;color:#a6adc8;margin-bottom:4px}
    .dot{width:9px;height:9px;border-radius:2px;flex-shrink:0}
    .d-si{background:#a6e3a1}.d-tr{background:#89b4fa}.d-fa{background:#fab387}.d-va{background:#585b70}
    .main{flex:1;display:flex;flex-direction:column;overflow:hidden;min-width:0}
    .tabs{background:#181825;border-bottom:1px solid #313244;display:flex;padding:0 12px;overflow-x:auto;flex-shrink:0;gap:2px}
    .tab{padding:7px 14px;font-size:11px;cursor:pointer;color:#585b70;border:none;border-bottom:2px solid transparent;background:none;white-space:nowrap;transition:all .1s}
    .tab:hover{color:#a6adc8}
    .tab.active{color:#89b4fa;border-bottom-color:#89b4fa}
    .graph-wrap{flex:1;display:flex;flex-direction:column;overflow:hidden}
    .graph-area{flex:1;display:flex;flex-direction:column;padding:12px;background:#1e1e2e;overflow:hidden}
    .graph-card{background:#181825;border:1px solid #313244;border-radius:8px;overflow:hidden;flex:1;display:flex;flex-direction:column}
    .graph-card-title{font-size:11px;color:#585b70;font-weight:600;text-transform:uppercase;letter-spacing:.06em;padding:10px 16px;display:flex;align-items:center;gap:6px;border-bottom:1px solid #313244;background:#1e1e2e}
    .cname{color:#a6adc8}.sep{color:#45475a;margin:0 2px}.varname{color:#cdd6f4}
    .file-link{color:#89b4fa;cursor:pointer;font-size:10px;text-transform:none;letter-spacing:0;font-weight:400}
    .file-link:hover{text-decoration:underline}
    .file-path{color:#585b70;font-size:10px;text-transform:none;letter-spacing:0;font-weight:400}
    .detail-panel{position:absolute;bottom:0;left:0;right:0;background:#181825;border-top:1px solid #313244;padding:10px 16px;font-size:12px;display:none;gap:16px;align-items:center}
    .detail-panel.visible{display:flex}
    .detail-name{font-weight:600;color:#cdd6f4}
    .detail-badge{padding:2px 8px;border-radius:12px;font-size:10px;font-weight:600}
    .badge-singleton{background:#a6e3a122;color:#a6e3a1;border:1px solid #a6e3a1}
    .badge-transient{background:#89b4fa22;color:#89b4fa;border:1px solid #89b4fa}
    .badge-factory{background:#fab38722;color:#fab387;border:1px solid #fab387}
    .badge-value{background:#58587022;color:#a6adc8;border:1px solid #585b70}
    .detail-deps{color:#a6adc8;font-size:11px}
    .detail-close{margin-left:auto;cursor:pointer;color:#585b70;font-size:16px;background:none;border:none;padding:0 4px}
    .statsbar{background:#181825;border-top:1px solid #313244;padding:5px 16px;display:flex;gap:18px;font-size:11px;color:#585b70;flex-shrink:0;overflow-x:auto}
    .stat b{color:#cdd6f4}
    .empty{display:flex;align-items:center;justify-content:center;height:100%;color:#585b70;font-size:13px}
  </style>
</head>
<body>
<div class="topbar">
  <div class="topbar-logo">N</div>
  <div class="topbar-title">NeoSyringe</div>
  <div class="topbar-meta">${totalPackages} package${totalPackages !== 1 ? 's' : ''} · ${totalContainers} container${totalContainers !== 1 ? 's' : ''}</div>
  <span style="font-size:10px;color:#45475a;margin-left:8px">v${Date.now().toString().slice(-4)}</span>
  <button class="btn" data-action="fit">⤢ Fit</button>
  <button class="btn" data-action="refresh">↺ Refresh</button>
</div>
<div class="layout">
  <aside class="sidebar">
    <div class="sidebar-label">Packages</div>
    <div id="pkg-list"><div style="padding:10px 14px;color:#585b70;font-size:11px">Loading…</div></div>
    <div class="legend">
      <div class="legend-title">Legend</div>
      <div class="legend-row"><span class="dot d-si"></span> Singleton</div>
      <div class="legend-row"><span class="dot d-tr"></span> Transient</div>
      <div class="legend-row"><span class="dot d-fa"></span> Factory</div>
      <div class="legend-row"><span class="dot d-va"></span> Value</div>
      <div class="legend-row" style="margin-top:6px"><span class="dot" style="background:none;border:1px dashed #585b70"></span> <span style="font-style:italic">Parent / external</span></div>
    </div>
  </aside>
  <div class="main">
    <div class="tabs" id="tabs"></div>
    <div class="graph-wrap">
    <div class="graph-area" id="graph-area"></div>
      <div class="detail-panel" id="detail">
        <span class="detail-name" id="d-name"></span>
        <span class="detail-badge" id="d-badge"></span>
        <span class="detail-deps" id="d-deps"></span>
        <button class="detail-close" data-action="closeDetail">✕</button>
      </div>
    </div>
    <div class="statsbar" id="statsbar"></div>
  </div>
</div>
${dataScript}
${mainScript}
</body>
</html>`;
}

/** Returns the raw JS for the WebView (reads data from #neosyringe-data). */
export function buildWebviewScript(): string {
  return `const DATA = JSON.parse(document.getElementById('neosyringe-data').textContent || '[]');
${buildMainJs()}`;
}

function buildMainJs(): string {
  return `
let activePkg = 0, activeTab = 0, cy = null;

window.onerror = function(msg, src, line) {
  const el = document.getElementById('graph-area');
  if (el) el.innerHTML = '<div style="padding:20px;color:#f38ba8;font-family:monospace;font-size:12px"><b>JS Error:</b> ' + msg + '<br>Line: ' + line + '</div>';
};

const NODE_COLORS = {
  singleton: { bg: '#a6e3a1', border: '#79c47c', text: '#1e1e2e' },
  transient:  { bg: '#89b4fa', border: '#5b9ef7', text: '#1e1e2e' },
  factory:    { bg: '#fab387', border: '#f08040', text: '#1e1e2e' },
  value:      { bg: '#6c7086', border: '#45475a', text: '#cdd6f4' },
};

function nodeColor(n) {
  if (n.type === 'factory') return NODE_COLORS.factory;
  if (n.type === 'value') return NODE_COLORS.value;
  return NODE_COLORS[n.lifecycle] || NODE_COLORS.singleton;
}

function renderSidebar() {
  const el = document.getElementById('pkg-list');
  if (!el) return;
  if (!DATA || DATA.length === 0) {
    el.innerHTML = '<div style="padding:10px 14px;color:#f38ba8;font-size:11px">No containers found</div>';
    return;
  }
  el.innerHTML = DATA.map((p, i) =>
    '<div class="pkg-item ' + (i===activePkg?'active':'') + '" data-pkg="' + i + '">' +
    '<span style="font-size:12px">\u{1F4E6}</span>' +
    '<span class="pkg-name" title="' + esc(p.name) + '">' + esc(shortName(p.name)) + '</span>' +
    '<span class="pkg-badge">' + p.containers.length + '</span></div>'
  ).join('');
}

function renderTabs() {
  const pkg = DATA[activePkg];
  if (!pkg) return;
  document.getElementById('tabs').innerHTML = pkg.containers.map((c, i) =>
    '<button class="tab ' + (i===activeTab?'active':'') + '" data-tab="' + i + '">' + esc(c.name) + '</button>'
  ).join('');
}

function renderGraph() {
  const pkg = DATA[activePkg];
  const c = pkg && pkg.containers[activeTab];
  closeDetail();
  if (!c || c.nodes.length === 0) {
    document.getElementById('graph-area').innerHTML = '<div class="empty">No services found</div>';
    return;
  }

  const shortPath = c.sourcePath ? c.sourcePath.replace(/.*\\/(packages|src|apps)\\//, '$1/') : null;
  const fileLink = c.sourcePath
    ? '<span class="file-link" data-path="' + esc(c.sourcePath) + '" data-action="openFile">' + esc(shortPath) + ' \u2197</span>'
    : '';
  const localCount = c.nodes.filter(n => !n.isParent).length;
  const titleHtml =
    '<div class="graph-card-title">' +
    (c.appName ? '<span class="cname">' + esc(c.appName) + '</span><span class="sep">/</span>' : '') +
    '<span class="varname">' + esc(c.name) + '</span>' +
    '<span style="color:#585b70;font-weight:400;font-size:10px;margin-left:4px">\u00B7 ' + c.stats.total + ' service' + (c.stats.total!==1?'s':'') + '</span>' +
    (fileLink ? '<span style="margin-left:auto">' + fileLink + '</span>' : '') +
    '</div>';

  document.getElementById('graph-area').innerHTML =
    '<div class="graph-card" style="height:100%;display:flex;flex-direction:column">' + titleHtml + '<div id="cy-inner" style="flex:1;min-height:0"></div></div>';

  try {
    const cyEl = document.getElementById('cy-inner');
    if (!cyEl) { document.getElementById('graph-area').innerHTML = '<div style="padding:20px;color:#f38ba8">Error: cy-inner not found</div>'; return; }
    buildCytoscape(cyEl, c);
  } catch(err) {
    document.getElementById('graph-area').innerHTML = '<div style="padding:20px;color:#f38ba8;font-family:monospace;font-size:12px"><b>Graph Error:</b><br>' + String(err) + '</div>';
  }
}

function buildCytoscape(container, c) {
  // Group parent-type nodes under a compound parent container node
  const hasParents = c.nodes.some(n => n.isParent);
  const parentGroupId = '__parent_container__';

  const elements = [];

  // Compound parent group node (if there are parent nodes)
  if (hasParents) {
    elements.push({ data: {
      id: parentGroupId,
      label: 'Parent Container',
      isGroup: true,
    }});
  }

  elements.push(
    ...c.nodes.map(n => {
      const col = nodeColor(n);
      return { data: {
        id: n.id, label: n.label, lifecycle: n.lifecycle, type: n.type,
        isParent: n.isParent || false,
        bgColor: col.bg, borderColor: col.border, textColor: col.text,
        parent: (n.isParent && hasParents) ? parentGroupId : undefined,
      }};
    }),
    ...c.edges.map((e, i) => ({
      data: { id: 'e' + i, source: e.source, target: e.target, optional: e.optional }
    }))
  );

  // Always use dagre LR — better for DI dependency chains
  const layout = { name: 'dagre', rankDir: 'LR', rankSep: 80, nodeSep: 30, edgeSep: 20, padding: 32 };

  if (cy) cy.destroy();
  cy = cytoscape({
    container,
    elements,
    style: [
      { selector: 'node', style: {
        'label': 'data(label)', 'background-color': 'data(bgColor)',
        'border-color': 'data(borderColor)', 'border-width': 2,
        'color': 'data(textColor)', 'font-size': 11,
        'font-family': '-apple-system, BlinkMacSystemFont, Segoe UI, sans-serif',
        'text-valign': 'center', 'text-halign': 'center', 'padding': '8px',
        'width': 'label', 'height': 'label', 'shape': 'round-rectangle',
        'text-wrap': 'wrap', 'text-max-width': 160, 'cursor': 'pointer',
      }},
      { selector: '#' + parentGroupId, style: {
        'label': 'Parent Container',
        'background-color': '#1e1e2e',
        'border-color': '#cba6f7',
        'border-width': 2,
        'border-style': 'dashed',
        'color': '#cba6f7',
        'font-size': 12,
        'font-weight': 'bold',
        'text-valign': 'top',
        'text-halign': 'center',
        'text-margin-y': -8,
        'padding': '20px',
        'shape': 'round-rectangle',
      }},
      { selector: 'node[?isParent]', style: { 'border-style': 'dashed', 'border-width': 1.5, 'opacity': 0.7, 'font-style': 'italic' }},
      { selector: 'node:selected', style: { 'border-width': 3, 'border-color': '#f38ba8' } },
      { selector: 'edge', style: {
        'width': 1.5, 'line-color': '#45475a', 'target-arrow-color': '#45475a',
        'target-arrow-shape': 'triangle', 'curve-style': 'bezier', 'arrow-scale': 0.8,
      }},
      { selector: 'edge[?optional]', style: {
        'line-style': 'dashed', 'line-dash-pattern': [6, 3],
        'line-color': '#585b70', 'target-arrow-color': '#585b70',
      }},
      { selector: '.highlighted', style: { 'background-color': '#f38ba8', 'border-color': '#e53e6a' } },
    ],
    layout,
    wheelSensitivity: 0.3,
  });

  cy.one('layoutstop', function() { cy.fit(undefined, 32); });

  cy.on('tap', 'node', function(e) {
    if (e.target.data('isGroup')) return; // don't show detail for compound group
    const n = e.target.data();
    showDetail(n, c);
    cy.elements().removeClass('highlighted');
    e.target.addClass('highlighted');
    cy.edges('[source = "' + n.id + '"]').style({ 'line-color': '#f38ba8', 'target-arrow-color': '#f38ba8' });
    cy.edges('[target = "' + n.id + '"]').style({ 'line-color': '#cba6f7', 'target-arrow-color': '#cba6f7' });
  });
  cy.on('tap', function(e) {
    if (e.target === cy) {
      closeDetail();
      cy.elements().removeClass('highlighted');
      cy.edges().style({ 'line-color': '#45475a', 'target-arrow-color': '#45475a' });
    }
  });
}

let vscodeApi = null;
try { vscodeApi = typeof acquireVsCodeApi !== 'undefined' ? acquireVsCodeApi() : null; } catch(e) {}
function openFile(path) { if (vscodeApi) vscodeApi.postMessage({ command: 'openFile', path }); }

function showDetail(n) {
  document.getElementById('d-name').textContent = n.label;
  const badge = document.getElementById('d-badge');
  const cls = n.type === 'factory' ? 'factory' : n.type === 'value' ? 'value' : n.lifecycle;
  badge.className = 'detail-badge badge-' + cls;
  badge.textContent = cls;
  const outgoing = cy.edges('[source = "' + n.id + '"]').length;
  const incoming = cy.edges('[target = "' + n.id + '"]').length;
  document.getElementById('d-deps').textContent = outgoing + ' dependenc' + (outgoing !== 1 ? 'ies' : 'y') + ' \u00B7 required by ' + incoming;
  document.getElementById('detail').classList.add('visible');
}

function closeDetail() {
  const el = document.getElementById('detail');
  if (el) el.classList.remove('visible');
}
function fitGraph() { if (cy) cy.fit(undefined, 24); }

function renderStats() {
  const c = DATA[activePkg]?.containers[activeTab];
  if (!c) { document.getElementById('statsbar').innerHTML = ''; return; }
  const s = c.stats;
  document.getElementById('statsbar').innerHTML =
    '<span class="stat">Local services: <b>' + s.total + '</b></span>' +
    (s.singleton ? '<span class="stat">Singletons: <b>' + s.singleton + '</b></span>' : '') +
    (s.transient  ? '<span class="stat">Transient: <b>' + s.transient + '</b></span>' : '') +
    (s.factory    ? '<span class="stat">Factories: <b>' + s.factory + '</b></span>' : '') +
    (s.value      ? '<span class="stat">Values: <b>' + s.value + '</b></span>' : '') +
    (s.parent     ? '<span class="stat" style="color:#585b70">From parent: <b style="color:#a6adc8">' + s.parent + '</b></span>' : '');
}

function selectPkg(i) { activePkg = i; activeTab = 0; render(); }
function selectTab(i) { activeTab = i; renderTabs(); renderGraph(); renderStats(); }
function render() { renderSidebar(); renderTabs(); renderGraph(); renderStats(); }
function shortName(n) { const p = n.split('/'); return p.length > 1 ? p.slice(-2).join('/') : n; }
function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

// Event delegation — avoids inline onclick handlers blocked by CSP
document.addEventListener('click', function(e) {
  const t = e.target.closest('[data-pkg],[data-tab],[data-action]');
  if (!t) return;
  if (t.dataset.pkg !== undefined) selectPkg(parseInt(t.dataset.pkg));
  else if (t.dataset.tab !== undefined) selectTab(parseInt(t.dataset.tab));
  else if (t.dataset.action === 'fit') fitGraph();
  else if (t.dataset.action === 'refresh') { if (vscodeApi) vscodeApi.postMessage({ command: 'refresh' }); else location.reload(); }
  else if (t.dataset.action === 'closeDetail') closeDetail();
  else if (t.dataset.action === 'openFile') openFile(t.dataset.path);
});

// Handle messages from the extension (e.g. navigate to a specific container)
window.addEventListener('message', function(e) {
  const msg = e.data;
  if (!msg) return;
  if (msg.command === 'selectByPath' && msg.path) {
    // Find the project and tab matching the given source path
    for (let p = 0; p < DATA.length; p++) {
      for (let t = 0; t < DATA[p].containers.length; t++) {
        if (DATA[p].containers[t].sourcePath === msg.path) {
          activePkg = p;
          activeTab = t;
          render();
          return;
        }
      }
    }
  }
});

render();
`;
}
