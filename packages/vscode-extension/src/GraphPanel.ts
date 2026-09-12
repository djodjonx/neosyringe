import * as vscode from 'vscode';
import * as ts from 'typescript';
import * as path from 'path';
import { Analyzer } from '@djodjonx/neosyringe-core/analyzer';
import { TSContext } from '@djodjonx/neosyringe-core/context';
import { serializeGraph, buildStandaloneHtml } from '@djodjonx/neosyringe-ui';

export class GraphPanel {
  private static _instance: GraphPanel | undefined;
  private readonly _panel: vscode.WebviewPanel;

  private constructor(_extensionUri: vscode.Uri) {
    this._panel = vscode.window.createWebviewPanel(
      'neosyringeGraph',
      'NeoSyringe Graph',
      vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    this._panel.onDidDispose(() => { GraphPanel._instance = undefined; });
    this._loadContent();
  }

  static createOrShow(extensionUri: vscode.Uri): void {
    if (GraphPanel._instance) {
      GraphPanel._instance._panel.reveal();
      return;
    }
    GraphPanel._instance = new GraphPanel(extensionUri);
  }

  static refresh(): void {
    GraphPanel._instance?._loadContent();
  }

  static dispose(): void {
    GraphPanel._instance?._panel.dispose();
  }

  private _loadContent(): void {
    this._panel.webview.html = '<p style="font-family:system-ui;padding:24px">Analyzing…</p>';

    try {
      const html = buildGraphHtml();
      this._panel.webview.html = html;
    } catch (err) {
      this._panel.webview.html = errorPage(String(err));
    }
  }
}

function buildGraphHtml(): string {
  const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!cwd) throw new Error('No workspace folder open.');

  const tsconfigPath = ts.findConfigFile(cwd, ts.sys.fileExists, 'tsconfig.json');
  if (!tsconfigPath) throw new Error('Could not find tsconfig.json in workspace.');

  TSContext.projectRoot = path.dirname(tsconfigPath);

  const { config } = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
  const { options, fileNames } = ts.parseJsonConfigFileContent(config, ts.sys, cwd);
  const program = ts.createProgram(fileNames, options);

  const analyzer = new Analyzer(program);
  const graphs = analyzer.extractAll();

  if (graphs.length === 0) {
    return noContainersPage();
  }

  return buildStandaloneHtml(graphs.map(serializeGraph));
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
