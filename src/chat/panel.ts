import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { executeAgentActions } from '../agent/executor';
import { showDiffPreview } from '../diff/preview';
import { applyDiffToContent, validateDiff } from '../diff/validator';
import { callLLMForAgent, callLLMForChat, generateSessionTitle } from '../llm/stub';
import {
	buildResponsesInputWindow,
	estimateTokenCount,
	maybeCompactInput,
} from '../llm/compact';
import { buildAgentMessages } from '../llm/messages';
import {
	getAvailableModels,
	getModel,
	getModelDefinitions,
	getReasoningEffort,
	setModel,
	setReasoningEffort,
} from '../llm/provider';
import { AGENT_SYSTEM_PROMPT } from '../llm/prompts';
import type {
	ActionExecutionResult,
	AgentAction,
	AgentResponse,
	ApprovalMode,
	ChatContext,
	LLMResponse,
	PendingDiff,
	SerializedActionResult,
	SerializedToolResult,
} from '../types';
import { describeAction } from '../utils/format';
import { getAutoContextConfig } from '../autoContext';
import { gatherChatContext, resolveMentionedFiles } from './context';
import { SessionManager } from './session';
import {
	formatApprovalModeLabel,
	formatSlashHelp,
	parseApprovalModeArg,
	parseSlashCommand,
} from './slashCommands';
import { getWebviewHtml } from './webview';
import { showQuotaExceededDialog, type UsageService } from '../usage/service';
import { isPremiumModel, type UsageCategory } from '../usage/types';

interface TrackedFile {
	filePath: string;
	originalContent: string | null;
	status: 'modified' | 'created' | 'deleted';
	createdDirs: string[];
}

const MAX_AGENT_ITERATIONS = Infinity;

export class ChatViewProvider implements vscode.WebviewViewProvider {
	public static readonly viewType = 'flixa.chatView';

	private _view?: vscode.WebviewView;
	private _extensionUri: vscode.Uri;
	private _sessionManager: SessionManager;
	private _storePendingDiff: (diff: PendingDiff) => void;
	private _agentMode: boolean = true;
	private _approvalMode: ApprovalMode = vscode.workspace
		.getConfiguration('flixa').get<ApprovalMode>('agentApprovalMode', 'SAFE_APPROVE');
	private _pendingRequest?: Promise<void>;
	private _isLoading: boolean = false;
	private _isAgentRunning: boolean = false;
	private _stopRequested: boolean = false;
	private _currentAbortController?: AbortController;
	private _usageService?: UsageService;
	private _changedFiles: Map<string, TrackedFile> = new Map();
	private _workspaceFiles: string[] = [];
	private _activeFilePath: string = '';
	private _activeSelection: string = '';

	constructor(
		extensionUri: vscode.Uri,
		context: vscode.ExtensionContext,
		storePendingDiff: (diff: PendingDiff) => void,
		usageService?: UsageService
	) {
		this._extensionUri = extensionUri;
		this._sessionManager = new SessionManager(context);
		this._storePendingDiff = storePendingDiff;
		this._usageService = usageService;
		context.subscriptions.push(
			vscode.window.onDidChangeActiveTextEditor(() => {
				void this._sendEditorContext();
			}),
			vscode.window.onDidChangeTextEditorSelection(() => {
				void this._sendEditorContext();
			}),
			vscode.workspace.onDidSaveTextDocument(() => {
				void this._refreshWorkspaceFiles();
			}),
			vscode.workspace.onDidCreateFiles(() => {
				void this._refreshWorkspaceFiles();
			}),
			vscode.workspace.onDidDeleteFiles(() => {
				void this._refreshWorkspaceFiles();
			}),
			vscode.workspace.onDidChangeConfiguration((event) => {
				if (event.affectsConfiguration('flixa.agentApprovalMode')) {
					this._approvalMode = vscode.workspace.getConfiguration('flixa')
						.get<ApprovalMode>('agentApprovalMode', 'SAFE_APPROVE');
					void this._updateState();
				}
				if (event.affectsConfiguration('flixa.autoContext.enabled')) {
					void this._updateState();
					void this._sendEditorContext();
				}
			}),
		);
	}

	private async _finishCurrentRequest(): Promise<void> {
		if (this._pendingRequest) {
			this._stopRequested = true;
			this._currentAbortController?.abort();
			await this._pendingRequest;
		}
	}

	public async clearHistory(): Promise<void> {
		await this._finishCurrentRequest();
		this._sessionManager.clearHistory();
		this._updateMessages();
	}

	public async newChat(): Promise<void> {
		await this._finishCurrentRequest();
		this._sessionManager.createNewSession();
		this._changedFiles.clear();
		this._updateMessages();
		this._updateSessions();
		this._sendChangedFiles();
	}

