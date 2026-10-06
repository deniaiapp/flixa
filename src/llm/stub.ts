import { generateText, type ModelMessage } from 'ai';
import { agentTools } from '../agent/tools';
import { createResponse } from '../api/flixaClient';
import {
	extractApiErrorCode,
	getClientSignalUserMessage,
	logMissingClientSignal,
} from '../api/flixaClientHeaders';
import { log } from '../logger';
import type {
	AgentResponse,
	ChatCompletionToolCall,
	ChatContext,
	ImplementRequest,
	LLMResponse,
} from '../types';
import type { QuotaExceededErrorMeta } from '../usage/types';
import {
	buildAgentResponsesTools,
	buildResponsesInputWindow,
	hasCompactionItem,
	maybeCompactInput,
	modelMessagesToResponsesInput,
} from './compact';
import { buildAgentMessages, buildChatMessages } from './messages';
import { convertToolCallsToActions, parseLLMResponse, stripCodeBlocks } from './parser';
import { getFlixaProvider, getModel, getReasoningEffort } from './provider';
import {
	AGENT_SYSTEM_PROMPT,
	buildImplementPrompt,
	CHAT_SYSTEM_PROMPT,
	IMPLEMENT_SYSTEM_PROMPT,
} from './prompts';

export { getFlixaProvider } from './provider';
export { parseLLMResponse, parseAgentResponse } from './parser';

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === 'object';
}

function normalizeQuotaExceededError(value: unknown): QuotaExceededErrorMeta | null {
	if (!isRecord(value)) {
		return null;
	}

	const error = isRecord(value.error) ? value.error : value;
	if (error.code !== 'USAGE_LIMIT_EXCEEDED') {
		return null;
	}

	return {
		message: typeof error.message === 'string' ? error.message : 'Usage limit exceeded.',
		type: typeof error.type === 'string' ? error.type : 'quota_exceeded',
		param: null,
		code: 'USAGE_LIMIT_EXCEEDED',
		category:
			error.category === 'basic' || error.category === 'premium'
				? error.category
				: undefined,
		tier:
			error.tier === 'free' ||
			error.tier === 'plus' ||
			error.tier === 'pro' ||
			error.tier === 'max'
				? error.tier
				: undefined,
		canVerifyForBoost:
			typeof error.canVerifyForBoost === 'boolean'
				? error.canVerifyForBoost
				: undefined,
		canUpgrade:
			typeof error.canUpgrade === 'boolean' ? error.canUpgrade : undefined,
		verifyUrl: typeof error.verifyUrl === 'string' ? error.verifyUrl : undefined,
		upgradeUrl:
			typeof error.upgradeUrl === 'string' ? error.upgradeUrl : undefined,
	};
}

