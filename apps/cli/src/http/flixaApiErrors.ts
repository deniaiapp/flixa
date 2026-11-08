import { APICallError } from "@ai-sdk/provider";
import { getFlixaCliClientHeaders } from "./flixaClientHeaders.ts";

const SERVICE_UNAVAILABLE_FALLBACK =
  "Deni AI Flixa is currently unavailable. Please contact us at contact@deniai.app.";
const CLIENT_UPDATE_REQUIRED_FALLBACK = "Please update your Deni AI Flixa to continue.";
const INVALID_KEY_FALLBACK = "API key is invalid or expired. Run `flixa login` to re-authenticate.";

export type FlixaPublicErrorCode =
  | "service_unavailable"
  | "client_update_required"
  | "invalid_key"
  | "expired_key"
  | string;

/**
 * Format a failed Flixa HTTP response for CLI display.
 * Maps abuse / ban / update codes to stable user-facing copy.
 */
export async function formatFlixaHttpError(response: Response): Promise<string> {
  const statusLine = `Flixa API request failed: ${response.status} ${response.statusText}`;
  let payload: unknown = null;
  let rawText = "";

  try {
    rawText = await response.text();
    if (rawText.trim()) {
      payload = JSON.parse(rawText) as unknown;
    }
  } catch {
    // Keep raw text / empty payload.
  }

  const mapped = mapFlixaErrorPayload({
    status: response.status,
    payload,
    rawText,
  });
  if (mapped) {
    return mapped;
  }

  const message = extractErrorMessage(payload);
  if (message) {
    return `${statusLine} - ${message}`;
  }

  if (rawText.trim()) {
    return `${statusLine} - ${rawText.trim()}`;
  }

  return statusLine;
}

/**
 * Map AI SDK / generic errors to user-facing Flixa messages when possible.
 */
export function toUserFacingFlixaErrorMessage(error: unknown): string {
  for (const candidate of walkErrorChain(error)) {
    if (APICallError.isInstance(candidate)) {
      const mapped = mapFlixaErrorPayload({
        status: candidate.statusCode,
        payload: tryParseJson(candidate.responseBody),
        rawText: candidate.responseBody ?? "",
      });
      if (mapped) {
        return mapped;
      }
    }
  }

  if (error instanceof Error && error.message.trim()) {
    return error.message.trim();
  }

  return String(error);
}

function walkErrorChain(error: unknown): unknown[] {
  const seen = new Set<unknown>();
  const chain: unknown[] = [];
  let current: unknown = error;

  while (current && !seen.has(current)) {
    seen.add(current);
    chain.push(current);
    if (current instanceof Error && current.cause !== undefined) {
      current = current.cause;
      continue;
    }
    break;
  }

  return chain;
}

/**
 * Re-throw AI SDK failures with a clearer Flixa-facing message when codes match.
 */
export function rethrowAsUserFacingFlixaError(error: unknown): never {
  const message = toUserFacingFlixaErrorMessage(error);
  if (error instanceof Error && error.message === message) {
    throw error;
  }
  throw new Error(message, { cause: error instanceof Error ? error : undefined });
}

function mapFlixaErrorPayload(options: {
  status?: number;
  payload: unknown;
  rawText: string;
}): string | null {
  const code = extractErrorCode(options.payload);
  const message = extractErrorMessage(options.payload);

  if (options.status === 403 && code === "service_unavailable") {
    logClientSignalSelfCheck();
    return message?.trim() || SERVICE_UNAVAILABLE_FALLBACK;
  }

  if (options.status === 403 && code === "client_update_required") {
    return (
      message?.trim() ||
      `${CLIENT_UPDATE_REQUIRED_FALLBACK} Update the CLI (e.g. \`npm update -g @deniai/flixa\`) and try again.`
    );
  }

  if (options.status === 401 && (code === "invalid_key" || code === "expired_key")) {
    return message?.trim() || INVALID_KEY_FALLBACK;
  }

  // Some gateways only put the public code in the body without a nested error object.
  if (options.status === 403 && !code) {
    const lowered = `${message ?? ""}\n${options.rawText}`.toLowerCase();
    if (
      lowered.includes("client_update_required") ||
      lowered.includes("update your deni ai flixa")
    ) {
      return message?.trim() || CLIENT_UPDATE_REQUIRED_FALLBACK;
    }
    if (lowered.includes("service_unavailable") || lowered.includes("currently unavailable")) {
      logClientSignalSelfCheck();
      return message?.trim() || SERVICE_UNAVAILABLE_FALLBACK;
    }
  }

  return null;
}

function extractErrorCode(payload: unknown): FlixaPublicErrorCode | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const record = payload as Record<string, unknown>;
  if (typeof record["code"] === "string" && record["code"].trim()) {
    return record["code"].trim();
  }

  const error = record["error"];
  if (error && typeof error === "object") {
    const nested = (error as Record<string, unknown>)["code"];
    if (typeof nested === "string" && nested.trim()) {
      return nested.trim();
    }
  }

  return null;
}

function extractErrorMessage(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const record = payload as Record<string, unknown>;
  if (typeof record["message"] === "string" && record["message"].trim()) {
    return record["message"].trim();
  }

  const error = record["error"];
  if (error && typeof error === "object") {
    const nested = (error as Record<string, unknown>)["message"];
    if (typeof nested === "string" && nested.trim()) {
      return nested.trim();
    }
  }

  return null;
}

function tryParseJson(value: string | undefined): unknown {
  if (!value?.trim()) {
    return null;
  }

  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

/**
 * On ban / missing-signal 403, log which client headers this CLI version would send.
 * Never logs API keys or Authorization.
 */
function logClientSignalSelfCheck(): void {
  const headers = getFlixaCliClientHeaders();
  console.error(
    "[flixa] client signal self-check (no API key): " +
      JSON.stringify({
        "User-Agent": headers["User-Agent"],
        "x-client": headers["x-client"],
        "x-flixa-client": headers["x-flixa-client"],
        originator: headers["originator"],
      }),
  );
}
