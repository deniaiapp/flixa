import { beforeEach, describe, expect, it, mock } from 'bun:test';
import * as path from 'path';
import type * as vscode from 'vscode';
import type { ChatContext, LLMResponse } from '../types';

const root = process.cwd();
let approvalMode = 'MANUAL_APPROVE';
let configurationChanged: (event: { affectsConfiguration: (key: string) => boolean }) => void;
const disposable = { dispose() {} };
const windowMock = {
	activeTextEditor: undefined as unknown,
	onDidChangeActiveTextEditor: () => disposable,
	onDidChangeTextEditorSelection: () => disposable,
	showErrorMessage: mock(() => undefined),
};
mock.module('vscode', () => ({
	window: windowMock,
	workspace: {
		workspaceFolders: [{ uri: { fsPath: root } }],
		getConfiguration: () => ({
			get: (key: string, fallback?: unknown) => key === 'agentApprovalMode' ? approvalMode : fallback,
		}),
		onDidSaveTextDocument: () => disposable,
		onDidCreateFiles: () => disposable,
		onDidDeleteFiles: () => disposable,
		onDidChangeConfiguration: (listener: typeof configurationChanged) => {
			configurationChanged = listener;
			return disposable;
		},
	},
	Uri: { file: (fsPath: string) => ({ fsPath }) },
}));

let respond: (response: LLMResponse) => void;
let started: () => void;
let requestSignal: AbortSignal | undefined;
let resolveTitle: (title: string) => void;
mock.module('../llm/stub', () => ({
	callLLMForChat: (_context: unknown, _stream: unknown, signal: AbortSignal) => {
		requestSignal = signal;
		return new Promise<LLMResponse>((resolve) => {
			respond = resolve;
			started();
		});
	},
	callLLMForAgent: mock(),
	generateSessionTitle: () => new Promise<string>((resolve) => { resolveTitle = resolve; }),
	getFlixaProvider: mock(),
}));
const context: ChatContext = {
	userMessage: 'edit', activeSelection: '', activeFileText: 'old\n',
	activeFilePath: path.join(root, 'original.ts'), languageId: 'typescript',
	diagnostics: [], gitDiff: '', history: [], sessionMessages: [],
	autoContext: { fileList: [], gitStatus: '', packageInfo: '', tsConfig: '' }, mentionedFiles: [],
};
mock.module('./context', () => ({
	resolveMentionedFiles: async () => [],
	gatherChatContext: async () => context,
}));
const preview = mock(async () => ({ applied: false }));
mock.module('../diff/preview', () => ({ showDiffPreview: preview }));

const { ChatViewProvider } = require('./panel') as typeof import('./panel');
const { isPathInsideWorkspace } = require('../utils/workspace') as typeof import('../utils/workspace');
const { executeShellAction } = require('../agent/actions/shell') as typeof import('../agent/actions/shell');

function createProvider() {
	const state = new Map<string, unknown>();
	state.set('chatSessions', [{ id: 'original', name: 'Original', messages: [], createdAt: 1 }]);
	state.set('currentSessionId', 'original');
	const extensionContext = {
		subscriptions: [],
		globalState: {
			get: (key: string) => state.get(key),
			update: async (key: string, value: unknown) => { state.set(key, value); },
		},
	} as unknown as vscode.ExtensionContext;
	const provider = new ChatViewProvider({ fsPath: root } as vscode.Uri, extensionContext, () => {});
	provider.setAgentMode(false);
	const send = (message: string) => (provider as unknown as {
		_handleUserMessage: (message: string) => Promise<void>;
	})._handleUserMessage(message);
	return { provider, send, state };
}

beforeEach(() => {
	approvalMode = 'MANUAL_APPROVE';
	windowMock.activeTextEditor = undefined;
	preview.mockClear();
	requestSignal = undefined;
});

describe('workspace boundaries', () => {
	it('accepts descendants and rejects sibling prefixes and traversal', () => {
		expect(isPathInsideWorkspace('src/file.ts')).toBe(true);
		expect(isPathInsideWorkspace(root)).toBe(true);
		expect(isPathInsideWorkspace(`${root}-backup/file.ts`)).toBe(false);
		expect(isPathInsideWorkspace('../outside.ts')).toBe(false);
	});
});

describe('chat regression coverage', () => {
	it('loads approval configuration and follows configuration changes', () => {
		const { provider } = createProvider();
		expect(provider.getApprovalMode()).toBe('MANUAL_APPROVE');
		approvalMode = 'SAFE_APPROVE';
		configurationChanged({ affectsConfiguration: (key) => key === 'flixa.agentApprovalMode' });
		expect(provider.getApprovalMode()).toBe('SAFE_APPROVE');
	});

	it('waits for the cancelled request before switching and keeps the title on its original session', async () => {
		const { provider, send, state } = createProvider();
		const began = new Promise<void>((resolve) => { started = resolve; });
		const running = send('edit');
		await began;
		const switching = provider.newChat();
		expect(requestSignal?.aborted).toBe(true);
		expect(state.get('currentSessionId')).toBe('original');
		respond({ type: 'message', message: 'late answer' });
		await Promise.all([running, switching]);
		resolveTitle('Original title');
		await Promise.resolve();
		const sessions = state.get('chatSessions') as Array<{ id: string; name: string; messages: unknown[] }>;
		expect(sessions[0].id).not.toBe('original');
		expect(sessions[0].messages).toEqual([]);
		expect(sessions.find((session) => session.id === 'original')?.name).toBe('Original title');
	});

	it('previews the original file after the active editor changes', async () => {
		const { send } = createProvider();
		const began = new Promise<void>((resolve) => { started = resolve; });
		const running = send('edit');
		await began;
		windowMock.activeTextEditor = { document: { uri: { fsPath: path.join(root, 'other.ts') } } };
		respond({ type: 'diff', message: 'edited', diff: '--- a/original.ts\n+++ b/original.ts\n@@ -1 +1 @@\n-old\n+new\n' });
		await running;
		expect(preview).toHaveBeenCalledWith(
			{ fsPath: context.activeFilePath }, context.activeFileText, expect.any(String), 'chat', expect.any(Function),
		);
		resolveTitle('Title');
	});
});

it('answers a terminal prompt without requiring additional output', async () => {
	const command = process.platform === 'win32'
		? '[Console]::Write("Continue? [y/n]"); $answer = [Console]::ReadLine(); if ($answer -eq "y") { exit 0 } else { exit 1 }'
		: 'printf "Continue? [y/n]"; read answer; test "$answer" = y';
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 4000);
	try {
		const result = await executeShellAction({ type: 'shell', command }, 'ALL_APPROVE', undefined, undefined, controller.signal);
		expect(result.success).toBe(true);
	} finally {
		clearTimeout(timeout);
	}
});