function tryParseJsonObject(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

function extractQuotaExceededError(error: unknown): QuotaExceededErrorMeta | null {
	const direct = normalizeQuotaExceededError(error);
	if (direct) {
		return direct;
	}

	if (error instanceof Error) {
		const fromMessage = normalizeQuotaExceededError(tryParseJsonObject(error.message));
		if (fromMessage) {
			return fromMessage;
		}
	}

	if (!isRecord(error)) {
		return null;
	}

	const keys = [
		'data',
		'body',
		'responseBody',
		'response',
		'cause',
		'error',
		'value',
	];
	for (const key of keys) {
		const value = error[key];
		const nested =
			typeof value === 'string'
				? normalizeQuotaExceededError(tryParseJsonObject(value))
				: extractQuotaExceededError(value);
		if (nested) {
			return nested;
		}
	}

	return null;
}

function resolveLlmApiError(
	error: unknown,
	requestPath: string,
	fallbackPrefix: string
): { message: string; quotaExceeded?: QuotaExceededErrorMeta } {
	const quotaExceeded = extractQuotaExceededError(error) ?? undefined;
	if (quotaExceeded) {
		return { message: quotaExceeded.message, quotaExceeded };
	}

	const code = extractApiErrorCode(error);
	if (code === 'missing_client_signal') {
		logMissingClientSignal(requestPath);
	}

	const clientMessage = code ? getClientSignalUserMessage(code) : null;
	if (clientMessage) {
		return { message: clientMessage };
	}

	const message = error instanceof Error ? error.message : String(error);
	return { message: `${fallbackPrefix}${message}` };
}

function serializeToolArguments(input: unknown): string {
	try {
		return JSON.stringify(input ?? {});
	} catch {
		return '{}';
	}
}

function serializeToolCall(toolCall: {
	toolCallId: string;
	toolName: string;
	input: unknown;
}): ChatCompletionToolCall {
	return {
		id: toolCall.toolCallId,
		type: 'function',
		function: {
			name: toolCall.toolName,
			arguments: serializeToolArguments(toolCall.input),
		},
	};
}

function convertExecutableToolCalls(
	toolCalls: Array<{ toolCallId: string; toolName: string; input: unknown }>
): { actions: AgentResponse['actions']; toolCalls: ChatCompletionToolCall[] } {
	const actions: AgentResponse['actions'] = [];
	const chatToolCalls: ChatCompletionToolCall[] = [];

	for (const toolCall of toolCalls) {
		const convertedActions = convertToolCallsToActions([toolCall]);
		for (const action of convertedActions) {
			actions.push(action);
			chatToolCalls.push(serializeToolCall(toolCall));
		}
	}

	return { actions, toolCalls: chatToolCalls };
}

export async function generateSessionTitle(userMessage: string): Promise<string> {
	const flixa = getFlixaProvider();
	const model = getModel();

	try {
		const reasoningEffort = getReasoningEffort();
		const text = reasoningEffort === 'max'
			? await callTextViaResponses({
					model,
					input: [{ role: 'user', content: userMessage }],
					instructions: 'Generate a very short title (2-5 words, max 30 chars) for a chat conversation based on the user\'s first message. Return ONLY the title, nothing else. No quotes, no punctuation at the end.',
				})
			: (await generateText({
					model: flixa(model),
					system: 'Generate a very short title (2-5 words, max 30 chars) for a chat conversation based on the user\'s first message. Return ONLY the title, nothing else. No quotes, no punctuation at the end.',
					prompt: userMessage,
					providerOptions: {
						openai: {
							reasoningEffort,
						},
					},
				})).text;
		const title = text.trim().slice(0, 30);
		return title || 'New Chat';
	} catch {
		return 'New Chat';
	}
}

export async function callLLMForImplement(
	request: ImplementRequest
): Promise<LLMResponse> {
	const flixa = getFlixaProvider();
	const model = getModel();

	const hasSelection = request.scopeText && request.scopeText !== request.fullFileText;

	const userPrompt = buildImplementPrompt(
		request.filePath,
		request.languageId,
		request.commentPayload,
		request.fullFileText,
		request.scopeRange,
		request.scopeText
	);

	try {
		const reasoningEffort = getReasoningEffort();
		const text = reasoningEffort === 'max'
			? await callTextViaResponses({
					model,
					input: [{ role: 'user', content: userPrompt }],
					instructions: IMPLEMENT_SYSTEM_PROMPT,
				})
			: (await generateText({
					model: flixa(model),
					system: IMPLEMENT_SYSTEM_PROMPT,
					prompt: userPrompt,
					providerOptions: {
						openai: {
							reasoningEffort,
						},
					},
				})).text;

		const newContent = stripCodeBlocks(text);

		console.log('[Flixa] Generated new content length:', newContent.length);

		if (hasSelection) {
			const lines = request.fullFileText.split('\n');
			const beforeSelection = lines.slice(0, request.scopeRange.startLine).join('\n');
			const afterSelection = lines.slice(request.scopeRange.endLine + 1).join('\n');
			
			let mergedContent: string;
			if (beforeSelection && afterSelection) {
				mergedContent = beforeSelection + '\n' + newContent + '\n' + afterSelection;
			} else if (beforeSelection) {
				mergedContent = beforeSelection + '\n' + newContent;
			} else if (afterSelection) {
				mergedContent = newContent + '\n' + afterSelection;
			} else {
				mergedContent = newContent;
			}

			return {
				type: 'full',
				message: 'Implementation generated.',
				newContent: mergedContent,
			};
		}

		return {
			type: 'full',
			message: 'Implementation generated.',
			newContent,
		};
	} catch (error) {
		const resolved = resolveLlmApiError(
			error,
			'/v1/agent/chat/completions',
			'Error calling API: '
		);
		return {
			type: 'message',
			message: resolved.message,
			quotaExceeded: resolved.quotaExceeded,
		};
	}
}

export async function callLLMForChat(
	context: ChatContext,
	onTextUpdate?: (text: string) => void,
	abortSignal?: AbortSignal
): Promise<LLMResponse> {
	const flixa = getFlixaProvider();
	const model = getModel();

	const messages = buildChatMessages(context);

	try {
		const reasoningEffort = getReasoningEffort();
		const text = reasoningEffort === 'max'
			? await callTextViaResponses({
					model,
					input: modelMessagesToResponsesInput(messages),
					instructions: CHAT_SYSTEM_PROMPT,
					abortSignal,
				})
			: (await generateText({
					model: flixa(model),
					system: CHAT_SYSTEM_PROMPT,
					messages,
					abortSignal,
					providerOptions: {
						openai: {
							reasoningEffort,
						},
					},
				})).text;
		console.log('[Flixa] chat response text:', text);
		console.log('[Flixa] chat response text length:', text.length);

		if (onTextUpdate) {
			onTextUpdate(text);
		}

		return parseLLMResponse(text);
	} catch (error) {
		const resolved = resolveLlmApiError(
			error,
			'/v1/agent/chat/completions',
			'Error calling API: '
		);
		return {
			type: 'message',
			message: resolved.message,
			diff: '',
			quotaExceeded: resolved.quotaExceeded,
		};
	}
}

export interface AgentCallOptions {
	/** Compacted Responses window from a prior standalone compact call. */
	compactedInput?: unknown[] | null;
	/** sessionMessages length at last compact; messages after this are appended. */
	compactedSessionMessageCount?: number;
	/** Called when compact runs; client must store output as next input base. */
	onCompacted?: (input: unknown[], sessionMessageCount: number) => void;
}

function extractOutputText(content: unknown): string {
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
		if (
			(rec.type === 'output_text' || rec.type === 'text') &&
			typeof rec.text === 'string'
		) {
			parts.push(rec.text);
		}
	}
	return parts.join('');
}

