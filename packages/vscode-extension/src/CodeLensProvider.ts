import * as vscode from 'vscode';

export class NeoSyringeCodeLensProvider implements vscode.CodeLensProvider {
  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const lenses: vscode.CodeLens[] = [];
    const text = document.getText();
    const regex = /defineBuilderConfig/g;
    let match: RegExpExecArray | null;

    while ((match = regex.exec(text)) !== null) {
      const pos = document.positionAt(match.index);
      const range = new vscode.Range(pos, pos);
      lenses.push(
        new vscode.CodeLens(range, {
          title: '$(type-hierarchy) Show Dependency Graph',
          command: 'neosyringe.showGraph',
          arguments: [document.uri.fsPath],
        })
      );
    }

    return lenses;
  }
}
