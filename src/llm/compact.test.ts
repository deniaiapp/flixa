import { describe, expect, it } from 'bun:test';
import type { ModelMessage } from 'ai';
import {
	DEFAULT_COMPACT_TOKEN_THRESHOLD,
	estimateTokenCount,
	hasCompactionItem,
	modelMessagesToCompactMessages,
	modelMessagesToResponsesInput,
	buildResponsesInputWindow,
} from './compact';

describe('estimateTokenCount', () => {
	it('estimates from string length', () => {
		expect(estimateTokenCount('abcd')).toBe(1);
		expect(estimateTokenCount('a'.repeat(400))).toBe(100);
	});

	it('estimates from objects via JSON', () => {
		const tokens = estimateTokenCount({ role: 'user', content: 'hello world' });
		expect(tokens).toBeGreaterThan(0);
	});
});

describe('DEFAULT_COMPACT_TOKEN_THRESHOLD', () => {
	it('defaults to 200k', () => {
		expect(DEFAULT_COMPACT_TOKEN_THRESHOLD).toBe(200_000);
	});
});

describe('modelMessagesToCompactMessages', () => {
	it('converts user/assistant/tool messages', () => {
		const messages: ModelMessage[] = [
			{ role: 'user', content: 'hello' },
			{
				role: 'assistant',
				content: [
					{ type: 'text', text: 'hi' },
					{
						type: 'tool-call',
						toolCallId: 'call_1',
						toolName: 'read_file',
						input: { target_file: 'a.ts' },
					},
				],
			},
			{
				role: 'tool',
				content: [
					{
						type: 'tool-result',
						toolCallId: 'call_1',
						toolName: 'read_file',
						output: { type: 'text', value: 'file contents' },
					},
				],
			},
		];

		const converted = modelMessagesToCompactMessages(messages);
		expect(converted[0]).toEqual({ role: 'user', content: 'hello' });
		expect(converted[1]).toMatchObject({
			role: 'assistant',
			content: 'hi',
			tool_calls: [
				{
					id: 'call_1',
					type: 'function',
					function: {
						name: 'read_file',
						arguments: '{"target_file":"a.ts"}',
					},
				},
			],
		});
		expect(converted[2]).toEqual({
			role: 'tool',
			tool_call_id: 'call_1',
			content: 'file contents',
		});
	});
});

describe('modelMessagesToResponsesInput', () => {
	it('converts tool calls to function_call items', () => {
		const messages: ModelMessage[] = [
			{ role: 'user', content: 'read it' },
			{
				role: 'assistant',
				content: [
					{
						type: 'tool-call',
						toolCallId: 'call_1',
						toolName: 'read_file',
						input: { target_file: 'a.ts' },
					},
				],
			},
			{
				role: 'tool',
				content: [
					{
						type: 'tool-result',
						toolCallId: 'call_1',
						toolName: 'read_file',
						output: { type: 'text', value: 'ok' },
					},
				],
			},
		];

		const input = modelMessagesToResponsesInput(messages);
		expect(input[0]).toEqual({ role: 'user', content: 'read it' });
		expect(input[1]).toMatchObject({
			type: 'function_call',
			call_id: 'call_1',
			name: 'read_file',
		});
		expect(input[2]).toMatchObject({
			type: 'function_call_output',
			call_id: 'call_1',
			output: 'ok',
		});
	});
});

describe('hasCompactionItem', () => {
	it('detects compaction items', () => {
		expect(hasCompactionItem([{ role: 'user', content: 'x' }])).toBe(false);
		expect(
			hasCompactionItem([
				{ role: 'user', content: 'x' },
				{ type: 'compaction', encrypted_content: 'abc' },
			])
		).toBe(true);
	});
});

describe('buildResponsesInputWindow', () => {
	it('prepends compacted base and appends later messages', () => {
		const base = [
			{ role: 'user', content: 'old' },
			{ type: 'compaction', encrypted_content: 'enc' },
		];
		const after: ModelMessage[] = [{ role: 'user', content: 'continue' }];
		const window = buildResponsesInputWindow({
			compactedBase: base,
			messages: after,
		});
		expect(window).toHaveLength(3);
		expect(window[0]).toEqual(base[0]);
		expect(window[1]).toEqual(base[1]);
		expect(window[2]).toEqual({ role: 'user', content: 'continue' });
	});
});
