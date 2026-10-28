import { describe, it, expect } from 'vitest';
import {
	parseLLMResponse,
	parseAgentResponse,
	convertToolCallsToActions,
	stripCodeBlocks,
} from './parser';

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

describe('parseAgentResponse', () => {
	it('should parse valid agent response with shell action', () => {
		const raw = JSON.stringify({
			type: 'agent',
			message: 'Running command',
			actions: [{ type: 'shell', command: 'npm test' }],
		});
		const result = parseAgentResponse(raw);

		expect(result.type).toBe('agent');
		if (result.type === 'agent') {
			expect(result.message).toBe('Running command');
			expect(result.actions).toHaveLength(1);
			expect(result.actions[0]).toEqual({ type: 'shell', command: 'npm test' });
		}
	});

	it('should parse valid agent response with writeFile action', () => {
		const raw = JSON.stringify({
			type: 'agent',
			message: 'Writing file',
			actions: [
				{ type: 'writeFile', filePath: 'test.ts', content: 'export const x = 1;' },
			],
		});
		const result = parseAgentResponse(raw);

		expect(result.type).toBe('agent');
		if (result.type === 'agent') {
			expect(result.actions[0]).toEqual({
				type: 'writeFile',
				filePath: 'test.ts',
				content: 'export const x = 1;',
			});
		}
	});

	it('should parse valid agent response with editFile action', () => {
		const raw = JSON.stringify({
			type: 'agent',
			message: 'Editing file',
			actions: [
				{
					type: 'editFile',
					filePath: 'test.ts',
					search: 'const x = 1',
					replace: 'const x = 2',
				},
			],
		});
		const result = parseAgentResponse(raw);

		expect(result.type).toBe('agent');
		if (result.type === 'agent') {
			expect(result.actions[0]).toEqual({
				type: 'editFile',
				filePath: 'test.ts',
				search: 'const x = 1',
				replace: 'const x = 2',
			});
		}
	});

	it('should parse valid agent response with deleteFile action', () => {
		const raw = JSON.stringify({
			type: 'agent',
			message: 'Deleting file',
			actions: [{ type: 'deleteFile', filePath: 'test.ts' }],
		});
		const result = parseAgentResponse(raw);

		expect(result.type).toBe('agent');
		if (result.type === 'agent') {
			expect(result.actions[0]).toEqual({
				type: 'deleteFile',
				filePath: 'test.ts',
			});
		}
	});

	it('should parse valid agent response with diff action', () => {
		const raw = JSON.stringify({
			type: 'agent',
			message: 'Showing diff',
			actions: [
				{ type: 'diff', filePath: 'test.ts', diff: '--- a/test.ts\n+++ b/test.ts' },
			],
		});
		const result = parseAgentResponse(raw);

		expect(result.type).toBe('agent');
		if (result.type === 'agent') {
			expect(result.actions[0]).toEqual({
				type: 'diff',
				filePath: 'test.ts',
				diff: '--- a/test.ts\n+++ b/test.ts',
			});
		}
	});

	it('should parse valid agent response with vscodeCommand action', () => {
		const raw = JSON.stringify({
			type: 'agent',
			message: 'Running VSCode command',
			actions: [
				{
					type: 'vscodeCommand',
					command: 'workbench.action.files.save',
					args: ['arg1'],
				},
			],
		});
		const result = parseAgentResponse(raw);

		expect(result.type).toBe('agent');
		if (result.type === 'agent') {
			expect(result.actions[0]).toEqual({
				type: 'vscodeCommand',
				command: 'workbench.action.files.save',
				args: ['arg1'],
			});
		}
	});

	it('should skip invalid actions', () => {
		const raw = JSON.stringify({
			type: 'agent',
			message: 'Mixed actions',
			actions: [
				{ type: 'shell', command: 'npm test' },
				{ type: 'invalid' },
				{ type: 'writeFile' }, // missing fields
				null,
				'not an object',
			],
		});
		const result = parseAgentResponse(raw);

		expect(result.type).toBe('agent');
		if (result.type === 'agent') {
			expect(result.actions).toHaveLength(1);
			expect(result.actions[0]).toEqual({ type: 'shell', command: 'npm test' });
		}
	});

	it('should return error for agent response with missing message', () => {
		const raw = JSON.stringify({
			type: 'agent',
			actions: [{ type: 'shell', command: 'npm test' }],
		});
		const result = parseAgentResponse(raw);

		expect(result.type).toBe('message');
		if (result.type === 'message') {
			expect(result.message).toBe('Invalid agent response: missing message');
		}
	});

	it('should return error for agent response with non-array actions', () => {
		const raw = JSON.stringify({
			type: 'agent',
			message: 'Test',
			actions: 'not an array',
		});
		const result = parseAgentResponse(raw);

		expect(result.type).toBe('message');
		if (result.type === 'message') {
			expect(result.message).toBe('Invalid agent response: actions must be an array');
		}
	});

	it('should fallback to LLM response parsing', () => {
		const raw = JSON.stringify({
			type: 'message',
			message: 'Regular message',
		});
		const result = parseAgentResponse(raw);

		expect(result.type).toBe('message');
		if (result.type === 'message') {
			expect(result.message).toBe('Regular message');
		}
	});

	it('should strip code blocks before parsing', () => {
		const raw = '```json\n{"type": "agent", "message": "Test", "actions": []}\n```';
		const result = parseAgentResponse(raw);

		expect(result.type).toBe('agent');
	});

	it('should return raw text when parsing fails', () => {
		const raw = 'Plain text response';
		const result = parseAgentResponse(raw);

		expect(result.type).toBe('message');
		if (result.type === 'message') {
			expect(result.message).toBe('Plain text response');
		}
	});
});

