import type { LLMResponse } from '../types';

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

export function stripCodeBlocks(text: string): string {
  let result = text.trim();
  if (result.startsWith('```')) {
    result = result.replace(/^```[\w]*\n?/, '').replace(/\n?```$/, '');
  }
  return result;
}
