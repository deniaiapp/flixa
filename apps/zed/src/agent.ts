import * as acp from '@agentclientprotocol/sdk/unstable';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import {
  describeDeviceAuthKeyProblem,
  initiateDeviceAuth,
  waitForDeviceAuth,
} from '@deniai/flixa-api-client';
import {
  compactConversation,
  CORE_TOOLS,
  createResponsesSummarizer,
  estimateTokens,
  formatApprovalMode,
  migrateLegacyResponseItems,
  parseApprovalMode,
  reviewCommandSafety,
  runAgentLoop,
  type AgentEvent,
  type AgentToolCall,
  type ResponseUsage,
  type ToolApprovalRequest,
  type ToolCategory,
  type ToolResult,
} from '@deniai/flixa-core';
import { createNodeToolHost } from '@deniai/flixa-core/node';
import {
  FlixaApiError,
  getClientHeaders,
  getResponsesClient,
  listModels,
  type ModelDefinition,
} from './api.js';
import {
  DEFAULT_MODEL,
  DEFAULT_REASONING_EFFORT,
  FLIXA_VERSION,
  getApiKey,
  getConfig,
  openUrl,
  setApiKey,
  type ApprovalMode,
  type ReasoningEffort,
} from './config.js';
import { getWorkspaceContext } from './workspaceContext.js';
import { SessionStore, type PersistedSession } from './sessionStore.js';
import {
  getAvailableReasoningEfforts,
  getReasoningEffortLabel,
  isReasoningEffort,
  type ModelReasoningEfforts,
} from './reasoning.js';
import { AGENT_SYSTEM_PROMPT, CHAT_SYSTEM_PROMPT, SLASH_HELP } from './prompts.js';

interface SessionState {
  cwd: string;
  additionalDirectories: string[];
  input: unknown[];
  model: string;
  reasoningEffort?: ReasoningEffort;
  approvalMode: ApprovalMode;
  modeId: 'agent' | 'chat';
  pendingPrompt?: AbortController;
  promptCount: number;
  history: acp.SessionNotification[];
}

export class FlixaAgent {
  private readonly sessions = new Map<string, SessionState>();
  private readonly modelCache = new Map<string, ModelDefinition[]>();
  private readonly sessionStore: SessionStore;

  constructor(sessionStore: SessionStore = new SessionStore()) {
    this.sessionStore = sessionStore;
  }

