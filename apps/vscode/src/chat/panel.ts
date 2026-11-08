import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import type { AgentEvent, FinishedToolCall, ToolApprovalRequest } from '@deniai/flixa-core';
import { requestIndividualApproval } from '../agent/approval';
import { getAgentResponsesClient, runExtensionAgentTurn } from '../agent/loop';
import { checkShellCommandSafety } from '../agent/safetyChecker';
import { showDiffPreview } from '../diff/preview';
import { applyDiffToContent, validateDiff } from '../diff/validator';
import { callLLMForChat, generateSessionTitle, resolveLlmApiError } from '../llm/stub';
import { buildResponsesInputWindow, compactInputWindow, estimateTokenCount } from '../llm/compact';
import { buildAgentMessages } from '../llm/messages';
import {
  getAvailableModels,
  getModel,
  getModelDefinitions,
  getReasoningEffort,
  setModel,
  setReasoningEffort,
} from '../llm/provider';
import type {
  ApprovalMode,
  ChatCompletionToolCall,
  ChatContext,
  PendingDiff,
  SerializedActionResult,
  SerializedToolResult,
} from '../types';
import { describeToolCall } from '../utils/format';
import { getWorkspaceRoot } from '../utils/workspace';
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

const FILE_CHANGING_TOOLS = new Set(['Write', 'Edit', 'Delete']);
const MAX_AGENT_RETRIES = 3;

