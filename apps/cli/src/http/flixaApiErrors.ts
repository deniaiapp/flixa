import { APICallError } from "@ai-sdk/provider";
import { FlixaApiError, parseFlixaErrorEnvelope, tryParseJson } from "@deniai/flixa-api-client";
import { getFlixaCliClientHeaders } from "./flixaClientHeaders.ts";

const SERVICE_UNAVAILABLE_FALLBACK =
  "Deni AI Flixa is currently unavailable. Please contact us at contact@deniai.app.";
const CLIENT_UPDATE_REQUIRED_FALLBACK = "Please update your Deni AI Flixa to continue.";
const INVALID_KEY_FALLBACK = "API key is invalid or expired. Run `flixa login` to re-authenticate.";

/**
 * Format a failed Flixa HTTP response for CLI display.
 * Maps abuse / ban / update codes to stable user-facing copy.
 */
export function formatFlixaApiError(error: FlixaApiError): string {
  const statusLine = `Flixa API request failed: ${error.status} ${error.statusText}`;
  const mapped = mapFlixaErrorPayload({
    status: error.status,
    payload: error.payload,
    rawText: error.rawText,
  });
  if (mapped) {
    return mapped;
  }

  const message = parseFlixaErrorEnvelope(error.payload)?.message;
  if (message) {
    return `${statusLine} - ${message}`;
  }

  if (error.rawText.trim()) {
    return `${statusLine} - ${error.rawText.trim()}`;
  }

  return statusLine;
}

/** Re-throw FlixaApiError from the shared client as a CLI-formatted Error. */
export function rethrowFormattedFlixaApiError(error: unknown): never {
  if (error instanceof FlixaApiError) {
    throw new Error(formatFlixaApiError(error), { cause: error });
  }
  throw error;
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
  const envelope = parseFlixaErrorEnvelope(options.payload);
  const code = envelope?.code ?? null;
  const message = envelope?.message ?? null;

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
