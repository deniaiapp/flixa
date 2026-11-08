import type { AgentAction, AgentResponse, LLMResponse } from '../types';

export function parseLLMResponse(raw: string): LLMResponse {
	let text = raw.trim();

	if (text.startsWith('```json')) {
		text = text.replace(/^```json\n?/, '').replace(/\n?```$/, '');
	} else if (text.startsWith('```')) {
		text = text.replace(/^```\n?/, '').replace(/\n?```$/, '');
	}

	try {
		const parsed = JSON.parse(text);
		if (
			parsed &&
			typeof parsed === 'object' &&
			(parsed.type === 'message' || parsed.type === 'diff') &&
			typeof parsed.message === 'string'
		) {
			return {
				type: parsed.type,
				message: parsed.message,
				diff: typeof parsed.diff === 'string' ? parsed.diff : '',
			};
		}
	} catch {
		// Not valid JSON
	}

	return {
		type: 'message',
		message: raw,
		diff: '',
	};
}

export function parseAgentResponse(raw: string): AgentResponse | LLMResponse {
	let text = raw.trim();

	if (text.startsWith('```json')) {
		text = text.replace(/^```json\n?/, '').replace(/\n?```$/, '');
	} else if (text.startsWith('```')) {
		text = text.replace(/^```\n?/, '').replace(/\n?```$/, '');
	}

	try {
		const parsed = JSON.parse(text);

		if (parsed && typeof parsed === 'object' && parsed.type === 'agent') {
			if (typeof parsed.message !== 'string') {
				return {
					type: 'message',
					message: 'Invalid agent response: missing message',
					diff: '',
				};
			}

			if (!Array.isArray(parsed.actions)) {
				return {
					type: 'message',
					message: 'Invalid agent response: actions must be an array',
					diff: '',
				};
			}

			const validActions: AgentAction[] = [];
			for (const action of parsed.actions) {
				if (
					!action ||
					typeof action !== 'object' ||
					typeof action.type !== 'string'
				) {
					continue;
				}

				switch (action.type) {
					case 'shell':
						if (typeof action.command === 'string') {
							validActions.push({ type: 'shell', command: action.command });
						}
						break;
					case 'vscodeCommand':
						if (typeof action.command === 'string') {
							validActions.push({
								type: 'vscodeCommand',
								command: action.command,
								args: Array.isArray(action.args) ? action.args : undefined,
							});
						}
						break;
					case 'writeFile':
						if (
							typeof action.filePath === 'string' &&
							typeof action.content === 'string'
						) {
							validActions.push({
								type: 'writeFile',
								filePath: action.filePath,
								content: action.content,
							});
						}
						break;
					case 'editFile':
						if (
							typeof action.filePath === 'string' &&
							typeof action.search === 'string' &&
							typeof action.replace === 'string'
						) {
							validActions.push({
								type: 'editFile',
								filePath: action.filePath,
								search: action.search,
								replace: action.replace,
							});
						}
						break;
					case 'deleteFile':
						if (typeof action.filePath === 'string') {
							validActions.push({
								type: 'deleteFile',
								filePath: action.filePath,
							});
						}
						break;
					case 'diff':
						if (
							typeof action.filePath === 'string' &&
							typeof action.diff === 'string'
						) {
							validActions.push({
								type: 'diff',
								filePath: action.filePath,
								diff: action.diff,
							});
						}
						break;
				}
			}

			return {
				type: 'agent',
				message: parsed.message,
				actions: validActions,
			};
		}

		if (
			parsed &&
			typeof parsed === 'object' &&
			(parsed.type === 'message' || parsed.type === 'diff') &&
			typeof parsed.message === 'string'
		) {
			return {
				type: parsed.type,
				message: parsed.message,
				diff: typeof parsed.diff === 'string' ? parsed.diff : '',
			};
		}
	} catch {
		// JSON parse failed
	}

	return {
		type: 'message',
		message: raw,
		diff: '',
	};
}

/**
 * Convert tool calls from Vercel AI SDK to AgentActions.
 * Supports both Cursor-style tools and legacy tools.
 */