	public async showChatHistory(): Promise<void> {
		const selected = await vscode.window.showQuickPick(
			this._sessionManager.sessions.map((session) => ({
				label: session.name,
				description: session.id === this._sessionManager.currentSessionId ? 'Current chat' : undefined,
				sessionId: session.id,
			})),
			{
				placeHolder: 'Flixa: Chat History',
				matchOnDescription: true,
			},
		);
		if (!selected) {
			return;
		}
		await this._finishCurrentRequest();
		this._sessionManager.currentSessionId = selected.sessionId;
		this._updateMessages();
		this._updateSessions();
	}

	public resolveWebviewView(
		webviewView: vscode.WebviewView,
		_context: vscode.WebviewViewResolveContext,
		_token: vscode.CancellationToken
	): void {
		this._view = webviewView;
		webviewView.onDidDispose(() => {
			this._view = undefined;
		});

		webviewView.webview.options = {
			enableScripts: true,
			localResourceRoots: [this._extensionUri],
		};

		webviewView.webview.html = getWebviewHtml(
			webviewView.webview,
			this._extensionUri
		);

		webviewView.webview.onDidReceiveMessage(async (data) => {
			if (data.type === 'ready') {
				await this._refreshWorkspaceFiles();
				this._updateState();
				this._updateMessages();
				this._updateSessions();
				this._sendChangedFiles();
				await this._sendEditorContext();
				if (this._usageService) {
					await this._usageService.fetchUsage(true);
					this.updateUsage(this._usageService.getCachedUsage());
				}
			} else if (data.type === 'sendMessage') {
				await this._handleUserMessage(
					data.message,
					typeof data.excludedActiveFilePath === 'string'
						? data.excludedActiveFilePath
						: undefined,
				);
			} else if (data.type === 'toggleAgentMode') {
				this._agentMode = data.enabled;
				this._updateState();
			} else if (data.type === 'setApprovalMode') {
				this._approvalMode = data.mode;
				this._updateState();
			} else if (data.type === 'setModel') {
				await setModel(data.model);
				this._updateState();
			} else if (data.type === 'setReasoningEffort') {
				await setReasoningEffort(data.reasoningEffort);
				this._updateState();
			} else if (data.type === 'setAutoContextEnabled') {
				await vscode.workspace
					.getConfiguration('flixa')
					.update(
						'autoContext.enabled',
						data.enabled === true,
						vscode.ConfigurationTarget.Global,
					);
				await this._updateState();
			} else if (data.type === 'openSettings') {
				await vscode.commands.executeCommand(
					'workbench.action.openSettings',
					'@ext:deniai.flixa',
				);
			} else if (data.type === 'stopAgent') {
				this._stopRequested = true;
				this._currentAbortController?.abort();
			} else if (data.type === 'newChat') {
				await this.newChat();
			} else if (data.type === 'switchChat') {
				await this._finishCurrentRequest();
				this._sessionManager.currentSessionId = data.sessionId;
				this._updateMessages();
				this._updateSessions();
			} else if (data.type === 'deleteChat') {
				await this._finishCurrentRequest();
				this._sessionManager.deleteSession(data.sessionId);
				this._updateMessages();
				this._updateSessions();
			} else if (data.type === 'showUsageDetail') {
				vscode.commands.executeCommand('flixa.showUsageDetail');
			} else if (data.type === 'login') {
				vscode.commands.executeCommand('flixa.login');
			} else if (data.type === 'openBilling') {
				if (this._usageService) {
					const billingUrl =
						this._usageService.getCachedUsage()?.upgradeUrl ??
						this._usageService.getBillingUrl();
					vscode.env.openExternal(vscode.Uri.parse(billingUrl));
				}
			} else if (data.type === 'openExternalUrl') {
				if (typeof data.url === 'string') {
					vscode.env.openExternal(vscode.Uri.parse(data.url));
				}
			} else if (data.type === 'openFile') {
				const workspaceFolders = vscode.workspace.workspaceFolders;
				if (workspaceFolders && data.filePath) {
					const fileUri = vscode.Uri.joinPath(workspaceFolders[0].uri, data.filePath);
					try {
						await vscode.window.showTextDocument(fileUri, { preview: true });
					} catch { }
				}
			} else if (data.type === 'revertFile') {
				await this._revertFile(data.filePath);
			} else if (data.type === 'keepFile') {
				this._keepFile(data.filePath);
			} else if (data.type === 'keepAll') {
				this._keepAll();
			}
		});
	}

	public setAgentMode(enabled: boolean): void {
		this._agentMode = enabled;
		this._updateState();
	}

	public setApprovalMode(mode: ApprovalMode): void {
		this._approvalMode = mode;
		this._updateState();
	}