function parseResponsesAgentOutput(output: unknown[]): {
	text: string;
	toolCalls: Array<{ toolCallId: string; toolName: string; input: unknown }>;
} {
	let text = '';
	const toolCalls: Array<{
		toolCallId: string;
		toolName: string;
		input: unknown;
	}> = [];

	for (const item of output) {
		if (!item || typeof item !== 'object') {
			continue;
		}
		const rec = item as Record<string, unknown>;
		if (
			(rec.type === 'message' || rec.role === 'assistant') &&
			(rec.role === 'assistant' || rec.type === 'message')
		) {
			const piece = extractOutputText(rec.content);
			if (piece) {
				text += (text ? '\n' : '') + piece;
			}
		}
		if (rec.type === 'function_call' && typeof rec.name === 'string') {
			const callId =
				typeof rec.call_id === 'string'
					? rec.call_id
					: typeof rec.id === 'string'
						? rec.id
						: `call_${toolCalls.length + 1}`;
			let input: unknown = {};
			if (typeof rec.arguments === 'string') {
				try {
					input = JSON.parse(rec.arguments);
				} catch {
					input = {};
				}
			} else if (rec.arguments && typeof rec.arguments === 'object') {
				input = rec.arguments;
			}
			toolCalls.push({
				toolCallId: callId,
				toolName: rec.name,
				input,
			});
		}
	}

	return { text, toolCalls };
}

async function callTextViaResponses(options: {
	model: string;
	input: unknown[];
	instructions: string;
	abortSignal?: AbortSignal;
}): Promise<string> {
	const reasoningEffort = getReasoningEffort();
	const result = await createResponse({
		model: options.model,
		input: options.input,
		instructions: options.instructions,
		reasoning: reasoningEffort
			? {
				effort: reasoningEffort,
				context: 'all_turns',
			}
			: undefined,
		abortSignal: options.abortSignal,
	});
	return parseResponsesAgentOutput(result.output).text;
}

function sliceSessionMessagesAfterCompact(
	context: ChatContext,
	compactedSessionMessageCount: number
): ChatContext {
	const start = Math.max(0, compactedSessionMessageCount);
	return {
		...context,
		sessionMessages: context.sessionMessages.slice(start),
	};
}

