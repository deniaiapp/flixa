import type {
	AgentAction,
	ActionExecutionResult,
	ApprovalMode,
	PendingDiff,
	AllowlistConfig,
} from '../types';
import { requiresApproval } from '../types';
import {
	executeShellAction,
	executeVscodeCommandAction,
	executeWriteFileAction,
	executeEditFileAction,
	executeDeleteFileAction,
	executeDiffAction,
	executeReadFileAction,
	executeListDirAction,
	executeGrepSearchAction,
	executeSearchReplaceAction,
	executeFileSearchAction,
	executeCodebaseSearchAction,
	executeEditFileNewAction,
	executeDeleteFileNewAction,
} from './actions';
import { requestIndividualApproval } from './approval';
import { describeAction } from '../utils/format';

export interface ExecuteActionsOptions {
	actions: AgentAction[];
	approvalMode: ApprovalMode;
	allowlist?: AllowlistConfig;
	storePendingDiff: (diff: PendingDiff) => void;
	onOutput?: (actionDesc: string, output: string) => void;
	onSafetyCheck?: (actionDesc: string, checking: boolean) => void;
	abortSignal?: AbortSignal;
}

export async function executeAgentActions(
	options: ExecuteActionsOptions
): Promise<ActionExecutionResult[]> {
	const {
		actions,
		approvalMode,
		allowlist,
		storePendingDiff,
		onOutput,
		onSafetyCheck,
		abortSignal,
	} = options;
	console.log(
		'[Flixa] executeAgentActions start',
		actions.length,
		approvalMode
	);
	const results: ActionExecutionResult[] = [];

	for (const action of actions) {
		if (abortSignal?.aborted) {
			results.push({
				action,
				success: false,
				error: 'Action cancelled',
			});
			continue;
		}

		console.log('[Flixa] executeAgentActions action', action.type);

		// Check if this action requires approval
		const needsApproval = requiresApproval(action, approvalMode, allowlist);

		if (needsApproval) {
			const userChoice = await requestIndividualApproval(action);
			if (userChoice !== 'approve') {
				results.push({
					action,
					success: false,
					rejected: true,
					rejectionReason: 'User rejected action',
				});
				continue;
			}
		}

		const result = await executeSingleAction(
			action,
			approvalMode,
			storePendingDiff,
			onOutput,
			onSafetyCheck,
			abortSignal
		);
		results.push(result);
	}

	console.log('[Flixa] executeAgentActions done', results.length);
	return results;
}

async function executeSingleAction(
	action: AgentAction,
	approvalMode: ApprovalMode,
	storePendingDiff: (diff: PendingDiff) => void,
	onOutput?: (actionDesc: string, output: string) => void,
	onSafetyCheck?: (actionDesc: string, checking: boolean) => void,
	abortSignal?: AbortSignal
): Promise<ActionExecutionResult> {
	const actionDesc = describeAction(action);

	switch (action.type) {
		case 'shell':
			return executeShellAction(
				action,
				approvalMode,
				onOutput,
				onSafetyCheck,
				abortSignal
			);
		case 'vscodeCommand':
			if (onOutput) {
				onOutput(actionDesc, '');
			}
			return executeVscodeCommandAction(action, abortSignal);
		case 'writeFile':
			if (onOutput) {
				onOutput(actionDesc, '');
			}
			return executeWriteFileAction(action, abortSignal);
		case 'editFile':
			if (onOutput) {
				onOutput(actionDesc, '');
			}
			return executeEditFileAction(action, abortSignal);
		case 'deleteFile':
			if (onOutput) {
				onOutput(actionDesc, '');
			}
			return executeDeleteFileAction(action, abortSignal);
		case 'diff':
			if (onOutput) {
				onOutput(actionDesc, '');
			}
			return executeDiffAction(action, storePendingDiff, abortSignal);
		case 'read_file':
			if (onOutput) {
				onOutput(actionDesc, '');
			}
			return executeReadFileAction(action, abortSignal);
		case 'list_dir':
			if (onOutput) {
				onOutput(actionDesc, '');
			}
			return executeListDirAction(action, abortSignal);
		case 'grep_search':
			if (onOutput) {
				onOutput(actionDesc, '');
			}
			return executeGrepSearchAction(action, abortSignal);
		case 'search_replace':
			if (onOutput) {
				onOutput(actionDesc, '');
			}
			return executeSearchReplaceAction(action, abortSignal);
		case 'file_search':
			if (onOutput) {
				onOutput(actionDesc, '');
			}
			return executeFileSearchAction(action, abortSignal);
		case 'codebase_search':
			if (onOutput) {
				onOutput(actionDesc, '');
			}
			return executeCodebaseSearchAction(action, abortSignal);
		case 'run_terminal_cmd':
			return executeShellAction(
				{ type: 'shell', command: action.command },
				approvalMode,
				onOutput,
				onSafetyCheck,
				abortSignal
			);
		case 'edit_file':
			if (onOutput) {
				onOutput(actionDesc, '');
			}
			return executeEditFileNewAction(action, abortSignal);
		case 'delete_file':
			if (onOutput) {
				onOutput(actionDesc, '');
			}
			return executeDeleteFileNewAction(action, abortSignal);
		default:
			return {
				action,
				success: false,
				error: `Unknown action type: ${(action as AgentAction).type}`,
			};
	}
}