  async initialize(_params: acp.InitializeRequest): Promise<acp.InitializeResponse> {
    return {
      protocolVersion: acp.PROTOCOL_VERSION,
      agentInfo: {
        name: 'flixa',
        title: 'Flixa',
        version: FLIXA_VERSION,
      },
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: {
          embeddedContext: true,
        },
        sessionCapabilities: {
          list: {},
          additionalDirectories: {},
          resume: {},
        },
        auth: {
          logout: {},
        },
      },
      authMethods: [
        {
          id: 'flixa-login',
          name: 'Sign in to Flixa',
          description: 'Open Deni AI in a browser and authorize this Zed agent.',
        },
      ],
    };
  }

  async newSession(params: acp.NewSessionRequest): Promise<acp.NewSessionResponse> {
    if (!(await getApiKey())) {
      throw acp.RequestError.authRequired(
        { methodId: 'flixa-login' },
        'Sign in to Flixa before creating a session.',
      );
    }

    const config = getConfig();
    const sessionId = randomUUID();
    const session: SessionState = {
      cwd: params.cwd,
      additionalDirectories: params.additionalDirectories || [],
      input: [],
      model: config.model || DEFAULT_MODEL,
      reasoningEffort: config.reasoningEffort || DEFAULT_REASONING_EFFORT,
      approvalMode: config.approvalMode,
      modeId: 'agent',
      promptCount: 0,
      history: [],
    };
    this.sessions.set(sessionId, session);
    await this.persistSession(sessionId, session);

    return {
      sessionId,
      modes: getModes(session.modeId),
      configOptions: await this.getConfigOptions(session),
    };
  }

  async loadSession(
    params: acp.LoadSessionRequest,
    client: acp.AgentContext,
  ): Promise<acp.LoadSessionResponse> {
    const session = await this.restoreSession(
      params.sessionId,
      params.cwd,
      params.additionalDirectories,
    );
    for (const notification of session.history) {
      await client.notify(acp.methods.client.session.update, notification);
    }
    return {
      modes: getModes(session.modeId),
      configOptions: await this.getConfigOptions(session),
    };
  }

  async resumeSession(params: acp.ResumeSessionRequest): Promise<acp.ResumeSessionResponse> {
    const session = await this.restoreSession(
      params.sessionId,
      params.cwd,
      params.additionalDirectories,
    );
    return {
      modes: getModes(session.modeId),
      configOptions: await this.getConfigOptions(session),
    };
  }

  async listSessions(params: acp.ListSessionsRequest): Promise<acp.ListSessionsResponse> {
    const persisted = await this.sessionStore.list();
    const sessions = persisted
      .filter(({ session }) => !params.cwd || samePath(session.cwd, params.cwd))
      .sort((left, right) => right.session.updatedAt.localeCompare(left.session.updatedAt))
      .map(({ sessionId, session }) => ({
        sessionId,
        cwd: session.cwd,
        additionalDirectories: session.additionalDirectories,
        title: 'Flixa',
        updatedAt: session.updatedAt,
      }));
    return { sessions };
  }

  async authenticate(params: acp.AuthenticateRequest): Promise<acp.AuthenticateResponse> {
    if (params.methodId !== 'flixa-login') {
      throw acp.RequestError.invalidParams(
        undefined,
        `Unsupported authentication method: ${params.methodId}`,
      );
    }

    const existingKey = await getApiKey();
    if (existingKey) {
      return {};
    }

    const session = await initiateDeviceAuth({ headers: getClientHeaders() });
    console.error(
      `[Flixa] Open ${session.verificationUrl} to complete login. Code: ${session.userCode}`,
    );
    openUrl(session.verificationUrl);

    const outcome = await waitForDeviceAuth(session, {
      headers: getClientHeaders(),
      timeoutMs: Math.max(session.expiresIn, 60) * 1000,
      maxConsecutiveFailures: Number.POSITIVE_INFINITY,
      onPollError: (error) =>
        console.error(
          '[Flixa] Device auth poll failed',
          error instanceof Error ? error.message : String(error),
        ),
    });

    switch (outcome.status) {
      case 'approved':
        await setApiKey(outcome.apiKey);
        console.error('[Flixa] Login completed');
        return {};
      case 'api_key_unavailable':
      case 'api_key_limit_reached':
        throw acp.RequestError.internalError(undefined, describeDeviceAuthKeyProblem(outcome));
      case 'expired':
        throw acp.RequestError.internalError(undefined, 'Flixa login expired. Please try again.');
      case 'invalid_code':
      case 'error':
        throw acp.RequestError.internalError(undefined, 'Flixa login failed. Please try again.');
      case 'timed_out':
      case 'cancelled':
        throw acp.RequestError.internalError(undefined, 'Flixa login timed out. Please try again.');
    }
  }

  async logout(_params: acp.LogoutRequest): Promise<acp.LogoutResponse> {
    await setApiKey(undefined);
    return {};
  }

  async setSessionMode(params: acp.SetSessionModeRequest): Promise<acp.SetSessionModeResponse> {
    const session = this.requireSession(params.sessionId);
    if (params.modeId !== 'agent' && params.modeId !== 'chat') {
      throw acp.RequestError.invalidParams(undefined, `Unsupported mode: ${params.modeId}`);
    }
    session.modeId = params.modeId;
    await this.persistSession(params.sessionId, session);
    return {};
  }

  async setSessionConfigOption(
    params: acp.SetSessionConfigOptionRequest,
  ): Promise<acp.SetSessionConfigOptionResponse> {
    const session = this.requireSession(params.sessionId);
    const value = 'value' in params && typeof params.value === 'string' ? params.value : '';

    switch (params.configId) {
      case 'model':
        session.model = value;
        this.syncReasoningEffort(session, this.getModelDefinition(value)?.reasoningEfforts);
        break;
      case 'reasoning_effort':
        if (
          !isReasoningEffort(value) ||
          !getAvailableReasoningEfforts(
            session.model,
            this.getModelDefinition(session.model)?.reasoningEfforts,
          ).includes(value)
        ) {
          throw acp.RequestError.invalidParams(undefined, `Unsupported reasoning effort: ${value}`);
        }
        session.reasoningEffort = value;
        break;
      case 'approval_mode': {
        const mode = parseApprovalMode(value);
        if (!mode) {
          throw acp.RequestError.invalidParams(undefined, `Unsupported approval mode: ${value}`);
        }
        session.approvalMode = mode;
        break;
      }
      default:
        throw acp.RequestError.invalidParams(
          undefined,
          `Unsupported configuration option: ${params.configId}`,
        );
    }

    await this.persistSession(params.sessionId, session);
    return { configOptions: await this.getConfigOptions(session) };
  }

  async prompt(params: acp.PromptRequest, client: acp.AgentContext): Promise<acp.PromptResponse> {
    const session = this.requireSession(params.sessionId);
    session.pendingPrompt?.abort();
    const controller = new AbortController();
    session.pendingPrompt = controller;

    try {
      const slashResult = await this.handleSlashCommand(session, params, client, controller.signal);
      if (slashResult) {
        return { stopReason: 'end_turn' };
      }

      const promptText = await promptBlocksToText(params.prompt, session);
      if (!promptText.trim()) {
        await this.sendMessage(params.sessionId, client, 'Please provide a text prompt.', 'agent');
        return { stopReason: 'end_turn' };
      }

      session.promptCount += 1;
      session.input.push({
        role: 'user',
        content: await this.buildUserPrompt(promptText, session),
      });
      const usage =
        session.modeId === 'chat'
          ? await this.runChatTurn(session, params.sessionId, client, controller.signal)
          : await this.runAgentTurn(session, params.sessionId, client, controller.signal);

      return {
        stopReason: 'end_turn',
        usage: usage ? mapUsage(usage) : undefined,
      };
    } catch (error) {
      if (controller.signal.aborted) {
        return { stopReason: 'cancelled' };
      }
      const message = formatApiError(error);
      await this.sendMessage(params.sessionId, client, message, 'agent');
      return { stopReason: 'end_turn' };
    } finally {
      if (session.pendingPrompt === controller) {
        session.pendingPrompt = undefined;
      }
      await this.persistSession(params.sessionId, session);
    }
  }

  async cancel(params: acp.CancelNotification): Promise<void> {
    this.sessions.get(params.sessionId)?.pendingPrompt?.abort();
  }

  private async runChatTurn(
    session: SessionState,
    sessionId: string,
    client: acp.AgentContext,
    signal: AbortSignal,
  ): Promise<ResponseUsage | undefined> {
    const result = await runAgentLoop({
      client: await getResponsesClient(),
      model: session.model,
      instructions: CHAT_SYSTEM_PROMPT,
      input: session.input,
      tools: [],
      host: this.createHost(session),
      approval: 'MANUAL_APPROVE',
      reasoningEffort: session.reasoningEffort,
      signal,
      maxSteps: 1,
      onEvent: async (event) => {
        if (event.type === 'assistant_message' && event.text) {
          await this.sendMessage(sessionId, client, event.text, 'agent');
        }
      },
    });
    session.input = result.items;
    return result.usage;
  }

  private async runAgentTurn(
    session: SessionState,
    sessionId: string,
    client: acp.AgentContext,
    signal: AbortSignal,
  ): Promise<ResponseUsage | undefined> {
    const config = getConfig();
    const responsesClient = await getResponsesClient();
    const result = await runAgentLoop({
      client: responsesClient,
      model: session.model,
      instructions: AGENT_SYSTEM_PROMPT,
      input: session.input,
      tools: CORE_TOOLS,
      host: this.createHost(session),
      approval: session.approvalMode,
      requestApproval: (request) => this.requestToolPermission(session, sessionId, client, request),
      reviewToolCall: (request) =>
        reviewCommandSafety({
          client: responsesClient,
          model: session.model,
          command: typeof request.call.input.command === 'string' ? request.call.input.command : '',
          reason: request.modelReason,
          reasoningEffort: getAvailableReasoningEfforts(
            session.model,
            this.getModelDefinition(session.model)?.reasoningEfforts,
          ).includes('low')
            ? 'low'
            : undefined,
          signal,
        }),
      reasoningEffort: session.reasoningEffort,
      signal,
      maxSteps: config.maxAgentIterations,
      compaction: { thresholdTokens: config.compactTokenThreshold },
      onEvent: (event) => this.handleAgentEvent(session, sessionId, client, event),
    });
    session.input = result.items;

    if (result.stopReason === 'max_steps') {
      await this.sendMessage(sessionId, client, 'Maximum agent iterations reached.', 'agent');
    }
    return result.usage;
  }

  private createHost(session: SessionState) {
    return createNodeToolHost({
      workspaceRoot: session.cwd,
      additionalRoots: session.additionalDirectories,
    });
  }

  private async handleAgentEvent(
    session: SessionState,
    sessionId: string,
    client: acp.AgentContext,
    event: AgentEvent,
  ): Promise<void> {
    switch (event.type) {
      case 'compacted':
        session.input = event.items;
        await this.sendMessage(sessionId, client, 'Context compacted.', 'agent');
        return;
      case 'assistant_message':
        if (event.text) {
          await this.sendMessage(sessionId, client, event.text, 'agent');
        }
        return;
      case 'tool_call_started':
        await this.sendSessionUpdate(sessionId, client, {
          sessionUpdate: 'tool_call',
          ...toAcpToolCall(event.call, session),
          status: 'pending',
        });
        return;
      case 'tool_execution_started':
        await this.updateToolCall(client, sessionId, event.call, 'in_progress');
        return;
      case 'tool_output':
        await this.updateToolCall(client, sessionId, event.call, 'in_progress', event.output);
        return;
      case 'tool_call_finished':
        if (event.denied) {
          await this.updateToolCall(
            client,
            sessionId,
            event.call,
            'failed',
            event.denialReason ?? event.result.summary,
          );
          return;
        }
        await this.updateToolCall(
          client,
          sessionId,
          event.call,
          event.result.ok ? 'completed' : 'failed',
          event.result.displayOutput || event.result.output,
          event.result,
        );
        return;
      default:
        return;
    }
  }

  private async requestToolPermission(
    session: SessionState,
    sessionId: string,
    client: acp.AgentContext,
    request: ToolApprovalRequest,
  ): Promise<boolean> {
    const response = await client.request<acp.RequestPermissionResponse>(
      acp.methods.client.session.requestPermission,
      {
        sessionId,
        toolCall: {
          ...toAcpToolCall(request.call, session),
          status: 'pending',
        },
        options: [
          { optionId: 'allow', name: 'Allow this action', kind: 'allow_once' },
          { optionId: 'reject', name: 'Reject this action', kind: 'reject_once' },
        ],
      },
    );
    return response.outcome.outcome === 'selected' && response.outcome.optionId === 'allow';
  }

  private async updateToolCall(
    client: acp.AgentContext,
    sessionId: string,
    toolCall: AgentToolCall,
    status: acp.ToolCallStatus,
    text?: string,
    result?: ToolResult,
  ): Promise<void> {
    const content: acp.ToolCallContent[] = [];
    const change = result?.fileChange;
    if (change) {
      content.push({
        type: 'diff',
        path: change.path.absolute,
        oldText: change.oldText,
        newText: change.newText,
      });
    } else if (text) {
      content.push({
        type: 'content',
        content: { type: 'text', text: trimText(text) },
      });
    }

    await this.sendSessionUpdate(sessionId, client, {
      sessionUpdate: 'tool_call_update',
      toolCallId: toolCall.callId,
      status,
      content: content.length > 0 ? content : undefined,
      rawOutput: text || undefined,
    });
  }

  private async handleSlashCommand(
    session: SessionState,
    params: acp.PromptRequest,
    client: acp.AgentContext,
    signal: AbortSignal,
  ): Promise<boolean> {
    const promptText = await promptBlocksToText(params.prompt, session);
    const parsed = parseSlashCommand(promptText);
    if (!parsed) {
      return false;
    }

    switch (parsed.name) {
      case 'help':
        await this.sendMessage(params.sessionId, client, SLASH_HELP, 'agent');
        return true;
      case 'clear':
      case 'new':
        session.input = [];
        await this.sendMessage(params.sessionId, client, 'Context cleared.', 'agent');
        return true;
      case 'stop':
        session.pendingPrompt?.abort();
        return true;
      case 'agent':
        session.modeId = 'agent';
        await this.sendMessage(params.sessionId, client, 'Switched to agent mode.', 'agent');
        return true;
      case 'chat':
        session.modeId = 'chat';
        await this.sendMessage(params.sessionId, client, 'Switched to chat mode.', 'agent');
        return true;
      case 'model':
        await this.handleModelCommand(session, parsed.args, params.sessionId, client);
        return true;
      case 'approval':
        await this.handleApprovalCommand(session, parsed.args, params.sessionId, client);
        return true;
      case 'compact':
        await this.handleCompactCommand(session, params.sessionId, client, signal);
        return true;
      default:
        await this.sendMessage(
          params.sessionId,
          client,
          `Unknown command: /${parsed.name}\n\n${SLASH_HELP}`,
          'agent',
        );
        return true;
    }
  }

  private async handleModelCommand(
    session: SessionState,
    args: string[],
    sessionId: string,
    client: acp.AgentContext,
  ): Promise<void> {
    const models = await this.getModels(session.cwd);
    if (args.length === 0) {
      const currentName = models.find((model) => model.id === session.model)?.name ?? session.model;
      await this.sendMessage(
        sessionId,
        client,
        `Current model: ${currentName}\n\nAvailable models:\n${models.map((model) => `- ${model.name}`).join('\n')}`,
        'agent',
      );
      return;
    }
    const requested = args.join(' ');
    const match =
      models.find((model) => model.id === requested) ||
      models.find(
        (model) =>
          model.id.toLowerCase() === requested.toLowerCase() ||
          model.name.toLowerCase() === requested.toLowerCase(),
      );
    if (!match) {
      await this.sendMessage(sessionId, client, `Unknown model: ${requested}`, 'agent');
      return;
    }
    session.model = match.id;
    this.syncReasoningEffort(session, match.reasoningEfforts);
    await this.sendMessage(sessionId, client, `Model set to ${match.name}.`, 'agent');
  }

  private async handleApprovalCommand(
    session: SessionState,
    args: string[],
    sessionId: string,
    client: acp.AgentContext,
  ): Promise<void> {
    if (args.length === 0) {
      await this.sendMessage(
        sessionId,
        client,
        `Current approval mode: ${formatApprovalMode(session.approvalMode)}\n\nOptions: auto, safe, manual, all`,
        'agent',
      );
      return;
    }
    const mode = parseApprovalMode(args[0]);
    if (!mode) {
      await this.sendMessage(
        sessionId,
        client,
        'Unknown approval mode. Options: auto, safe, manual, all',
        'agent',
      );
      return;
    }
    session.approvalMode = mode;
    await this.sendMessage(
      sessionId,
      client,
      `Approval mode set to ${formatApprovalMode(mode)}.`,
      'agent',
    );
  }

  private async handleCompactCommand(
    session: SessionState,
    sessionId: string,
    client: acp.AgentContext,
    signal: AbortSignal,
  ): Promise<void> {
    if (session.input.length === 0) {
      await this.sendMessage(sessionId, client, 'Nothing to compact.', 'agent');
      return;
    }
    const before = estimateTokens(session.input);
    const compacted = await compactConversation({
      items: session.input,
      generate: createResponsesSummarizer({
        client: await getResponsesClient(),
        model: session.model,
        signal,
      }),
    });
    if (signal.aborted) {
      return;
    }
    session.input = compacted.items;
    await this.sendMessage(
      sessionId,
      client,
      `Context compacted (~${before.toLocaleString()} tokens before).`,
      'agent',
    );
  }

  private async getModels(cwd: string): Promise<ModelDefinition[]> {
    const cached = this.modelCache.get(cwd);
    if (cached) {
      return cached;
    }
    const models = await listModels();
    this.modelCache.set(cwd, models);
    return models;
  }

  private getModelDefinition(
    modelId: string,
    models?: ModelDefinition[],
  ): ModelDefinition | undefined {
    const candidates = models ?? Array.from(this.modelCache.values()).flat();
    return candidates.find((model) => model.id === modelId);
  }

  private async getConfigOptions(session: SessionState): Promise<acp.SessionConfigOption[]> {
    const models = await this.getModels(session.cwd);
    const availableModels = models.some((model) => model.id === session.model)
      ? models
      : [{ id: session.model, name: session.model }, ...models];
    const modelDefinition = this.getModelDefinition(session.model, availableModels);
    const availableEfforts = getAvailableReasoningEfforts(
      session.model,
      modelDefinition?.reasoningEfforts,
    );
    this.syncReasoningEffort(session, modelDefinition?.reasoningEfforts);
    const configOptions: acp.SessionConfigOption[] = [
      {
        type: 'select',
        id: 'model',
        name: 'Model',
        category: 'model',
        currentValue: session.model,
        options: availableModels.map((model) => ({ value: model.id, name: model.name })),
      },
    ];
    if (availableEfforts.length > 0) {
      configOptions.push({
        type: 'select',
        id: 'reasoning_effort',
        name: 'Reasoning effort',
        category: 'thought_level',
        currentValue: session.reasoningEffort ?? availableEfforts[0],
        options: availableEfforts.map((effort) => ({
          value: effort,
          name: getReasoningEffortLabel(effort),
        })),
      });
    }
    configOptions.push({
      type: 'select',
      id: 'approval_mode',
      name: 'Approval mode',
      currentValue: formatApprovalMode(session.approvalMode),
      options: [
        { value: 'auto', name: 'Auto Approve' },
        { value: 'safe', name: 'Safe Approve' },
        { value: 'manual', name: 'Manual Approve' },
        { value: 'all', name: 'All Approve' },
      ],
    });
    return configOptions;
  }

  private syncReasoningEffort(session: SessionState, modelEfforts?: ModelReasoningEfforts): void {
    const availableEfforts = getAvailableReasoningEfforts(session.model, modelEfforts);
    if (availableEfforts.length === 0) {
      session.reasoningEffort = undefined;
      return;
    }
    if (!session.reasoningEffort || !availableEfforts.includes(session.reasoningEffort)) {
      session.reasoningEffort = availableEfforts.includes('medium')
        ? 'medium'
        : availableEfforts[0];
    }
  }

  private async buildUserPrompt(promptText: string, session: SessionState): Promise<string> {
    if (session.promptCount > 1) {
      return promptText;
    }
    const workspaceContext = await getWorkspaceContext({
      cwd: session.cwd,
      additionalDirectories: session.additionalDirectories,
      signal: session.pendingPrompt?.signal || new AbortController().signal,
    });
    return `User request: ${promptText}\n\nWorkspace: ${session.cwd}\nAdditional workspace roots: ${session.additionalDirectories.join(', ') || 'none'}${workspaceContext ? `\n\n${workspaceContext}` : ''}`;
  }

  private async sendMessage(
    sessionId: string,
    client: acp.AgentContext,
    text: string,
    role: 'agent' | 'thought',
  ): Promise<void> {
    await this.sendSessionUpdate(sessionId, client, {
      sessionUpdate: role === 'thought' ? 'agent_thought_chunk' : 'agent_message_chunk',
      content: { type: 'text', text },
      messageId: `message-${randomUUID()}`,
    });
  }

  private async sendSessionUpdate(
    sessionId: string,
    client: acp.AgentContext,
    update: acp.SessionUpdate,
  ): Promise<void> {
    const notification: acp.SessionNotification = { sessionId, update };
    const session = this.sessions.get(sessionId);
    if (session) {
      session.history.push(notification);
      await this.persistSession(sessionId, session);
    }
    await client.notify(acp.methods.client.session.update, notification);
  }

  private requireSession(sessionId: string): SessionState {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw acp.RequestError.resourceNotFound(sessionId);
    }
    return session;
  }

  private async restoreSession(
    sessionId: string,
    cwd: string,
    additionalDirectories: string[] | undefined,
  ): Promise<SessionState> {
    let session = this.sessions.get(sessionId);
    if (!session) {
      const persisted = await this.sessionStore.get(sessionId);
      if (!persisted) {
        throw acp.RequestError.resourceNotFound(sessionId);
      }
      session = fromPersistedSession(persisted);
      this.sessions.set(sessionId, session);
    }

    if (!samePath(session.cwd, cwd)) {
      throw acp.RequestError.invalidParams(
        { sessionId, cwd },
        'The requested workspace does not match the saved session.',
      );
    }

    session.additionalDirectories = additionalDirectories ? [...additionalDirectories] : [];
    await this.persistSession(sessionId, session);
    return session;
  }

  private async persistSession(sessionId: string, session: SessionState): Promise<void> {
    try {
      await this.sessionStore.save(sessionId, {
        cwd: session.cwd,
        additionalDirectories: [...session.additionalDirectories],
        input: session.input,
        model: session.model,
        reasoningEffort: session.reasoningEffort,
        approvalMode: session.approvalMode,
        modeId: session.modeId,
        promptCount: session.promptCount,
        history: session.history,
        updatedAt: new Date().toISOString(),
      });
    } catch (error) {
      console.error(
        '[Flixa] Failed to persist session',
        sessionId,
        error instanceof Error ? error.message : String(error),
      );
    }
  }
}

