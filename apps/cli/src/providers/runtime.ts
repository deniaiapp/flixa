import {
  generateText,
  jsonSchema,
  stepCountIs,
  tool as aiTool,
  type LanguageModel,
  type ModelMessage,
  type ToolSet,
} from "ai";
import { randomUUID } from "node:crypto";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createMistral } from "@ai-sdk/mistral";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { getApiKey } from "../auth/service.ts";
import { hasStoredSecret, primeStoredSecrets } from "../auth/keychain.ts";
import {
  getDefaultProvider,
  getPersistedModel,
  getPersistedProviderBaseUrl,
} from "../config/store.ts";
import {
  executeToolCall,
  getAgentToolDefinitions,
  type SubagentRequest,
  type ToolExecutionContext,
} from "../agent-tools/tools.ts";
import {
  getPermissionDenial,
  loadToolGuards,
  runPostToolUseHooks,
  runPreToolUseHooks,
  type ToolGuards,
} from "../agent-tools/guards.ts";
import { findSubagent, loadSubagents, resolveSubagentTools } from "../subagents/definitions.ts";
import {
  getToolApprovalRequest,
  getToolSafetyReviewRequest,
  summarizeToolCall,
  type ToolApprovalRequest,
  type ToolSafetyReviewResult,
} from "../agent-tools/runner.ts";
import {
  getProviderDefinition,
  isProviderId,
  listProviderDefinitions,
  type ProviderDefinition,
  type ProviderId,
} from "./registry.ts";
import { assertSecureBaseUrl, isLoopbackUrl } from "../security/url.ts";
import type { ChatMessage } from "../flixa/api.ts";
import { createFlixaFetch, getFlixaCliClientHeaders } from "../http/flixaClientHeaders.ts";
import { rethrowAsUserFacingFlixaError } from "../http/flixaApiErrors.ts";
import { cwd } from "node:process";

export interface ProviderResolutionOptions {
  provider?: string;
  model?: string;
  baseUrl?: string;
}

export interface ResolvedProviderContext {
  provider: ProviderId;
  apiKey: string | null;
  model: string;
  baseUrl?: string;
  displayName: string;
  runtime: ProviderDefinition["runtime"];
}

export interface SharedAgentRunOptions {
  provider?: string;
  model?: string;
  baseUrl?: string;
  system?: string;
  prompt: string;
  history: ChatMessage[];
  /** Stable per-conversation id, sent to gateways that route and cache by session. */
  sessionId?: string;
  maxOutputTokens?: number;
  signal?: AbortSignal;
  autoMode?: boolean;
  yoloMode?: boolean;
  planMode?: boolean;
  acceptEdits?: boolean;
  requestToolApproval?: (request: ToolApprovalRequest) => Promise<boolean>;
  reviewToolSafety?: (request: ToolApprovalRequest) => Promise<ToolSafetyReviewResult>;
  onEvent?: (event: SharedAgentRunEvent) => void;
  /** Permission rules and hooks; loaded from settings when omitted. */
  guards?: ToolGuards;
  /** Offer the Task tool. Sub-agents run with this off so they cannot nest. */
  allowTask?: boolean;
  /** Restrict the offered tools to these names (used for sub-agents). */
  allowedTools?: readonly string[];
}

export type SharedAgentRunEvent =
  | { type: "round_start"; round: number }
  | { type: "tool_start"; toolName: string; summary: string }
  | { type: "tool_result"; toolName: string; summary: string; output: string };

export interface SharedAgentRunResult {
  text: string;
  context: ResolvedProviderContext;
  history: ChatMessage[];
}

export interface ProviderModelOption {
  id: string;
  label: string;
  description: string;
  sortKey?: number;
}

const ANTHROPIC_API_VERSION = "2023-06-01";
const DEFAULT_GEMINI_API_ROOT = "https://generativelanguage.googleapis.com/v1beta";
const OPENROUTER_REFERER = "https://github.com/deniaiapp/flixa-cli";
const OPENROUTER_TITLE = "Flixa CLI";

