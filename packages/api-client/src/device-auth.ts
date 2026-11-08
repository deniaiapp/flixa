import { FlixaApiError, isRecord } from "./errors";
import { requestJson, type FlixaRequestOptions } from "./http";
import { getDeviceAuthVerificationUrl, resolveDeniAiBaseUrl } from "./urls";

export const DEVICE_AUTH_POLL_INTERVAL_MS = 5_000;
export const DEVICE_AUTH_MAX_TIMEOUT_MS = 15 * 60 * 1_000;
export const DEVICE_AUTH_MAX_CONSECUTIVE_FAILURES = 5;
const DEVICE_AUTH_REQUEST_TIMEOUT_MS = 15_000;

export interface DeviceAuthOptions extends FlixaRequestOptions {
  /** Deni AI web app base URL. Defaults to `DENI_AI_BASE_URL` or https://deniai.app. */
  deniAiBaseUrl?: string;
}

export interface DeviceAuthSession {
  userCode: string;
  deviceCode: string;
  /** Seconds until the device code expires (the server uses 900). */
  expiresIn: number;
  /** `{deniAi}/flixa/authorize?code=<userCode>` */
  verificationUrl: string;
}

/** One API key listed in an `API_KEY_LIMIT_REACHED` response. */
export interface DeviceAuthApiKeySummary {
  id: string;
  name: string | null;
  keyPrefix: string | null;
  lastUsedAt: string | null;
  createdAt: string | null;
}

export type DeviceAuthPollResult =
  | { status: "pending" }
  | { status: "approved"; apiKey: string; apiKeyId: string | null }
  /** Approved, but the server did not return a key (it can only be delivered once). */
  | { status: "api_key_unavailable" }
  /** The account already has the maximum number of API keys. */
  | { status: "api_key_limit_reached"; message: string; apiKeys: DeviceAuthApiKeySummary[] }
  | { status: "invalid_code" }
  | { status: "expired" }
  | { status: "rate_limited"; retryAfterMs: number | null };

export type DeviceAuthOutcome =
  | { status: "approved"; apiKey: string; apiKeyId: string | null }
  | { status: "api_key_unavailable" }
  | { status: "api_key_limit_reached"; message: string; apiKeys: DeviceAuthApiKeySummary[] }
  | { status: "invalid_code" }
  | { status: "expired" }
  | { status: "timed_out" }
  | { status: "cancelled" }
  /** Polling kept failing (network or server errors). */
  | { status: "error"; error: unknown };

function deviceAuthUrl(deniAiBaseUrl?: string): string {
  return `${resolveDeniAiBaseUrl(deniAiBaseUrl)}/api/device-auth`;
}

function withDefaultTimeout(options: FlixaRequestOptions): FlixaRequestOptions {
  return { ...options, timeoutMs: options.timeoutMs ?? DEVICE_AUTH_REQUEST_TIMEOUT_MS };
}

