import { createResponse, type ResponsesClientConfig } from "./responses";
import { errorMessage, isRecord } from "./util";

export const SAFETY_REVIEW_SYSTEM_PROMPT =
  'You are a security validation assistant for a developer\'s local workspace. Decide whether the supplied terminal command is safe to execute. Allow normal package managers, build tools, tests, linters, language runtimes, non-destructive git commands, and file operations inside the project. Reject system-level modifications, destructive filesystem commands, credential theft, network attacks, reverse shells, malware, data exfiltration, privilege escalation, destructive git operations, and crypto mining. Be lenient for ordinary development work. Reply with JSON only in the form {"verdict":"SAFE"|"UNSAFE","reason":"..."}.';

export interface SafetyReviewResult {
  safe: boolean;
  reason: string;
}

/** Parse `{"verdict":"SAFE"|"UNSAFE","reason":"..."}`, tolerating a Markdown code fence. */
export function parseSafetyVerdict(text: string): SafetyReviewResult {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/, "")
    .replace(/\s*```$/, "");
  try {
    const parsed = JSON.parse(cleaned) as unknown;
    if (
      isRecord(parsed) &&
      (parsed["verdict"] === "SAFE" || parsed["verdict"] === "UNSAFE") &&
      typeof parsed["reason"] === "string"
    ) {
      return { safe: parsed["verdict"] === "SAFE", reason: parsed["reason"] };
    }
  } catch {
    // Fall through.
  }
  return { safe: false, reason: "Failed to parse safety check response" };
}

/** AI review of a shell command through the Flixa Responses endpoint. Fails closed. */
export async function reviewCommandSafety(options: {
  client: ResponsesClientConfig;
  model: string;
  command: string;
  /** The model's stated reason for running the command. */
  reason?: string;
  reasoningEffort?: string;
  signal?: AbortSignal;
}): Promise<SafetyReviewResult> {
  try {
    const turn = await createResponse(
      options.client,
      {
        model: options.model,
        instructions: SAFETY_REVIEW_SYSTEM_PROMPT,
        input: [
          {
            role: "user",
            content: `Command:\n${options.command}${options.reason ? `\n\nStated reason:\n${options.reason}` : ""}`,
          },
        ],
        reasoningEffort: options.reasoningEffort,
      },
      { signal: options.signal },
    );
    return parseSafetyVerdict(turn.text);
  } catch (error) {
    return { safe: false, reason: errorMessage(error) };
  }
}