interface OpenAiCompatibleModelListResponse {
  data?: OpenAiCompatibleModel[];
}

interface OpenAiCompatibleModel {
  id?: string;
  created?: number;
}

interface AnthropicModelListResponse {
  data?: AnthropicProviderModel[];
}

interface AnthropicProviderModel {
  id?: string;
  display_name?: string;
  created_at?: string;
  max_input_tokens?: number;
  max_tokens?: number;
}

interface GeminiModelListResponse {
  models?: GeminiProviderModel[];
  nextPageToken?: string;
}

interface GeminiProviderModel {
  name?: string;
  baseModelId?: string;
  displayName?: string;
  description?: string;
  supportedGenerationMethods?: string[];
  inputTokenLimit?: number;
  outputTokenLimit?: number;
}

interface OpenRouterModelListResponse {
  data?: OpenRouterProviderModel[];
}

interface OpenRouterProviderModel {
  id?: string;
  name?: string;
  created?: number;
  description?: string;
  context_length?: number;
  architecture?: {
    input_modalities?: string[];
    output_modalities?: string[];
  };
}

export function resolveProviderId(rawProvider?: string): ProviderId {
  if (!rawProvider?.trim()) {
    return getDefaultProvider();
  }

  const normalized = rawProvider.trim().toLowerCase();
  if (!isProviderId(normalized)) {
    throw new Error(`Unsupported provider: ${rawProvider}`);
  }

  return normalized;
}

export function resolveProviderContext(
  options: ProviderResolutionOptions = {},
): ResolvedProviderContext {
  const provider = resolveProviderId(options.provider);
  const definition = getProviderDefinition(provider);
  const model =
    options.model?.trim() ||
    getPersistedModel(provider) ||
    definition.defaultModel ||
    getPersistedModel() ||
    "gpt-4.1";
  const rawBaseUrl =
    options.baseUrl?.trim() || getPersistedProviderBaseUrl(provider) || definition.defaultBaseUrl;
  const baseUrl = rawBaseUrl ? assertSecureBaseUrl(rawBaseUrl) : rawBaseUrl;

  // Local servers (LM Studio, llama.cpp...) take no key; the SDK still needs a non-empty one.
  const apiKey =
    resolveApiKeyForProvider(provider) ?? (baseUrl && isLoopbackUrl(baseUrl) ? "local" : null);

  return {
    provider,
    apiKey,
    model,
    baseUrl,
    displayName: definition.displayName,
    runtime: definition.runtime,
  };
}

export function resolveApiKeyForProvider(provider: ProviderId): string | null {
  const definition = getProviderDefinition(provider);

  switch (provider) {
    case "flixa": {
      const envApiKey = process.env.FLIXA_API_KEY?.trim();
      if (envApiKey) return envApiKey;
      const openAiCompatibleApiKey = process.env.OPENAI_API_KEY?.trim();
      if (openAiCompatibleApiKey) return openAiCompatibleApiKey;
      return getApiKey(provider);
    }
  }

  for (const envName of definition.apiKeyEnvNames ?? []) {
    const value = process.env[envName]?.trim();
    if (value) {
      return value;
    }
  }

  return getApiKey(provider);
}

function isProviderConfigured(provider: ProviderId): boolean {
  const environmentNames =
    provider === "flixa"
      ? ["FLIXA_API_KEY", "OPENAI_API_KEY"]
      : (getProviderDefinition(provider).apiKeyEnvNames ?? []);
  return (
    environmentNames.some((name) => Boolean(process.env[name]?.trim())) || hasStoredSecret(provider)
  );
}

/** Providers with an API key available, found without decrypting each secret one by one. */
export function listConfiguredProviderIds(): ProviderId[] {
  const ids = listProviderDefinitions().map((definition) => definition.id);
  primeStoredSecrets(ids);
  return ids.filter((id) => isProviderConfigured(id));
}

// Fallback for callers without a conversation id: stable for the lifetime of this process.
const PROCESS_SESSION_ID = randomUUID();

