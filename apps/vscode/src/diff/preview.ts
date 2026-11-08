import * as vscode from 'vscode';
import { PendingDiff } from '../types';

export interface DiffPreviewResult {
  applied: boolean;
}

export async function showDiffPreview(
  originalUri: vscode.Uri,
  originalContent: string,
  newContent: string,
  flow: 'codelens' | 'chat',
  storePendingDiff: (diff: PendingDiff) => void
): Promise<DiffPreviewResult> {
  const scheme = 'flixa-diff';
  const originalPath = `${scheme}:${originalUri.fsPath}?original`;
  const newPath = `${scheme}:${originalUri.fsPath}?new`;

  const originalVirtualUri = vscode.Uri.parse(originalPath);
  const newVirtualUri = vscode.Uri.parse(newPath);

  const provider = new DiffContentProvider(originalContent, newContent);

  const disposable = vscode.workspace.registerTextDocumentContentProvider(
    scheme,
    provider
  );

  const title =
    flow === 'codelens' ? 'Flixa Implement: Diff' : 'Flixa Chat: Diff';

  const pendingDiff: PendingDiff = {
    filePath: originalUri.fsPath,
    originalContent,
    newContent,
    flow,
  };
  storePendingDiff(pendingDiff);

  await vscode.commands.executeCommand(
    'vscode.diff',
    originalVirtualUri,
    newVirtualUri,
    title,
    { preview: true }
  );

  // Show Quick Pick for apply/cancel
  const choice = await vscode.window.showQuickPick(
    [
      { label: '$(check) Apply', description: 'Apply the diff to the file', value: 'apply' },
      { label: '$(x) Cancel', description: 'Discard the diff', value: 'cancel' }
    ],
    {
      placeHolder: 'Apply this diff?',
      ignoreFocusOut: true
    }
  );

  disposable.dispose();

  if (choice?.value === 'apply') {
    const applied = await applyDiffDirectly(pendingDiff);
    return { applied };
  }

  return { applied: false };
}

async function applyDiffDirectly(pendingDiff: PendingDiff): Promise<boolean> {
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
      // Close the diff editor and show the updated file
      await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
      await vscode.window.showTextDocument(fileUri);
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

class DiffContentProvider implements vscode.TextDocumentContentProvider {
  private originalContent: string;
  private newContent: string;

  constructor(originalContent: string, newContent: string) {
    this.originalContent = originalContent;
    this.newContent = newContent;
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    if (uri.query === 'original') {
      return this.originalContent;
    } else if (uri.query === 'new') {
      return this.newContent;
    }
    return '';
  }
}