	public getAgentMode(): boolean {
		return this._agentMode;
	}

	public getApprovalMode(): ApprovalMode {
		return this._approvalMode;
	}

	public async refreshState(): Promise<void> {
		await this._updateState();
	}

	private _setLoading(loading: boolean): void {
		this._isLoading = loading;
		if (!this._view) {
			return;
		}
		try {
			this._view.webview.postMessage({
				type: 'setLoading',
				loading: this._isLoading,
				agentRunning: this._isAgentRunning,
			});
		} catch { }
	}

	private _setAgentRunning(running: boolean): void {
		this._isAgentRunning = running;
		if (!running) {
			this._stopRequested = false;
		}
		if (!this._view) {
			return;
		}
		try {
			this._view.webview.postMessage({
				type: 'setLoading',
				loading: this._isLoading,
				agentRunning: this._isAgentRunning,
			});
		} catch { }
	}

	private async _handleUserMessage(
		message: string,
		excludedActiveFilePath?: string,
	): Promise<void> {
		const slash = parseSlashCommand(message);
		if (slash && ['stop', 'new', 'clear'].includes(slash.name)) {
			await this._handleSlashCommand(slash.name, slash.args, slash.raw);
			return;
		}
		if (this._pendingRequest) {
			return;
		}
		this._stopRequested = false;
		this._setLoading(true);
		const request = this._processUserMessage(message, excludedActiveFilePath)
			.catch((error: unknown) => {
				console.log('[Flixa] request failed', error);
				if (!this._stopRequested) {
					this._pushSystemReply(error instanceof Error ? error.message : String(error));
				}
			})
			.finally(() => {
				this._pendingRequest = undefined;
				this._setLoading(false);
			});
		this._pendingRequest = request;
		await request;
	}

	private async _processUserMessage(
		message: string,
		excludedActiveFilePath?: string,
	): Promise<void> {
		const slash = parseSlashCommand(message);
		if (slash) {
			await this._handleSlashCommand(slash.name, slash.args, slash.raw);
			return;
		}

		const currentSession = this._sessionManager.getCurrentSession();
		const isFirstMessage = currentSession && currentSession.messages.length === 0;

		const currentModel = getModel();
		const usageCategory: UsageCategory = isPremiumModel(currentModel)
			? 'premium'
			: 'basic';

		const editor = vscode.window.activeTextEditor;
		const activeFilePath = editor ? this._toRelativePath(editor.document.uri.fsPath) : '';
		const normalizedExcludedPath = excludedActiveFilePath
			?.replace(/\\/g, '/')
			.toLowerCase();
		const normalizedActivePath = activeFilePath.toLowerCase();
		const includeActiveFile =
			getAutoContextConfig().enabled &&
			!!editor &&
			(!normalizedExcludedPath || normalizedExcludedPath !== normalizedActivePath);
		const activeSelection =
			includeActiveFile && editor && !editor.selection.isEmpty
				? editor.document.getText(editor.selection)
				: '';
		const includedActiveFilePath = includeActiveFile ? activeFilePath : '';
		const activeSelectionLabel = editor
			? includeActiveFile
				? this._getSelectionLabel(editor)
				: ''
			: '';
		const mentionedFiles = await resolveMentionedFiles(message);
		if (this._stopRequested) {
			return;
		}

		this._sessionManager.pushMessage({
			role: 'user',
			content: message,
			activeSelection,
			activeFilePath: includedActiveFilePath,
			activeSelectionLabel,
			mentionedFiles,
		});
		this._updateMessages();

		if (isFirstMessage) {
			const sessionId = this._sessionManager.currentSessionId;
			generateSessionTitle(message).then((title) => {
				this._sessionManager.updateSessionName(
					sessionId,
					title
				);
				this._updateSessions();
			});
		}

		const context = await gatherChatContext(
			message,
			() => this._sessionManager.getMessages(),
			() => this._sessionManager.getSessionMessages(),
			excludedActiveFilePath,
		);
		if (this._stopRequested) {
			return;
		}

		if (this._agentMode) {
			await this._handleAgentLoop(context, usageCategory);
		} else {
			this._setLoading(true);
			try {
				await this._handleChatMessage(context, usageCategory);
			} finally {
				this._setLoading(false);
			}
		}
	}

	private _pushSlashEcho(raw: string): void {
		this._sessionManager.pushMessage({
			role: 'user',
			content: raw,
		});
		this._updateMessages();
	}

	private _pushSystemReply(content: string): void {
		this._sessionManager.pushMessage({
			role: 'system',
			content,
		});
		this._updateMessages();
	}

