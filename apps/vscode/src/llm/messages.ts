import type { ModelMessage } from 'ai';
import { mapLegacyToolArguments, mapLegacyToolName } from '@deniai/flixa-core';
import type { ChatCompletionToolCall, ChatContext } from '../types';
import { log } from '../logger';
import { formatSessionResults } from '../utils/format';
import { formatAutoContext } from '../autoContext';

function buildReferencedFilesText(
  mentionedFiles?: Array<{ reference: string; filePath: string; content: string }>,
): string {
  if (!mentionedFiles || mentionedFiles.length === 0) {
    return '';
  }

  return mentionedFiles
    .map(
      (file) =>
        `Referenced file (${file.reference}): ${file.filePath}\n\`\`\`\n${file.content}\n\`\`\``,
    )
    .join('\n\n');
}

function buildUserContextText(message: {
  activeSelection?: string;
  activeFilePath?: string;
  mentionedFiles?: Array<{ reference: string; filePath: string; content: string }>;
}): string {
  let content = '';

  if (message.activeSelection) {
    if (message.activeFilePath) {
      content += `Selected code from ${message.activeFilePath}:\n\`\`\`\n${message.activeSelection}\n\`\`\`\n\n`;
    } else {
      content += `Selected code:\n\`\`\`\n${message.activeSelection}\n\`\`\`\n\n`;
    }
  }

  const referencedFilesText = buildReferencedFilesText(message.mentionedFiles);
  if (referencedFilesText) {
    content += `${referencedFilesText}\n\n`;
  }

  return content;
}

/** Saved chats can hold tool calls with the pre-unification names; replay them as the new tools. */
function replayToolCall(toolCall: ChatCompletionToolCall): { name: string; input: unknown } {
  const mapped = mapLegacyToolArguments(toolCall.function.name, toolCall.function.arguments);
  try {
    return { name: mapped.name, input: JSON.parse(mapped.argumentsText) };
  } catch {
    return { name: mapped.name, input: {} };
  }
}

export function buildChatMessages(
  context: ChatContext,
): Array<{ role: 'user' | 'assistant'; content: string }> {
  const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [];

  let isFirstUserMessage = true;
  for (const msg of context.sessionMessages) {
    if (msg.role === 'user') {
      if (isFirstUserMessage) {
        isFirstUserMessage = false;
        let content = `User message: ${msg.content}\n\n`;

        const autoContextText = formatAutoContext(context.autoContext);
        if (autoContextText) {
          content += `${autoContextText}\n\n`;
        }

        if (context.activeFilePath) {
          content += `Active file: ${context.activeFilePath}\nLanguage: ${context.languageId}\n\n`;
        }
        content += buildUserContextText({
          activeSelection: msg.activeSelection ?? context.activeSelection,
          activeFilePath: msg.activeFilePath ?? context.activeFilePath,
          mentionedFiles: msg.mentionedFiles ?? context.mentionedFiles,
        });
        if (context.activeFileText) {
          content += `Full file content:\n\`\`\`\n${context.activeFileText}\n\`\`\`\n\n`;
        }
        if (context.diagnostics.length > 0) {
          content += `Current diagnostics/problems:\n${context.diagnostics.join('\n')}\n\n`;
        }
        if (context.gitDiff) {
          content += `Current git diff:\n\`\`\`\n${context.gitDiff}\n\`\`\`\n\n`;
        }
        messages.push({ role: 'user', content });
      } else {
        messages.push({
          role: 'user',
          content: `${msg.content}\n\n${buildUserContextText(msg)}`.trim(),
        });
      }
    } else if (msg.role === 'assistant') {
      messages.push({ role: 'assistant', content: msg.content });
    } else if (msg.role === 'result' && msg.results) {
      const resultsText = formatSessionResults(msg.results);
      messages.push({ role: 'user', content: resultsText });
    }
  }

  return messages;
}

export function buildAgentMessages(context: ChatContext): ModelMessage[] {
  const messages: ModelMessage[] = [];

  let isFirstUserMessage = true;
  for (const msg of context.sessionMessages) {
    if (msg.role === 'user') {
      if (isFirstUserMessage) {
        isFirstUserMessage = false;
        let content = `User request: ${msg.content}\n\n`;

        const autoContextText = formatAutoContext(context.autoContext);
        if (autoContextText) {
          content += `${autoContextText}\n\n`;
        }

        if (context.activeFilePath) {
          content += `Active file: ${context.activeFilePath}\nLanguage: ${context.languageId}\n\n`;
        }
        content += buildUserContextText({
          activeSelection: msg.activeSelection ?? context.activeSelection,
          activeFilePath: msg.activeFilePath ?? context.activeFilePath,
          mentionedFiles: msg.mentionedFiles ?? context.mentionedFiles,
        });
        if (context.activeFileText) {
          content += `Full file content:\n\`\`\`\n${context.activeFileText}\n\`\`\`\n\n`;
        }
        messages.push({ role: 'user', content });
      } else {
        messages.push({
          role: 'user',
          content: `${msg.content}\n\n${buildUserContextText(msg)}`.trim(),
        });
      }
    } else if (msg.role === 'assistant') {
      if (msg.content.startsWith('[Agent - Step')) {
        continue;
      }
      if (msg.tool_calls && msg.tool_calls.length > 0) {
        messages.push({
          role: 'assistant',
          content: [
            ...(msg.content.trim() ? [{ type: 'text' as const, text: msg.content }] : []),
            ...msg.tool_calls.map((toolCall) => {
              const replayed = replayToolCall(toolCall);
              return {
                type: 'tool-call' as const,
                toolCallId: toolCall.id,
                toolName: replayed.name,
                input: replayed.input,
              };
            }),
          ],
        });
      } else {
        messages.push({ role: 'assistant', content: msg.content });
      }
    } else if (msg.role === 'tool' && msg.toolResults) {
      messages.push({
        role: 'tool',
        content: msg.toolResults.map((toolResult) => ({
          type: 'tool-result' as const,
          toolCallId: toolResult.tool_call_id,
          toolName: mapLegacyToolName(toolResult.toolName),
          output: {
            type: 'text' as const,
            value: toolResult.content,
          },
        })),
      });
    } else if (msg.role === 'result' && msg.results) {
      const resultsText = formatSessionResults(msg.results);
      log('[Flixa] agent result message to AI:', resultsText);
      messages.push({ role: 'user', content: resultsText });
    }
  }

  return messages;
}