/** OpenCode Zen/Go reject requests that carry no session id and a generic SDK user agent. */
function isOpenCodeGateway(context: ResolvedProviderContext): boolean {
  if (context.provider === "opencode" || context.provider === "opencode-go") {
    return true;
  }
  try {
    return context.baseUrl ? new URL(context.baseUrl).hostname.endsWith("opencode.ai") : false;
  } catch {
    return false;
  }
}

export function createLanguageModel(
  context: ResolvedProviderContext,
  sessionId: string = PROCESS_SESSION_ID,
): LanguageModel {
  const definition = getProviderDefinition(context.provider);
  if (definition.baseUrlRequired && !context.baseUrl) {
    throw new Error(
      `${context.displayName} requires a base URL. Pass --base-url or configure it during login.`,
    );
  }

  if (context.runtime === "external") {
    throw new Error(
      `${context.displayName} requires provider-specific credentials or SDK configuration. Configure its environment variables and use --base-url if the endpoint is OpenAI-compatible.`,
    );
  }

  const apiKey = context.apiKey;
  if (!apiKey) {
    throw new Error(
      `No API key configured for ${context.displayName}. Run \`flixa login --provider ${context.provider}\` first.`,
    );
  }

  switch (context.runtime) {
    case "openai-chat": {
      // `@ai-sdk/openai` drops reasoning parts, so thinking models (DeepSeek, Kimi, GLM, Qwen...)
      // reject the follow-up request of a tool loop. The compatible provider reads
      // `reasoning_content` from responses and sends it back on assistant messages.
      if (!context.baseUrl) {
        throw new Error(`${context.displayName} requires a base URL. Pass --base-url.`);
      }
      if (context.provider === "mistral") {
        // Mistral returns/accepts reasoning as `thinking` content chunks, which only its own SDK maps.
        return createMistral({
          apiKey,
          baseURL: normalizeOpenAiBaseUrl(context.baseUrl),
        }).chat(context.model);
      }
      return createOpenAICompatible({
        name: context.provider,
        apiKey,
        baseURL: normalizeOpenAiBaseUrl(context.baseUrl),
        includeUsage: true,
        // Groq and Cerebras expect prior reasoning under `reasoning`, not `reasoning_content`.
        ...(REASONING_FIELD_PROVIDERS.has(context.provider)
          ? { transformRequestBody: renameReasoningContentField }
          : {}),
        ...(context.provider === "openrouter"
          ? {
              headers: {
                "HTTP-Referer": OPENROUTER_REFERER,
                "X-Title": OPENROUTER_TITLE,
              },
            }
          : {}),
        ...(isOpenCodeGateway(context)
          ? {
              headers: { "x-opencode-session": sessionId },
              // AI SDK sets User-Agent to `ai/...`; identify as this CLI instead.
              fetch: createFlixaFetch(),
            }
          : {}),
      }).chatModel(context.model);
    }
    case "openai-responses": {
      const openai = createOpenAI({
        apiKey,
        ...(context.baseUrl ? { baseURL: normalizeOpenAiBaseUrl(context.baseUrl) } : {}),
      });
      return openai.responses(context.model);
    }
    case "flixa": {
      const anthropic = createAnthropic({
        apiKey,
        ...(context.baseUrl ? { baseURL: context.baseUrl } : {}),
        headers: getFlixaCliClientHeaders(),
        // AI SDK sets User-Agent to `ai/...`; re-apply CLI signals on the wire.
        fetch: createFlixaFetch(),
      });
      return anthropic(context.model);
    }
    case "anthropic": {
      const anthropic = createAnthropic({
        // MiniMax's Anthropic-compatible endpoint documents Bearer auth instead of `x-api-key`.
        ...(context.provider.startsWith("minimax") ? { authToken: apiKey } : { apiKey }),
        ...(context.baseUrl ? { baseURL: normalizeAnthropicBaseUrl(context.baseUrl) } : {}),
      });
      return anthropic(context.model);
    }
    case "google": {
      const google = createGoogleGenerativeAI({
        apiKey,
        ...(context.baseUrl ? { baseURL: context.baseUrl } : {}),
      });
      return google(context.model);
    }
  }
}

