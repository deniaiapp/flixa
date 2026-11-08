import * as vscode from 'vscode';

/** Quick-pick approval used when the chat view is not open. */
export async function requestIndividualApproval(
  description: string,
): Promise<'approve' | 'reject'> {
  const choice = await vscode.window.showQuickPick(
    [
      { label: '$(check) Approve', value: 'approve' },
      { label: '$(x) Reject', value: 'reject' },
    ],
    {
      placeHolder: description,
      ignoreFocusOut: true,
    },
  );

  return choice?.value === 'approve' ? 'approve' : 'reject';
}