	private async _handleSlashCommand(
		name: string,
		args: string[],
		raw: string
	): Promise<void> {
		switch (name) {
			case 'help':
				this._pushSlashEcho(raw);
				this._pushSystemReply(formatSlashHelp());
				return;
			case 'new':
				await this.newChat();
				return;
			case 'clear':
				await this.clearHistory();
				this._changedFiles.clear();
				this._pushSystemReply('Chat history cleared.');
				this._sendChangedFiles();
				return;
			case 'compact':
				await this._handleCompactCommand(raw);
				return;
			case 'stop':
				this._pushSlashEcho(raw);
				if (this._isAgentRunning || this._isLoading) {
					this._stopRequested = true;
					this._currentAbortController?.abort();
					this._pushSystemReply('Stop requested.');
				} else {
					this._pushSystemReply('Nothing is running.');
				}
				return;
			case 'agent':
				this._pushSlashEcho(raw);
				this._agentMode = true;
				await this._updateState();
				this._pushSystemReply('Switched to agent mode.');
				return;
			case 'chat':
				this._pushSlashEcho(raw);
				this._agentMode = false;
				await this._updateState();
				this._pushSystemReply('Switched to chat mode.');
				return;
			case 'model':
				await this._handleModelCommand(raw, args);
				return;
			case 'approval':
				await this._handleApprovalCommand(raw, args);
				return;
			default:
				this._pushSlashEcho(raw);
				this._pushSystemReply(
					`Unknown command: /${name}\n\n${formatSlashHelp()}`
				);
		}
	}

	private async _handleModelCommand(raw: string, args: string[]): Promise<void> {
		this._pushSlashEcho(raw);
		const models = await getAvailableModels();
		if (args.length === 0) {
			const list = models.map((model) => `  - ${model}`).join('\n');
			this._pushSystemReply(
				`Current model: ${getModel()}\n\nAvailable models:\n${list}\n\nUsage: /model <model-id>`
			);
			return;
		}

		const requested = args.join(' ').trim();
		const match =
			models.find((model) => model === requested) ??
			models.find((model) => model.toLowerCase() === requested.toLowerCase());
		if (!match) {
			this._pushSystemReply(
				`Unknown model: ${requested}\n\nAvailable models:\n${models.map((model) => `  - ${model}`).join('\n')}`
			);
			return;
		}

		await setModel(match);
		await this._updateState();
		this._pushSystemReply(`Model set to ${match}.`);
	}

	private async _handleApprovalCommand(
		raw: string,
		args: string[]
	): Promise<void> {
		this._pushSlashEcho(raw);
		if (args.length === 0) {
			this._pushSystemReply(
				`Current approval mode: ${formatApprovalModeLabel(this._approvalMode)}\n\nOptions: auto, safe, manual, all\nUsage: /approval <mode>`
			);
			return;
		}

		const mode = parseApprovalModeArg(args[0] ?? '');
		if (!mode) {
			this._pushSystemReply(
				`Unknown approval mode: ${args[0]}\n\nOptions: auto, safe, manual, all`
			);
			return;
		}

		this._approvalMode = mode;
		await this._updateState();
		this._pushSystemReply(
			`Approval mode set to ${formatApprovalModeLabel(mode)}.`
		);
	}