export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'flixa.chatView';

  private _view?: vscode.WebviewView;
  private _extensionUri: vscode.Uri;
  private _sessionManager: SessionManager;
  private _storePendingDiff: (diff: PendingDiff) => void;
  private _agentMode: boolean = true;
  private _approvalMode: ApprovalMode = vscode.workspace
    .getConfiguration('flixa')
    .get<ApprovalMode>('agentApprovalMode', 'SAFE_APPROVE');
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
  private _pendingApprovals: Map<
    string,
    { action: string; detail: string; resolve: (decision: 'approve' | 'reject') => void }
  > = new Map();

  constructor(
    extensionUri: vscode.Uri,
    context: vscode.ExtensionContext,
    storePendingDiff: (diff: PendingDiff) => void,
    usageService?: UsageService,
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
          this._approvalMode = vscode.workspace
            .getConfiguration('flixa')
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
        description:
          session.id === this._sessionManager.currentSessionId ? 'Current chat' : undefined,
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
    _token: vscode.CancellationToken,
  ): void {
    this._view = webviewView;
    webviewView.onDidDispose(() => {
      this._view = undefined;
    });

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri],
    };

    webviewView.webview.html = getWebviewHtml(webviewView.webview, this._extensionUri);

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
        this._sendApprovals();
      } else if (data.type === 'sendMessage') {
        if (data.queued === true) {
          while (this._pendingRequest) {
            await this._pendingRequest;
          }
        }
        await this._handleUserMessage(
          data.message,
          typeof data.excludedActiveFilePath === 'string' ? data.excludedActiveFilePath : undefined,
        );
      } else if (data.type === 'approvalResponse') {
        const pending = this._pendingApprovals.get(data.id);
        if (pending) {
          this._pendingApprovals.delete(data.id);
          pending.resolve(data.decision === 'approve' ? 'approve' : 'reject');
          this._sendApprovals();
        }
      } else if (data.type === 'copyToClipboard') {
        if (typeof data.text === 'string') {
          await vscode.env.clipboard.writeText(data.text);
        }
      } else if (data.type === 'editMessage') {
        await this._editUserMessage(data.index, data.message);
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
          .update('autoContext.enabled', data.enabled === true, vscode.ConfigurationTarget.Global);
        await this._updateState();
      } else if (data.type === 'openSettings') {
        await vscode.commands.executeCommand('workbench.action.openSettings', '@ext:deniai.flixa');
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
            this._usageService.getCachedUsage()?.upgradeUrl ?? this._usageService.getBillingUrl();
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
          } catch {}
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
    } catch {}
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
    } catch {}
  }

  private _sendApprovals(): void {
    if (!this._view) {
      return;
    }
    try {
      this._view.webview.postMessage({
        type: 'updateApprovals',
        approvals: Array.from(this._pendingApprovals.entries()).map(([id, approval]) => ({
          id,
          action: approval.action,
          detail: approval.detail,
        })),
      });
    } catch {}
  }

  private _requestApprovalInChat(
    description: string,
    detail: string,
    abortSignal: AbortSignal,
  ): Promise<'approve' | 'reject'> {
    if (!this._view) {
      return requestIndividualApproval(description);
    }
    if (abortSignal.aborted) {
      return Promise.resolve('reject');
    }
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    return new Promise((resolve) => {
      const onAbort = () => {
        if (this._pendingApprovals.delete(id)) {
          this._sendApprovals();
        }
        resolve('reject');
      };
      abortSignal.addEventListener('abort', onAbort, { once: true });
      this._pendingApprovals.set(id, {
        action: description,
        detail,
        resolve: (decision) => {
          abortSignal.removeEventListener('abort', onAbort);
          resolve(decision);
        },
      });
      this._sendApprovals();
    });
  }

  private async _editUserMessage(index: unknown, message: unknown): Promise<void> {
    if (typeof index !== 'number' || typeof message !== 'string' || !message.trim()) {
      return;
    }
    if (this._pendingRequest) {
      return;
    }
    const messages = this._sessionManager.getMessages();
    if (!messages[index] || messages[index].role !== 'user') {
      return;
    }
    this._sessionManager.setMessages(messages.slice(0, index));
    if (
      this._sessionManager.getSessionMessages().length <
      this._sessionManager.getCompactedSessionMessageCount()
    ) {
      this._sessionManager.clearCompactedInput();
    }
    this._updateMessages();
    await this._handleUserMessage(message);
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
    const usageCategory: UsageCategory = isPremiumModel(currentModel) ? 'premium' : 'basic';

    const editor = vscode.window.activeTextEditor;
    const activeFilePath = editor ? this._toRelativePath(editor.document.uri.fsPath) : '';
    const normalizedExcludedPath = excludedActiveFilePath?.replace(/\\/g, '/').toLowerCase();
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
        this._sessionManager.updateSessionName(sessionId, title);
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

  private async _handleSlashCommand(name: string, args: string[], raw: string): Promise<void> {
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
        this._pushSystemReply(`Unknown command: /${name}\n\n${formatSlashHelp()}`);
    }
  }

  private async _handleModelCommand(raw: string, args: string[]): Promise<void> {
    this._pushSlashEcho(raw);
    const models = await getAvailableModels();
    if (args.length === 0) {
      const list = models.map((model) => `  - ${model}`).join('\n');
      this._pushSystemReply(
        `Current model: ${getModel()}\n\nAvailable models:\n${list}\n\nUsage: /model <model-id>`,
      );
      return;
    }

    const requested = args.join(' ').trim();
    const match =
      models.find((model) => model === requested) ??
      models.find((model) => model.toLowerCase() === requested.toLowerCase());
    if (!match) {
      this._pushSystemReply(
        `Unknown model: ${requested}\n\nAvailable models:\n${models.map((model) => `  - ${model}`).join('\n')}`,
      );
      return;
    }

    await setModel(match);
    await this._updateState();
    this._pushSystemReply(`Model set to ${match}.`);
  }

  private async _handleApprovalCommand(raw: string, args: string[]): Promise<void> {
    this._pushSlashEcho(raw);
    if (args.length === 0) {
      this._pushSystemReply(
        `Current approval mode: ${formatApprovalModeLabel(this._approvalMode)}\n\nOptions: auto, safe, manual, all\nUsage: /approval <mode>`,
      );
      return;
    }

    const mode = parseApprovalModeArg(args[0] ?? '');
    if (!mode) {
      this._pushSystemReply(
        `Unknown approval mode: ${args[0]}\n\nOptions: auto, safe, manual, all`,
      );
      return;
    }

    this._approvalMode = mode;
    await this._updateState();
    this._pushSystemReply(`Approval mode set to ${formatApprovalModeLabel(mode)}.`);
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
        () => this._sessionManager.getSessionMessages(),
      );
      const input = this._buildAgentInput(context);
      if (input.length < 2) {
        this._pushSystemReply('Nothing to compact.');
        return;
      }

      const beforeTokens = estimateTokenCount(input);
      const result = await compactInputWindow({
        input,
        model: getModel(),
        client: getAgentResponsesClient(),
      });

      this._sessionManager.setCompactedInput(result.input, sessionMessages.length);
      const afterTokens = estimateTokenCount(result.input);
      this._pushSystemReply(
        `Context compacted (~${beforeTokens.toLocaleString()} → ~${afterTokens.toLocaleString()} tokens).`,
      );

      if (this._usageService) {
        const usageCategory: UsageCategory = isPremiumModel(getModel()) ? 'premium' : 'basic';
        this._usageService.refreshAfterSend(usageCategory);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this._pushSystemReply(`Compact failed: ${message}`);
    } finally {
      this._setLoading(false);
    }
  }

  /** Responses input for agent mode: the compacted base (if any) plus later session messages. */
  private _buildAgentInput(context: ChatContext): unknown[] {
    const compactedInput = this._sessionManager.getCompactedInput();
    const compactedSessionMessageCount = this._sessionManager.getCompactedSessionMessageCount();
    const messages = compactedInput
      ? buildAgentMessages({
          ...context,
          sessionMessages: context.sessionMessages.slice(Math.max(0, compactedSessionMessageCount)),
        })
      : buildAgentMessages(context);
    return buildResponsesInputWindow({ compactedBase: compactedInput, messages });
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
    } catch {}
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

  private _captureOriginalContent(filePath: string): void {
    const absolutePath = this._resolveFilePath(filePath);
    const relativePath = this._getRelativePath(absolutePath);
    if (this._changedFiles.has(relativePath)) {
      return;
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

  private _markDeleted(filePath: string): void {
    const relativePath = this._getRelativePath(this._resolveFilePath(filePath));
    const tracked = this._changedFiles.get(relativePath);
    if (tracked) {
      tracked.status = 'deleted';
    }
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
          } catch {
            break;
          }
        }
      } else {
        await vscode.workspace.fs.writeFile(
          vscode.Uri.file(absolutePath),
          Buffer.from(tracked.originalContent, 'utf-8'),
        );
      }
      this._changedFiles.delete(relativePath);
      this._sendChangedFiles();
    } catch {}
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
    } catch {}
  }

  private _setExecutingOutput(actionDesc: string, output: string): void {
    const messages = this._sessionManager.getMessages();
    const existing = messages.find(
      (message) => message.role === 'executing' && message.executingAction === actionDesc,
    );
    if (existing) {
      existing.executingOutput = output;
    } else {
      this._sessionManager.pushMessage({
        role: 'executing',
        content: '',
        executingAction: actionDesc,
        executingOutput: output,
      });
    }
    this._updateMessages();
  }

  private _serializeToolResult(finished: FinishedToolCall): SerializedActionResult {
    const action = describeToolCall(finished.call.name, finished.call.input);
    if (finished.denied) {
      return {
        action,
        success: false,
        rejected: true,
        rejectionReason: finished.denialReason ?? 'Rejected',
      };
    }
    const output = finished.result.displayOutput ?? finished.result.output;
    if (finished.result.ok) {
      return { action, success: true, output };
    }
    let error = finished.result.summary;
    try {
      const parsed = JSON.parse(finished.result.output) as { error?: unknown; exit_code?: unknown };
      if (typeof parsed.error === 'string') {
        error = parsed.error;
      } else if (typeof parsed.exit_code === 'number') {
        error = `Exit code: ${parsed.exit_code}`;
      }
    } catch {}
    return { action, success: false, output, error };
  }

  private async _handleAgentLoop(
    context: ChatContext,
    usageCategory: UsageCategory,
  ): Promise<void> {
    let retryCount = 0;
    this._setAgentRunning(true);

    try {
      while (true) {
        if (this._stopRequested) {
          this._sessionManager.pushMessage({ role: 'system', content: 'Stopped by user' });
          this._updateMessages();
          break;
        }

        const workspaceRoot = getWorkspaceRoot();
        if (!workspaceRoot) {
          this._sessionManager.pushMessage({
            role: 'assistant',
            content: 'Open a folder to use agent mode.',
          });
          this._updateMessages();
          break;
        }

        context.sessionMessages = this._sessionManager.getSessionMessages();
        const controller = new AbortController();
        this._currentAbortController = controller;
        let streamingText = '';
        let stepResults: FinishedToolCall[] = [];
        let pendingToolCalls: ChatCompletionToolCall[] = [];
        this._setLoading(true);

        const onEvent = (event: AgentEvent): void => {
          switch (event.type) {
            case 'step_started':
              streamingText = '';
              stepResults = [];
              this._setLoading(true);
              return;
            case 'text_delta':
              streamingText += event.delta;
              this._sendStreamingUpdate(streamingText);
              return;
            case 'assistant_message':
              this._setLoading(false);
              this._sendStreamingUpdate('');
              pendingToolCalls = event.toolCalls.map((call) => ({
                id: call.callId,
                type: 'function',
                function: { name: call.name, arguments: call.argumentsText },
              }));
              if (pendingToolCalls.length > 0) {
                this._sessionManager.pushMessage({
                  role: 'assistant',
                  content: event.text,
                  tool_calls: pendingToolCalls,
                });
                this._updateMessages();
              }
              return;
            case 'tool_call_started': {
              const target = event.call.input.file_path;
              if (FILE_CHANGING_TOOLS.has(event.call.name) && typeof target === 'string') {
                this._captureOriginalContent(target);
              }
              return;
            }
            case 'safety_review_started':
              this._setExecutingOutput(
                describeToolCall(event.call.name, event.call.input),
                "Checking if it's safe...",
              );
              return;
            case 'tool_execution_started':
              this._setExecutingOutput(describeToolCall(event.call.name, event.call.input), '');
              return;
            case 'tool_output':
              this._setExecutingOutput(
                describeToolCall(event.call.name, event.call.input),
                event.output,
              );
              return;
            case 'tool_call_finished': {
              stepResults.push(event);
              const target = event.call.input.file_path;
              if (!event.denied && event.call.name === 'Delete' && typeof target === 'string') {
                this._markDeleted(target);
              }
              return;
            }
            case 'step_finished': {
              this._sessionManager.filterMessages((message) => message.role !== 'executing');
              const toolResults: SerializedToolResult[] = stepResults.map((finished) => ({
                tool_call_id: finished.call.callId,
                toolName: finished.call.name,
                content: finished.result.output,
              }));
              this._sessionManager.pushMessage({
                role: 'tool',
                content: '',
                results: stepResults.map((finished) => this._serializeToolResult(finished)),
                toolResults,
              });
              this._updateMessages();
              this._sendChangedFiles();
              return;
            }
            case 'compacted':
              this._sessionManager.setCompactedInput(
                event.items,
                this._sessionManager.getSessionMessages().length,
              );
              return;
            default:
              return;
          }
        };

        let result: Awaited<ReturnType<typeof runExtensionAgentTurn>>;
        try {
          result = await runExtensionAgentTurn({
            input: this._buildAgentInput(context),
            workspaceRoot,
            approvalMode: this._approvalMode,
            signal: controller.signal,
            onEvent,
            requestApproval: async (request: ToolApprovalRequest) =>
              (await this._requestApprovalInChat(
                describeToolCall(request.call.name, request.call.input),
                request.call.name === 'Bash' && typeof request.call.input.command === 'string'
                  ? request.call.input.command
                  : '',
                controller.signal,
              )) === 'approve',
            reviewToolCall: async (request) => {
              const command =
                typeof request.call.input.command === 'string' ? request.call.input.command : '';
              const review = await checkShellCommandSafety(command, request.modelReason);
              return { safe: review.verdict === 'SAFE', reason: review.reason };
            },
          });
        } catch (error) {
          this._sessionManager.filterMessages((message) => message.role !== 'executing');
          if (this._stopRequested || controller.signal.aborted) {
            this._sessionManager.pushMessage({ role: 'system', content: 'Stopped by user' });
            this._updateMessages();
            break;
          }
          console.error('[Flixa] agent loop error:', error);
          const resolved = resolveLlmApiError(error, '/v1/agent/responses', '[API Error] ');
          this._sessionManager.pushMessage({ role: 'assistant', content: resolved.message });
          this._updateMessages();
          if (resolved.quotaExceeded) {
            await this._handleQuotaExceeded(resolved.quotaExceeded);
            break;
          }
          if (resolved.message.startsWith('[API Error]') && retryCount < MAX_AGENT_RETRIES) {
            retryCount += 1;
            continue;
          }
          break;
        } finally {
          if (this._currentAbortController === controller) {
            this._currentAbortController = undefined;
          }
          this._setLoading(false);
          this._sendStreamingUpdate('');
        }

        if (result.stopReason === 'cancelled' || this._stopRequested) {
          this._sessionManager.filterMessages((message) => message.role !== 'executing');
          this._sessionManager.pushMessage({ role: 'system', content: 'Stopped by user' });
          this._updateMessages();
          break;
        }

        this._sessionManager.pushMessage({
          role: 'assistant',
          content: result.finalText.trim() || 'Empty response',
        });
        this._updateMessages();
        if (this._usageService) {
          this._usageService.refreshAfterSend(usageCategory);
        }
        break;
      }
    } finally {
      this._sendChangedFiles();
      this._setAgentRunning(false);
    }
  }

  private async _handleChatMessage(
    context: ChatContext,
    usageCategory: UsageCategory,
  ): Promise<void> {
    const chatAbortController = new AbortController();
    this._currentAbortController = chatAbortController;
    const response = await callLLMForChat(
      context,
      (text) => {
        this._sendStreamingUpdate(text);
      },
      chatAbortController.signal,
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

      const validationResult = validateDiff(response.diff, 'chat', activeFilePath);

      if (!validationResult.valid) {
        this._sessionManager.pushMessage({
          role: 'assistant',
          content: `Error: ${validationResult.error}`,
        });
        this._updateMessages();
        vscode.window.showErrorMessage(`Flixa: ${validationResult.error}`);
        return;
      }

      const newContent = applyDiffToContent(context.activeFileText, response.diff);
      if (!newContent) {
        this._sessionManager.pushMessage({
          role: 'assistant',
          content: 'Error: Failed to apply diff to file content.',
        });
        this._updateMessages();
        vscode.window.showErrorMessage('Flixa: Failed to apply diff to file content.');
        return;
      }

      this._sessionManager.pushMessage({
        role: 'assistant',
        content: response.message + '\n\n[Diff generated - check diff preview]',
      });
      this._updateMessages();

      if (activeFilePath) {
        await showDiffPreview(
          vscode.Uri.file(this._resolveFilePath(activeFilePath)),
          context.activeFileText,
          newContent,
          'chat',
          this._storePendingDiff,
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
    } catch {}
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
    } catch {}
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
    } catch {}
  }

  private async _refreshWorkspaceFiles(): Promise<void> {
    try {
      const workspaceFiles = await vscode.workspace.findFiles(
        '**/*',
        '**/{node_modules,.git,out,dist,build}/**',
        2000,
      );
      const workspaceFolders = vscode.workspace.workspaceFolders;
      const workspaceRoot = workspaceFolders?.[0]?.uri.fsPath;
      this._workspaceFiles = workspaceFiles
        .map((file) =>
          workspaceRoot
            ? path.relative(workspaceRoot, file.fsPath).replace(/\\/g, '/')
            : file.fsPath.replace(/\\/g, '/'),
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
        editor && !editor.selection.isEmpty ? editor.document.getText(editor.selection) : '';
      const activeSelectionLabel = editor ? this._getSelectionLabel(editor) : '';
      this._activeFilePath = activeFilePath;
      this._activeSelection = activeSelection;
      this._view.webview.postMessage({
        type: 'updateEditorContext',
        activeFilePath,
        activeSelection,
        activeSelectionLabel,
      });
    } catch {}
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
    } catch {}
  }

  private async _handleQuotaExceeded(
    error: import('../usage/types').QuotaExceededErrorMeta,
  ): Promise<void> {
    await showQuotaExceededDialog(error, async () => {
      await this._usageService?.fetchUsage(true);
    });
  }
}
