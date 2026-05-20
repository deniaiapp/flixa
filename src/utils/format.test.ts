import { describe, it, expect } from 'bun:test';
import {
	describeAction,
	describeActionFull,
	formatSessionResults,
	generateNonce,
} from './format';
import type { AgentAction, SerializedActionResult } from '../types';

describe('describeAction', () => {
	it('should describe shell action with truncation', () => {
		const action: AgentAction = {
			type: 'shell',
			command: 'npm run build && npm test && npm run lint && more commands here',
		};
		const result = describeAction(action);
		expect(result.startsWith('Shell: npm run build && npm test && npm run lint')).toBe(true);
		expect(result.length).toBeLessThanOrEqual(57); // "Shell: " + 50 chars
	});

	it('should describe short shell action', () => {
		const action: AgentAction = { type: 'shell', command: 'npm test' };
		const result = describeAction(action);
		expect(result).toBe('Shell: npm test');
	});

	it('should describe vscodeCommand action', () => {
		const action: AgentAction = {
			type: 'vscodeCommand',
			command: 'workbench.action.files.save',
		};
		const result = describeAction(action);
		expect(result).toBe('VSCode: workbench.action.files.save');
	});

	it('should describe writeFile action', () => {
		const action: AgentAction = {
			type: 'writeFile',
			filePath: 'src/test.ts',
			content: 'export const x = 1;',
		};
		const result = describeAction(action);
		expect(result).toBe('Write: src/test.ts');
	});

	it('should describe editFile action', () => {
		const action: AgentAction = {
			type: 'editFile',
			filePath: 'src/test.ts',
			search: 'old',
			replace: 'new',
		};
		const result = describeAction(action);
		expect(result).toBe('Edit: src/test.ts');
	});

	it('should describe deleteFile action', () => {
		const action: AgentAction = {
			type: 'deleteFile',
			filePath: 'src/test.ts',
		};
		const result = describeAction(action);
		expect(result).toBe('Delete: src/test.ts');
	});

	it('should describe diff action', () => {
		const action: AgentAction = {
			type: 'diff',
			filePath: 'src/test.ts',
			diff: '--- a/test.ts\n+++ b/test.ts',
		};
		const result = describeAction(action);
		expect(result).toBe('Diff: src/test.ts');
	});

	it('should handle unknown action type', () => {
		const action = { type: 'unknown' } as unknown as AgentAction;
		const result = describeAction(action);
		expect(result).toBe('Unknown action');
	});
});

describe('describeActionFull', () => {
	it('should describe shell action with full command', () => {
		const action: AgentAction = {
			type: 'shell',
			command: 'npm run build && npm test',
		};
		const result = describeActionFull(action);
		expect(result).toBe('[Shell] npm run build && npm test');
	});

	it('should describe vscodeCommand without args', () => {
		const action: AgentAction = {
			type: 'vscodeCommand',
			command: 'workbench.action.files.save',
		};
		const result = describeActionFull(action);
		expect(result).toBe('[VSCode Command] workbench.action.files.save');
	});

	it('should describe vscodeCommand with args', () => {
		const action: AgentAction = {
			type: 'vscodeCommand',
			command: 'vscode.open',
			args: ['/path/to/file'],
		};
		const result = describeActionFull(action);
		expect(result).toBe('[VSCode Command] vscode.open (args: ["/path/to/file"])');
	});

	it('should describe writeFile action', () => {
		const action: AgentAction = {
			type: 'writeFile',
			filePath: 'src/test.ts',
			content: 'export const x = 1;',
		};
		const result = describeActionFull(action);
		expect(result).toBe('[Write File] src/test.ts');
	});

	it('should describe editFile action with line count', () => {
		const action: AgentAction = {
			type: 'editFile',
			filePath: 'src/test.ts',
			search: 'old',
			replace: 'line1\nline2\nline3',
		};
		const result = describeActionFull(action);
		expect(result).toBe('[Edit File] src/test.ts (edited 3 lines)');
	});

	it('should describe editFile with single line', () => {
		const action: AgentAction = {
			type: 'editFile',
			filePath: 'src/test.ts',
			search: 'old',
			replace: 'new',
		};
		const result = describeActionFull(action);
		expect(result).toBe('[Edit File] src/test.ts (edited 1 lines)');
	});

	it('should describe deleteFile action', () => {
		const action: AgentAction = {
			type: 'deleteFile',
			filePath: 'src/test.ts',
		};
		const result = describeActionFull(action);
		expect(result).toBe('[Delete File] src/test.ts');
	});

	it('should describe diff action', () => {
		const action: AgentAction = {
			type: 'diff',
			filePath: 'src/test.ts',
			diff: '--- a/test.ts\n+++ b/test.ts',
		};
		const result = describeActionFull(action);
		expect(result).toBe('[Diff Preview] src/test.ts');
	});

	it('should handle unknown action type', () => {
		const action = { type: 'unknown' } as unknown as AgentAction;
		const result = describeActionFull(action);
		expect(result).toBe('[Unknown Action]');
	});
});

