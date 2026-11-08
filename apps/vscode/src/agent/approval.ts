import * as vscode from 'vscode';
import type { AgentAction } from '../types';

export interface ManualApprovalResult {
	type: 'approve_all' | 'reject_all' | 'individual';
	approved: number[];
}

export async function requestManualApproval(
	actions: AgentAction[]
): Promise<ManualApprovalResult> {
	const actionDescriptions = actions.map((action, index) => {
		switch (action.type) {
			case 'shell':
				return `${index + 1}. Shell: ${action.command.substring(0, 50)}${action.command.length > 50 ? '...' : ''}`;
			case 'vscodeCommand':
				return `${index + 1}. VSCode Command: ${action.command}`;
			case 'writeFile':
				return `${index + 1}. Write File: ${action.filePath}`;
			case 'editFile':
				return `${index + 1}. Edit File: ${action.filePath}`;
			case 'deleteFile':
				return `${index + 1}. Delete File: ${action.filePath}`;
			case 'diff':
				return `${index + 1}. Diff: ${action.filePath}`;
			default:
				return `${index + 1}. Unknown action`;
		}
	});

	const choice = await vscode.window.showQuickPick(
		[
			{ label: '$(check-all) Approve All', value: 'approve_all' },
			{ label: '$(x) Reject All', value: 'reject_all' },
			{ label: '$(list-unordered) Review Individual', value: 'individual' },
		],
		{
			placeHolder: `${actions.length} actions pending:\n${actionDescriptions.join('\n')}`,
			ignoreFocusOut: true,
		}
	);

	if (!choice || choice.value === 'reject_all') {
		return { type: 'reject_all', approved: [] };
	}

	if (choice.value === 'approve_all') {
		return { type: 'approve_all', approved: actions.map((_, i) => i) };
	}

	return { type: 'individual', approved: [] };
}

export async function requestIndividualApproval(
	action: AgentAction
): Promise<'approve' | 'reject'> {
	let description: string;
	switch (action.type) {
		case 'shell':
			description = `Shell command: ${action.command}`;
			break;
		case 'vscodeCommand':
			description = `VSCode command: ${action.command}`;
			break;
		case 'writeFile':
			description = `Write file: ${action.filePath}`;
			break;
		case 'editFile':
			description = `Edit file: ${action.filePath}`;
			break;
		case 'deleteFile':
			description = `Delete file: ${action.filePath}`;
			break;
		case 'diff':
			description = `Apply diff to: ${action.filePath}`;
			break;
		default:
			description = 'Unknown action';
	}

	const choice = await vscode.window.showQuickPick(
		[
			{ label: '$(check) Approve', value: 'approve' },
			{ label: '$(x) Reject', value: 'reject' },
		],
		{
			placeHolder: description,
			ignoreFocusOut: true,
		}
	);

	return choice?.value === 'approve' ? 'approve' : 'reject';
}
