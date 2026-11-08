import type { AgentAction, SerializedActionResult } from '../types';

export function describeAction(action: AgentAction): string {
	switch (action.type) {
		case 'shell':
			return `Shell: ${action.command.substring(0, 50)}`;
		case 'vscodeCommand':
			return `VSCode: ${action.command}`;
		case 'writeFile':
			return `Write: ${action.filePath}`;
		case 'editFile':
			return `Edit: ${action.filePath}`;
		case 'deleteFile':
			return `Delete: ${action.filePath}`;
		case 'diff':
			return `Diff: ${action.filePath}`;
		case 'codebase_search':
			return `Codebase Search: ${action.query.substring(0, 50)}`;
		case 'read_file':
			return `Read: ${action.target_file}`;
		case 'run_terminal_cmd':
			return `Terminal: ${action.command.substring(0, 50)}`;
		case 'list_dir':
			return `List Dir: ${action.relative_workspace_path}`;
		case 'grep_search':
			return `Grep: ${action.query.substring(0, 50)}`;
		case 'search_replace':
			return `Search Replace: ${action.file_path}`;
		case 'file_search':
			return `File Search: ${action.query}`;
		case 'edit_file':
			return `Edit: ${action.target_file}`;
		case 'delete_file':
			return `Delete: ${action.target_file}`;
		default:
			return `Unknown action`;
	}
}

export function describeActionFull(action: AgentAction): string {
	switch (action.type) {
		case 'shell':
			return `[Shell] ${action.command}`;
		case 'vscodeCommand':
			return `[VSCode Command] ${action.command}${action.args ? ` (args: ${JSON.stringify(action.args)})` : ''}`;
		case 'writeFile':
			return `[Write File] ${action.filePath}`;
		case 'editFile': {
			const replaceLines = action.replace.split('\n').length;
			return `[Edit File] ${action.filePath} (edited ${replaceLines} lines)`;
		}
		case 'deleteFile':
			return `[Delete File] ${action.filePath}`;
		case 'diff':
			return `[Diff Preview] ${action.filePath}`;
		case 'codebase_search':
			return `[Codebase Search] ${action.query}`;
		case 'read_file':
			return `[Read File] ${action.target_file}`;
		case 'run_terminal_cmd':
			return `[Terminal] ${action.command}`;
		case 'list_dir':
			return `[List Directory] ${action.relative_workspace_path}`;
		case 'grep_search':
			return `[Grep Search] ${action.query}`;
		case 'search_replace':
			return `[Search Replace] ${action.file_path}`;
		case 'file_search':
			return `[File Search] ${action.query}`;
		case 'edit_file':
			return `[Edit File] ${action.target_file}`;
		case 'delete_file':
			return `[Delete File] ${action.target_file}`;
		default:
			return `[Unknown Action]`;
	}
}

export function formatSessionResults(results: SerializedActionResult[]): string {
	const lines: string[] = ['[Action Results]'];
	const outputActions = /^(List Dir|Read|Terminal|Grep|File Search|Codebase Search|Shell):/i;

	for (const r of results) {
		if (r.rejected) {
			lines.push(`[REJECTED] ${r.action}: ${r.rejectionReason}`);
		} else if (r.success) {
			lines.push(`[SUCCESS] ${r.action}`);
			const hasOutput = r.output && r.output.trim() && r.output !== '(no output)';
			if (hasOutput) {
				lines.push(`  Output: ${r.output}`);
			} else if (outputActions.test(r.action)) {
				lines.push(`  Output: <no files or terminal output>`);
			}
		} else {
			lines.push(`[FAILED] ${r.action}: ${r.error}`);
			if (r.output && r.output.trim() && r.output !== '(no output)') {
				lines.push(`  Output: ${r.output}`);
			}
		}
	}
	lines.push('\nContinue with the next steps or finish if done.');
	return lines.join('\n');
}

export function generateNonce(): string {
	let text = '';
	const possible =
		'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	for (let i = 0; i < 32; i++) {
		text += possible.charAt(Math.floor(Math.random() * possible.length));
	}
	return text;
}
