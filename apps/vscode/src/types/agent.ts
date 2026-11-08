import type { ChatCompletionToolCall } from './chat';

/**
 * Approval modes for agent actions:
 * - 'ALL_APPROVE': All actions execute immediately without any approval (YOLO mode)
 * - 'AUTO_APPROVE': AI checks if actions are safe before execution (recommended)
 * - 'SAFE_APPROVE': Read/write actions run automatically; shell commands need manual approval
 * - 'MANUAL_APPROVE': Review and approve each action individually
 */
export type ApprovalMode =
	| 'ALL_APPROVE'
	| 'AUTO_APPROVE'
	| 'SAFE_APPROVE'
	| 'MANUAL_APPROVE';

/**
 * Action categories for approval logic
 */
export type ActionCategory = 'read' | 'write' | 'execute' | 'search';

export type AgentActionType =
	| 'shell'
	| 'vscodeCommand'
	| 'writeFile'
	| 'editFile'
	| 'deleteFile'
	| 'diff'
	| 'codebase_search'
	| 'read_file'
	| 'run_terminal_cmd'
	| 'list_dir'
	| 'grep_search'
	| 'search_replace'
	| 'file_search'
	| 'edit_file'
	| 'delete_file';

export interface AgentActionShell {
	type: 'shell';
	command: string;
	/** AI's reason for why this command is needed and safe */
	reason?: string;
}

export interface AgentActionVscodeCommand {
	type: 'vscodeCommand';
	command: string;
	args?: unknown[];
}

export interface AgentActionWriteFile {
	type: 'writeFile';
	filePath: string;
	content: string;
}

export interface AgentActionEditFile {
	type: 'editFile';
	filePath: string;
	search: string;
	replace: string;
}

export interface AgentActionDeleteFile {
	type: 'deleteFile';
	filePath: string;
}

export interface AgentActionDiff {
	type: 'diff';
	filePath: string;
	diff: string;
}

export interface AgentActionCodebaseSearch {
	type: 'codebase_search';
	query: string;
	target_directories?: string[];
	explanation: string;
}

export interface AgentActionReadFile {
	type: 'read_file';
	target_file: string;
	should_read_entire_file: boolean;
	start_line_one_indexed: number;
	end_line_one_indexed_inclusive: number;
	explanation: string;
}

export interface AgentActionRunTerminalCmd {
	type: 'run_terminal_cmd';
	command: string;
	is_background: boolean;
	explanation: string;
}

export interface AgentActionListDir {
	type: 'list_dir';
	relative_workspace_path: string;
	explanation: string;
}

export interface AgentActionGrepSearch {
	type: 'grep_search';
	query: string;
	case_sensitive?: boolean;
	include_pattern?: string;
	exclude_pattern?: string;
	explanation: string;
}

export interface AgentActionSearchReplace {
	type: 'search_replace';
	file_path: string;
	old_string: string;
	new_string: string;
}

export interface AgentActionFileSearch {
	type: 'file_search';
	query: string;
	explanation: string;
}

export interface AgentActionEditFileNew {
	type: 'edit_file';
	target_file: string;
	instructions: string;
	diff: string;
}

export interface AgentActionDeleteFileNew {
	type: 'delete_file';
	target_file: string;
	explanation: string;
}

export type AgentAction =
	| AgentActionShell
	| AgentActionVscodeCommand
	| AgentActionWriteFile
	| AgentActionEditFile
	| AgentActionDeleteFile
	| AgentActionDiff
	| AgentActionCodebaseSearch
	| AgentActionReadFile
	| AgentActionRunTerminalCmd
	| AgentActionListDir
	| AgentActionGrepSearch
	| AgentActionSearchReplace
	| AgentActionFileSearch
	| AgentActionEditFileNew
	| AgentActionDeleteFileNew;

export interface AgentResponse {
	type: 'agent';
	message: string;
	actions: AgentAction[];
	toolCalls?: ChatCompletionToolCall[];
}

export interface ActionExecutionResult {
	action: AgentAction;
	success: boolean;
	output?: string;
	error?: string;
	rejected?: boolean;
	rejectionReason?: string;
}

export interface SafetyCheckResult {
	verdict: 'SAFE' | 'UNSAFE';
	reason: string;
}

/**
 * Allowlist configuration for auto-approval
 */
export interface AllowlistConfig {
	/** Shell commands that are auto-approved (regex patterns) */
	shellCommands: string[];
	/** File patterns that can be modified without approval (glob patterns) */
	filePatterns: string[];
	/** Action types that are always auto-approved */
	actionTypes: AgentActionType[];
}

/**
 * Default allowlist - read/search operations are always safe
 */
export const DEFAULT_ALLOWLIST: AllowlistConfig = {
	shellCommands: [],
	filePatterns: [],
	actionTypes: [
		'read_file',
		'list_dir',
		'grep_search',
		'file_search',
		'codebase_search',
	],
};

/**
 * Get the category of an action for approval logic
 */
export function getActionCategory(action: AgentAction): ActionCategory {
	switch (action.type) {
		case 'read_file':
		case 'list_dir':
			return 'read';
		case 'grep_search':
		case 'file_search':
		case 'codebase_search':
			return 'search';
		case 'shell':
		case 'run_terminal_cmd':
		case 'vscodeCommand':
			return 'execute';
		case 'writeFile':
		case 'editFile':
		case 'deleteFile':
		case 'diff':
		case 'search_replace':
		case 'edit_file':
		case 'delete_file':
			return 'write';
		default:
			return 'write';
	}
}

/**
 * Check if an action requires approval based on mode
 */
export function requiresApproval(
	action: AgentAction,
	mode: ApprovalMode,
	_allowlist: AllowlistConfig = DEFAULT_ALLOWLIST
): boolean {
	// ALL_APPROVE: YOLO mode - no approval needed
	if (mode === 'ALL_APPROVE') {
		return false;
	}

	// MANUAL_APPROVE: Everything needs approval
	if (mode === 'MANUAL_APPROVE') {
		return true;
	}

	// AUTO_APPROVE: AI safety check handles approval (handled in executor)
	// Return false here - the AI safety check is done separately
	if (mode === 'AUTO_APPROVE') {
		return false;
	}

	// SAFE_APPROVE: Read/write auto, shell commands need approval
	const category = getActionCategory(action);

	// Read and search actions never require approval
	if (category === 'read' || category === 'search') {
		return false;
	}

	// Write actions (file operations) don't require approval in SAFE_APPROVE
	if (category === 'write') {
		return false;
	}

	// Execute actions (shell commands) require approval in SAFE_APPROVE
	if (category === 'execute') {
		return true;
	}

	return true;
}
