const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

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
 * local model servers; FLIXA_ALLOW_INSECURE_BASE_URL=1 opts out for trusted networks.
 */
export function assertSecureBaseUrl(baseUrl: string): string {
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
      process.env.FLIXA_ALLOW_INSECURE_BASE_URL === "1")
  ) {
    return baseUrl;
  }

  throw new Error(
    `Refusing to send credentials to ${parsed.protocol}//${parsed.host}: use https:// ` +
      "(http:// is only allowed for localhost, or set FLIXA_ALLOW_INSECURE_BASE_URL=1).",
  );
}