async function promptBlocksToText(
  blocks: acp.ContentBlock[],
  session: SessionState,
): Promise<string> {
  const parts: string[] = [];
  for (const block of blocks) {
    if (block.type === 'text') {
      parts.push(block.text);
      continue;
    }
    if (block.type === 'resource_link') {
      parts.push(`Referenced resource: ${block.uri}`);
      continue;
    }
    if (block.type === 'resource') {
      const resource = block.resource;
      if ('text' in resource && typeof resource.text === 'string') {
        parts.push(resource.text);
      } else if ('uri' in resource && typeof resource.uri === 'string') {
        parts.push(`Referenced resource: ${resource.uri}`);
      }
    }
  }
  void session;
  return parts.join('\n\n');
}

function parseSlashCommand(message: string): { name: string; args: string[] } | null {
  const trimmed = message.trim();
  if (!trimmed.startsWith('/')) {
    return null;
  }
  const parts = trimmed.slice(1).split(/\s+/).filter(Boolean);
  if (parts.length === 0) {
    return null;
  }
  return { name: parts[0].toLowerCase(), args: parts.slice(1) };
}

function getModes(currentModeId: 'agent' | 'chat'): acp.SessionModeState {
  return {
    currentModeId,
    availableModes: [
      { id: 'agent', name: 'Agent', description: 'Use tools to complete coding tasks.' },
      { id: 'chat', name: 'Chat', description: 'Answer coding questions without changing files.' },
    ],
  };
}

