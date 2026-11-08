import {
  compactConversation,
  MAX_SUMMARY_OUTPUT_TOKENS,
  type SummaryGenerator,
} from "@deniai/flixa-core";
import { createResponse, extractOutputText, type ChatMessage } from "../flixa/api.ts";
import { generateProviderText, type ResolvedProviderContext } from "../providers/runtime.ts";

const DEFAULT_AUTO_COMPACT_CHARS = 240_000;

export interface CompactResult {
  history: ChatMessage[];
  summary: string;
  charsBefore: number;
  charsAfter: number;
}

export function estimateHistoryChars(history: readonly ChatMessage[]): number {
  return history.reduce((total, message) => total + message.content.length, 0);
}

export function getAutoCompactThreshold(): number {
  const raw = process.env.FLIXA_AUTO_COMPACT_CHARS?.trim();
  if (raw === undefined || raw === "") {
    return DEFAULT_AUTO_COMPACT_CHARS;
  }

  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_AUTO_COMPACT_CHARS;
}

export function shouldAutoCompact(history: readonly ChatMessage[]): boolean {
  const threshold = getAutoCompactThreshold();
  return threshold > 0 && history.length >= 4 && estimateHistoryChars(history) > threshold;
}

export type { SummaryGenerator };

/** Builds a summarizer bound to the provider that is serving the conversation. */
export function createSummaryGenerator(options: {
  context: ResolvedProviderContext;
  apiKey: string;
  model: string;
  baseUrl?: string;
  signal?: AbortSignal;
}): SummaryGenerator {
  return async (system, prompt) => {
    if (options.context.provider === "flixa") {
      const response = await createResponse({
        apiKey: options.apiKey,
        model: options.model,
        system,
        input: [{ role: "user", content: prompt }],
        baseUrl: options.baseUrl ?? options.context.baseUrl,
        maxOutputTokens: MAX_SUMMARY_OUTPUT_TOKENS,
        signal: options.signal,
        toolChoice: "none",
      });
      return extractOutputText(response);
    }

    const result = await generateProviderText({
      provider: options.context.provider,
      model: options.model,
      baseUrl: options.context.baseUrl,
      system,
      prompt,
      maxOutputTokens: MAX_SUMMARY_OUTPUT_TOKENS,
      signal: options.signal,
    });
    return result.text;
  };
}

export async function compactHistory(options: {
  history: readonly ChatMessage[];
  generate: SummaryGenerator;
  instructions?: string;
}): Promise<CompactResult> {
  const result = await compactConversation({
    items: options.history.map((message) => ({ role: message.role, content: message.content })),
    generate: options.generate,
    instructions: options.instructions,
    keepLatestRequest: false,
  });
  const history = result.items.map((item): ChatMessage => ({
    role: item["role"] === "assistant" ? "assistant" : "user",
    content: typeof item["content"] === "string" ? item["content"] : "",
  }));

  return {
    history,
    summary: result.summary,
    charsBefore: estimateHistoryChars(options.history),
    charsAfter: estimateHistoryChars(history),
  };
}

export function formatCompactResult(result: CompactResult): string {
  return `Compacted conversation: ${result.charsBefore.toLocaleString("en-US")} → ${result.charsAfter.toLocaleString("en-US")} characters.`;
}
