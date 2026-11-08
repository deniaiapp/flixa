/** Error codes the Flixa / Deni AI API returns in its OpenAI-style error envelope. */
export const FLIXA_ERROR_CODES = [
  "missing_api_key",
  "invalid_key",
  "expired_key",
  "guest_account",
  "service_unavailable",
  "client_update_required",
  "missing_client_signal",
  "missing_model",
  "model_not_found",
  "tier_restricted",
  "invalid_parameter",
  "invalid_tool",
  "USAGE_LIMIT_EXCEEDED",
  "rate_limit_exceeded",
  "db_error",
  "unsupported_model",
] as const;

export type FlixaKnownErrorCode = (typeof FLIXA_ERROR_CODES)[number];

/** A known code, or any other string the server may add later. */
export type FlixaErrorCode = FlixaKnownErrorCode | (string & {});

export type UsageTier = "free" | "go" | "plus" | "pro";
export type UsageCategory = "basic" | "premium";

/** Extra fields of a `USAGE_LIMIT_EXCEEDED` error. */
export interface UsageLimitExceededDetails {
  message: string;
  type: string;
  code: "USAGE_LIMIT_EXCEEDED";
  category?: UsageCategory;
  tier?: UsageTier;
  canVerifyForBoost?: boolean;
  canUpgrade?: boolean;
  verifyUrl?: string;
  upgradeUrl?: string;
}