function formatApiError(error: unknown): string {
  if (error instanceof FlixaApiError) {
    if (error.status === 401 || error.code === 'invalid_key' || error.code === 'expired_key') {
      return 'Flixa API key is invalid or expired. Use the Flixa login flow and try again.';
    }
    if (error.code === 'USAGE_LIMIT_EXCEEDED') {
      return `Flixa usage limit reached: ${error.message}`;
    }
    return `[API Error] ${error.message}`;
  }
  return error instanceof Error ? `[API Error] ${error.message}` : `[API Error] ${String(error)}`;
}

function trimText(value: string): string {
  return value.length > 200_000 ? value.slice(-200_000) : value;
}

function mapUsage(usage: ResponseUsage): acp.Usage {
  return {
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    totalTokens: usage.total_tokens ?? 0,
  };
}

function fromPersistedSession(session: PersistedSession): SessionState {
  return {
    cwd: session.cwd,
    additionalDirectories: [...session.additionalDirectories],
    input: migrateLegacyResponseItems([...session.input]),
    model: session.model,
    reasoningEffort: session.reasoningEffort,
    approvalMode: session.approvalMode,
    modeId: session.modeId,
    promptCount: session.promptCount,
    history: [...session.history],
  };
}

function samePath(left: string, right: string): boolean {
  const normalizedLeft = path.normalize(path.resolve(left));
  const normalizedRight = path.normalize(path.resolve(right));
  return process.platform === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

const ACP_TOOL_KINDS: Record<ToolCategory, acp.ToolKind> = {
  read: 'read',
  search: 'search',
  edit: 'edit',
  delete: 'delete',
  execute: 'execute',
  network: 'fetch',
  other: 'other',
};

/** The ACP tool-call fields Zed shows for a core tool call. */
export function toAcpToolCall(
  call: AgentToolCall,
  session: Pick<SessionState, 'cwd'>,
): {
  toolCallId: string;
  name: string;
  title: string;
  kind: acp.ToolKind;
  locations: Array<{ path: string }>;
  rawInput: Record<string, unknown>;
} {
  const target = call.input.file_path ?? call.input.path;
  const locations =
    typeof target === 'string' && target
      ? [{ path: path.resolve(session.cwd, target) }]
      : call.category === 'execute' || call.category === 'search'
        ? [{ path: session.cwd }]
        : [];
  return {
    toolCallId: call.callId,
    name: call.name,
    title: call.title,
    kind: ACP_TOOL_KINDS[call.category],
    locations,
    rawInput: call.input,
  };
}