export function chatHistoryToModelMessages(history: ChatMessage[]): ModelMessage[] {
  return history.map((message) => ({
    role: message.role,
    content: message.content,
  }));
}

export async function generateProviderText(options: {
  provider?: string;
  model?: string;
  baseUrl?: string;
  prompt: string;
  system?: string;
  maxOutputTokens?: number;
  signal?: AbortSignal;
}): Promise<{ text: string; context: ResolvedProviderContext }> {
  const context = resolveProviderContext(options);
  try {
    const model = createLanguageModel(context);
    const result = await generateText({
      model,
      prompt: options.prompt,
      ...(options.signal ? { abortSignal: options.signal } : {}),
      ...(options.system ? { system: options.system } : {}),
      ...(typeof options.maxOutputTokens === "number"
        ? { maxOutputTokens: options.maxOutputTokens }
        : {}),
    });

    return {
      text: result.text,
      context,
    };
  } catch (error) {
    if (context.provider === "flixa") {
      rethrowAsUserFacingFlixaError(error);
    }
    throw error;
  }
}

export async function runSharedAgentTurn(
  options: SharedAgentRunOptions,
): Promise<SharedAgentRunResult> {
  const context = resolveProviderContext(options);
  const model = createLanguageModel(context, options.sessionId);
  const guards = options.guards ?? loadToolGuards(cwd());
  const allowTask = options.allowTask !== false;
  const toolContext: ToolExecutionContext = {
    workspaceRoot: cwd(),
    allowShell: options.planMode !== true,
    allowFileEdits: options.planMode !== true,
    ...(allowTask
      ? {
          runSubagent: (request: SubagentRequest) =>
            runSharedSubagentTurn(request, options, guards),
        }
      : {}),
  };
  const toolDefinitions = getAgentToolDefinitions({
    allowShell: toolContext.allowShell,
    allowFileEdits: toolContext.allowFileEdits,
    allowTask,
    allowedTools: options.allowedTools,
  });
  const tools: ToolSet = Object.fromEntries(
    toolDefinitions.map((definition) => [
      definition.name,
      aiTool({
        description: definition.description,
        inputSchema: jsonSchema(definition.parameters as never),
        execute: async (input) => {
          const callId = `${definition.name}-${Date.now()}-${Math.random()
            .toString(36)
            .slice(2, 8)}`;
          const argumentsText = JSON.stringify(input ?? {});
          const summary = summarizeToolCall(definition.name, argumentsText);
          const requestOptions = {
            autoMode: options.autoMode,
            yoloMode: options.yoloMode,
            acceptEdits: options.acceptEdits,
            planMode: options.planMode,
            guards,
          };

          const preflightDenial =
            getPermissionDenial(guards, definition.name, argumentsText) ??
            (await runPreToolUseHooks(guards, definition.name, argumentsText, options.signal));
          if (preflightDenial) {
            const denied = createSharedDeniedToolResult(definition.name, summary, preflightDenial);
            options.onEvent?.({
              type: "tool_result",
              toolName: definition.name,
              summary: denied.summary,
              output: denied.output,
            });
            return denied.output;
          }

          if (!options.yoloMode) {
            const safetyRequest = getToolSafetyReviewRequest(
              definition.name,
              argumentsText,
              requestOptions,
            );
            if (safetyRequest) {
              const review = options.reviewToolSafety
                ? await options.reviewToolSafety(safetyRequest)
                : {
                    safe: false,
                    verdict: "UNSAFE: No safety reviewer configured for auto mode.",
                  };
              if (!review.safe) {
                const denied = createSharedDeniedToolResult(
                  definition.name,
                  summary,
                  `Blocked by safety review: ${review.verdict}`,
                );
                options.onEvent?.({
                  type: "tool_result",
                  toolName: definition.name,
                  summary: denied.summary,
                  output: denied.output,
                });
                return denied.output;
              }
            }

            const approvalRequest = getToolApprovalRequest(
              definition.name,
              argumentsText,
              requestOptions,
            );
            if (approvalRequest) {
              const approved = options.requestToolApproval
                ? await options.requestToolApproval(approvalRequest)
                : false;
              if (!approved) {
                const denied = createSharedDeniedToolResult(
                  definition.name,
                  summary,
                  "Permission denied by user or no approval handler was configured.",
                );
                options.onEvent?.({
                  type: "tool_result",
                  toolName: definition.name,
                  summary: denied.summary,
                  output: denied.output,
                });
                return denied.output;
              }
            }
          }

          options.onEvent?.({
            type: "tool_start",
            toolName: definition.name,
            summary,
          });

          try {
            const result = await executeToolCall(
              {
                name: definition.name,
                callId,
                argumentsText,
              },
              options.signal ? { ...toolContext, signal: options.signal } : toolContext,
            );
            options.onEvent?.({
              type: "tool_result",
              toolName: definition.name,
              summary: result.summary,
              output: result.output,
            });
            const hookFeedback = await runPostToolUseHooks(
              guards,
              definition.name,
              argumentsText,
              result.output,
              options.signal,
            );
            return `${result.output}${hookFeedback}`;
          } catch (error) {
            if (options.signal?.aborted || isAbortError(error)) {
              throw error;
            }
            const message = error instanceof Error ? error.message : String(error);
            const failed = createSharedFailedToolResult(definition.name, summary, message);
            options.onEvent?.({
              type: "tool_result",
              toolName: definition.name,
              summary: failed.summary,
              output: failed.output,
            });
            return failed.output;
          }
        },
      }),
    ]),
  );

  try {
    options.onEvent?.({ type: "round_start", round: 1 });
    const result = await generateText({
      model,
      system: options.system,
      messages: [
        ...chatHistoryToModelMessages(options.history),
        { role: "user", content: options.prompt },
      ],
      tools,
      stopWhen: stepCountIs(8),
      abortSignal: options.signal,
      ...(typeof options.maxOutputTokens === "number"
        ? { maxOutputTokens: options.maxOutputTokens }
        : {}),
    });

    const text = result.text.trim();
    return {
      text,
      context,
      history: [
        ...options.history,
        { role: "user", content: options.prompt },
        { role: "assistant", content: text },
      ],
    };
  } catch (error) {
    if (context.provider === "flixa") {
      rethrowAsUserFacingFlixaError(error);
    }
    throw error;
  }
}

