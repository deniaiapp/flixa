import type { DeviceAuthInitiateResponse, DeviceAuthPollResponse } from "../types.ts";
import { saveSecret, loadSecret, deleteSecret, type SaveResult } from "./keychain.ts";
import { DEFAULT_PROVIDER, getProviderDefinition, type ProviderId } from "../providers/registry.ts";

const DENI_AI_BASE_URL = "https://deniai.app";
const POLLING_INTERVAL_MS = 5_000;
const MAX_CONSECUTIVE_POLL_FAILURES = 5;
const DEVICE_AUTH_TIMEOUT_MS = 15 * 60 * 1_000;

export function getApiKey(provider: ProviderId = DEFAULT_PROVIDER): string | null {
  const environmentNames =
    provider === "flixa"
      ? ["FLIXA_API_KEY", "OPENAI_API_KEY"]
      : (getProviderDefinition(provider).apiKeyEnvNames ?? []);
  for (const environmentName of environmentNames) {
    const environmentValue = process.env[environmentName]?.trim();
    if (environmentValue) {
      return environmentValue;
    }
  }

  return loadSecret(provider);
}

/** True when a secret is stored for the provider, ignoring environment variables. */
export function hasStoredCredentials(provider: ProviderId = DEFAULT_PROVIDER): boolean {
  return loadSecret(provider) !== null;
}

export function saveApiKey(provider: ProviderId, apiKey: string): SaveResult {
  return saveSecret(apiKey, provider);
}

export function deleteCredentials(provider: ProviderId = DEFAULT_PROVIDER): void {
  deleteSecret(provider);
}

async function initiateDeviceAuth(): Promise<DeviceAuthInitiateResponse> {
  const res = await fetch(`${DENI_AI_BASE_URL}/api/device-auth`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(15_000),
    body: JSON.stringify({ action: "initiate" }),
  });
  if (!res.ok) {
    throw new Error(`Device auth initiation failed: ${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<DeviceAuthInitiateResponse>;
}

async function pollDeviceAuth(deviceCode: string): Promise<DeviceAuthPollResponse> {
  const res = await fetch(`${DENI_AI_BASE_URL}/api/device-auth`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(15_000),
    body: JSON.stringify({ action: "poll", deviceCode }),
  });
  if (!res.ok) {
    throw new Error(`Device auth poll failed: ${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<DeviceAuthPollResponse>;
}

export interface LoginOptions {
  provider?: ProviderId;
  onUserCode?: (userCode: string, verificationUrl: string) => void;
  onSaved?: (backend: string, warning?: string) => void;
}

export async function loginWithDeviceAuth(options: LoginOptions = {}): Promise<string> {
  const provider = options.provider ?? DEFAULT_PROVIDER;
  const providerDefinition = getProviderDefinition(provider);
  if (providerDefinition.authType !== "device") {
    throw new Error(`${providerDefinition.displayName} does not support device authentication.`);
  }

  const initResponse = await initiateDeviceAuth();
  const { userCode, deviceCode, expiresIn } = initResponse;

  const verificationUrl = `${DENI_AI_BASE_URL}/flixa/authorize?code=${encodeURIComponent(userCode)}`;

  options.onUserCode?.(userCode, verificationUrl);

  const timeoutMs =
    Number.isFinite(expiresIn) && expiresIn > 0
      ? Math.min(expiresIn * 1_000, DEVICE_AUTH_TIMEOUT_MS)
      : DEVICE_AUTH_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;

  let consecutiveFailures = 0;
  while (Date.now() < deadline) {
    await sleep(POLLING_INTERVAL_MS);

    let pollResponse: DeviceAuthPollResponse;
    try {
      pollResponse = await pollDeviceAuth(deviceCode);
    } catch (error) {
      // A transient network/server error should not abort a login the user is mid-way through.
      consecutiveFailures += 1;
      if (consecutiveFailures >= MAX_CONSECUTIVE_POLL_FAILURES) throw error;
      continue;
    }
    consecutiveFailures = 0;
    if (pollResponse.approved && pollResponse.apiKey) {
      const result = saveSecret(pollResponse.apiKey, provider);
      options.onSaved?.(result.backend, result.warning);
      return pollResponse.apiKey;
    }
  }

  throw new Error("Device auth timed out. Please try again.");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
