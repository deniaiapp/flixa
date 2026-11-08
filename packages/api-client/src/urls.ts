/** Deni AI web app (device login, billing, API key management). */
export const DEFAULT_DENI_AI_BASE_URL = "https://deniai.app";

/** Flixa API origin. */
export const DEFAULT_FLIXA_API_ORIGIN = "https://flixa-api.deniai.app";

/** Flixa agent (Responses API) base URL. `FLIXA_BASE_URL` overrides it. */
export const DEFAULT_FLIXA_BASE_URL = `${DEFAULT_FLIXA_API_ORIGIN}/v1/agent`;

export type EnvironmentVariables = Readonly<Record<string, string | undefined>>;

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export function getProcessEnv(): EnvironmentVariables {
  return (globalThis as { process?: { env?: EnvironmentVariables } }).process?.env ?? {};
}

export function isLoopbackUrl(baseUrl: string): boolean {
  try {
    return LOOPBACK_HOSTS.has(new URL(baseUrl).hostname.toLowerCase());
  } catch {
    return false;
  }
}

/**
 * API keys are sent as bearer tokens to the configured base URL, so refuse anything
 * that would put them on the wire in cleartext. Loopback http:// stays allowed for
 * local servers; FLIXA_ALLOW_INSECURE_BASE_URL=1 opts out for trusted networks.
 */
export function assertSecureBaseUrl(
  baseUrl: string,
  env: EnvironmentVariables = getProcessEnv(),
): string {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error(`Invalid base URL: ${baseUrl}`);
  }

  if (parsed.protocol === "https:") {
    return baseUrl;
  }

  if (
    parsed.protocol === "http:" &&
    (LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase()) ||
      env["FLIXA_ALLOW_INSECURE_BASE_URL"] === "1")
  ) {
    return baseUrl;
  }

  throw new Error(
    `Refusing to send credentials to ${parsed.protocol}//${parsed.host}: use https:// ` +
      "(http:// is only allowed for localhost, or set FLIXA_ALLOW_INSECURE_BASE_URL=1).",
  );
}

function trimTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, "");
}

/** The configured agent base URL (`FLIXA_BASE_URL` or production), not yet validated. */
export function getConfiguredFlixaBaseUrl(env: EnvironmentVariables = getProcessEnv()): string {
  return env["FLIXA_BASE_URL"]?.trim() || DEFAULT_FLIXA_BASE_URL;
}

/**
 * Flixa agent base URL (`…/v1/agent`): the explicit override, else `FLIXA_BASE_URL`,
 * else the production URL. Always https unless loopback or explicitly allowed.
 */
export function resolveFlixaBaseUrl(
  override?: string,
  env: EnvironmentVariables = getProcessEnv(),
): string {
  const candidate = override?.trim() || getConfiguredFlixaBaseUrl(env);
  return trimTrailingSlashes(assertSecureBaseUrl(candidate, env));
}

/**
 * Flixa API root (`…/v1`) used for `/models` and `/deni/*`: the agent base URL without
 * its trailing `/agent` segment.
 */
export function resolveFlixaApiRoot(
  override?: string,
  env: EnvironmentVariables = getProcessEnv(),
): string {
  const baseUrl = resolveFlixaBaseUrl(override, env);
  return baseUrl.endsWith("/agent") ? baseUrl.slice(0, -"/agent".length) : baseUrl;
}

/** Deni AI web app base URL: the explicit override, else `DENI_AI_BASE_URL`, else production. */
export function resolveDeniAiBaseUrl(
  override?: string,
  env: EnvironmentVariables = getProcessEnv(),
): string {
  const candidate = override?.trim() || env["DENI_AI_BASE_URL"]?.trim() || DEFAULT_DENI_AI_BASE_URL;
  return trimTrailingSlashes(assertSecureBaseUrl(candidate, env));
}

/** Browser page where the user approves a device login code. */
export function getDeviceAuthVerificationUrl(userCode: string, deniAiBaseUrl?: string): string {
  return `${resolveDeniAiBaseUrl(deniAiBaseUrl)}/flixa/authorize?code=${encodeURIComponent(userCode)}`;
}

/** Billing and plan management page. */
export function getBillingUrl(deniAiBaseUrl?: string): string {
  return `${resolveDeniAiBaseUrl(deniAiBaseUrl)}/settings/billing`;
}
