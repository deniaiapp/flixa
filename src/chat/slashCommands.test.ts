import { describe, expect, it } from 'bun:test';
import {
	formatApprovalModeLabel,
	formatSlashHelp,
	isSlashCommandMessage,
	parseApprovalModeArg,
	parseSlashCommand,
} from './slashCommands';

describe('parseSlashCommand', () => {
	it('parses command without args', () => {
		expect(parseSlashCommand('/help')).toEqual({
			name: 'help',
			args: [],
			raw: '/help',
		});
	});

	it('parses command with args', () => {
		expect(parseSlashCommand('/model openai/gpt-5.5')).toEqual({
			name: 'model',
			args: ['openai/gpt-5.5'],
			raw: '/model openai/gpt-5.5',
		});
	});

	it('returns null for normal messages', () => {
		expect(parseSlashCommand('hello')).toBeNull();
		expect(parseSlashCommand('')).toBeNull();
	});
});

describe('isSlashCommandMessage', () => {
	it('detects slash commands', () => {
		expect(isSlashCommandMessage('/compact')).toBe(true);
		expect(isSlashCommandMessage('/model openai/gpt-5.5')).toBe(true);
		expect(isSlashCommandMessage('not a command')).toBe(false);
		expect(isSlashCommandMessage('/')).toBe(false);
	});
});

describe('parseApprovalModeArg', () => {
	it('parses aliases', () => {
		expect(parseApprovalModeArg('auto')).toBe('AUTO_APPROVE');
		expect(parseApprovalModeArg('safe')).toBe('SAFE_APPROVE');
		expect(parseApprovalModeArg('manual')).toBe('MANUAL_APPROVE');
		expect(parseApprovalModeArg('all')).toBe('ALL_APPROVE');
		expect(parseApprovalModeArg('yolo')).toBe('ALL_APPROVE');
	});

	it('rejects unknown values', () => {
		expect(parseApprovalModeArg('nope')).toBeNull();
	});
});

describe('formatApprovalModeLabel', () => {
	it('formats modes', () => {
		expect(formatApprovalModeLabel('AUTO_APPROVE')).toBe('auto');
		expect(formatApprovalModeLabel('SAFE_APPROVE')).toBe('safe');
	});
});

describe('formatSlashHelp', () => {
	it('includes core commands', () => {
		const help = formatSlashHelp();
		expect(help).toContain('/help');
		expect(help).toContain('/compact');
		expect(help).toContain('/new');
		expect(help).toContain('/clear');
	});
});