async function runSharedSubagentTurn(
  request: SubagentRequest,
  parent: SharedAgentRunOptions,
  guards: ToolGuards,
): Promise<string> {
  const definitions = loadSubagents(cwd());
  const definition = findSubagent(definitions, request.subagentType);
  if (!definition) {
    throw new Error(
      `Unknown subagent type "${request.subagentType}". Available: ${definitions
        .map((candidate) => candidate.name)
        .join(", ")}`,
    );
  }

  const toolNames = getAgentToolDefinitions({ allowTask: false }).map((tool) => tool.name);
  const result = await runSharedAgentTurn({
    ...parent,
    history: [],
    prompt: request.prompt,
    system: [definition.systemPrompt, parent.system].filter(Boolean).join("\n\n"),
    allowTask: false,
    allowedTools: resolveSubagentTools(definition, toolNames),
    guards,
    onEvent: (event) => {
      if (event.type === "tool_start" || event.type === "tool_result") {
        parent.onEvent?.({ ...event, summary: `↳ ${event.summary}` });
      }
    },
  });

  return result.text;
}

function createSharedDeniedToolResult(
  toolName: string,
  summary: string,
  reason: string,
): { output: string; summary: string } {
  return {
    output: JSON.stringify(
      {
        ok: false,
        tool: toolName,
        denied: true,
        reason,
      },
      null,
      2,
    ),
    summary: `Denied ${toolName} ${summary}`.trim(),
  };
}