/** `POST {deniAi}/api/device-auth {action:"initiate"}` */
export async function initiateDeviceAuth(
  options: DeviceAuthOptions = {},
): Promise<DeviceAuthSession> {
  const { payload } = await requestJson(
    deviceAuthUrl(options.deniAiBaseUrl),
    { method: "POST", body: { action: "initiate" } },
    withDefaultTimeout(options),
  );

  if (
    !isRecord(payload) ||
    typeof payload["userCode"] !== "string" ||
    typeof payload["deviceCode"] !== "string"
  ) {
    throw new Error("Device auth response is invalid");
  }

  const expiresIn = payload["expiresIn"];
  return {
    userCode: payload["userCode"],
    deviceCode: payload["deviceCode"],
    expiresIn: typeof expiresIn === "number" && Number.isFinite(expiresIn) ? expiresIn : 900,
    verificationUrl: getDeviceAuthVerificationUrl(payload["userCode"], options.deniAiBaseUrl),
  };
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function parseApiKeySummaries(value: unknown): DeviceAuthApiKeySummary[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(isRecord).map((key) => ({
    id: typeof key["id"] === "string" ? key["id"] : String(key["id"] ?? ""),
    name: nullableString(key["name"]),
    keyPrefix: nullableString(key["keyPrefix"]),
    lastUsedAt: nullableString(key["lastUsedAt"]),
    createdAt: nullableString(key["createdAt"]),
  }));
}

/**
 * `POST {deniAi}/api/device-auth {action:"poll", deviceCode}` once. Known outcomes
 * (pending, approved, key unavailable, key limit, invalid/expired code, rate limit) are
 * returned; other HTTP and network failures throw.
 */
export async function pollDeviceAuth(
  deviceCode: string,
  options: DeviceAuthOptions = {},
): Promise<DeviceAuthPollResult> {
  let payload: unknown;
  try {
    ({ payload } = await requestJson(
      deviceAuthUrl(options.deniAiBaseUrl),
      { method: "POST", body: { action: "poll", deviceCode } },
      withDefaultTimeout(options),
    ));
  } catch (error) {
    if (!(error instanceof FlixaApiError)) {
      throw error;
    }
    if (error.status === 404) {
      return { status: "invalid_code" };
    }
    if (error.status === 410) {
      return { status: "expired" };
    }
    if (error.status === 429) {
      return { status: "rate_limited", retryAfterMs: error.retryAfterMs };
    }
    if (error.status === 403 && error.code === "API_KEY_LIMIT_REACHED") {
      const body = isRecord(error.payload) ? error.payload : {};
      return {
        status: "api_key_limit_reached",
        message: error.serverMessage ?? "API key limit reached.",
        apiKeys: parseApiKeySummaries(body["apiKeys"]),
      };
    }
    throw error;
  }

  if (!isRecord(payload) || typeof payload["approved"] !== "boolean") {
    throw new Error("Device auth poll response is invalid");
  }
  if (!payload["approved"]) {
    return { status: "pending" };
  }
  if (typeof payload["apiKey"] === "string" && payload["apiKey"]) {
    return {
      status: "approved",
      apiKey: payload["apiKey"],
      apiKeyId: nullableString(payload["apiKeyId"]),
    };
  }
  return { status: "api_key_unavailable" };
}

export interface WaitForDeviceAuthOptions extends DeviceAuthOptions {
  /** Delay between polls. Defaults to 5 s. */
  intervalMs?: number;
  /** Overall timeout. Defaults to the code lifetime, capped at 15 minutes. */
  timeoutMs?: number;
  /** Consecutive network/server failures tolerated before giving up. Defaults to 5. */
  maxConsecutiveFailures?: number;
  /** Cancels the wait (resolves with `cancelled`). */
  signal?: AbortSignal;
  /** Called for every failed poll that will be retried. */
  onPollError?: (error: unknown) => void;
  /** Called with every poll result (logging). */
  onPollResult?: (result: DeviceAuthPollResult) => void;
  /** Injectable for tests. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

/** Poll until the user approves (or the flow ends) and return the typed outcome. */
export async function waitForDeviceAuth(
  session: Pick<DeviceAuthSession, "deviceCode" | "expiresIn">,
  options: WaitForDeviceAuthOptions = {},
): Promise<DeviceAuthOutcome> {
  const {
    intervalMs = DEVICE_AUTH_POLL_INTERVAL_MS,
    maxConsecutiveFailures = DEVICE_AUTH_MAX_CONSECUTIVE_FAILURES,
    signal,
    onPollError,
    onPollResult,
    sleep = defaultSleep,
    now = Date.now,
    timeoutMs: overallTimeoutMs,
    ...requestOptions
  } = options;

  const timeoutMs =
    overallTimeoutMs ??
    (Number.isFinite(session.expiresIn) && session.expiresIn > 0
      ? Math.min(session.expiresIn * 1_000, DEVICE_AUTH_MAX_TIMEOUT_MS)
      : DEVICE_AUTH_MAX_TIMEOUT_MS);
  const deadline = now() + timeoutMs;

  let delayMs = intervalMs;
  let consecutiveFailures = 0;
  while (now() < deadline) {
    await sleep(delayMs, signal);
    if (signal?.aborted) {
      return { status: "cancelled" };
    }
    delayMs = intervalMs;

    let result: DeviceAuthPollResult;
    try {
      result = await pollDeviceAuth(session.deviceCode, { ...requestOptions, signal });
    } catch (error) {
      if (signal?.aborted) {
        return { status: "cancelled" };
      }
      // A transient network/server error should not abort a login the user is mid-way through.
      consecutiveFailures += 1;
      if (consecutiveFailures >= maxConsecutiveFailures) {
        return { status: "error", error };
      }
      onPollError?.(error);
      continue;
    }
    consecutiveFailures = 0;
    onPollResult?.(result);

    switch (result.status) {
      case "pending":
        continue;
      case "rate_limited":
        delayMs = Math.max(intervalMs, result.retryAfterMs ?? intervalMs);
        continue;
      default:
        return result;
    }
  }

  return { status: "timed_out" };
}

/**
 * User-facing explanation for the outcomes where the login was approved but no key could
 * be stored. Both ask the user to revoke an unused key at deniai.app.
 */
export function describeDeviceAuthKeyProblem(
  outcome: Extract<DeviceAuthOutcome, { status: "api_key_unavailable" | "api_key_limit_reached" }>,
  deniAiBaseUrl?: string,
): string {
  const manageUrl = resolveDeniAiBaseUrl(deniAiBaseUrl);
  if (outcome.status === "api_key_unavailable") {
    return (
      "Login was approved, but no API key could be issued for this device. " +
      `Revoke an unused API key at ${manageUrl} and log in again.`
    );
  }

  const keys = outcome.apiKeys
    .map((key) => {
      const label = key.name ?? key.keyPrefix ?? key.id;
      const prefix = key.keyPrefix && key.name ? ` (${key.keyPrefix}…)` : "";
      const lastUsed = key.lastUsedAt ? `, last used ${key.lastUsedAt}` : "";
      return `- ${label}${prefix}${lastUsed}`;
    })
    .join("\n");
  return (
    `${outcome.message} Revoke an API key at ${manageUrl} and log in again.` +
    (keys ? `\nExisting keys:\n${keys}` : "")
  );
}
