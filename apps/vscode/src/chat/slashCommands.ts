import type { ApprovalMode } from '../types';

export interface SlashCommandDefinition {
	name: string;
	description: string;
	usage?: string;
}

export const SLASH_COMMANDS: SlashCommandDefinition[] = [
	{
		name: 'help',
		description: 'Show available slash commands',
	},
	{
		name: 'new',
		description: 'Start a new chat',
	},
	{
		name: 'clear',
		description: 'Clear messages in the current chat',
	},
	{
		name: 'compact',
		description: 'Compact the context window for this chat',
	},
	{
		name: 'stop',
		description: 'Stop the running agent',
	},
	{
		name: 'agent',
		description: 'Switch to agent mode',
	},
	{
		name: 'chat',
		description: 'Switch to chat mode',
	},
	{
		name: 'model',
		description: 'Show or set the model',
		usage: '/model [model-id]',
	},
	{
		name: 'approval',
		description: 'Show or set approval mode',
		usage: '/approval [auto|safe|manual|all]',
	},
];

export function isSlashCommandMessage(content: string): boolean {
	return /^\/[a-zA-Z0-9_-]+(?:\s+.*)?$/.test(content.trim());
}

export function parseSlashCommand(message: string): {
	name: string;
	args: string[];
	raw: string;
} | null {
	const trimmed = message.trim();
	if (!trimmed.startsWith('/')) {
		return null;
	}
	const body = trimmed.slice(1).trim();
	if (!body) {
		return null;
	}
	const parts = body.split(/\s+/);
	const name = (parts[0] ?? '').toLowerCase();
	if (!name) {
		return null;
	}
	return {
		name,
		args: parts.slice(1),
		raw: trimmed,
	};
}

export function formatSlashHelp(): string {
	const lines = ['Available commands:', ''];
	for (const command of SLASH_COMMANDS) {
		const usage = command.usage ?? `/${command.name}`;
		lines.push(`${usage} — ${command.description}`);
	}
	return lines.join('\n');
}

const APPROVAL_ALIASES: Record<string, ApprovalMode> = {
	auto: 'AUTO_APPROVE',
	auto_approve: 'AUTO_APPROVE',
	'auto-approve': 'AUTO_APPROVE',
	safe: 'SAFE_APPROVE',
	safe_approve: 'SAFE_APPROVE',
	'safe-approve': 'SAFE_APPROVE',
	manual: 'MANUAL_APPROVE',
	manual_approve: 'MANUAL_APPROVE',
	'manual-approve': 'MANUAL_APPROVE',
	all: 'ALL_APPROVE',
	all_approve: 'ALL_APPROVE',
	'all-approve': 'ALL_APPROVE',
	yolo: 'ALL_APPROVE',
};

export function parseApprovalModeArg(arg: string): ApprovalMode | null {
	const key = arg.trim().toLowerCase();
	if (key in APPROVAL_ALIASES) {
		return APPROVAL_ALIASES[key];
	}
	const upper = arg.trim().toUpperCase();
	if (
		upper === 'ALL_APPROVE' ||
		upper === 'AUTO_APPROVE' ||
		upper === 'SAFE_APPROVE' ||
		upper === 'MANUAL_APPROVE'
	) {
		return upper;
	}
	return null;
}

export function formatApprovalModeLabel(mode: ApprovalMode): string {
	switch (mode) {
		case 'ALL_APPROVE':
			return 'all';
		case 'AUTO_APPROVE':
			return 'auto';
		case 'SAFE_APPROVE':
			return 'safe';
		case 'MANUAL_APPROVE':
			return 'manual';
		default:
			return mode;
	}
}
