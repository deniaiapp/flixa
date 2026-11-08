import { createResponse, extractOutputText, type ChatMessage } from "../flixa/api.ts";
import { generateProviderText, type ResolvedProviderContext } from "../providers/runtime.ts";

const DEFAULT_AUTO_COMPACT_CHARS = 240_000;
// The summarizer prompt itself must fit in a context window, so very long
// transcripts keep their newest part and drop the oldest.
const MAX_TRANSCRIPT_CHARS = 400_000;
const MAX_SUMMARY_OUTPUT_TOKENS = 4_000;

const SUMMARY_SYSTEM_PROMPT = [
  "You compress a coding-assistant conversation so work can continue in a fresh context window.",
  "Write a dense, factual summary. Do not call tools and do not answer the conversation's questions again.",
  "Preserve: the user's goals and constraints, decisions made and why, files and paths touched, commands run and their outcomes, errors hit, the current state of the work, and the concrete next steps.",
  "Keep exact identifiers, file paths, and commands verbatim. Omit pleasantries and anything already resolved that no longer matters.",
].join(" ");

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

export type SummaryGenerator = (system: string, prompt: string) => Promise<string>;

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
  if (options.history.length < 2) {
    throw new Error("Nothing to compact yet.");
  }

  const focus = options.instructions?.trim();
  const prompt = [
    "Summarize the conversation below.",
    ...(focus ? [`Extra focus from the user: ${focus}`] : []),
    "",
    "<conversation>",
    renderTranscript(options.history),
    "</conversation>",
  ].join("\n");

  const summary = (await options.generate(SUMMARY_SYSTEM_PROMPT, prompt)).trim();
  if (!summary) {
    throw new Error("The model returned an empty summary.");
  }

  const history: ChatMessage[] = [
    {
      role: "user",
      content: [
        "This session continues from an earlier conversation that was compacted to save context.",
        "Summary of the earlier conversation:",
        "",
        summary,
      ].join("\n"),
    },
    {
      role: "assistant",
      content:
        "Understood. I have the summary of the earlier conversation and will continue from it.",
    },
  ];

  return {
    history,
    summary,
    charsBefore: estimateHistoryChars(options.history),
    charsAfter: estimateHistoryChars(history),
  };
}

function renderTranscript(history: readonly ChatMessage[]): string {
  const rendered = history
    .map((message) => `${message.role === "user" ? "User" : "Assistant"}:\n${message.content}`)
    .join("\n\n");

  if (rendered.length <= MAX_TRANSCRIPT_CHARS) {
    return rendered;
  }

  return `[Earlier messages omitted]\n${rendered.slice(-MAX_TRANSCRIPT_CHARS)}`;
}

export function formatCompactResult(result: CompactResult): string {
  return `Compacted conversation: ${result.charsBefore.toLocaleString("en-US")} → ${result.charsAfter.toLocaleString("en-US")} characters.`;
}
