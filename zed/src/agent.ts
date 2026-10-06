import * as acp from '@agentclientprotocol/sdk';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import {
  compactResponse,
  createResponse,
  FlixaApiError,
  initiateDeviceAuth,
  listModels,
  pollDeviceAuth,
  type ResponseUsage,
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
import {
  AGENT_TOOLS,
  executeTool,
  getWorkspaceContext,
  getToolMetadata,
  isExecuteTool,
  isObviouslyUnsafeCommand,
  isWriteTool,
  type ToolExecutionResult,
} from './tools.js';
import { SessionStore, type PersistedSession } from './sessionStore.js';
import {
  getAvailableReasoningEfforts,
  getReasoningEffortLabel,
  isReasoningEffort,
  type ModelReasoningEfforts,
} from './reasoning.js';
import {
  AGENT_SYSTEM_PROMPT,
  CHAT_SYSTEM_PROMPT,
  SAFETY_SYSTEM_PROMPT,
  SLASH_HELP,
} from './prompts.js';

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

interface ParsedModelOutput {
  text: string;
  toolCalls: Array<{ id: string; name: string; input: Record<string, unknown> }>;
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
      throw acp.RequestError.invalidParams(undefined, `Unsupported authentication method: ${params.methodId}`);
    }

    const existingKey = await getApiKey();
    if (existingKey) {
      return {};
    }

    const initiated = await initiateDeviceAuth();
    const authUrl = `${getConfig().deniAiBaseUrl}/flixa/authorize?code=${encodeURIComponent(initiated.userCode)}`;
    console.error(`[Flixa] Open ${authUrl} to complete login. Code: ${initiated.userCode}`);
    openUrl(authUrl);

    const deadline = Date.now() + Math.max(initiated.expiresIn, 60) * 1000;
    while (Date.now() < deadline) {
      await delay(5000);
      try {
        const result = await pollDeviceAuth(initiated.deviceCode);
        if (result.approved && result.apiKey) {
          await setApiKey(result.apiKey);
          console.error('[Flixa] Login completed');
          return {};
        }
      } catch (error) {
        if (error instanceof FlixaApiError && error.status === 410) {
          throw acp.RequestError.internalError(undefined, 'Flixa login expired. Please try again.');
        }
        console.error(
          '[Flixa] Device auth poll failed',
          error instanceof Error ? error.message : String(error),
        );
      }
    }

    throw acp.RequestError.internalError(undefined, 'Flixa login timed out. Please try again.');
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
        throw acp.RequestError.invalidParams(undefined, `Unsupported configuration option: ${params.configId}`);
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
      session.input.push({ role: 'user', content: await this.buildUserPrompt(promptText, session) });
      const usage = session.modeId === 'chat'
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
    const result = await createResponse({
      model: session.model,
      input: session.input,
      instructions: CHAT_SYSTEM_PROMPT,
      reasoningEffort: session.reasoningEffort,
      abortSignal: signal,
    });
    session.input.push(...result.output);
    const parsed = parseResponsesAgentOutput(result.output);
    if (parsed.text) {
      await this.sendMessage(sessionId, client, parsed.text, 'agent');
    }
    return result.usage;
  }

  private async runAgentTurn(
    session: SessionState,
    sessionId: string,
    client: acp.AgentContext,
    signal: AbortSignal,
  ): Promise<ResponseUsage | undefined> {
    let latestUsage: ResponseUsage | undefined;
    const config = getConfig();

    for (let iteration = 0; iteration < config.maxAgentIterations; iteration += 1) {
      if (signal.aborted) {
        return latestUsage;
      }

      if (config.compactTokenThreshold > 0 && estimateTokenCount(session.input) >= config.compactTokenThreshold) {
        const compacted = await compactResponse(session.model, session.input, AGENT_SYSTEM_PROMPT);
        session.input = compacted.output;
        await this.sendMessage(sessionId, client, 'Context compacted.', 'agent');
      }

      const result = await createResponse({
        model: session.model,
        input: session.input,
        instructions: AGENT_SYSTEM_PROMPT,
        tools: AGENT_TOOLS,
        reasoningEffort: session.reasoningEffort,
        abortSignal: signal,
      });
      latestUsage = result.usage;
      session.input.push(...result.output);
      const parsed = parseResponsesAgentOutput(result.output);

      if (parsed.text) {
        await this.sendMessage(sessionId, client, parsed.text, 'agent');
      }
      if (parsed.toolCalls.length === 0) {
        return latestUsage;
      }

      for (const toolCall of parsed.toolCalls) {
        const result = await this.executeAgentTool(session, sessionId, client, toolCall, signal);
        session.input.push({
          type: 'function_call_output',
          call_id: toolCall.id,
          output: formatToolResult(result),
        });
      }
    }

    await this.sendMessage(sessionId, client, 'Maximum agent iterations reached.', 'agent');
    return latestUsage;
  }

  private async executeAgentTool(
    session: SessionState,
    sessionId: string,
    client: acp.AgentContext,
    toolCall: { id: string; name: string; input: Record<string, unknown> },
    signal: AbortSignal,
  ): Promise<ToolExecutionResult> {
    const context = {
      cwd: session.cwd,
      additionalDirectories: session.additionalDirectories,
      signal,
      onOutput: async (output: string) => {
        await this.updateToolCall(client, sessionId, toolCall, 'in_progress', output);
      },
    };
    const metadata = getToolMetadata(toolCall.name, toolCall.input, context);
    await this.sendSessionUpdate(sessionId, client, {
      sessionUpdate: 'tool_call',
      toolCallId: toolCall.id,
      name: toolCall.name,
      title: metadata.title,
      kind: metadata.kind,
      status: 'pending',
      locations: metadata.locations,
      rawInput: toolCall.input,
    });

    const permission = await this.shouldAllowTool(session, client, sessionId, toolCall, metadata, signal);
    if (!permission.allowed) {
      const result = { success: false, error: permission.reason, output: permission.reason };
      await this.updateToolCall(client, sessionId, toolCall, 'failed', permission.reason);
      return result;
    }

    await this.updateToolCall(client, sessionId, toolCall, 'in_progress');
    const result = await executeTool(toolCall.name, toolCall.input, context);
    await this.updateToolCall(client, sessionId, toolCall, result.success ? 'completed' : 'failed', result.output || result.error, result);
    return result;
  }

  private async shouldAllowTool(
    session: SessionState,
    client: acp.AgentContext,
    sessionId: string,
    toolCall: { id: string; name: string; input: Record<string, unknown> },
    metadata: ReturnType<typeof getToolMetadata>,
    signal: AbortSignal,
  ): Promise<{ allowed: boolean; reason: string }> {
    const needsApproval = isWriteTool(toolCall.name) || isExecuteTool(toolCall.name);
    if (!needsApproval || session.approvalMode === 'ALL_APPROVE') {
      return { allowed: true, reason: '' };
    }

    if (
      session.approvalMode === 'AUTO_APPROVE' &&
      isExecuteTool(toolCall.name) &&
      typeof toolCall.input.command === 'string' &&
      isObviouslyUnsafeCommand(toolCall.input.command)
    ) {
      return { allowed: false, reason: 'Command rejected by the Flixa safety check.' };
    }

    if (session.approvalMode === 'AUTO_APPROVE' && isExecuteTool(toolCall.name)) {
      const command = typeof toolCall.input.command === 'string' ? toolCall.input.command : '';
      const safety = await this.checkShellCommandSafety(session, command, signal);
      if (!safety.safe) {
        return { allowed: false, reason: `AI safety check: ${safety.reason}` };
      }
      return { allowed: true, reason: '' };
    }

    if (session.approvalMode === 'AUTO_APPROVE' || session.approvalMode === 'SAFE_APPROVE') {
      if (session.approvalMode === 'AUTO_APPROVE' && isWriteTool(toolCall.name)) {
        return { allowed: true, reason: '' };
      }
      if (session.approvalMode === 'SAFE_APPROVE' && isWriteTool(toolCall.name)) {
        return { allowed: true, reason: '' };
      }
    }

    if (signal.aborted) {
      return { allowed: false, reason: 'Action cancelled' };
    }

    const response = await client.request<acp.RequestPermissionResponse>(acp.methods.client.session.requestPermission, {
      sessionId,
      toolCall: {
        toolCallId: toolCall.id,
        name: toolCall.name,
        title: metadata.title,
        kind: metadata.kind,
        status: 'pending',
        locations: metadata.locations,
        rawInput: toolCall.input,
      },
      options: [
        { optionId: 'allow', name: 'Allow this action', kind: 'allow_once' },
        { optionId: 'reject', name: 'Reject this action', kind: 'reject_once' },
      ],
    });
    if (response.outcome.outcome !== 'selected' || response.outcome.optionId !== 'allow') {
      return { allowed: false, reason: 'User rejected action' };
    }
    return { allowed: true, reason: '' };
  }

  private async updateToolCall(
    client: acp.AgentContext,
    sessionId: string,
    toolCall: { id: string; name: string; input: Record<string, unknown> },
    status: acp.ToolCallStatus,
    text?: string,
    result?: ToolExecutionResult,
  ): Promise<void> {
    const content: acp.ToolCallContent[] = [];
    if (result?.path && result.newText !== undefined) {
      content.push({
        type: 'diff',
        path: result.path,
        oldText: result.oldText,
        newText: result.newText,
      });
    } else if (text) {
      content.push({
        type: 'content',
        content: { type: 'text', text: trimText(text) },
      });
    }

    await this.sendSessionUpdate(sessionId, client, {
      sessionUpdate: 'tool_call_update',
      toolCallId: toolCall.id,
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
        await this.sendMessage(params.sessionId, client, `Unknown command: /${parsed.name}\n\n${SLASH_HELP}`, 'agent');
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
      await this.sendMessage(sessionId, client, `Current model: ${currentName}\n\nAvailable models:\n${models.map((model) => `- ${model.name}`).join('\n')}`, 'agent');
      return;
    }
    const requested = args.join(' ');
    const match = models.find((model) => model.id === requested) || models.find((model) => model.id.toLowerCase() === requested.toLowerCase() || model.name.toLowerCase() === requested.toLowerCase());
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
      await this.sendMessage(sessionId, client, `Current approval mode: ${formatApprovalMode(session.approvalMode)}\n\nOptions: auto, safe, manual, all`, 'agent');
      return;
    }
    const mode = parseApprovalMode(args[0]);
    if (!mode) {
      await this.sendMessage(sessionId, client, 'Unknown approval mode. Options: auto, safe, manual, all', 'agent');
      return;
    }
    session.approvalMode = mode;
    await this.sendMessage(sessionId, client, `Approval mode set to ${formatApprovalMode(mode)}.`, 'agent');
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
    const before = estimateTokenCount(session.input);
    const compacted = await compactResponse(session.model, session.input, AGENT_SYSTEM_PROMPT);
    if (signal.aborted) {
      return;
    }
    session.input = compacted.output;
    await this.sendMessage(sessionId, client, `Context compacted (~${before.toLocaleString()} tokens before).`, 'agent');
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

  private async checkShellCommandSafety(
    session: SessionState,
    command: string,
    signal: AbortSignal,
  ): Promise<{ safe: boolean; reason: string }> {
    try {
      const result = await createResponse({
        model: session.model,
        input: [{ role: 'user', content: `Command:\n${command}` }],
        instructions: SAFETY_SYSTEM_PROMPT,
        reasoningEffort: getAvailableReasoningEfforts(
          session.model,
          this.getModelDefinition(session.model)?.reasoningEfforts,
        ).includes('low')
          ? 'low'
          : undefined,
        abortSignal: signal,
      });
      const responseText = parseResponsesAgentOutput(result.output).text.trim().replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
      const parsed = JSON.parse(responseText) as Record<string, unknown>;
      if ((parsed.verdict === 'SAFE' || parsed.verdict === 'UNSAFE') && typeof parsed.reason === 'string') {
        return { safe: parsed.verdict === 'SAFE', reason: parsed.reason };
      }
      return { safe: false, reason: 'Failed to parse safety check response' };
    } catch (error) {
      return { safe: false, reason: error instanceof Error ? error.message : String(error) };
    }
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

  private syncReasoningEffort(
    session: SessionState,
    modelEfforts?: ModelReasoningEfforts,
  ): void {
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

export function parseResponsesAgentOutput(output: unknown[]): ParsedModelOutput {
  let text = '';
  const toolCalls: ParsedModelOutput['toolCalls'] = [];
  for (const item of output) {
    if (!isRecord(item)) {
      continue;
    }
    if ((item.type === 'message' || item.role === 'assistant') && item.content !== undefined) {
      const piece = extractOutputText(item.content);
      if (piece) {
        text += `${text ? '\n' : ''}${piece}`;
      }
    }
    if (item.type === 'function_call' && typeof item.name === 'string') {
      let input: Record<string, unknown> = {};
      if (typeof item.arguments === 'string') {
        try {
          const parsed = JSON.parse(item.arguments) as unknown;
          if (isRecord(parsed)) {
            input = parsed;
          }
        } catch {
          input = {};
        }
      } else if (isRecord(item.arguments)) {
        input = item.arguments;
      }
      toolCalls.push({
        id: typeof item.call_id === 'string' ? item.call_id : typeof item.id === 'string' ? item.id : `call-${toolCalls.length + 1}`,
        name: item.name,
        input,
      });
    }
  }
  return { text, toolCalls };
}

function extractOutputText(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }
  return content
    .filter((part): part is Record<string, unknown> => isRecord(part))
    .map((part) => (typeof part.text === 'string' ? part.text : ''))
    .join('');
}

async function promptBlocksToText(blocks: acp.ContentBlock[], session: SessionState): Promise<string> {
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

function parseApprovalMode(value: string | undefined): ApprovalMode | null {
  switch (value?.toLowerCase()) {
    case 'auto':
    case 'auto_approve':
    case 'auto-approve':
      return 'AUTO_APPROVE';
    case 'safe':
    case 'safe_approve':
    case 'safe-approve':
      return 'SAFE_APPROVE';
    case 'manual':
    case 'manual_approve':
    case 'manual-approve':
      return 'MANUAL_APPROVE';
    case 'all':
    case 'all_approve':
    case 'all-approve':
    case 'yolo':
      return 'ALL_APPROVE';
    default:
      return null;
  }
}

function formatApprovalMode(mode: ApprovalMode): string {
  return mode === 'ALL_APPROVE'
    ? 'all'
    : mode === 'AUTO_APPROVE'
      ? 'auto'
      : mode === 'SAFE_APPROVE'
        ? 'safe'
        : 'manual';
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

function formatToolResult(result: ToolExecutionResult): string {
  if (result.success) {
    return result.output || 'Action completed successfully.';
  }
  return `[FAILED] ${result.error || 'Action failed'}${result.output ? `\n${result.output}` : ''}`;
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

function estimateTokenCount(value: unknown): number {
  try {
    return Math.ceil(JSON.stringify(value).length / 4);
  } catch {
    return 0;
  }
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object';
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function fromPersistedSession(session: PersistedSession): SessionState {
  return {
    cwd: session.cwd,
    additionalDirectories: [...session.additionalDirectories],
    input: [...session.input],
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
