import { generateText, jsonSchema, streamText, tool, type ModelMessage } from "ai";
import { createOpenResponses } from "@ai-sdk/open-responses";
import { getApiKey } from "../auth/service.ts";
import { assertSecureBaseUrl } from "../security/url.ts";
import { formatFlixaHttpError, rethrowAsUserFacingFlixaError } from "../http/flixaApiErrors.ts";
import {
  createFlixaFetch,
  flixaFetch,
  getFlixaCliClientHeaders,
} from "../http/flixaClientHeaders.ts";

export const DEFAULT_FLIXA_BASE_URL =
  process.env.FLIXA_BASE_URL?.trim() || "https://flixa-api.deniai.app/v1/agent";
export const DEFAULT_FLIXA_MODEL =
  process.env.FLIXA_MODEL?.trim() || process.env.OPENAI_MODEL?.trim() || "openai/gpt-5.6-sol";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ResponseMessageInputItem {
  role: "user" | "assistant" | "system";
  content: string;
}

export interface FunctionCallOutputInputItem {
  type: "function_call_output";
  call_id: string;
  output: string;
}

export type ResponseInputItem = ResponseMessageInputItem | FunctionCallOutputInputItem;

export interface FunctionToolDefinition {
  type: "function";
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface FlixaResponseOutputContent {
  type?: string;
  text?: string;
}

export interface FlixaResponseOutputItem {
  type?: string;
  content?: FlixaResponseOutputContent[];
  summary?: FlixaResponseOutputContent[];
  id?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
}

export interface FlixaResponse {
  id?: string;
  output?: FlixaResponseOutputItem[];
  output_text?: string;
}

export interface CreateResponseOptions {
  apiKey: string;
  model: string;
  messages?: ChatMessage[];
  input?: ResponseInputItem[];
  system?: string;
  stream?: boolean;
  baseUrl?: string;
  maxOutputTokens?: number;
  signal?: AbortSignal;
  previousResponseId?: string;
  tools?: FunctionToolDefinition[];
  toolChoice?: "auto" | "none";
}

export type FlixaModelTier = "free" | "plus" | "pro" | "max";

export interface FlixaModelDefinition {
  id: string;
  label: string;
  description: string;
  tags: string[];
  premium?: boolean;
  tier: FlixaModelTier;
}

export interface AnthropicCompatibleModelDefinition {
  type: "model";
  id: string;
  display_name: string;
}

export interface AnthropicCompatibleModelList {
  data: AnthropicCompatibleModelDefinition[];
  has_more: boolean;
  first_id: string | null;
  last_id: string | null;
}

export interface DeniUsageBucket {
  category: "basic" | "premium";
  unit: "requests" | "tokens";
  limit: number | null;
  used: number;
  remaining: number | null;
  periodStart: string;
  periodEnd: string | null;
}

export interface DeniUsageInfo {
  tier: FlixaModelTier;
  planId: string | null;
  status: string | null;
  isTeam: boolean;
  periodEnd: string | null;
  maxModeEnabled: boolean;
  maxModeEligible: boolean;
  usage: DeniUsageBucket[];
}

export interface StreamResponseResult {
  text: string;
  response?: FlixaResponse;
}

export interface FlixaResponseDisplayParts {
  assistantText: string;
  thinkingText: string;
}

export interface GeneratedResponseTurn {
  assistantText: string;
  thinkingText?: string;
  toolCalls: Array<{
    callId: string;
    name: string;
    argumentsText: string;
  }>;
  responseMessages: ModelMessage[];
  response: FlixaResponse;
}

export function resolveFlixaApiKey(): string | null {
  const envApiKey = process.env.FLIXA_API_KEY?.trim();
  if (envApiKey) return envApiKey;

  const openAiCompatibleApiKey = process.env.OPENAI_API_KEY?.trim();
  if (openAiCompatibleApiKey) return openAiCompatibleApiKey;

  return getApiKey("flixa");
}

export async function fetchAvailableModels(options: {
  apiKey: string;
  baseUrl?: string;
}): Promise<FlixaModelDefinition[]> {
  const response = await flixaFetch(`${resolveApiRoot(options.baseUrl)}/models`, {
    headers: {
      Authorization: `Bearer ${options.apiKey}`,
    },
  });

  if (!response.ok) {
    throw new Error(await formatFlixaHttpError(response));
  }

  const payload = (await response.json()) as unknown;
  return extractModelDefinitions(payload);
}

export async function fetchDeniUsage(options: {
  apiKey: string;
  baseUrl?: string;
}): Promise<DeniUsageInfo> {
  const response = await flixaFetch(`${resolveApiRoot(options.baseUrl)}/deni/usage`, {
    headers: {
      Authorization: `Bearer ${options.apiKey}`,
    },
  });

  if (!response.ok) {
    throw new Error(await formatFlixaHttpError(response));
  }

  return (await response.json()) as DeniUsageInfo;
}

export async function createResponse(options: CreateResponseOptions): Promise<FlixaResponse> {
  if (options.previousResponseId) {
    throw new Error(
      "previousResponseId is not supported here. Resend the full conversation instead.",
    );
  }

  const messages = buildModelMessages(options);
  const result = await generateResponseTurn({
    apiKey: options.apiKey,
    model: options.model,
    messages,
    system: options.system,
    baseUrl: options.baseUrl,
    maxOutputTokens: options.maxOutputTokens,
    signal: options.signal,
    tools: options.tools,
    toolChoice: options.toolChoice,
  });

  return result.response;
}

export async function streamResponse(
  options: CreateResponseOptions,
  onText: (delta: string) => void,
): Promise<StreamResponseResult> {
  if (options.previousResponseId) {
    throw new Error(
      "previousResponseId is not supported here. Resend the full conversation instead.",
    );
  }

  try {
    const messages = buildModelMessages(options);
    const aiTools = buildAiSdkTools(options.tools);
    const model = createResponsesModel(options);
    const result = streamText({
      model,
      messages,
      system: options.system,
      maxOutputTokens: options.maxOutputTokens,
      abortSignal: options.signal,
      maxRetries: 0,
      ...(aiTools
        ? {
            tools: aiTools,
            toolChoice: (options.toolChoice ?? "auto") as "auto" | "none",
          }
        : {}),
    });

    let text = "";
    for await (const delta of result.textStream) {
      text += delta;
      onText(delta);
    }

    return { text };
  } catch (error) {
    rethrowAsUserFacingFlixaError(error);
  }
}

export async function generateResponseTurn(options: {
  apiKey: string;
  model: string;
  messages: ModelMessage[];
  system?: string;
  baseUrl?: string;
  maxOutputTokens?: number;
  signal?: AbortSignal;
  tools?: FunctionToolDefinition[];
  toolChoice?: "auto" | "none";
}): Promise<GeneratedResponseTurn> {
  try {
    const aiTools = buildAiSdkTools(options.tools);
    const result = await generateText({
      model: createResponsesModel(options),
      messages: options.messages,
      system: options.system,
      maxOutputTokens: options.maxOutputTokens,
      abortSignal: options.signal,
      maxRetries: 0,
      ...(aiTools
        ? {
            tools: aiTools,
            toolChoice: (options.toolChoice ?? "auto") as "auto" | "none",
          }
        : {}),
    });

    return {
      assistantText: result.text,
      thinkingText: result.reasoningText ?? undefined,
      toolCalls: result.toolCalls.map((toolCall) => ({
        callId: toolCall.toolCallId,
        name: toolCall.toolName,
        argumentsText:
          typeof toolCall.input === "string" ? toolCall.input : JSON.stringify(toolCall.input),
      })),
      responseMessages: result.response.messages as ModelMessage[],
      response: coerceFlixaResponse(
        result.response.body,
        result.response.id,
        result.text,
        result.reasoningText,
        result.toolCalls.map((toolCall) => ({
          callId: toolCall.toolCallId,
          name: toolCall.toolName,
          argumentsText:
            typeof toolCall.input === "string" ? toolCall.input : JSON.stringify(toolCall.input),
        })),
      ),
    };
  } catch (error) {
    rethrowAsUserFacingFlixaError(error);
  }
}

export function createResponsesModel(options: { apiKey: string; model: string; baseUrl?: string }) {
  return createOpenResponses({
    name: "flixa",
    url: `${resolveBaseUrl(options.baseUrl)}/responses`,
    apiKey: options.apiKey,
    headers: getFlixaCliClientHeaders(),
    fetch: createFlixaFetch(),
  })(options.model);
}

export function buildAiSdkTools(
  tools?: FunctionToolDefinition[],
): Record<string, ReturnType<typeof tool>> | undefined {
  if (!tools || tools.length === 0) {
    return undefined;
  }

  return Object.fromEntries(
    tools.map((toolDefinition) => [
      toolDefinition.name,
      tool({
        description: toolDefinition.description,
        inputSchema: jsonSchema(toolDefinition.parameters as never),
      }),
    ]),
  );
}

export function chatHistoryToModelMessages(history: ChatMessage[]): ModelMessage[] {
  return history.map((message) => ({
    role: message.role,
    content: message.content,
  }));
}

export function createToolResultMessage(
  results: Array<{
    callId: string;
    name: string;
    output: string;
  }>,
): ModelMessage {
  return {
    role: "tool",
    content: results.map((result) => ({
      type: "tool-result" as const,
      toolCallId: result.callId,
      toolName: result.name,
      output: {
        type: "text" as const,
        value: result.output,
      },
    })),
  };
}

export function extractOutputText(response: FlixaResponse): string {
  return extractResponseDisplayParts(response).assistantText;
}

export function extractThinkingText(response: FlixaResponse): string {
  return extractResponseDisplayParts(response).thinkingText;
}

export function extractFunctionCalls(response: FlixaResponse): Array<{
  id?: string;
  callId: string;
  name: string;
  argumentsText: string;
}> {
  return (response.output ?? [])
    .filter(
      (item) =>
        item.type === "function_call" &&
        typeof item.call_id === "string" &&
        typeof item.name === "string",
    )
    .map((item) => ({
      id: item.id,
      callId: item.call_id as string,
      name: item.name as string,
      argumentsText: typeof item.arguments === "string" ? item.arguments : "{}",
    }));
}

function buildModelMessages(options: CreateResponseOptions): ModelMessage[] {
  if (options.messages) {
    return chatHistoryToModelMessages(options.messages);
  }

  if (!options.input) {
    throw new Error("No input messages provided.");
  }

  return options.input.map((item) => {
    if ("type" in item) {
      throw new Error(
        "function_call_output is not supported here. Resend the full conversation instead.",
      );
    }

    return {
      role: item.role,
      content: item.content,
    };
  });
}

function coerceFlixaResponse(
  value: unknown,
  id: string | undefined,
  text: string,
  thinkingText: string | undefined,
  toolCalls: Array<{
    callId: string;
    name: string;
    argumentsText: string;
  }>,
): FlixaResponse {
  if (isFlixaResponse(value)) {
    return value;
  }

  const output: FlixaResponseOutputItem[] = [];

  if (thinkingText?.trim()) {
    output.push({
      type: "reasoning",
      content: [{ type: "reasoning", text: thinkingText.trim() }],
    });
  }

  if (text.trim()) {
    output.push({
      type: "message",
      content: [{ type: "output_text", text: text.trim() }],
    });
  }

  for (const toolCall of toolCalls) {
    output.push({
      type: "function_call",
      call_id: toolCall.callId,
      name: toolCall.name,
      arguments: toolCall.argumentsText,
    });
  }

  return {
    id,
    output,
    output_text: text,
  };
}

function resolveBaseUrl(baseUrl?: string): string {
  return assertSecureBaseUrl(baseUrl?.trim() || DEFAULT_FLIXA_BASE_URL).replace(/\/+$/, "");
}

export function resolveApiRoot(baseUrl?: string): string {
  const normalizedBaseUrl = resolveBaseUrl(baseUrl);
  return normalizedBaseUrl.endsWith("/agent")
    ? normalizedBaseUrl.slice(0, -"/agent".length)
    : normalizedBaseUrl;
}

function isFlixaResponse(value: unknown): value is FlixaResponse {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as { output?: unknown; output_text?: unknown };
  return Array.isArray(candidate.output) || typeof candidate.output_text === "string";
}

function extractResponseDisplayParts(response: FlixaResponse): FlixaResponseDisplayParts {
  const outputItems = response.output ?? [];
  const thinkingSegments: string[] = [];
  const assistantSegments: string[] = [];

  for (const item of outputItems) {
    const itemType = normalizeItemType(item.type);
    const content = item.content ?? [];
    const summary = item.summary ?? [];

    if (itemType === "reasoning" || itemType === "thinking") {
      thinkingSegments.push(...extractTextSegments(summary), ...extractTextSegments(content));
      continue;
    }

    if (itemType === "message" || itemType === "output") {
      assistantSegments.push(...extractNonThinkingContent(content));
      thinkingSegments.push(...extractThinkingContent(content));
      continue;
    }

    assistantSegments.push(...extractNonThinkingContent(content));
    thinkingSegments.push(...extractTextSegments(summary), ...extractThinkingContent(content));
  }

  if (
    assistantSegments.length === 0 &&
    typeof response.output_text === "string" &&
    response.output_text.length > 0
  ) {
    assistantSegments.push(response.output_text);
  }

  return {
    assistantText: joinSegments(assistantSegments),
    thinkingText: joinSegments(thinkingSegments),
  };
}

function extractNonThinkingContent(contentItems: FlixaResponseOutputContent[]): string[] {
  return contentItems
    .filter((content) => !isThinkingType(content.type))
    .flatMap((content) =>
      typeof content.text === "string" && content.text.length > 0 ? [content.text] : [],
    );
}

function extractThinkingContent(contentItems: FlixaResponseOutputContent[]): string[] {
  return contentItems
    .filter((content) => isThinkingType(content.type))
    .flatMap((content) =>
      typeof content.text === "string" && content.text.length > 0 ? [content.text] : [],
    );
}

function extractTextSegments(contentItems: FlixaResponseOutputContent[]): string[] {
  return contentItems.flatMap((content) =>
    typeof content.text === "string" && content.text.length > 0 ? [content.text] : [],
  );
}

function normalizeItemType(value: string | undefined): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function isThinkingType(value: string | undefined): boolean {
  const normalized = normalizeItemType(value);
  return (
    normalized.includes("reasoning") ||
    normalized.includes("thinking") ||
    normalized.includes("summary")
  );
}

function joinSegments(segments: string[]): string {
  return segments
    .map((segment) => segment.trim())
    .filter(Boolean)
    .join("\n\n");
}

function extractModelDefinitions(payload: unknown): FlixaModelDefinition[] {
  if (Array.isArray(payload)) {
    return payload.filter(isFlixaModelDefinition);
  }

  if (!payload || typeof payload !== "object") {
    throw new Error("Unexpected models response format.");
  }

  const wrappedData = (payload as { data?: unknown }).data;
  if (!Array.isArray(wrappedData)) {
    throw new Error("Unexpected models response format.");
  }

  if (wrappedData.every(isFlixaModelDefinition)) {
    return wrappedData;
  }

  if (wrappedData.every(isAnthropicCompatibleModelDefinition)) {
    return wrappedData.map((model) => ({
      id: model.id,
      label: model.display_name,
      description: "",
      tags: ["anthropic-compatible"],
      tier: "free",
    }));
  }

  throw new Error("Unexpected models response format.");
}

function isFlixaModelDefinition(value: unknown): value is FlixaModelDefinition {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate["id"] === "string" &&
    typeof candidate["label"] === "string" &&
    typeof candidate["description"] === "string" &&
    Array.isArray(candidate["tags"]) &&
    typeof candidate["tier"] === "string"
  );
}

function isAnthropicCompatibleModelDefinition(
  value: unknown,
): value is AnthropicCompatibleModelDefinition {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    candidate["type"] === "model" &&
    typeof candidate["id"] === "string" &&
    typeof candidate["display_name"] === "string"
  );
}
