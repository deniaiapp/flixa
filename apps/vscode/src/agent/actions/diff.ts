import * as vscode from 'vscode';
import type { ActionExecutionResult, AgentActionDiff, PendingDiff } from '../../types';
import { isPathInsideWorkspace, resolveFilePath } from '../../utils/workspace';
import { showDiffPreview } from '../../diff/preview';

export async function executeDiffAction(
	action: AgentActionDiff,
	storePendingDiff: (diff: PendingDiff) => void,
	abortSignal?: AbortSignal
): Promise<ActionExecutionResult> {
	try {
		if (abortSignal?.aborted) {
			return {
				action,
				success: false,
				error: 'Action cancelled',
			};
		}
		console.log('[Flixa] executeDiffAction start', action.filePath);
		const resolvedPath = resolveFilePath(action.filePath);

		if (!isPathInsideWorkspace(action.filePath)) {
			return {
				action,
				success: false,
				error: `Path ${action.filePath} is outside workspace`,
			};
		}

		const uri = vscode.Uri.file(resolvedPath);
		const document = await vscode.workspace.openTextDocument(uri);
		const originalContent = document.getText();

		const { applyDiffToContent } = await import('../../diff/validator');
		const newContent = applyDiffToContent(originalContent, action.diff);

		if (!newContent) {
			return {
				action,
				success: false,
				error: 'Failed to apply diff',
			};
		}

		await showDiffPreview(
			uri,
			originalContent,
			newContent,
			'chat',
			storePendingDiff
		);

		return {
			action,
			success: true,
			output: 'Diff preview shown - awaiting user apply command',
		};
	} catch (error) {
		console.log(
			'[Flixa] executeDiffAction error',
			action.filePath,
			error instanceof Error ? error.message : String(error)
		);
		return {
			action,
			success: false,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}