describe('convertToolCallsToActions', () => {
	it('should convert shell tool call', () => {
		const toolCalls = [{ toolName: 'shell', input: { command: 'npm test' } }];
		const actions = convertToolCallsToActions(toolCalls);

		expect(actions).toHaveLength(1);
		expect(actions[0]).toEqual({ type: 'shell', command: 'npm test' });
	});

	it('should convert writeFile tool call', () => {
		const toolCalls = [
			{
				toolName: 'writeFile',
				input: { filePath: 'test.ts', content: 'export const x = 1;' },
			},
		];
		const actions = convertToolCallsToActions(toolCalls);

		expect(actions).toHaveLength(1);
		expect(actions[0]).toEqual({
			type: 'writeFile',
			filePath: 'test.ts',
			content: 'export const x = 1;',
		});
	});

	it('should convert editFile tool call', () => {
		const toolCalls = [
			{
				toolName: 'editFile',
				input: { filePath: 'test.ts', search: 'old', replace: 'new' },
			},
		];
		const actions = convertToolCallsToActions(toolCalls);

		expect(actions).toHaveLength(1);
		expect(actions[0]).toEqual({
			type: 'editFile',
			filePath: 'test.ts',
			search: 'old',
			replace: 'new',
		});
	});

	it('should convert deleteFile tool call', () => {
		const toolCalls = [
			{ toolName: 'deleteFile', input: { filePath: 'test.ts' } },
		];
		const actions = convertToolCallsToActions(toolCalls);

		expect(actions).toHaveLength(1);
		expect(actions[0]).toEqual({ type: 'deleteFile', filePath: 'test.ts' });
	});

	it('should convert diff tool call', () => {
		const toolCalls = [
			{
				toolName: 'diff',
				input: { filePath: 'test.ts', diff: '--- a/test.ts\n+++ b/test.ts' },
			},
		];
		const actions = convertToolCallsToActions(toolCalls);

		expect(actions).toHaveLength(1);
		expect(actions[0]).toEqual({
			type: 'diff',
			filePath: 'test.ts',
			diff: '--- a/test.ts\n+++ b/test.ts',
		});
	});

	it('should convert vscodeCommand tool call', () => {
		const toolCalls = [
			{
				toolName: 'vscodeCommand',
				input: { command: 'workbench.action.files.save', args: ['arg1'] },
			},
		];
		const actions = convertToolCallsToActions(toolCalls);

		expect(actions).toHaveLength(1);
		expect(actions[0]).toEqual({
			type: 'vscodeCommand',
			command: 'workbench.action.files.save',
			args: ['arg1'],
		});
	});

	it('should skip finishTask tool call', () => {
		const toolCalls = [
			{ toolName: 'finishTask', input: { summary: 'Done' } },
		];
		const actions = convertToolCallsToActions(toolCalls);

		expect(actions).toHaveLength(0);
	});

	it('should handle multiple tool calls', () => {
		const toolCalls = [
			{ toolName: 'shell', input: { command: 'npm test' } },
			{ toolName: 'writeFile', input: { filePath: 'test.ts', content: 'x' } },
		];
		const actions = convertToolCallsToActions(toolCalls);

		expect(actions).toHaveLength(2);
	});

	it('should skip tool calls with invalid input', () => {
		const toolCalls = [
			{ toolName: 'shell', input: { command: 123 } }, // command should be string
			{ toolName: 'writeFile', input: { filePath: 'test.ts' } }, // missing content
		];
		const actions = convertToolCallsToActions(toolCalls);

		expect(actions).toHaveLength(0);
	});

	it('should handle empty tool calls array', () => {
		const actions = convertToolCallsToActions([]);
		expect(actions).toHaveLength(0);
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