function createSharedFailedToolResult(
  toolName: string,
  summary: string,
  error: string,
): { output: string; summary: string } {
  return {
    output: JSON.stringify(
      {
        ok: false,
        tool: toolName,
        error,
      },
      null,
      2,
    ),
    summary: `${toolName} ${summary} failed: ${error}`,
  };
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

export async function listProviderModelOptions(
  options: ProviderResolutionOptions = {},
): Promise<ProviderModelOption[]> {
  const context = resolveProviderContext(options);
  const definition = getProviderDefinition(context.provider);
  if (!context.apiKey) {
    throw new Error(
      `No API key configured for ${context.displayName}. Run \`flixa login --provider ${context.provider}\` first.`,
    );
  }

  if (definition.catalogModels && definition.catalogModels.length > 0) {
    return definition.catalogModels.map((model) => ({
      id: model.id,
      label: model.name || model.id,
      description: model.description,
    }));
  }

  switch (context.provider) {
    case "openai":
    case "custom-openai":
      return fetchOpenAiCompatibleModelOptions(context);
    case "anthropic":
      return fetchAnthropicModelOptions(context);
    case "google":
      return fetchGeminiModelOptions(context);
    case "openrouter":
      return fetchOpenRouterModelOptions(context);
    case "flixa":
      return [
        {
          id: context.model,
          label: context.model,
          description: "",
        },
      ];
    default:
      return [
        {
          id: context.model,
          label: context.model,
          description: "",
        },
      ];
  }
}

async function fetchOpenAiCompatibleModelOptions(
  context: ResolvedProviderContext,
): Promise<ProviderModelOption[]> {
  const payload = await fetchProviderJson<OpenAiCompatibleModelListResponse>({
    url: `${resolveApiBaseUrl(context.baseUrl)}/models`,
    headers: {
      Authorization: `Bearer ${context.apiKey}`,
    },
  });

  const models = Array.isArray(payload.data)
    ? payload.data
        .map((model) => normalizeOpenAiCompatibleModel(model, context.provider === "openai"))
        .filter((model): model is ProviderModelOption => model !== null)
    : [];

  return finalizeProviderModelOptions(models, context);
}

async function fetchAnthropicModelOptions(
  context: ResolvedProviderContext,
): Promise<ProviderModelOption[]> {
  const apiKey = context.apiKey;
  if (!apiKey) {
    throw new Error("An Anthropic API key is required to list models.");
  }

  const payload = await fetchProviderJson<AnthropicModelListResponse>({
    url: resolveAnthropicModelsUrl(context.baseUrl),
    headers: {
      "anthropic-version": ANTHROPIC_API_VERSION,
      "x-api-key": apiKey,
    },
  });

  const models = Array.isArray(payload.data)
    ? payload.data
        .map((model) => normalizeAnthropicModel(model))
        .filter((model): model is ProviderModelOption => model !== null)
    : [];

  return finalizeProviderModelOptions(models, context);
}

async function fetchGeminiModelOptions(
  context: ResolvedProviderContext,
): Promise<ProviderModelOption[]> {
  const apiKey = context.apiKey;
  if (!apiKey) {
    throw new Error("A Google API key is required to list models.");
  }

  const modelsById = new Map<string, ProviderModelOption>();
  let pageToken: string | undefined;

  do {
    const url = new URL(`${DEFAULT_GEMINI_API_ROOT}/models`);
    url.searchParams.set("key", apiKey);
    url.searchParams.set("pageSize", "1000");
    if (pageToken) {
      url.searchParams.set("pageToken", pageToken);
    }

    const payload = await fetchProviderJson<GeminiModelListResponse>({
      url: url.toString(),
    });

    if (Array.isArray(payload.models)) {
      for (const model of payload.models) {
        const normalized = normalizeGeminiModel(model);
        if (normalized) {
          modelsById.set(normalized.id, normalized);
        }
      }
    }

    pageToken =
      typeof payload.nextPageToken === "string" && payload.nextPageToken.trim()
        ? payload.nextPageToken
        : undefined;
  } while (pageToken);

  return finalizeProviderModelOptions([...modelsById.values()], context);
}

async function fetchOpenRouterModelOptions(
  context: ResolvedProviderContext,
): Promise<ProviderModelOption[]> {
  const payload = await fetchProviderJson<OpenRouterModelListResponse>({
    url: `${resolveApiBaseUrl(context.baseUrl)}/models`,
    headers: {
      Authorization: `Bearer ${context.apiKey}`,
      "HTTP-Referer": OPENROUTER_REFERER,
      "X-Title": OPENROUTER_TITLE,
    },
  });

  const models = Array.isArray(payload.data)
    ? payload.data
        .map((model) => normalizeOpenRouterModel(model))
        .filter((model): model is ProviderModelOption => model !== null)
    : [];

  return finalizeProviderModelOptions(models, context);
}

function normalizeOpenAiCompatibleModel(
  model: OpenAiCompatibleModel,
  // The name-based text-model filter only knows OpenAI's own naming (gpt-*, o1, ...).
  filterOpenAiNames: boolean,
): ProviderModelOption | null {
  const id = typeof model.id === "string" ? model.id.trim() : "";
  if (!id || (filterOpenAiNames && !isLikelyTextModelForOpenAiCompatibleProvider(id))) {
    return null;
  }

  const createdAt =
    typeof model.created === "number" && Number.isFinite(model.created)
      ? model.created * 1000
      : undefined;

  return {
    id,
    label: id,
    description: "",
    sortKey: createdAt,
  };
}

function normalizeAnthropicModel(model: AnthropicProviderModel): ProviderModelOption | null {
  const id = typeof model.id === "string" ? model.id.trim() : "";
  if (!id) {
    return null;
  }

  const label =
    typeof model.display_name === "string" && model.display_name.trim()
      ? model.display_name.trim()
      : id;
  const createdAt = parseDateValue(model.created_at);

  return {
    id,
    label,
    description: "",
    sortKey: createdAt,
  };
}

function normalizeGeminiModel(model: GeminiProviderModel): ProviderModelOption | null {
  const supportedMethods = Array.isArray(model.supportedGenerationMethods)
    ? model.supportedGenerationMethods
    : [];
  if (!supportedMethods.includes("generateContent")) {
    return null;
  }

  const rawId =
    typeof model.baseModelId === "string" && model.baseModelId.trim()
      ? model.baseModelId.trim()
      : typeof model.name === "string" && model.name.startsWith("models/")
        ? model.name.slice("models/".length).trim()
        : "";

  if (!rawId || !rawId.startsWith("gemini-")) {
    return null;
  }

  const label =
    typeof model.displayName === "string" && model.displayName.trim()
      ? model.displayName.trim()
      : rawId;
  return {
    id: rawId,
    label,
    description: "",
  };
}

function normalizeOpenRouterModel(model: OpenRouterProviderModel): ProviderModelOption | null {
  const id = typeof model.id === "string" ? model.id.trim() : "";
  if (!id) {
    return null;
  }

  const outputModalities = Array.isArray(model.architecture?.output_modalities)
    ? model.architecture.output_modalities
    : [];
  if (!outputModalities.includes("text")) {
    return null;
  }
  if (outputModalities.some((modality) => modality !== "text")) {
    return null;
  }

  const label = typeof model.name === "string" && model.name.trim() ? model.name.trim() : id;
  const createdAt =
    typeof model.created === "number" && Number.isFinite(model.created)
      ? model.created * 1000
      : undefined;

  return {
    id,
    label,
    description: "",
    sortKey: createdAt,
  };
}

function finalizeProviderModelOptions(
  models: readonly ProviderModelOption[],
  context: ResolvedProviderContext,
): ProviderModelOption[] {
  const uniqueModels = new Map<string, ProviderModelOption>();
  for (const model of models) {
    if (!uniqueModels.has(model.id)) {
      uniqueModels.set(model.id, model);
    }
  }

  const result = [...uniqueModels.values()].sort(
    (left, right) =>
      (right.sortKey ?? Number.NEGATIVE_INFINITY) - (left.sortKey ?? Number.NEGATIVE_INFINITY) ||
      left.id.localeCompare(right.id),
  );

  if (result.length > 0) {
    return result;
  }

  return [
    {
      id: context.model,
      label: context.model,
      description: "",
    },
  ];
}

async function fetchProviderJson<T>(options: { url: string; headers?: HeadersInit }): Promise<T> {
  const response = await fetch(options.url, {
    headers: options.headers,
  });

  if (!response.ok) {
    throw new Error(await formatProviderApiError(response));
  }

  return (await response.json()) as T;
}

async function formatProviderApiError(response: Response): Promise<string> {
  const fallback = `${response.status} ${response.statusText}`.trim();
  const text = await response.text();
  if (!text) {
    return fallback;
  }

  try {
    const payload = JSON.parse(text) as unknown;
    if (payload && typeof payload === "object") {
      const candidate = payload as Record<string, unknown>;
      const directMessage = typeof candidate["message"] === "string" ? candidate["message"] : null;
      if (directMessage) {
        return directMessage;
      }

      const errorValue = candidate["error"];
      if (errorValue && typeof errorValue === "object") {
        const errorRecord = errorValue as Record<string, unknown>;
        const nestedMessage =
          typeof errorRecord["message"] === "string" ? errorRecord["message"] : null;
        if (nestedMessage) {
          return nestedMessage;
        }
      }
    }
  } catch {
    // Fall back to the raw response body below.
  }

  return `${fallback}: ${text.trim()}`;
}

function resolveApiBaseUrl(baseUrl?: string): string {
  const resolved = baseUrl?.trim();
  if (!resolved) {
    throw new Error("A provider API base URL is required.");
  }

  return resolved.endsWith("/") ? resolved.slice(0, -1) : resolved;
}

function normalizeOpenAiBaseUrl(baseUrl: string): string {
  const normalized = baseUrl.replace(/\/+$/, "");
  return normalized.endsWith("/chat/completions")
    ? normalized.slice(0, -"/chat/completions".length)
    : normalized;
}

const REASONING_FIELD_PROVIDERS: ReadonlySet<string> = new Set(["groq", "cerebras"]);

function renameReasoningContentField(body: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(body["messages"])) {
    return body;
  }
  return {
    ...body,
    messages: body["messages"].map((message: unknown) => {
      if (
        !message ||
        typeof message !== "object" ||
        (message as { role?: unknown }).role !== "assistant" ||
        !("reasoning_content" in message)
      ) {
        return message;
      }
      const { reasoning_content, ...rest } = message as Record<string, unknown>;
      return { ...rest, reasoning: reasoning_content };
    }),
  };
}

