import * as vscode from 'vscode';
import * as ts from 'typescript';
import * as path from 'path';
import * as fs from 'fs';
import { Analyzer } from '@djodjonx/neosyringe-core/analyzer';
import { TSContext } from '@djodjonx/neosyringe-core/context';
import { serializeGraph, buildProjectHtml, buildWebviewScript } from '@djodjonx/neosyringe-ui';
import type { ProjectGraphs } from '@djodjonx/neosyringe-ui';
import { outputChannel } from './extension';

function getNonce(): string {
  let text = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) text += chars.charAt(Math.floor(Math.random() * chars.length));
  return text;
}

export class GraphPanel {
  private static _instance: GraphPanel | undefined;
  private readonly _panel: vscode.WebviewPanel;
  private readonly _extensionUri: vscode.Uri;

  private constructor(extensionUri: vscode.Uri, initialFilePath?: string) {
    this._extensionUri = extensionUri;
    this._panel = vscode.window.createWebviewPanel(
      'neosyringeGraph',
      'NeoSyringe Graph',
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')],
      }
    );
    this._panel.onDidDispose(() => { GraphPanel._instance = undefined; });
    this._panel.webview.onDidReceiveMessage(msg => {
      if (msg.command === 'openFile' && msg.path) {
        vscode.workspace.openTextDocument(msg.path).then(doc => vscode.window.showTextDocument(doc));
      }
      if (msg.command === 'refresh') {
        this._loadContent();
      }
    });
    this._loadContent(initialFilePath);
  }

  static createOrShow(extensionUri: vscode.Uri, filePath?: string): void {
    if (GraphPanel._instance) {
      GraphPanel._instance._panel.reveal();
      // Navigate to the specific file's container
      if (filePath) {
        GraphPanel._instance._panel.webview.postMessage({ command: 'selectByPath', path: filePath });
      }
      return;
    }
    GraphPanel._instance = new GraphPanel(extensionUri, filePath);
  }

  static refresh(): void {
    GraphPanel._instance?._loadContent();
  }

  static dispose(): void {
    GraphPanel._instance?._panel.dispose();
  }

  private _loadContent(initialFilePath?: string): void {
    this._panel.webview.html = '<p style="font-family:system-ui;padding:24px;background:#1e1e2e;color:#cdd6f4">Analyzing…</p>';

    try {
      outputChannel.appendLine('Building graph HTML...');
      const nonce = getNonce();
      const cspSource = this._panel.webview.cspSource;
      outputChannel.appendLine(`cspSource: ${cspSource}`);

      // Write webview.js to media/ folder so it can be served as a local resource
      const mediaDir = vscode.Uri.joinPath(this._extensionUri, 'media').fsPath;
      if (!fs.existsSync(mediaDir)) fs.mkdirSync(mediaDir, { recursive: true });
      const scriptPath = path.join(mediaDir, 'webview.js');
      fs.writeFileSync(scriptPath, buildWebviewScript(), 'utf-8');

      const scriptUri = this._panel.webview.asWebviewUri(
        vscode.Uri.joinPath(this._extensionUri, 'media', 'webview.js')
      );
      // cytoscape.js is pre-built by esbuild.mjs into media/cytoscape.js
      const cytoscapeUri = this._panel.webview.asWebviewUri(
        vscode.Uri.joinPath(this._extensionUri, 'media', 'cytoscape.js')
      );
      outputChannel.appendLine(`Script URI: ${scriptUri}`);
      outputChannel.appendLine(`Cytoscape URI: ${cytoscapeUri}`);

      const html = buildGraphHtml(this._panel.webview, nonce, cspSource, scriptUri.toString(), cytoscapeUri.toString());
      outputChannel.appendLine(`HTML generated, length: ${html.length}`);
      this._panel.webview.html = html;

      // After load, navigate to the container from the clicked file
      if (initialFilePath) {
        // Give the webview time to initialize, then post the select message
        setTimeout(() => {
          this._panel.webview.postMessage({ command: 'selectByPath', path: initialFilePath });
        }, 500);
      }
    } catch (err) {
      this._panel.webview.html = errorPage(String(err));
    }
  }
}