export function convertToolCallsToActions(
	toolCalls: Array<{ toolName: string; input: unknown }>
): AgentAction[] {
	const actions: AgentAction[] = [];

	for (const toolCall of toolCalls) {
		const input = toolCall.input as Record<string, unknown>;

		switch (toolCall.toolName) {
			// Cursor-style tools
			case 'codebase_search':
				if (typeof input.query === 'string') {
					actions.push({
						type: 'codebase_search',
						query: input.query,
						target_directories: Array.isArray(input.target_directories)
							? (input.target_directories as string[])
							: undefined,
						explanation: '',
					});
				}
				break;

			case 'read_file':
				if (typeof input.target_file === 'string') {
					actions.push({
						type: 'read_file',
						target_file: input.target_file,
						should_read_entire_file: !input.start_line && !input.end_line,
						start_line_one_indexed:
							typeof input.start_line === 'number' ? input.start_line : 1,
						end_line_one_indexed_inclusive:
							typeof input.end_line === 'number' ? input.end_line : 9999,
						explanation: '',
					});
				}
				break;

			case 'list_dir':
				if (typeof input.path === 'string') {
					actions.push({
						type: 'list_dir',
						relative_workspace_path: input.path,
						explanation: '',
					});
				}
				break;

			case 'grep_search':
				if (typeof input.query === 'string') {
					actions.push({
						type: 'grep_search',
						query: input.query,
						case_sensitive: input.case_sensitive === true,
						include_pattern:
							typeof input.include_pattern === 'string'
								? input.include_pattern
								: undefined,
						exclude_pattern:
							typeof input.exclude_pattern === 'string'
								? input.exclude_pattern
								: undefined,
						explanation: '',
					});
				}
				break;

			case 'file_search':
				if (typeof input.query === 'string') {
					actions.push({
						type: 'file_search',
						query: input.query,
						explanation: '',
					});
				}
				break;

			case 'edit_file':
				if (typeof input.target_file === 'string') {
					actions.push({
						type: 'edit_file',
						target_file: input.target_file,
						instructions:
							typeof input.instructions === 'string' ? input.instructions : '',
						diff: typeof input.diff === 'string' ? input.diff : '',
					});
				}
				break;

			case 'write_file':
				if (
					typeof input.target_file === 'string' &&
					typeof input.content === 'string'
				) {
					actions.push({
						type: 'writeFile',
						filePath: input.target_file,
						content: input.content,
					});
				}
				break;

			case 'delete_file':
				if (typeof input.target_file === 'string') {
					actions.push({
						type: 'delete_file',
						target_file: input.target_file,
						explanation: '',
					});
				}
				break;

			case 'run_terminal_cmd':
				if (typeof input.command === 'string') {
					actions.push({
						type: 'run_terminal_cmd',
						command: input.command,
						is_background: input.is_background === true,
						explanation: '',
					});
				}
				break;

			// Legacy tools (kept for backwards compatibility)
			case 'shell':
				if (typeof input.command === 'string') {
					actions.push({ type: 'shell', command: input.command });
				}
				break;

			case 'vscodeCommand':
				if (typeof input.command === 'string') {
					actions.push({
						type: 'vscodeCommand',
						command: input.command,
						args: Array.isArray(input.args) ? input.args : undefined,
					});
				}
				break;

			case 'writeFile':
				if (
					typeof input.filePath === 'string' &&
					typeof input.content === 'string'
				) {
					actions.push({
						type: 'writeFile',
						filePath: input.filePath,
						content: input.content,
					});
				}
				break;

			case 'editFile':
				if (
					typeof input.filePath === 'string' &&
					typeof input.search === 'string' &&
					typeof input.replace === 'string'
				) {
					actions.push({
						type: 'editFile',
						filePath: input.filePath,
						search: input.search,
						replace: input.replace,
					});
				}
				break;

			case 'deleteFile':
				if (typeof input.filePath === 'string') {
					actions.push({ type: 'deleteFile', filePath: input.filePath });
				}
				break;

			case 'diff':
				if (
					typeof input.filePath === 'string' &&
					typeof input.diff === 'string'
				) {
					actions.push({
						type: 'diff',
						filePath: input.filePath,
						diff: input.diff,
					});
				}
				break;

			case 'search_replace':
				if (
					typeof input.file_path === 'string' &&
					typeof input.old_string === 'string' &&
					typeof input.new_string === 'string'
				) {
					actions.push({
						type: 'search_replace',
						file_path: input.file_path,
						old_string: input.old_string,
						new_string: input.new_string,
					});
				}
				break;
		}
	}

	return actions;
}

export function stripCodeBlocks(text: string): string {
	let result = text.trim();
	if (result.startsWith('```')) {
		result = result.replace(/^```[\w]*\n?/, '').replace(/\n?```$/, '');
	}
	return result;
}