async function callAgentViaResponses(options: {
	input: unknown[];
	model: string;
	onTextUpdate?: (text: string) => void;
	abortSignal?: AbortSignal;
}): Promise<AgentResponse | LLMResponse> {
	const tools = await buildAgentResponsesTools();
	const reasoningEffort = getReasoningEffort();
	const result = await createResponse({
		model: options.model,
		input: options.input,
		instructions: AGENT_SYSTEM_PROMPT,
		tools,
		store: false,
		include: ['reasoning.encrypted_content'],
		reasoning: reasoningEffort
			? {
				effort: reasoningEffort,
				context: 'all_turns',
			}
			: undefined,
		abortSignal: options.abortSignal,
	});

	const { text, toolCalls } = parseResponsesAgentOutput(result.output);
	log('[Flixa] agent responses text:', text);
	log(
		'[Flixa] agent responses toolCalls:',
		JSON.stringify(toolCalls, null, 2)
	);

	if (options.onTextUpdate) {
		options.onTextUpdate(text || '');
	}

	if (toolCalls.length > 0) {
		const { actions, toolCalls: chatToolCalls } =
			convertExecutableToolCalls(toolCalls);
		return {
			type: 'agent',
			message: text || '',
			actions,
			toolCalls: chatToolCalls,
		};
	}

	if (text && text.trim()) {
		return {
			type: 'message',
			message: text,
			diff: '',
		};
	}

	return {
		type: 'message',
		message: 'Empty response',
		diff: '',
	};
}

/**
 * Call LLM for agent mode.
 *
 * All tool calls from the LLM are processed and executed sequentially
 * by the executor.
 *
 * When the estimated context size reaches flixa.compactTokenThreshold
 * (default 200k), calls POST /v1/agent/responses/compact and continues
 * with the compact output as the next input base.
 */
export async function callLLMForAgent(
	context: ChatContext,
	onTextUpdate?: (text: string) => void,
	abortSignal?: AbortSignal,
	agentOptions?: AgentCallOptions
): Promise<AgentResponse | LLMResponse> {
	const flixa = getFlixaProvider();
	const model = getModel();

	const compactedInput = agentOptions?.compactedInput ?? null;
	const compactedSessionMessageCount =
		agentOptions?.compactedSessionMessageCount ?? 0;

	const messages: ModelMessage[] = compactedInput
		? buildAgentMessages(
				sliceSessionMessagesAfterCompact(context, compactedSessionMessageCount)
			)
		: buildAgentMessages(context);

	let responsesInput = buildResponsesInputWindow({
		compactedBase: compactedInput,
		messages,
	});

	try {
		let didCompact = false;
		try {
			const compactResult = await maybeCompactInput({
				input: responsesInput,
				model,
				instructions: AGENT_SYSTEM_PROMPT,
			});

			if (compactResult.didCompact) {
				didCompact = true;
				responsesInput = compactResult.input;
				agentOptions?.onCompacted?.(
					compactResult.input,
					context.sessionMessages.length
				);
				log('[Flixa] using compacted input window', {
					items: responsesInput.length,
					estimatedTokens: compactResult.estimatedTokens,
					threshold: compactResult.threshold,
				});
			}
		} catch (compactError) {
			console.error('[Flixa] compact failed, continuing without compact', compactError);
		}

		const useResponsesPath =
			getReasoningEffort() === 'max' ||
			didCompact ||
			!!compactedInput ||
			hasCompactionItem(responsesInput);

		if (useResponsesPath) {
			return await callAgentViaResponses({
				input: responsesInput,
				model,
				onTextUpdate,
				abortSignal,
			});
		}

		const result = await generateText({
			model: flixa(model),
			system: AGENT_SYSTEM_PROMPT,
			messages,
			tools: agentTools,
			abortSignal,
			providerOptions: {
				openai: {
					reasoningEffort: getReasoningEffort(),
				},
			},
		});
		log('[Flixa] agent response text:', result.text);
		log(
			'[Flixa] agent response toolCalls:',
			JSON.stringify(result.toolCalls, null, 2)
		);
		log('[Flixa] agent response finishReason:', result.finishReason);

		if (onTextUpdate) {
			onTextUpdate(result.text || '');
		}

		const toolCalls = result.toolCalls;

		// Process all tool calls
		if (toolCalls && toolCalls.length > 0) {
			const { actions, toolCalls: chatToolCalls } =
				convertExecutableToolCalls(toolCalls);

			return {
				type: 'agent',
				message: result.text || '',
				actions,
				toolCalls: chatToolCalls,
			};
		}

		// No tool calls - this is the agent's final response
		if (result.text && result.text.trim()) {
			return {
				type: 'message',
				message: result.text,
				diff: '',
			};
		}

		// Empty response - return error
		return {
			type: 'message',
			message: 'Empty response',
			diff: '',
		};
	} catch (error) {
		console.error('[Flixa] callLLMForAgent error:', error);
		const resolved = resolveLlmApiError(
			error,
			'/v1/agent/responses',
			'[API Error] '
		);
		return {
			type: 'message',
			message: resolved.message,
			diff: '',
			quotaExceeded: resolved.quotaExceeded,
		};
	}
}
