import { FlixaApiError, readFlixaApiError, resolveFlixaBaseUrl } from "@deniai/flixa-api-client";
import type { FunctionToolDefinition } from "./types";
import { isRecord, parseToolArguments } from "./util";

/** Connection settings for `/v1/agent/responses`. */
export interface ResponsesClientConfig {
  apiKey?: string;
  /** Agent base URL override (`…/v1/agent`); defaults to FLIXA_BASE_URL or production. */
  baseUrl?: string;
  /** Client identification headers from `createClientHeaders`. */
  headers?: Record<string, string>;
  fetch?: typeof fetch;
}

/** One Responses API input/output item (`{ role, content }`, `function_call`, …). */
export type ResponseItem = Record<string, unknown>;

export interface ResponseUsage {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
}

export interface FunctionCall {
  callId: string;
  name: string;
  argumentsText: string;
  input: Record<string, unknown>;
}

export interface ResponseTurn {
  id?: string;
  status?: string;
  /** Output items to append to the conversation input. */
  output: ResponseItem[];
  text: string;
  reasoning: string;
  toolCalls: FunctionCall[];
  usage?: ResponseUsage;
}

export interface ResponseRequest {
  model: string;
  input: readonly unknown[];
  instructions?: string;
  tools?: readonly FunctionToolDefinition[];
  toolChoice?: "auto" | "none";
  reasoningEffort?: string;
  maxOutputTokens?: number;
}

export interface StreamCallbacks {
  signal?: AbortSignal;
  onTextDelta?: (delta: string) => void;
  onReasoningDelta?: (delta: string) => void;
}

export function getResponsesUrl(config: ResponsesClientConfig): string {
  return `${resolveFlixaBaseUrl(config.baseUrl)}/responses`;
}

export function buildResponseBody(request: ResponseRequest, stream: boolean): ResponseItem {
  return {
    model: request.model,
    input: request.input,
    ...(request.instructions ? { instructions: request.instructions } : {}),
    ...(request.tools && request.tools.length > 0 ? { tools: request.tools } : {}),
    ...(request.toolChoice && request.tools && request.tools.length > 0
      ? { tool_choice: request.toolChoice }
      : {}),
    ...(request.maxOutputTokens ? { max_output_tokens: request.maxOutputTokens } : {}),
    ...(request.reasoningEffort
      ? { reasoning: { effort: request.reasoningEffort, context: "all_turns" } }
      : {}),
    store: false,
    include: ["reasoning.encrypted_content"],
    stream,
  };
}

async function postResponses(
  config: ResponsesClientConfig,
  body: ResponseItem,
  signal: AbortSignal | undefined,
  accept: string,
): Promise<Response> {
  const headers: Record<string, string> = {
    ...config.headers,
    "Content-Type": "application/json",
    Accept: accept,
  };
  if (config.apiKey) {
    headers["Authorization"] = `Bearer ${config.apiKey}`;
  }
  const response = await (config.fetch ?? globalThis.fetch)(getResponsesUrl(config), {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok) {
    throw await readFlixaApiError(response);
  }
  return response;
}

/** One non-streaming Responses request (summaries, safety reviews, titles). */
export async function createResponse(
  config: ResponsesClientConfig,
  request: ResponseRequest,
  options: { signal?: AbortSignal } = {},
): Promise<ResponseTurn> {
  const response = await postResponses(
    config,
    buildResponseBody(request, false),
    options.signal,
    "application/json",
  );
  const payload = (await response.json()) as unknown;
  return turnFromResponse(payload, []);
}

/** Stream one Responses request, reporting text and reasoning deltas as they arrive. */
export async function streamResponse(
  config: ResponsesClientConfig,
  request: ResponseRequest,
  callbacks: StreamCallbacks = {},
): Promise<ResponseTurn> {
  const response = await postResponses(
    config,
    buildResponseBody(request, true),
    callbacks.signal,
    "text/event-stream",
  );

  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("text/event-stream") || !response.body) {
    const payload = (await response.json()) as unknown;
    const turn = turnFromResponse(payload, []);
    if (turn.reasoning) callbacks.onReasoningDelta?.(turn.reasoning);
    if (turn.text) callbacks.onTextDelta?.(turn.text);
    return turn;
  }

  const doneItems: Array<{ index: number; item: ResponseItem }> = [];
  let finalResponse: unknown;
  let streamedText = "";
  let streamedReasoning = "";

  for await (const event of readServerSentEvents(response.body, callbacks.signal)) {
    const type = typeof event["type"] === "string" ? event["type"] : "";
    switch (type) {
      case "response.output_text.delta": {
        const delta = typeof event["delta"] === "string" ? event["delta"] : "";
        if (delta) {
          streamedText += delta;
          callbacks.onTextDelta?.(delta);
        }
        break;
      }
      case "response.reasoning_summary_text.delta":
      case "response.reasoning_text.delta":
      case "response.reasoning.delta": {
        const delta = typeof event["delta"] === "string" ? event["delta"] : "";
        if (delta) {
          streamedReasoning += delta;
          callbacks.onReasoningDelta?.(delta);
        }
        break;
      }
      case "response.output_item.done": {
        if (isRecord(event["item"])) {
          const index =
            typeof event["output_index"] === "number" ? event["output_index"] : doneItems.length;
          doneItems.push({ index, item: event["item"] });
        }
        break;
      }
      case "response.completed":
      case "response.incomplete":
      case "response.done":
        finalResponse = event["response"] ?? event;
        break;
      case "response.failed":
        throw streamError(isRecord(event["response"]) ? event["response"]["error"] : event);
      case "error":
        throw streamError(event["error"] ?? event);
      default:
        break;
    }
  }

  const fallbackItems = doneItems
    .sort((left, right) => left.index - right.index)
    .map((entry) => entry.item);
  const turn = turnFromResponse(finalResponse ?? {}, fallbackItems);
  if (turn.output.length === 0 && streamedText) {
    turn.output = [
      {
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: streamedText }],
      },
    ];
  }
  if (!turn.text && streamedText) turn.text = streamedText;
  if (!turn.reasoning && streamedReasoning) turn.reasoning = streamedReasoning;
  return turn;
}

