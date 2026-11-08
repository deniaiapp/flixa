import type { ModelMessage } from 'ai';
import {
  compactConversation,
  createResponsesSummarizer,
  migrateLegacyResponseItems,
  type ResponsesClientConfig,
} from '@deniai/flixa-core';
import { log } from '../logger';

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
    const serialized = typeof value === 'string' ? value : JSON.stringify(value ?? '');
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
  messages: ModelMessage[],
): Array<Record<string, unknown>> {
  const result: Array<Record<string, unknown>> = [];

  for (const message of messages) {
    if (message.role === 'user') {
      const content =
        typeof message.content === 'string' ? message.content : extractTextContent(message.content);
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
                typeof part.input === 'string' ? part.input : JSON.stringify(part.input ?? {}),
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
export function modelMessagesToResponsesInput(messages: ModelMessage[]): unknown[] {
  const input: unknown[] = [];

  for (const message of messages) {
    if (message.role === 'user') {
      const content =
        typeof message.content === 'string' ? message.content : extractTextContent(message.content);
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
              typeof part.input === 'string' ? part.input : JSON.stringify(part.input ?? {}),
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

export function hasCompactionItem(items: unknown[]): boolean {
  return items.some(
    (item) =>
      !!item && typeof item === 'object' && (item as Record<string, unknown>).type === 'compaction',
  );
}

/**
 * Compact the window locally: the model summarizes it (no server compact call, so it works
 * for every model). Used by /compact; the agent loop compacts on its own at the threshold.
 */
export async function compactInputWindow(options: {
  input: unknown[];
  model: string;
  client: ResponsesClientConfig;
  signal?: AbortSignal;
}): Promise<{ input: unknown[]; tokensBefore: number; tokensAfter: number }> {
  log('[Flixa] compacting context locally', { items: options.input.length });
  const result = await compactConversation({
    items: options.input,
    generate: createResponsesSummarizer({
      client: options.client,
      model: options.model,
      signal: options.signal,
    }),
  });
  return {
    input: result.items,
    tokensBefore: result.tokensBefore,
    tokensAfter: result.tokensAfter,
  };
}

export function buildResponsesInputWindow(options: {
  compactedBase?: unknown[] | null;
  messages: ModelMessage[];
  messagesAfterCompact?: ModelMessage[];
}): unknown[] {
  if (options.compactedBase && options.compactedBase.length > 0) {
    const after = options.messagesAfterCompact ?? options.messages;
    return [
      ...migrateLegacyResponseItems(options.compactedBase),
      ...modelMessagesToResponsesInput(after),
    ];
  }
  return modelMessagesToResponsesInput(options.messages);
}