/** Parsed `{ error: { message, type, param, code, ... } }` envelope. */
export interface FlixaErrorEnvelope {
  message: string | null;
  type: string | null;
  param: string | null;
  code: FlixaErrorCode | null;
  /** The raw error object (envelope `error`, or the payload itself when it is flat). */
  details: Record<string, unknown>;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function isKnownFlixaErrorCode(code: unknown): code is FlixaKnownErrorCode {
  return typeof code === "string" && (FLIXA_ERROR_CODES as readonly string[]).includes(code);
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function tryParseJson(value: string | undefined | null): unknown {
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
 * Parse the OpenAI-style error envelope. Also accepts flat payloads
 * (`{ code, message }`) that some gateways return.
 */
export function parseFlixaErrorEnvelope(payload: unknown): FlixaErrorEnvelope | null {
  if (!isRecord(payload)) {
    return null;
  }

  const nested = isRecord(payload["error"]) ? payload["error"] : null;
  const source = nested ?? payload;
  const code = nonEmptyString(source["code"]) ?? (nested ? nonEmptyString(payload["code"]) : null);
  const message =
    nonEmptyString(source["message"]) ??
    (nested ? nonEmptyString(payload["message"]) : null) ??
    (typeof payload["error"] === "string" ? nonEmptyString(payload["error"]) : null);

  if (!code && !message && !nested) {
    return null;
  }

  return {
    message,
    type: nonEmptyString(source["type"]),
    param: nonEmptyString(source["param"]),
    code,
    details: source,
  };
}

/** Read the `USAGE_LIMIT_EXCEEDED` details from an error payload, if that is what it is. */
export function parseUsageLimitExceeded(payload: unknown): UsageLimitExceededDetails | null {
  if (!isRecord(payload)) {
    return null;
  }

  const error = isRecord(payload["error"]) ? payload["error"] : payload;
  if (error["code"] !== "USAGE_LIMIT_EXCEEDED") {
    return null;
  }

  const category = error["category"];
  const tier = error["tier"];
  return {
    message: typeof error["message"] === "string" ? error["message"] : "Usage limit exceeded.",
    type: typeof error["type"] === "string" ? error["type"] : "quota_exceeded",
    code: "USAGE_LIMIT_EXCEEDED",
    category: category === "basic" || category === "premium" ? category : undefined,
    tier: tier === "free" || tier === "go" || tier === "plus" || tier === "pro" ? tier : undefined,
    canVerifyForBoost:
      typeof error["canVerifyForBoost"] === "boolean" ? error["canVerifyForBoost"] : undefined,
    canUpgrade: typeof error["canUpgrade"] === "boolean" ? error["canUpgrade"] : undefined,
    verifyUrl: typeof error["verifyUrl"] === "string" ? error["verifyUrl"] : undefined,
    upgradeUrl: typeof error["upgradeUrl"] === "string" ? error["upgradeUrl"] : undefined,
  };
}

/** Parse a `Retry-After` header (seconds or HTTP date) into milliseconds. */
export function parseRetryAfterMs(
  value: string | null | undefined,
  now = Date.now(),
): number | null {
  if (!value?.trim()) {
    return null;
  }
  const seconds = Number(value);
  if (Number.isFinite(seconds)) {
    return Math.max(0, seconds * 1_000);
  }
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : null;
}

/** A failed HTTP response from the Flixa / Deni AI API. */
export class FlixaApiError extends Error {
  readonly status: number;
  readonly statusText: string;
  readonly code: FlixaErrorCode | null;
  readonly type: string | null;
  readonly param: string | null;
  /** Parsed JSON body, the raw text when it is not JSON, or null when empty. */
  readonly payload: unknown;
  readonly rawText: string;
  /** Set when `code` is `USAGE_LIMIT_EXCEEDED`. */
  readonly usageLimit: UsageLimitExceededDetails | null;
  /** From `Retry-After`, when present. */
  readonly retryAfterMs: number | null;

  constructor(options: {
    status: number;
    statusText?: string;
    payload: unknown;
    rawText?: string;
    retryAfterMs?: number | null;
  }) {
    const envelope = parseFlixaErrorEnvelope(options.payload);
    const rawText = options.rawText ?? "";
    const statusText = options.statusText ?? "";
    super(
      envelope?.message ||
        (typeof options.payload === "string" ? options.payload : "") ||
        rawText ||
        statusText ||
        `HTTP ${options.status}`,
    );
    this.name = "FlixaApiError";
    this.status = options.status;
    this.statusText = statusText;
    this.code = envelope?.code ?? null;
    this.type = envelope?.type ?? null;
    this.param = envelope?.param ?? null;
    this.payload = options.payload;
    this.rawText = rawText;
    this.usageLimit = parseUsageLimitExceeded(options.payload);
    this.retryAfterMs = options.retryAfterMs ?? null;
  }

  /** The envelope message only (no status/raw-text fallbacks). */
  get serverMessage(): string | null {
    return parseFlixaErrorEnvelope(this.payload)?.message ?? null;
  }
}

/** Read a non-ok response into a FlixaApiError. */
export async function readFlixaApiError(response: Response): Promise<FlixaApiError> {
  let rawText = "";
  try {
    rawText = await response.text();
  } catch {
    // Keep the empty body.
  }
  const parsed = tryParseJson(rawText);
  return new FlixaApiError({
    status: response.status,
    statusText: response.statusText,
    payload: parsed ?? (rawText.trim() ? rawText : null),
    rawText,
    retryAfterMs: parseRetryAfterMs(response.headers.get("retry-after")),
  });
}

const NESTED_ERROR_KEYS = ["data", "body", "responseBody", "response", "cause", "error", "value"];

/**
 * Find a Flixa error code anywhere in an error value: a FlixaApiError, an envelope, an
 * AI SDK APICallError (`responseBody`), an Error whose message is JSON, or a `cause` chain.
 */
export function findFlixaErrorCode(value: unknown, depth = 0): FlixaErrorCode | null {
  if (depth > 8 || value === null || value === undefined) {
    return null;
  }
  if (value instanceof FlixaApiError) {
    return value.code;
  }
  if (typeof value === "string") {
    const parsed = tryParseJson(value);
    return parsed === null ? null : findFlixaErrorCode(parsed, depth + 1);
  }
  if (typeof value !== "object") {
    return null;
  }

  const record = value as Record<string, unknown>;
  if (typeof record["code"] === "string") {
    return record["code"];
  }
  if (isRecord(record["error"]) && typeof record["error"]["code"] === "string") {
    return record["error"]["code"];
  }
  if (typeof record["message"] === "string") {
    const fromMessage = findFlixaErrorCode(tryParseJson(record["message"]), depth + 1);
    if (fromMessage) {
      return fromMessage;
    }
  }
  for (const key of NESTED_ERROR_KEYS) {
    const nested = findFlixaErrorCode(record[key], depth + 1);
    if (nested) {
      return nested;
    }
  }
  return null;
}

/** Find `USAGE_LIMIT_EXCEEDED` details anywhere in an error value (see findFlixaErrorCode). */
export function findUsageLimitExceeded(
  value: unknown,
  depth = 0,
): UsageLimitExceededDetails | null {
  if (depth > 8 || value === null || value === undefined) {
    return null;
  }
  if (value instanceof FlixaApiError) {
    return value.usageLimit;
  }
  if (typeof value === "string") {
    return findUsageLimitExceeded(tryParseJson(value), depth + 1);
  }
  if (typeof value !== "object") {
    return null;
  }

  const direct = parseUsageLimitExceeded(value);
  if (direct) {
    return direct;
  }

  const record = value as Record<string, unknown>;
  if (typeof record["message"] === "string") {
    const fromMessage = parseUsageLimitExceeded(tryParseJson(record["message"]));
    if (fromMessage) {
      return fromMessage;
    }
  }
  for (const key of NESTED_ERROR_KEYS) {
    const nested = findUsageLimitExceeded(record[key], depth + 1);
    if (nested) {
      return nested;
    }
  }
  return null;
}