function streamError(value: unknown): FlixaApiError {
  const error = isRecord(value) ? value : { message: String(value) };
  return new FlixaApiError({
    status: typeof error["status"] === "number" ? error["status"] : 500,
    statusText: "Response stream error",
    payload: { error },
    rawText: JSON.stringify({ error }),
  });
}

function turnFromResponse(payload: unknown, fallbackItems: ResponseItem[]): ResponseTurn {
  const record = isRecord(payload) ? payload : {};
  const output =
    Array.isArray(record["output"]) && record["output"].length > 0
      ? record["output"].filter(isRecord)
      : fallbackItems;
  const parsed = parseResponseOutput(output);
  const usage = isRecord(record["usage"]) ? (record["usage"] as ResponseUsage) : undefined;
  return {
    id: typeof record["id"] === "string" ? record["id"] : undefined,
    status: typeof record["status"] === "string" ? record["status"] : undefined,
    output,
    text:
      parsed.text ||
      (typeof record["output_text"] === "string" ? record["output_text"].trim() : ""),
    reasoning: parsed.reasoning,
    toolCalls: parsed.toolCalls,
    usage,
  };
}

/** Pull the assistant text, reasoning text, and function calls out of output items. */
export function parseResponseOutput(output: readonly unknown[]): {
  text: string;
  reasoning: string;
  toolCalls: FunctionCall[];
} {
  const textParts: string[] = [];
  const reasoningParts: string[] = [];
  const toolCalls: FunctionCall[] = [];

  for (const item of output) {
    if (!isRecord(item)) continue;
    const type = typeof item["type"] === "string" ? item["type"] : "";

    if (type === "reasoning") {
      reasoningParts.push(...textSegments(item["summary"]), ...textSegments(item["content"]));
      continue;
    }

    if (type === "function_call" && typeof item["name"] === "string") {
      const argumentsText =
        typeof item["arguments"] === "string"
          ? item["arguments"]
          : isRecord(item["arguments"])
            ? JSON.stringify(item["arguments"])
            : "{}";
      const callId =
        typeof item["call_id"] === "string"
          ? item["call_id"]
          : typeof item["id"] === "string"
            ? item["id"]
            : `call_${toolCalls.length + 1}`;
      toolCalls.push({
        callId,
        name: item["name"],
        argumentsText,
        input: parseToolArguments(argumentsText),
      });
      continue;
    }

    if (type === "message" || item["role"] === "assistant") {
      const content = item["content"];
      if (typeof content === "string") {
        if (content.trim()) textParts.push(content);
        continue;
      }
      if (!Array.isArray(content)) continue;
      for (const part of content) {
        if (!isRecord(part) || typeof part["text"] !== "string" || !part["text"]) continue;
        const partType = typeof part["type"] === "string" ? part["type"] : "";
        if (partType.includes("reasoning") || partType.includes("thinking")) {
          reasoningParts.push(part["text"]);
        } else {
          textParts.push(part["text"]);
        }
      }
    }
  }

  return {
    text: joinSegments(textParts),
    reasoning: joinSegments(reasoningParts),
    toolCalls,
  };
}

function textSegments(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((part) =>
    isRecord(part) && typeof part["text"] === "string" && part["text"] ? [part["text"]] : [],
  );
}

function joinSegments(segments: string[]): string {
  return segments
    .map((segment) => segment.trim())
    .filter(Boolean)
    .join("\n\n");
}

/** Parse a `text/event-stream` body into JSON event objects. `[DONE]` ends the stream. */
export async function* readServerSentEvents(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<Record<string, unknown>> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const onAbort = (): void => {
    void reader.cancel().catch(() => undefined);
  };
  signal?.addEventListener("abort", onAbort, { once: true });

  try {
    while (true) {
      if (signal?.aborted) {
        throw signal.reason instanceof Error ? signal.reason : abortError();
      }
      const { done, value } = await reader.read();
      if (signal?.aborted) {
        throw signal.reason instanceof Error ? signal.reason : abortError();
      }
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      buffer = buffer.replace(/\r\n?/g, "\n");

      let boundary = buffer.indexOf("\n\n");
      while (boundary !== -1) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const event = parseEventBlock(block);
        if (event === "done") return;
        if (event) yield event;
        boundary = buffer.indexOf("\n\n");
      }

      if (done) {
        const event = parseEventBlock(buffer);
        if (event && event !== "done") yield event;
        return;
      }
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
}

function parseEventBlock(block: string): Record<string, unknown> | "done" | null {
  const dataLines: string[] = [];
  let eventName: string | undefined;
  for (const line of block.split("\n")) {
    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).replace(/^ /, ""));
    } else if (line.startsWith("event:")) {
      eventName = line.slice(6).trim();
    }
  }
  if (dataLines.length === 0) return null;
  const data = dataLines.join("\n");
  if (data.trim() === "[DONE]") return "done";
  try {
    const parsed = JSON.parse(data) as unknown;
    if (!isRecord(parsed)) return null;
    if (typeof parsed["type"] !== "string" && eventName) {
      return { ...parsed, type: eventName };
    }
    return parsed;
  } catch {
    return null;
  }
}

function abortError(): Error {
  const error = new Error("Aborted");
  error.name = "AbortError";
  return error;
}
