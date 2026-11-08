import type { ModelMessage } from 'ai';
import { asSchema } from 'ai';
import { agentTools } from '../agent/tools';
import { log } from '../logger';
import { AGENT_SYSTEM_PROMPT } from './prompts';

export const DEFAULT_COMPACT_TOKEN_THRESHOLD = 200_000;

export function getCompactTokenThreshold(): number {
	try {
		const vscode = require('vscode') as typeof import('vscode');
		const config = vscode.workspace.getConfiguration('flixa');
		const value = config.get<number>('compactTokenThreshold');
		if (typeof value === 'number' && Number.isFinite(value)) {
			return Math.max(0, Math.floor(value));
		}
	} catch {
		// VS Code API unavailable (unit tests)
	}
	return DEFAULT_COMPACT_TOKEN_THRESHOLD;
}

/**
 * Rough token estimate: ~4 chars per token for mixed code/text.
 */
export function estimateTokenCount(value: unknown): number {
	try {
		const serialized =
			typeof value === 'string' ? value : JSON.stringify(value ?? '');
		if (!serialized) {
			return 0;
		}
		return Math.ceil(serialized.length / 4);
	} catch {
		return 0;
	}
}

function extractTextContent(content: unknown): string {
	if (typeof content === 'string') {
		return content;
	}
	if (!Array.isArray(content)) {
		return '';
	}
	const parts: string[] = [];
	for (const part of content) {
		if (!part || typeof part !== 'object') {
			continue;
		}
		const rec = part as Record<string, unknown>;
		if (typeof rec.text === 'string') {
			parts.push(rec.text);
		} else if (typeof rec.value === 'string') {
			parts.push(rec.value);
		}
	}
	return parts.join('');
}

/**
 * Convert AI SDK ModelMessage[] to Chat Completions-style messages for compact.
 */
export function modelMessagesToCompactMessages(
	messages: ModelMessage[]
): Array<Record<string, unknown>> {
	const result: Array<Record<string, unknown>> = [];

	for (const message of messages) {
		if (message.role === 'user') {
			const content =
				typeof message.content === 'string'
					? message.content
					: extractTextContent(message.content);
			result.push({ role: 'user', content });
			continue;
		}

		if (message.role === 'assistant') {
			if (typeof message.content === 'string') {
				result.push({ role: 'assistant', content: message.content });
				continue;
			}
			if (!Array.isArray(message.content)) {
				continue;
			}

			const textParts: string[] = [];
			const toolCalls: Array<Record<string, unknown>> = [];

			for (const part of message.content) {
				if (part.type === 'text') {
					textParts.push(part.text);
				} else if (part.type === 'tool-call') {
					toolCalls.push({
						id: part.toolCallId,
						type: 'function',
						function: {
							name: part.toolName,
							arguments:
								typeof part.input === 'string'
									? part.input
									: JSON.stringify(part.input ?? {}),
						},
					});
				}
			}

			const assistantMessage: Record<string, unknown> = {
				role: 'assistant',
				content: textParts.join('') || null,
			};
			if (toolCalls.length > 0) {
				assistantMessage.tool_calls = toolCalls;
			}
			result.push(assistantMessage);
			continue;
		}

		if (message.role === 'tool' && Array.isArray(message.content)) {
			for (const part of message.content) {
				if (part.type !== 'tool-result') {
					continue;
				}
				const output = part.output;
				let content = '';
				if (typeof output === 'string') {
					content = output;
				} else if (output && typeof output === 'object') {
					const rec = output as Record<string, unknown>;
					if (typeof rec.value === 'string') {
						content = rec.value;
					} else {
						try {
							content = JSON.stringify(output);
						} catch {
							content = String(output);
						}
					}
				}
				result.push({
					role: 'tool',
					tool_call_id: part.toolCallId,
					content,
				});
			}
		}
	}

	return result;
}

/**
 * Convert ModelMessage[] to Responses API input items.
 */
