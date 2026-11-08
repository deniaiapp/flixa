import { createResponse, type ResponseItem, type ResponsesClientConfig } from "./responses";
import { isRecord } from "./util";

/**
 * Local (client-side) context compaction, ported from the CLI. The conversation is
 * summarized by the model with a plain Responses request and replaced by the summary, so
 * it works for every model (the server's `/responses/compact` rejects `openai/*` models).
 */

export const DEFAULT_COMPACT_TOKEN_THRESHOLD = 200_000;
// The summarizer prompt itself must fit in a context window, so very long transcripts keep
// their newest part and drop the oldest.
const MAX_TRANSCRIPT_CHARS = 400_000;
const MAX_TOOL_TEXT_CHARS = 4_000;
export const MAX_SUMMARY_OUTPUT_TOKENS = 4_000;

export const SUMMARY_SYSTEM_PROMPT = [
  "You compress a coding-assistant conversation so work can continue in a fresh context window.",
  "Write a dense, factual summary. Do not call tools and do not answer the conversation's questions again.",
  "Preserve: the user's goals and constraints, decisions made and why, files and paths touched, commands run and their outcomes, errors hit, the current state of the work, and the concrete next steps.",
  "Keep exact identifiers, file paths, and commands verbatim. Omit pleasantries and anything already resolved that no longer matters.",
].join(" ");

const SUMMARY_PREFACE = [
  "This session continues from an earlier conversation that was compacted to save context.",
  "Summary of the earlier conversation:",
].join("\n");

const SUMMARY_ACK =
  "Understood. I have the summary of the earlier conversation and will continue from it.";

export type SummaryGenerator = (system: string, prompt: string) => Promise<string>;

/** Rough token estimate: ~4 characters per token for mixed code and text. */
export function estimateTokens(value: unknown): number {
  try {
    const serialized = typeof value === "string" ? value : JSON.stringify(value ?? "");
    return serialized ? Math.ceil(serialized.length / 4) : 0;
  } catch {
    return 0;
  }
}

/** A summarizer that asks the Flixa Responses endpoint (no tools). */
export function createResponsesSummarizer(options: {
  client: ResponsesClientConfig;
  model: string;
  signal?: AbortSignal;
}): SummaryGenerator {
  return async (system, prompt) => {
    const turn = await createResponse(
      options.client,
      {
        model: options.model,
        instructions: system,
        input: [{ role: "user", content: prompt }],
        maxOutputTokens: MAX_SUMMARY_OUTPUT_TOKENS,
      },
      { signal: options.signal },
    );
    return turn.text;
  };
}

export interface CompactResult {
  items: ResponseItem[];
  summary: string;
  tokensBefore: number;
  tokensAfter: number;
}

/**
 * Summarize a conversation. The latest user request and everything after it are kept
 * verbatim when they are small enough, so the model can keep working on it.
 */
export async function compactConversation(options: {
  items: readonly unknown[];
  generate: SummaryGenerator;
  /** Extra focus from the user (`/compact <instructions>`). */
  instructions?: string;
  /** Keep the latest user request and later items verbatim. Defaults to true. */
  keepLatestRequest?: boolean;
  /** Token budget for the kept tail; defaults to a quarter of the transcript. */
  maxTailTokens?: number;
}): Promise<CompactResult> {
  const items = options.items.filter(isRecord);
  if (items.length < 2) {
    throw new Error("Nothing to compact yet.");
  }

  const tokensBefore = estimateTokens(items);
  let head = items;
  let tail: ResponseItem[] = [];
  if (options.keepLatestRequest !== false) {
    const lastUser = findLastUserMessageIndex(items);
    const maxTail = options.maxTailTokens ?? Math.floor(tokensBefore / 4);
    if (lastUser > 0) {
      const candidate = items.slice(lastUser);
      if (estimateTokens(candidate) <= maxTail) {
        head = items.slice(0, lastUser);
        tail = candidate;
      }
    }
  }

  const focus = options.instructions?.trim();
  const prompt = [
    "Summarize the conversation below.",
    ...(focus ? [`Extra focus from the user: ${focus}`] : []),
    "",
    "<conversation>",
    renderTranscript(head),
    "</conversation>",
  ].join("\n");

  const summary = (await options.generate(SUMMARY_SYSTEM_PROMPT, prompt)).trim();
  if (!summary) {
    throw new Error("The model returned an empty summary.");
  }

  const compacted: ResponseItem[] =
    tail.length > 0
      ? [
          { role: "user", content: `${SUMMARY_PREFACE}\n\n${summary}` },
          { role: "assistant", content: SUMMARY_ACK },
          ...tail,
        ]
      : endsWithAssistantTurn(items)
        ? [
            { role: "user", content: `${SUMMARY_PREFACE}\n\n${summary}` },
            { role: "assistant", content: SUMMARY_ACK },
          ]
        : [
            {
              role: "user",
              content: `${SUMMARY_PREFACE}\n\n${summary}\n\nContinue the work described above from where it stopped.`,
            },
          ];

  return {
    items: compacted,
    summary,
    tokensBefore,
    tokensAfter: estimateTokens(compacted),
  };
}

function findLastUserMessageIndex(items: readonly ResponseItem[]): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item && item["role"] === "user" && item["type"] !== "function_call_output") {
      return index;
    }
  }
  return -1;
}

function endsWithAssistantTurn(items: readonly ResponseItem[]): boolean {
  const last = items[items.length - 1];
  return !!last && last["role"] === "assistant";
}

/** Render Responses items as a plain-text transcript for the summarizer. */
export function renderTranscript(items: readonly ResponseItem[]): string {
  const blocks: string[] = [];
  for (const item of items) {
    const type = typeof item["type"] === "string" ? item["type"] : "";
    if (type === "function_call") {
      blocks.push(
        `Assistant called tool ${String(item["name"])}:\n${clip(String(item["arguments"] ?? "{}"))}`,
      );
      continue;
    }
    if (type === "function_call_output") {
      blocks.push(`Tool result:\n${clip(stringifyContent(item["output"]))}`);
      continue;
    }
    if (type === "reasoning" || type === "compaction") {
      continue;
    }
    const role = item["role"];
    if (role === "user" || role === "assistant" || role === "system" || role === "developer") {
      const text = stringifyContent(item["content"]).trim();
      if (text) {
        blocks.push(
          `${role === "user" ? "User" : role === "assistant" ? "Assistant" : "System"}:\n${text}`,
        );
      }
    }
  }

  const rendered = blocks.join("\n\n");
  if (rendered.length <= MAX_TRANSCRIPT_CHARS) {
    return rendered;
  }
  return `[Earlier messages omitted]\n${rendered.slice(-MAX_TRANSCRIPT_CHARS)}`;
}

function stringifyContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (isRecord(part) && typeof part["text"] === "string") return part["text"];
        return "";
      })
      .join("");
  }
  if (content === undefined || content === null) return "";
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

function clip(value: string): string {
  return value.length > MAX_TOOL_TEXT_CHARS
    ? `${value.slice(0, MAX_TOOL_TEXT_CHARS)}\n...truncated...`
    : value;
}
