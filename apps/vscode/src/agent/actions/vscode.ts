import * as vscode from 'vscode';
import type { ActionExecutionResult, AgentActionVscodeCommand } from '../../types';

export async function executeVscodeCommandAction(
	action: AgentActionVscodeCommand,
	abortSignal?: AbortSignal
): Promise<ActionExecutionResult> {
	try {
		if (abortSignal?.aborted) {
			return {
				action,
				success: false,
				error: 'Command cancelled',
			};
		}
		console.log('[Flixa] executeVscodeCommandAction start', action.command);
		await vscode.commands.executeCommand(action.command, ...(action.args || []));
		return {
			action,
			success: true,
		};
	} catch (error) {
		console.log(
			'[Flixa] executeVscodeCommandAction error',
			action.command,
			error instanceof Error ? error.message : String(error)
		);
		return {
			action,
			success: false,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}
