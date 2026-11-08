import * as vscode from 'vscode';
import { PendingDiff } from '../types';

export async function applyPendingDiff(
  pendingDiff: PendingDiff | null,
  clearPendingDiff: () => void
): Promise<boolean> {
  if (!pendingDiff) {
    vscode.window.showErrorMessage('No pending diff to apply.');
    return false;
  }

  const fileUri = vscode.Uri.file(pendingDiff.filePath);

  try {
    const edit = new vscode.WorkspaceEdit();

    const document = await vscode.workspace.openTextDocument(fileUri);
    const fullRange = new vscode.Range(
      new vscode.Position(0, 0),
      new vscode.Position(
        document.lineCount - 1,
        document.lineAt(document.lineCount - 1).text.length
      )
    );

    edit.replace(fileUri, fullRange, pendingDiff.newContent);

    const success = await vscode.workspace.applyEdit(edit);

    if (success) {
      clearPendingDiff();
      vscode.window.showInformationMessage('Flixa: Diff applied successfully.');
      return true;
    } else {
      vscode.window.showErrorMessage('Flixa: Failed to apply diff.');
      return false;
    }
  } catch (error) {
    vscode.window.showErrorMessage(
      `Flixa: Error applying diff: ${error instanceof Error ? error.message : String(error)}`
    );
    return false;
  }
}
