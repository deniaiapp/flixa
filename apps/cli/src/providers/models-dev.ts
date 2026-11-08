import { MODELS_DEV_PROVIDERS, type ModelsDevGeneratedProvider } from "./models-dev.generated.ts";

export type ProviderRuntimeKind =
  | "flixa"
  | "openai-responses"
  | "openai-chat"
  | "anthropic"
  | "google"
  | "external";

export interface ProviderCatalogModel {
  id: string;
  name: string;
  description: string;
  toolCall: boolean;
}

export interface ProviderCatalogRecord {
  id: string;
  name: string;
  npm: string;
  api: string | null;
  env: readonly string[];
  models: readonly ProviderCatalogModel[];
  runtime: ProviderRuntimeKind;
  defaultBaseUrl?: string;
  baseUrlRequired: boolean;
  apiKeyEnvNames: readonly string[];
}

const FALLBACK_BASE_URLS: Record<string, string> = {
  cerebras: "https://api.cerebras.ai/v1",
  cohere: "https://api.cohere.com/compatibility/v1",
  deepinfra: "https://api.deepinfra.com/v1/openai",
  groq: "https://api.groq.com/openai/v1",
  mistral: "https://api.mistral.ai/v1",
  perplexity: "https://api.perplexity.ai",
  togetherai: "https://api.together.xyz/v1",
  xai: "https://api.x.ai/v1",
};

const OPENAI_COMPATIBLE_NPM_PACKAGES = new Set([
  "@ai-sdk/cerebras",
  "@ai-sdk/deepinfra",
  "@ai-sdk/groq",
  "@ai-sdk/mistral",
  "@ai-sdk/openai",
  "@ai-sdk/perplexity",
  "@ai-sdk/togetherai",
  "@ai-sdk/xai",
]);

const PROVIDER_CATALOG = new Map<string, ProviderCatalogRecord>(
  MODELS_DEV_PROVIDERS.map((provider) => [provider.id, createCatalogRecord(provider)]),
);

export function getProviderCatalogRecord(providerId: string): ProviderCatalogRecord | undefined {
  return PROVIDER_CATALOG.get(providerId);
}

export function listProviderCatalogRecords(): ProviderCatalogRecord[] {
  return [...PROVIDER_CATALOG.values()];
}

export function resolveCatalogBaseUrl(provider: ProviderCatalogRecord): string | undefined {
  const templatedUrl = provider.api;
  if (templatedUrl) {
    const resolved = resolveEnvironmentTemplate(templatedUrl);
    if (resolved) {
      return resolved;
    }
  }

  return FALLBACK_BASE_URLS[provider.id];
}

function createCatalogRecord(provider: ModelsDevGeneratedProvider): ProviderCatalogRecord {
  const api = provider.api;
  const runtime = inferRuntime(provider);
  const defaultBaseUrl =
    api && !hasEnvironmentTemplate(api) ? api : FALLBACK_BASE_URLS[provider.id];
  const baseUrlRequired = runtime === "openai-chat" && !defaultBaseUrl;

  return {
    id: provider.id,
    name: provider.name,
    npm: provider.npm,
    api,
    env: provider.env,
    models: provider.models,
    runtime,
    ...(defaultBaseUrl ? { defaultBaseUrl } : {}),
    baseUrlRequired,
    apiKeyEnvNames: inferApiKeyEnvNames(provider),
  };
}

function inferRuntime(provider: ModelsDevGeneratedProvider): ProviderRuntimeKind {
  if (
    provider.npm.includes("google-vertex") ||
    provider.npm.includes("amazon-bedrock") ||
    provider.npm.includes("azure") ||
    provider.npm.includes("gateway") ||
    provider.npm.includes("vercel")
  ) {
    return "external";
  }

  if (provider.npm === "@ai-sdk/google") {
    return "google";
  }

  if (provider.npm.includes("anthropic")) {
    return "anthropic";
  }

  if (
    provider.api ||
    provider.npm.includes("openai") ||
    OPENAI_COMPATIBLE_NPM_PACKAGES.has(provider.npm) ||
    FALLBACK_BASE_URLS[provider.id]
  ) {
    return "openai-chat";
  }

  return "external";
}

function inferApiKeyEnvNames(provider: ModelsDevGeneratedProvider): string[] {
  const templateVariables = new Set(
    [...(provider.api?.matchAll(/\$\{([A-Z0-9_]+)\}/g) ?? [])].map((match) => match[1]),
  );
  const candidates = provider.env.filter(
    (name) =>
      !templateVariables.has(name) && /(KEY|TOKEN|SECRET|PASSWORD|PAT|CREDENTIAL)/i.test(name),
  );

  return candidates.length > 0 ? candidates : provider.env.slice(0, 1);
}

function hasEnvironmentTemplate(value: string): boolean {
  return /\$\{[A-Z0-9_]+\}/.test(value);
}

function resolveEnvironmentTemplate(value: string): string | undefined {
  let unresolved = false;
  const resolved = value.replace(/\$\{([A-Z0-9_]+)\}/g, (_match, name: string) => {
    const environmentValue = process.env[name]?.trim();
    if (!environmentValue) {
      unresolved = true;
      return "";
    }
    return environmentValue;
  });

  return unresolved ? undefined : resolved;
}