/**
 * Finds all tsconfig.json in the workspace, excluding node_modules.
 * For monorepos: returns one tsconfig per package.
 */
function findAllTsconfigs(workspaceFolders: readonly vscode.WorkspaceFolder[]): string[] {
  const found: string[] = [];
  for (const folder of workspaceFolders) {
    const matches = vscode.workspace.findFiles(
      new vscode.RelativePattern(folder, '**/tsconfig.json'),
      new vscode.RelativePattern(folder, '**/node_modules/**')
    );
    // findFiles is async — we use sync glob via ts.sys instead
    collectTsconfigs(folder.uri.fsPath, found);
  }
  return found;
}

function collectTsconfigs(dir: string, result: string[], depth = 0): void {
  if (depth > 6) return; // don't go too deep
  const tsconfig = path.join(dir, 'tsconfig.json');
  if (ts.sys.fileExists(tsconfig)) result.push(tsconfig);
  try {
    for (const entry of ts.sys.getDirectories(dir)) {
      if (entry === 'node_modules' || entry === 'dist' || entry === '.git') continue;
      collectTsconfigs(path.join(dir, entry), result, depth + 1);
    }
  } catch {
    // ignore permission errors
  }
}

function buildGraphHtml(_webview: vscode.Webview, nonce: string, cspSource: string, scriptUri: string, cytoscapeUri: string): string {
  const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
  if (workspaceFolders.length === 0) throw new Error('No workspace folder open.');

  const tsconfigs = findAllTsconfigs(workspaceFolders);
  outputChannel.appendLine(`Found ${tsconfigs.length} tsconfig(s): ${tsconfigs.join(', ')}`);

  if (tsconfigs.length === 0) {
    throw new Error(`Could not find any tsconfig.json in workspace:\n${workspaceFolders.map(f => f.uri.fsPath).join('\n')}`);
  }

  TSContext.projectRoot = workspaceFolders[0].uri.fsPath;

  const projects: ProjectGraphs[] = [];

  for (const tsconfigPath of tsconfigs) {
    try {
      const projectRoot = path.dirname(tsconfigPath);
      const { config } = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
      const { options, fileNames } = ts.parseJsonConfigFileContent(config, ts.sys, projectRoot);

      outputChannel.appendLine(`${tsconfigPath}: ${fileNames.length} files`);
      if (fileNames.length === 0) continue;

      const program = ts.createProgram(fileNames, options);
      const analyzer = new Analyzer(program);
      const graphs = analyzer.extractAll();

      outputChannel.appendLine(`  → ${graphs.length} graphs, nodes: ${graphs.map(g => g.nodes.size).join(', ')}`);
      if (graphs.length === 0) continue;

      const workspaceRoot = workspaceFolders[0].uri.fsPath;
      const relPath = path.relative(workspaceRoot, projectRoot);
      const projectName = relPath || path.basename(workspaceRoot);

      projects.push({ projectName, graphs: graphs.map(serializeGraph) });
    } catch (e) {
      outputChannel.appendLine(`  ✗ Error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  outputChannel.appendLine(`Total projects: ${projects.length}`);
  if (projects.length === 0) return noContainersPage();

  return buildProjectHtml(projects, nonce, cspSource, scriptUri, cytoscapeUri);
}

function errorPage(message: string): string {
  return `<!DOCTYPE html><html><body style="font-family:system-ui;padding:24px;background:#1a1a2e;color:#ef9a9a">
    <h2>⚠️ NeoSyringe — Analysis Error</h2>
    <pre style="background:#2d2d4a;padding:16px;border-radius:8px;overflow:auto">${escapeHtml(message)}</pre>
  </body></html>`;
}

function noContainersPage(): string {
  return `<!DOCTYPE html><html><body style="font-family:system-ui;padding:24px;background:#1a1a2e;color:#90caf9">
    <h2>NeoSyringe — No Containers Found</h2>
    <p>No <code>defineBuilderConfig</code> calls detected in this workspace.</p>
  </body></html>`;
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
