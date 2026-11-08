import { describe, it, expect } from 'vitest';
import { parseLLMResponse, stripCodeBlocks } from './parser';

describe('parseLLMResponse', () => {
  it('should parse valid message response', () => {
    const raw = JSON.stringify({ type: 'message', message: 'Hello world' });
    const result = parseLLMResponse(raw);

    expect(result.type).toBe('message');
    expect(result.message).toBe('Hello world');
    expect(result.diff).toBe('');
  });

  it('should parse valid diff response', () => {
    const raw = JSON.stringify({
      type: 'diff',
      message: 'Here is a diff',
      diff: '--- a/file.ts\n+++ b/file.ts',
    });
    const result = parseLLMResponse(raw);

    expect(result.type).toBe('diff');
    expect(result.message).toBe('Here is a diff');
    expect(result.diff).toBe('--- a/file.ts\n+++ b/file.ts');
  });

  it('should strip ```json code blocks', () => {
    const raw = '```json\n{"type": "message", "message": "Test"}\n```';
    const result = parseLLMResponse(raw);

    expect(result.type).toBe('message');
    expect(result.message).toBe('Test');
  });

  it('should strip ``` code blocks', () => {
    const raw = '```\n{"type": "message", "message": "Test"}\n```';
    const result = parseLLMResponse(raw);

    expect(result.type).toBe('message');
    expect(result.message).toBe('Test');
  });

  it('should return raw text as message when invalid JSON', () => {
    const raw = 'This is just plain text';
    const result = parseLLMResponse(raw);

    expect(result.type).toBe('message');
    expect(result.message).toBe('This is just plain text');
    expect(result.diff).toBe('');
  });

  it('should return raw text when JSON does not match expected structure', () => {
    const raw = JSON.stringify({ foo: 'bar' });
    const result = parseLLMResponse(raw);

    expect(result.type).toBe('message');
    expect(result.message).toBe(raw);
  });

  it('should handle empty diff field', () => {
    const raw = JSON.stringify({ type: 'message', message: 'Test' });
    const result = parseLLMResponse(raw);

    expect(result.diff).toBe('');
  });
});

describe('stripCodeBlocks', () => {
  it('should strip ```json code blocks', () => {
    const text = '```json\n{"key": "value"}\n```';
    expect(stripCodeBlocks(text)).toBe('{"key": "value"}');
  });

  it('should strip ``` code blocks', () => {
    const text = '```\nsome content\n```';
    expect(stripCodeBlocks(text)).toBe('some content');
  });

  it('should strip ```typescript code blocks', () => {
    const text = '```typescript\nconst x = 1;\n```';
    expect(stripCodeBlocks(text)).toBe('const x = 1;');
  });

  it('should return text unchanged if no code blocks', () => {
    const text = 'plain text';
    expect(stripCodeBlocks(text)).toBe('plain text');
  });

  it('should trim whitespace', () => {
    const text = '  \n  {"key": "value"}  \n  ';
    expect(stripCodeBlocks(text)).toBe('{"key": "value"}');
  });

  it('should handle text starting with ``` but not ending with it', () => {
    const text = '```json\n{"key": "value"}';
    expect(stripCodeBlocks(text)).toBe('{"key": "value"}');
  });
});