describe('formatSessionResults', () => {
	it('should format successful results', () => {
		const results: SerializedActionResult[] = [
			{ action: 'Shell: npm test', success: true },
		];
		const formatted = formatSessionResults(results);

		expect(formatted).toContain('[Action Results]');
		expect(formatted).toContain('[SUCCESS] Shell: npm test');
		expect(formatted).toContain('Continue with the next steps or finish if done.');
	});

	it('should format successful results with output', () => {
		const results: SerializedActionResult[] = [
			{ action: 'Shell: npm test', success: true, output: 'All tests passed' },
		];
		const formatted = formatSessionResults(results);

		expect(formatted).toContain('[SUCCESS] Shell: npm test');
		expect(formatted).toContain('Output: All tests passed');
	});

	it('should format failed results', () => {
		const results: SerializedActionResult[] = [
			{ action: 'Shell: npm test', success: false, error: 'Tests failed' },
		];
		const formatted = formatSessionResults(results);

		expect(formatted).toContain('[FAILED] Shell: npm test: Tests failed');
	});

	it('should format failed results with output', () => {
		const results: SerializedActionResult[] = [
			{
				action: 'Shell: npm test',
				success: false,
				error: 'Exit code 1',
				output: 'Error details',
			},
		];
		const formatted = formatSessionResults(results);

		expect(formatted).toContain('[FAILED] Shell: npm test: Exit code 1');
		expect(formatted).toContain('Output: Error details');
	});

	it('should format rejected results', () => {
		const results: SerializedActionResult[] = [
			{
				action: 'Shell: rm -rf /',
				success: false,
				rejected: true,
				rejectionReason: 'Dangerous command',
			},
		];
		const formatted = formatSessionResults(results);

		expect(formatted).toContain('[REJECTED] Shell: rm -rf /: Dangerous command');
	});

	it('should include long output', () => {
		const longOutput = 'x'.repeat(5000);
		const results: SerializedActionResult[] = [
			{ action: 'Shell: npm test', success: true, output: longOutput },
		];
		const formatted = formatSessionResults(results);

		expect(formatted).toContain('Output:');
		expect(formatted).toContain(longOutput);
	});

	it('should include empty output marker for output actions', () => {
		const results: SerializedActionResult[] = [
			{ action: 'Shell: npm test', success: true, output: '' },
		];
		const formatted = formatSessionResults(results);

		expect(formatted).toContain('Output: <no files or terminal output>');
	});

	it('should include empty output marker for whitespace-only output actions', () => {
		const results: SerializedActionResult[] = [
			{ action: 'Shell: npm test', success: true, output: '   \n  ' },
		];
		const formatted = formatSessionResults(results);

		expect(formatted).toContain('Output: <no files or terminal output>');
	});

	it('should normalize "(no output)" marker for output actions', () => {
		const results: SerializedActionResult[] = [
			{ action: 'Shell: npm test', success: true, output: '(no output)' },
		];
		const formatted = formatSessionResults(results);

		expect(formatted).toContain('Output: <no files or terminal output>');
	});

	it('should format multiple results', () => {
		const results: SerializedActionResult[] = [
			{ action: 'Shell: npm test', success: true },
			{ action: 'Write: test.ts', success: true },
			{ action: 'Shell: npm build', success: false, error: 'Build failed' },
		];
		const formatted = formatSessionResults(results);

		expect(formatted).toContain('[SUCCESS] Shell: npm test');
		expect(formatted).toContain('[SUCCESS] Write: test.ts');
		expect(formatted).toContain('[FAILED] Shell: npm build: Build failed');
	});
});

describe('generateNonce', () => {
	it('should generate 32 character string', () => {
		const nonce = generateNonce();
		expect(nonce).toHaveLength(32);
	});

	it('should only contain alphanumeric characters', () => {
		const nonce = generateNonce();
		expect(nonce).toMatch(/^[A-Za-z0-9]+$/);
	});

	it('should generate unique values', () => {
		const nonces = new Set<string>();
		for (let i = 0; i < 100; i++) {
			nonces.add(generateNonce());
		}
		expect(nonces.size).toBe(100);
	});
});