/** The SDK appends `/messages`, so a bare host such as https://api.anthropic.com needs `/v1`. */
function normalizeAnthropicBaseUrl(baseUrl: string): string {
  const normalized = baseUrl.replace(/\/+$/, "");
  try {
    return new URL(normalized).pathname === "/" ? `${normalized}/v1` : normalized;
  } catch {
    return normalized;
  }
}

function resolveAnthropicModelsUrl(baseUrl?: string): string {
  const resolved = resolveApiBaseUrl(baseUrl);
  return resolved.endsWith("/v1") ? `${resolved}/models` : `${resolved}/v1/models`;
}

function parseDateValue(value: unknown): number | undefined {
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }

  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? undefined : timestamp;
}

function isLikelyTextModelForOpenAiCompatibleProvider(modelId: string): boolean {
  const normalized = modelId.trim().toLowerCase();
  if (!normalized) {
    return false;
  }

  if (normalized.startsWith("ft:")) {
    return isLikelyTextModelForOpenAiCompatibleProvider(normalized.slice(3));
  }

  const excludedPrefixes = [
    "dall-e-",
    "gpt-image-",
    "omni-moderation-",
    "text-embedding-",
    "text-moderation-",
    "tts-",
    "whisper-",
  ];
  if (excludedPrefixes.some((prefix) => normalized.startsWith(prefix))) {
    return false;
  }

  const excludedFragments = ["-audio-", "-realtime", "-transcribe", "-tts"];
  if (excludedFragments.some((fragment) => normalized.includes(fragment))) {
    return false;
  }

  return (
    normalized.startsWith("chatgpt-") ||
    normalized.startsWith("codex-") ||
    normalized.startsWith("gpt-") ||
    /^o\d/.test(normalized)
  );
}
