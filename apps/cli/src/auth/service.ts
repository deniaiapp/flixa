import {
  describeDeviceAuthKeyProblem,
  FlixaApiError,
  initiateDeviceAuth,
  waitForDeviceAuth,
  type DeviceAuthSession,
} from "@deniai/flixa-api-client";
import { saveSecret, loadSecret, deleteSecret, type SaveResult } from "./keychain.ts";
import { DEFAULT_PROVIDER, getProviderDefinition, type ProviderId } from "../providers/registry.ts";

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

  let session: DeviceAuthSession;
  try {
    session = await initiateDeviceAuth();
  } catch (error) {
    if (error instanceof FlixaApiError) {
      throw new Error(`Device auth initiation failed: ${error.status} ${error.statusText}`, {
        cause: error,
      });
    }
    throw error;
  }

  options.onUserCode?.(session.userCode, session.verificationUrl);

  const outcome = await waitForDeviceAuth(session);
  switch (outcome.status) {
    case "approved": {
      const result = saveSecret(outcome.apiKey, provider);
      options.onSaved?.(result.backend, result.warning);
      return outcome.apiKey;
    }
    case "api_key_unavailable":
    case "api_key_limit_reached":
      throw new Error(describeDeviceAuthKeyProblem(outcome));
    case "expired":
      throw new Error("Device auth expired. Please try again.");
    case "invalid_code":
      throw new Error("Device auth code was not recognized. Please try again.");
    case "error":
      if (outcome.error instanceof FlixaApiError) {
        throw new Error(
          `Device auth poll failed: ${outcome.error.status} ${outcome.error.statusText}`,
          { cause: outcome.error },
        );
      }
      throw outcome.error;
    case "timed_out":
    case "cancelled":
      throw new Error("Device auth timed out. Please try again.");
  }
}
