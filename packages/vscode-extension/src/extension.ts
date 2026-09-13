import * as vscode from 'vscode';
import { GraphPanel } from './GraphPanel';
import { NeoSyringeCodeLensProvider } from './CodeLensProvider';

export const outputChannel = vscode.window.createOutputChannel('NeoSyringe');

export function activate(context: vscode.ExtensionContext): void {
  outputChannel.appendLine('NeoSyringe extension activated');

  const showGraphCommand = vscode.commands.registerCommand('neosyringe.showGraph', () => {
    GraphPanel.createOrShow(context.extensionUri);
  });

  const codeLensProvider = vscode.languages.registerCodeLensProvider(
    { language: 'typescript', scheme: 'file' },
    new NeoSyringeCodeLensProvider()
  );

  context.subscriptions.push(showGraphCommand, codeLensProvider, outputChannel);

  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument(() => {
      GraphPanel.refresh();
    })
  );
}

export function deactivate(): void {
  GraphPanel.dispose();
}
