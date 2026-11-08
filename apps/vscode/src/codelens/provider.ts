import * as vscode from 'vscode';

const COMMENT_PATTERNS = [
  /\/\/\s*TODO\s*:\s*(.*)/i,
  /\/\/\s*implement\s*:\s*(.*)/i,
  /\/\*\s*TODO\s+(.*?)\s*\*\//i,
  /#\s*TODO\s*:\s*(.*)/i,
  /@flixa\s+implement\s+(.*)/i,
];

export interface DetectedComment {
  line: number;
  payload: string;
  range: vscode.Range;
}

export class FlixaCodeLensProvider implements vscode.CodeLensProvider {
  private _onDidChangeCodeLenses: vscode.EventEmitter<void> =
    new vscode.EventEmitter<void>();
  public readonly onDidChangeCodeLenses: vscode.Event<void> =
    this._onDidChangeCodeLenses.event;

  constructor() {
    vscode.workspace.onDidChangeTextDocument(() => {
      this._onDidChangeCodeLenses.fire();
    });
  }

  public provideCodeLenses(
    document: vscode.TextDocument,
    _token: vscode.CancellationToken
  ): vscode.CodeLens[] {
    console.log('[Flixa CodeLens] provideCodeLenses called for:', document.uri.fsPath);
    const codeLenses: vscode.CodeLens[] = [];
    const detectedComments = this.detectComments(document);
    console.log('[Flixa CodeLens] detected comments:', detectedComments.length);

    for (const comment of detectedComments) {
      const range = new vscode.Range(
        new vscode.Position(comment.line, 0),
        new vscode.Position(comment.line, 0)
      );

      const codeLens = new vscode.CodeLens(range, {
        title: 'Implement (Flixa)',
        command: 'flixa.implementComment',
        arguments: [document.uri, comment.line, comment.payload],
      });

      codeLenses.push(codeLens);
    }

    return codeLenses;
  }

  private detectComments(document: vscode.TextDocument): DetectedComment[] {
    const comments: DetectedComment[] = [];

    for (let i = 0; i < document.lineCount; i++) {
      const line = document.lineAt(i);
      const text = line.text;

      for (const pattern of COMMENT_PATTERNS) {
        const match = text.match(pattern);
        if (match) {
          comments.push({
            line: i,
            payload: match[1]?.trim() || '',
            range: line.range,
          });
          break;
        }
      }
    }

    return comments;
  }

  public refresh(): void {
    this._onDidChangeCodeLenses.fire();
  }
}
