import { generateObject, generateText } from 'ai';
import { z } from 'zod';
import { agentTools } from '../agent/tools';
import { log } from '../logger';
import type {
	AgentResponse,
	ChatContext,
	ImplementRequest,
	LLMResponse,
} from '../types';
import { buildAgentMessages, buildChatMessages } from './messages';
import { convertToolCallsToActions, parseLLMResponse, stripCodeBlocks } from './parser';
import { getAnthropicProvider, getModel, getReasoningEffort } from './provider';
import {
	AGENT_SYSTEM_PROMPT,
	buildImplementPrompt,
	CHAT_SYSTEM_PROMPT,
	IMPLEMENT_SYSTEM_PROMPT,
	SUGGESTION_SYSTEM_PROMPT,
} from './prompts';

export { getAnthropicProvider } from './provider';
export { parseLLMResponse, parseAgentResponse } from './parser';

export async function generateSessionTitle(userMessage: string): Promise<string> {
	const anthropic = getAnthropicProvider();
	const model = getModel();

	try {
		const { text } = await generateText({
			model: anthropic(model),
			system: 'Generate a very short title (2-5 words, max 30 chars) for a chat conversation based on the user\'s first message. Return ONLY the title, nothing else. No quotes, no punctuation at the end.',
			prompt: userMessage,
			providerOptions: {
				openai: {
					reasoningEffort: getReasoningEffort(),
				},
			},
		});
		const title = text.trim().slice(0, 30);
		return title || 'New Chat';
	} catch {
		return 'New Chat';
	}
}

export async function callLLMForImplement(
	request: ImplementRequest
): Promise<LLMResponse> {
	const anthropic = getAnthropicProvider();
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
		const { text } = await generateText({
			model: anthropic(model),
			system: IMPLEMENT_SYSTEM_PROMPT,
			prompt: userPrompt,
			providerOptions: {
				openai: {
					reasoningEffort: getReasoningEffort(),
				},
			},
		});

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
		const message = error instanceof Error ? error.message : String(error);
		return {
			type: 'message',
			message: `Error calling API: ${message}`,
		};
	}
}

export async function callLLMForChat(
	context: ChatContext,
	onTextUpdate?: (text: string) => void,
	abortSignal?: AbortSignal
): Promise<LLMResponse> {
	const anthropic = getAnthropicProvider();
	const model = getModel();

	const messages = buildChatMessages(context);

	try {
		const { text } = await generateText({
			model: anthropic(model),
			system: CHAT_SYSTEM_PROMPT,
			messages,
			abortSignal,
			providerOptions: {
				openai: {
					reasoningEffort: getReasoningEffort(),
				},
			},
		});
		console.log('[Flixa] chat response text:', text);
		console.log('[Flixa] chat response text length:', text.length);

		if (onTextUpdate) {
			onTextUpdate(text);
		}

		return parseLLMResponse(text);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			type: 'message',
			message: `Error calling API: ${message}`,
			diff: '',
		};
	}
}

/**
 * Call LLM for agent mode.
 *
 * All tool calls from the LLM are processed and executed sequentially
 * by the executor.
 */
export async function callLLMForAgent(
	context: ChatContext,
	onTextUpdate?: (text: string) => void,
	abortSignal?: AbortSignal
): Promise<AgentResponse | LLMResponse> {
	const anthropic = getAnthropicProvider();
	const model = getModel();

	const messages = buildAgentMessages(context);

	try {
		const result = await generateText({
			model: anthropic(model),
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
			const actions = convertToolCallsToActions(toolCalls);

			return {
				type: 'agent',
				message: result.text || 'Executing actions...',
				actions,
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
		const message = error instanceof Error ? error.message : String(error);
		return {
			type: 'message',
			message: `[API Error] ${message}`,
			diff: '',
		};
	}
}

export async function callLLMForSuggestion(
	inputText: string,
	activeFilePath: string,
	activeSelection: string,
	abortSignal?: AbortSignal
): Promise<string> {
	const anthropic = getAnthropicProvider();
	const model = getModel();

	const contextParts: string[] = [];
	if (activeFilePath) {
		contextParts.push(`Active file: ${activeFilePath}`);
	}
	if (activeSelection) {
		contextParts.push(`Selected code:\n${activeSelection.slice(0, 200)}`);
	}
	const context = contextParts.length > 0 ? `\n\nContext:\n${contextParts.join('\n')}` : '';

	try {
		const { text } = await generateText({
			model: anthropic(model),
			system: SUGGESTION_SYSTEM_PROMPT,
			prompt: `Complete this message: "${inputText}"${context}`,
			maxTokens: 40,
			abortSignal,
			providerOptions: {
				openai: {
					reasoningEffort: 'low',
				},
			},
		});
		return text.trim();
	} catch {
		return '';
	}
}