	private async _handleCompactCommand(raw: string = '/compact'): Promise<void> {
		this._pushSlashEcho(raw);

		const sessionMessages = this._sessionManager.getSessionMessages();
		if (sessionMessages.length === 0 && !this._sessionManager.getCompactedInput()) {
			this._pushSystemReply('Nothing to compact.');
			return;
		}

		this._setLoading(true);
		try {
			const context = await gatherChatContext(
				'/compact',
				() => this._sessionManager.getMessages(),
				() => this._sessionManager.getSessionMessages()
			);

			const compactedInput = this._sessionManager.getCompactedInput();
			const compactedSessionMessageCount =
				this._sessionManager.getCompactedSessionMessageCount();
			const messagesForWindow = compactedInput
				? buildAgentMessages({
						...context,
						sessionMessages: context.sessionMessages.slice(
							Math.max(0, compactedSessionMessageCount)
						),
					})
				: buildAgentMessages(context);

			const input = buildResponsesInputWindow({
				compactedBase: compactedInput,
				messages: messagesForWindow,
			});

			if (input.length === 0) {
				this._pushSystemReply('Nothing to compact.');
				return;
			}

			const beforeTokens = estimateTokenCount(input);
			const result = await maybeCompactInput({
				input,
				model: getModel(),
				instructions: AGENT_SYSTEM_PROMPT,
				force: true,
			});

			if (!result.didCompact) {
				this._pushSystemReply('Nothing to compact.');
				return;
			}

			this._sessionManager.setCompactedInput(
				result.input,
				sessionMessages.length
			);
			const afterTokens = estimateTokenCount(result.input);
			this._pushSystemReply(
				`Context compacted (~${beforeTokens.toLocaleString()} → ~${afterTokens.toLocaleString()} tokens).`
			);

			if (this._usageService) {
				const usageCategory: UsageCategory = isPremiumModel(getModel())
					? 'premium'
					: 'basic';
				this._usageService.refreshAfterSend(usageCategory);
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this._pushSystemReply(`Compact failed: ${message}`);
		} finally {
			this._setLoading(false);
		}
	}

	private _sendStreamingUpdate(text: string): void {
		if (!this._view) {
			return;
		}
		try {
			this._view.webview.postMessage({
				type: 'streamingUpdate',
				text,
			});
		} catch { }
	}

	private _getFilePathFromAction(action: AgentAction): string | null {
		switch (action.type) {
			case 'writeFile':
			case 'editFile':
			case 'deleteFile':
			case 'diff':
				return action.filePath;
			case 'search_replace':
				return action.file_path;
			case 'edit_file':
			case 'delete_file':
				return action.target_file;
			default:
				return null;
		}
	}

	private _resolveFilePath(filePath: string): string {
		const workspaceFolders = vscode.workspace.workspaceFolders;
		if (!workspaceFolders) {
			return filePath;
		}
		const root = workspaceFolders[0].uri.fsPath;
		if (path.isAbsolute(filePath)) {
			return filePath;
		}
		return path.join(root, filePath);
	}

	private _getRelativePath(absolutePath: string): string {
		const workspaceFolders = vscode.workspace.workspaceFolders;
		if (!workspaceFolders) {
			return absolutePath;
		}
		const root = workspaceFolders[0].uri.fsPath;
		if (absolutePath.startsWith(root)) {
			return absolutePath.substring(root.length + 1).replace(/\\/g, '/');
		}
		return absolutePath.replace(/\\/g, '/');
	}

	private _captureOriginalContents(actions: AgentAction[]): void {
		for (const action of actions) {
			const filePath = this._getFilePathFromAction(action);
			if (!filePath) {
				continue;
			}
			const absolutePath = this._resolveFilePath(filePath);
			const relativePath = this._getRelativePath(absolutePath);
			if (this._changedFiles.has(relativePath)) {
				continue;
			}
			try {
				const content = fs.readFileSync(absolutePath, 'utf-8');
				this._changedFiles.set(relativePath, {
					filePath: relativePath,
					originalContent: content,
					status: 'modified',
					createdDirs: [],
				});
			} catch {
				const createdDirs: string[] = [];
				let dir = path.dirname(absolutePath);
				const workspaceFolders = vscode.workspace.workspaceFolders;
				const root = workspaceFolders ? workspaceFolders[0].uri.fsPath : '';
				while (dir && dir !== root && dir !== path.dirname(dir)) {
					if (!fs.existsSync(dir)) {
						createdDirs.unshift(dir);
					} else {
						break;
					}
					dir = path.dirname(dir);
				}
				this._changedFiles.set(relativePath, {
					filePath: relativePath,
					originalContent: null,
					status: 'created',
					createdDirs,
				});
			}
		}
	}

	private _updateTrackedStatuses(results: ActionExecutionResult[]): void {
		for (const result of results) {
			if (!result.success || result.rejected) {
				continue;
			}
			const filePath = this._getFilePathFromAction(result.action);
			if (!filePath) {
				continue;
			}
			const absolutePath = this._resolveFilePath(filePath);
			const relativePath = this._getRelativePath(absolutePath);
			const tracked = this._changedFiles.get(relativePath);
			if (!tracked) {
				continue;
			}
			if (result.action.type === 'deleteFile' || result.action.type === 'delete_file') {
				tracked.status = 'deleted';
			}
		}
	}

	private _formatToolResult(result: ActionExecutionResult): string {
		const action = describeAction(result.action);
		if (result.rejected) {
			return `[REJECTED] ${action}: ${result.rejectionReason ?? 'Rejected'}`;
		}
		if (!result.success) {
			const lines = [`[FAILED] ${action}: ${result.error ?? 'Unknown error'}`];
			if (result.output && result.output.trim() && result.output !== '(no output)') {
				lines.push(result.output);
			}
			return lines.join('\n');
		}
		if (result.output && result.output.trim()) {
			return result.output;
		}
		return `[SUCCESS] ${action}`;
	}

	private async _revertFile(relativePath: string): Promise<void> {
		const tracked = this._changedFiles.get(relativePath);
		if (!tracked) {
			return;
		}
		const absolutePath = this._resolveFilePath(relativePath);
		try {
			if (tracked.originalContent === null) {
				await vscode.workspace.fs.delete(vscode.Uri.file(absolutePath));
				for (let i = tracked.createdDirs.length - 1; i >= 0; i--) {
					const dir = tracked.createdDirs[i];
					try {
						const entries = fs.readdirSync(dir);
						if (entries.length === 0) {
							fs.rmdirSync(dir);
						}
					} catch { break; }
				}
			} else {
				await vscode.workspace.fs.writeFile(
					vscode.Uri.file(absolutePath),
					Buffer.from(tracked.originalContent, 'utf-8')
				);
			}
			this._changedFiles.delete(relativePath);
			this._sendChangedFiles();
		} catch { }
	}

	private _keepFile(relativePath: string): void {
		this._changedFiles.delete(relativePath);
		this._sendChangedFiles();
	}

	private _keepAll(): void {
		this._changedFiles.clear();
		this._sendChangedFiles();
	}

	private _sendChangedFiles(): void {
		if (!this._view) {
			return;
		}
		const files = Array.from(this._changedFiles.values()).map((f) => ({
			filePath: f.filePath,
			status: f.status,
		}));
		try {
			this._view.webview.postMessage({
				type: 'updateChangedFiles',
				files,
			});
		} catch { }
	}

	private async _handleAgentLoop(
		context: ChatContext,
		usageCategory: UsageCategory
	): Promise<void> {
		let iteration = 0;
		let retryCount = 0;
		const maxRetries = 3;

		this._setAgentRunning(true);

		try {
			while (iteration < MAX_AGENT_ITERATIONS) {
				if (this._stopRequested) {
					this._sessionManager.pushMessage({
						role: 'system',
						content: 'Stopped by user',
					});
					this._updateMessages();
					break;
				}

				iteration++;

				context.sessionMessages = this._sessionManager.getSessionMessages();

				this._setLoading(true);
				let response: AgentResponse | LLMResponse;
				const llmAbortController = new AbortController();
				this._currentAbortController = llmAbortController;
				try {
					response = await callLLMForAgent(
						context,
						(text) => {
							this._sendStreamingUpdate(text);
						},
						llmAbortController.signal,
						{
							compactedInput: this._sessionManager.getCompactedInput(),
							compactedSessionMessageCount:
								this._sessionManager.getCompactedSessionMessageCount(),
							onCompacted: (input, sessionMessageCount) => {
								this._sessionManager.setCompactedInput(
									input,
									sessionMessageCount
								);
							},
						}
					);
				} finally {
					if (this._currentAbortController === llmAbortController) {
						this._currentAbortController = undefined;
					}
					this._setLoading(false);
					this._sendStreamingUpdate('');
				}

				if (this._stopRequested) {
					this._sessionManager.pushMessage({
						role: 'system',
						content: 'Stopped by user',
					});
					this._updateMessages();
					break;
				}

				if (response.type !== 'agent') {
					console.log('[Flixa] agent response non-agent', response.message);
					if (response.quotaExceeded) {
						this._sessionManager.pushMessage({
							role: 'assistant',
							content: response.message,
						});
						this._updateMessages();
						await this._handleQuotaExceeded(response.quotaExceeded);
						break;
					}
					const retryable =
						response.message.startsWith('[API Error]') ||
						response.message === 'Empty response' ||
						response.message.startsWith('[Agent - Step');
					if (retryable && retryCount < maxRetries) {
						retryCount++;
						this._sessionManager.pushMessage({
							role: 'assistant',
							content: response.message,
						});
						this._updateMessages();
						continue;
					}
					this._sessionManager.pushMessage({
						role: 'assistant',
						content: response.message,
					});
					this._updateMessages();

					if (this._usageService) {
						this._usageService.refreshAfterSend(usageCategory);
					}
					break;
				}

				const agentResponse = response as AgentResponse;
				console.log(
					'[Flixa] agent response actions',
					agentResponse.actions.length
				);
				retryCount = 0;

				if (agentResponse.actions.length === 0) {
					this._sessionManager.pushMessage({
						role: 'assistant',
						content: `[Agent] ${agentResponse.message}`,
					});
					this._updateMessages();

					if (this._usageService) {
						this._usageService.refreshAfterSend(usageCategory);
					}
					break;
				}

				if (this._stopRequested) {
					this._sessionManager.pushMessage({
						role: 'system',
						content: 'Stopped by user',
					});
					this._updateMessages();
					break;
				}

				const onOutput = (actionDesc: string, output: string) => {
					const messages = this._sessionManager.getMessages();
					const existingIdx = messages.findIndex(
						(m) => m.role === 'executing' && m.executingAction === actionDesc
					);
					if (existingIdx >= 0) {
						messages[existingIdx].executingOutput = output;
					} else {
						this._sessionManager.pushMessage({
							role: 'executing',
							content: '',
							executingAction: actionDesc,
							executingOutput: output,
						});
					}
					this._updateMessages();
				};

				const onSafetyCheck = (actionDesc: string, checking: boolean) => {
					const messages = this._sessionManager.getMessages();
					const existingIdx = messages.findIndex(
						(m) => m.role === 'executing' && m.executingAction === actionDesc
					);
					if (checking) {
						if (existingIdx >= 0) {
							messages[existingIdx].executingOutput = "Checking if it's safe...";
						} else {
							this._sessionManager.pushMessage({
								role: 'executing',
								content: '',
								executingAction: actionDesc,
								executingOutput: "Checking if it's safe...",
							});
						}
					} else {
						// Safety check done - don't remove the card, let onOutput update it
						// or let the final cleanup remove it
					}
					this._updateMessages();
				};

				console.log('[Flixa] execute actions start');
				let results: ActionExecutionResult[];
				const actionAbortController = new AbortController();
				this._currentAbortController = actionAbortController;

				this._captureOriginalContents(agentResponse.actions);

				try {
					results = await executeAgentActions({
						actions: agentResponse.actions,
						approvalMode: this._approvalMode,
						storePendingDiff: this._storePendingDiff,
						onOutput,
						onSafetyCheck,
						abortSignal: actionAbortController.signal,
					});
				} catch (error) {
					const message =
						error instanceof Error ? error.message : String(error);
					results = agentResponse.actions.map((action) => ({
						action,
						success: false,
						error: message,
					}));
				} finally {
					if (this._currentAbortController === actionAbortController) {
						this._currentAbortController = undefined;
					}
				}
				console.log('[Flixa] execute actions done', results.length);

				this._updateTrackedStatuses(results);

				this._sessionManager.filterMessages((m) => m.role !== 'executing');

				const serializedResults: SerializedActionResult[] = results.map(
					(r) => ({
						action: describeAction(r.action),
						success: r.success,
						rejected: r.rejected,
						rejectionReason: r.rejectionReason,
						output: r.output,
						error: r.error,
					})
				);

				if (agentResponse.toolCalls && agentResponse.toolCalls.length > 0) {
					this._sessionManager.pushMessage({
						role: 'assistant',
						content: agentResponse.message,
						tool_calls: agentResponse.toolCalls,
					});

					const toolResults: SerializedToolResult[] = agentResponse.toolCalls.map((toolCall, index) => {
						const result = results[index];
						return {
							tool_call_id: toolCall.id,
							toolName: toolCall.function.name,
							content: result
								? this._formatToolResult(result)
								: `[FAILED] ${toolCall.function.name}: Missing tool execution result`,
						};
					});

					this._sessionManager.pushMessage({
						role: 'tool',
						content: '',
						results: serializedResults,
						toolResults,
					});
				} else {
					this._sessionManager.pushMessage({
						role: 'result',
						content: '',
						results: serializedResults,
					});
				}
				this._updateMessages();
			}
		} finally {
			this._sendChangedFiles();
			this._setAgentRunning(false);
		}
	}

	private async _handleChatMessage(
		context: ChatContext,
		usageCategory: UsageCategory
	): Promise<void> {
		const chatAbortController = new AbortController();
		this._currentAbortController = chatAbortController;
		const response = await callLLMForChat(
			context,
			(text) => {
				this._sendStreamingUpdate(text);
			},
			chatAbortController.signal
		);
		if (this._currentAbortController === chatAbortController) {
			this._currentAbortController = undefined;
		}
		this._sendStreamingUpdate('');
		if (this._stopRequested) {
			return;
		}

		if (response.quotaExceeded) {
			this._sessionManager.pushMessage({
				role: 'assistant',
				content: response.message,
			});
			this._updateMessages();
			await this._handleQuotaExceeded(response.quotaExceeded);
			return;
		}

		if (response.type === 'diff' && response.diff) {
			const activeFilePath = context.activeFilePath;

			const validationResult = validateDiff(
				response.diff,
				'chat',
				activeFilePath
			);

			if (!validationResult.valid) {
				this._sessionManager.pushMessage({
					role: 'assistant',
					content: `Error: ${validationResult.error}`,
				});
				this._updateMessages();
				vscode.window.showErrorMessage(`Flixa: ${validationResult.error}`);
				return;
			}

			const newContent = applyDiffToContent(
				context.activeFileText,
				response.diff
			);
			if (!newContent) {
				this._sessionManager.pushMessage({
					role: 'assistant',
					content: 'Error: Failed to apply diff to file content.',
				});
				this._updateMessages();
				vscode.window.showErrorMessage(
					'Flixa: Failed to apply diff to file content.'
				);
				return;
			}

			this._sessionManager.pushMessage({
				role: 'assistant',
				content:
					response.message + '\n\n[Diff generated - check diff preview]',
			});
			this._updateMessages();

			if (activeFilePath) {
				await showDiffPreview(
					vscode.Uri.file(this._resolveFilePath(activeFilePath)),
					context.activeFileText,
					newContent,
					'chat',
					this._storePendingDiff
				);
			}
		} else {
			this._sessionManager.pushMessage({
				role: 'assistant',
				content: response.message,
			});
			this._updateMessages();
		}

		if (this._usageService) {
			this._usageService.refreshAfterSend(usageCategory);
		}
	}

	private _updateMessages(): void {
		this._sessionManager.save();
		if (!this._view) {
			return;
		}
		try {
			this._view.webview.postMessage({
				type: 'updateMessages',
				messages: this._sessionManager.getMessages(),
			});
		} catch { }
	}

	private _updateSessions(): void {
		if (!this._view) {
			return;
		}
		try {
			this._view.webview.postMessage({
				type: 'updateSessions',
				sessions: this._sessionManager.sessions.map((s) => ({
					id: s.id,
					name: s.name,
				})),
				currentSessionId: this._sessionManager.currentSessionId,
			});
		} catch { }
	}

	private async _updateState(): Promise<void> {
		if (!this._view) {
			return;
		}
		try {
			const isLoggedIn = this._usageService ? await this._usageService.isLoggedIn() : false;
			const availableModels = await getAvailableModels();
			const modelDefinitions = getModelDefinitions();
			this._view.webview.postMessage({
				type: 'updateState',
				agentMode: this._agentMode,
				approvalMode: this._approvalMode,
				selectedModel: getModel(),
				selectedReasoningEffort: getReasoningEffort() ?? null,
				autoContextEnabled: getAutoContextConfig().enabled,
				availableModels,
				modelDefinitions,
				isLoggedIn,
				workspaceFiles: this._workspaceFiles,
			});
		} catch { }
	}

	private async _refreshWorkspaceFiles(): Promise<void> {
		try {
			const workspaceFiles = await vscode.workspace.findFiles(
				'**/*',
				'**/{node_modules,.git,out,dist,build}/**',
				2000
			);
			const workspaceFolders = vscode.workspace.workspaceFolders;
			const workspaceRoot = workspaceFolders?.[0]?.uri.fsPath;
			this._workspaceFiles = workspaceFiles
				.map((file) =>
					workspaceRoot
						? path.relative(workspaceRoot, file.fsPath).replace(/\\/g, '/')
						: file.fsPath.replace(/\\/g, '/')
				)
				.sort((a, b) => a.localeCompare(b));
			this._updateState();
		} catch {
			this._workspaceFiles = [];
		}
	}

	private async _sendEditorContext(): Promise<void> {
		if (!this._view) {
			return;
		}
		try {
			const editor = vscode.window.activeTextEditor;
			const activeFilePath = editor ? this._toRelativePath(editor.document.uri.fsPath) : '';
			const activeSelection =
				editor && !editor.selection.isEmpty
					? editor.document.getText(editor.selection)
					: '';
			const activeSelectionLabel = editor ? this._getSelectionLabel(editor) : '';
			this._activeFilePath = activeFilePath;
			this._activeSelection = activeSelection;
			this._view.webview.postMessage({
				type: 'updateEditorContext',
				activeFilePath,
				activeSelection,
				activeSelectionLabel,
			});
		} catch { }
	}

	private _toRelativePath(filePath: string): string {
		const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		if (!workspaceRoot) {
			return filePath.replace(/\\/g, '/');
		}
		return path.relative(workspaceRoot, filePath).replace(/\\/g, '/');
	}

	private _getSelectionLabel(editor: vscode.TextEditor): string {
		const relativePath = this._toRelativePath(editor.document.uri.fsPath);
		if (editor.selection.isEmpty) {
			return relativePath;
		}

		const startLine = editor.selection.start.line + 1;
		const endLine = editor.selection.end.line + 1;
		return startLine === endLine
			? `${relativePath}:${startLine}`
			: `${relativePath}:${startLine}-${endLine}`;
	}

	public async updateUsage(data: import('../usage/types').UsageResponse | null): Promise<void> {
		if (!this._view) {
			return;
		}
		try {
			const isLoggedIn = this._usageService ? await this._usageService.isLoggedIn() : false;
			this._view.webview.postMessage({
				type: 'updateUsage',
				usage: data,
				isLoggedIn,
			});
		} catch { }
	}

	private async _handleQuotaExceeded(
		error: import('../usage/types').QuotaExceededErrorMeta
	): Promise<void> {
		await showQuotaExceededDialog(error, async () => {
			await this._usageService?.fetchUsage(true);
		});
	}
}