export function modelMessagesToResponsesInput(
	messages: ModelMessage[]
): unknown[] {
	const input: unknown[] = [];

	for (const message of messages) {
		if (message.role === 'user') {
			const content =
				typeof message.content === 'string'
					? message.content
					: extractTextContent(message.content);
			input.push({ role: 'user', content });
			continue;
		}

		if (message.role === 'assistant') {
			if (typeof message.content === 'string') {
				if (message.content.trim()) {
					input.push({
						type: 'message',
						role: 'assistant',
						status: 'completed',
						content: [{ type: 'output_text', text: message.content }],
					});
				}
				continue;
			}
			if (!Array.isArray(message.content)) {
				continue;
			}

			const textParts: string[] = [];
			for (const part of message.content) {
				if (part.type === 'text' && part.text.trim()) {
					textParts.push(part.text);
				} else if (part.type === 'tool-call') {
					input.push({
						type: 'function_call',
						call_id: part.toolCallId,
						name: part.toolName,
						arguments:
							typeof part.input === 'string'
								? part.input
								: JSON.stringify(part.input ?? {}),
						status: 'completed',
					});
				}
			}
			if (textParts.length > 0) {
				input.push({
					type: 'message',
					role: 'assistant',
					status: 'completed',
					content: [{ type: 'output_text', text: textParts.join('') }],
				});
			}
			continue;
		}

		if (message.role === 'tool' && Array.isArray(message.content)) {
			for (const part of message.content) {
				if (part.type !== 'tool-result') {
					continue;
				}
				const output = part.output;
				let content = '';
				if (typeof output === 'string') {
					content = output;
				} else if (output && typeof output === 'object') {
					const rec = output as Record<string, unknown>;
					if (typeof rec.value === 'string') {
						content = rec.value;
					} else {
						try {
							content = JSON.stringify(output);
						} catch {
							content = String(output);
						}
					}
				}
				input.push({
					type: 'function_call_output',
					call_id: part.toolCallId,
					output: content,
				});
			}
		}
	}

	return input;
}

export async function buildAgentResponsesTools(): Promise<unknown[]> {
	const tools: unknown[] = [];
	for (const [name, agentTool] of Object.entries(agentTools)) {
		const schema = await Promise.resolve(
			asSchema<unknown>(agentTool.inputSchema).jsonSchema
		);
		const parameters = JSON.parse(JSON.stringify(schema)) as Record<
			string,
			unknown
		>;
		delete parameters.$schema;
		tools.push({
			type: 'function',
			name,
			description: agentTool.description ?? '',
			parameters,
		});
	}
	return tools;
}

export function hasCompactionItem(items: unknown[]): boolean {
	return items.some(
		(item) =>
			!!item &&
			typeof item === 'object' &&
			(item as Record<string, unknown>).type === 'compaction'
	);
}

export interface MaybeCompactResult {
	input: unknown[];
	didCompact: boolean;
	estimatedTokens: number;
	threshold: number;
}

/**
 * If the window is at/over the compact threshold, call standalone compact
 * and return the compact output as the next canonical input base.
 * Compact output is returned as-is (not pruned).
 * Pass force: true to compact regardless of threshold (e.g. /compact).
 */
export async function maybeCompactInput(options: {
	input: unknown[];
	model: string;
	instructions?: string;
	threshold?: number;
	force?: boolean;
}): Promise<MaybeCompactResult> {
	const threshold =
		options.threshold !== undefined
			? options.threshold
			: getCompactTokenThreshold();
	const estimatedTokens = estimateTokenCount(options.input);
	const force = options.force === true;

	if (!force && (threshold <= 0 || estimatedTokens < threshold)) {
		return {
			input: options.input,
			didCompact: false,
			estimatedTokens,
			threshold,
		};
	}

	if (options.input.length === 0) {
		return {
			input: options.input,
			didCompact: false,
			estimatedTokens,
			threshold,
		};
	}

	log('[Flixa] compact threshold reached', {
		estimatedTokens,
		threshold,
		force,
	});

	const { compactResponse } = await import('../api/flixaClient');
	const compacted = await compactResponse({
		model: options.model,
		input: options.input,
		instructions: options.instructions ?? AGENT_SYSTEM_PROMPT,
	});

	return {
		input: compacted.output,
		didCompact: true,
		estimatedTokens,
		threshold,
	};
}

/**
 * Build Responses input from optional compacted base + model messages after compact.
 * When compactedBase is set, only messagesAfterCompact are converted and appended.
 */
export function buildResponsesInputWindow(options: {
	compactedBase?: unknown[] | null;
	messages: ModelMessage[];
	messagesAfterCompact?: ModelMessage[];
}): unknown[] {
	if (options.compactedBase && options.compactedBase.length > 0) {
		const after = options.messagesAfterCompact ?? options.messages;
		return [...options.compactedBase, ...modelMessagesToResponsesInput(after)];
	}
	return modelMessagesToResponsesInput(options.messages);
}
