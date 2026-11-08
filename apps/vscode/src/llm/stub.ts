import { findFlixaErrorCode, findUsageLimitExceeded } from '@deniai/flixa-api-client';
import { generateText } from 'ai';
import { createResponse } from '../api/flixaClient';
import { getClientSignalUserMessage, logMissingClientSignal } from '../api/flixaClientHeaders';
import type { ChatContext, ImplementRequest, LLMResponse } from '../types';
import type { QuotaExceededErrorMeta } from '../usage/types';
import { modelMessagesToResponsesInput } from './compact';
import { buildChatMessages } from './messages';
import { parseLLMResponse, stripCodeBlocks } from './parser';
import { getFlixaProvider, getModel, getReasoningEffort } from './provider';
import { buildImplementPrompt, CHAT_SYSTEM_PROMPT, IMPLEMENT_SYSTEM_PROMPT } from './prompts';

export { getFlixaProvider } from './provider';
export { parseLLMResponse } from './parser';

export function resolveLlmApiError(
  error: unknown,
  requestPath: string,
  fallbackPrefix: string,
): { message: string; quotaExceeded?: QuotaExceededErrorMeta } {
  const quotaExceeded = findUsageLimitExceeded(error) ?? undefined;
  if (quotaExceeded) {
    return { message: quotaExceeded.message, quotaExceeded };
  }

  const code = findFlixaErrorCode(error);
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

export async function generateSessionTitle(userMessage: string): Promise<string> {
  const flixa = getFlixaProvider();
  const model = getModel();

  try {
    const reasoningEffort = getReasoningEffort();
    const text =
      reasoningEffort === 'max'
        ? await callTextViaResponses({
            model,
            input: [{ role: 'user', content: userMessage }],
            instructions:
              "Generate a very short title (2-5 words, max 30 chars) for a chat conversation based on the user's first message. Return ONLY the title, nothing else. No quotes, no punctuation at the end.",
          })
        : (
            await generateText({
              model: flixa(model),
              system:
                "Generate a very short title (2-5 words, max 30 chars) for a chat conversation based on the user's first message. Return ONLY the title, nothing else. No quotes, no punctuation at the end.",
              prompt: userMessage,
              providerOptions: {
                openai: {
                  reasoningEffort,
                },
              },
            })
          ).text;
    const title = text.trim().slice(0, 30);
    return title || 'New Chat';
  } catch {
    return 'New Chat';
  }
}

export async function callLLMForImplement(request: ImplementRequest): Promise<LLMResponse> {
  const flixa = getFlixaProvider();
  const model = getModel();

  const hasSelection = request.scopeText && request.scopeText !== request.fullFileText;

  const userPrompt = buildImplementPrompt(
    request.filePath,
    request.languageId,
    request.commentPayload,
    request.fullFileText,
    request.scopeRange,
    request.scopeText,
  );

  try {
    const reasoningEffort = getReasoningEffort();
    const text =
      reasoningEffort === 'max'
        ? await callTextViaResponses({
            model,
            input: [{ role: 'user', content: userPrompt }],
            instructions: IMPLEMENT_SYSTEM_PROMPT,
          })
        : (
            await generateText({
              model: flixa(model),
              system: IMPLEMENT_SYSTEM_PROMPT,
              prompt: userPrompt,
              providerOptions: {
                openai: {
                  reasoningEffort,
                },
              },
            })
          ).text;

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
    const resolved = resolveLlmApiError(error, '/v1/agent/chat/completions', 'Error calling API: ');
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
  abortSignal?: AbortSignal,
): Promise<LLMResponse> {
  const flixa = getFlixaProvider();
  const model = getModel();

  const messages = buildChatMessages(context);

  try {
    const reasoningEffort = getReasoningEffort();
    const text =
      reasoningEffort === 'max'
        ? await callTextViaResponses({
            model,
            input: modelMessagesToResponsesInput(messages),
            instructions: CHAT_SYSTEM_PROMPT,
            abortSignal,
          })
        : (
            await generateText({
              model: flixa(model),
              system: CHAT_SYSTEM_PROMPT,
              messages,
              abortSignal,
              providerOptions: {
                openai: {
                  reasoningEffort,
                },
              },
            })
          ).text;
    console.log('[Flixa] chat response text:', text);
    console.log('[Flixa] chat response text length:', text.length);

    if (onTextUpdate) {
      onTextUpdate(text);
    }

    return parseLLMResponse(text);
  } catch (error) {
    const resolved = resolveLlmApiError(error, '/v1/agent/chat/completions', 'Error calling API: ');
    return {
      type: 'message',
      message: resolved.message,
      diff: '',
      quotaExceeded: resolved.quotaExceeded,
    };
  }
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
    if ((rec.type === 'output_text' || rec.type === 'text') && typeof rec.text === 'string') {
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
