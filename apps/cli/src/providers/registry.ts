import {
  listProviderCatalogRecords,
  resolveCatalogBaseUrl,
  type ProviderCatalogModel,
  type ProviderRuntimeKind,
} from "./models-dev.ts";

export type ProviderId = string;

export type ProviderAuthType = "device" | "apiKey" | "environment";

export interface ProviderDefinition {
  id: ProviderId;
  displayName: string;
  authType: ProviderAuthType;
  runtime: ProviderRuntimeKind;
  defaultBaseUrl?: string;
  baseUrlRequired?: boolean;
  defaultModel?: string;
  apiKeyEnvNames?: readonly string[];
  environmentVariables?: readonly string[];
  catalogModels?: readonly ProviderCatalogModel[];
  source: "builtin" | "models.dev";
  claudeCodeEnv?: {
    apiKeyEnv: string;
    baseUrlEnv?: string;
  };
}

const BUILTIN_PROVIDERS: Record<string, ProviderDefinition> = {
  flixa: {
    id: "flixa",
    displayName: "Flixa",
    authType: "device",
    runtime: "flixa",
    defaultBaseUrl: "https://flixa-api.deniai.app/v1/agent",
    defaultModel: "openai/gpt-5.6-sol",
    source: "builtin",
    claudeCodeEnv: {
      apiKeyEnv: "ANTHROPIC_API_KEY",
      baseUrlEnv: "ANTHROPIC_BASE_URL",
    },
  },
  openai: {
    id: "openai",
    displayName: "OpenAI",
    authType: "apiKey",
    runtime: "openai-responses",
    defaultBaseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-4.1",
    apiKeyEnvNames: ["OPENAI_API_KEY"],
    source: "builtin",
  },
  anthropic: {
    id: "anthropic",
    displayName: "Anthropic",
    authType: "apiKey",
    runtime: "anthropic",
    defaultBaseUrl: "https://api.anthropic.com/v1",
    defaultModel: "claude-sonnet-4-0",
    apiKeyEnvNames: ["ANTHROPIC_API_KEY"],
    source: "builtin",
    claudeCodeEnv: {
      apiKeyEnv: "ANTHROPIC_API_KEY",
      baseUrlEnv: "ANTHROPIC_BASE_URL",
    },
  },
  google: {
    id: "google",
    displayName: "Google Gemini",
    authType: "apiKey",
    runtime: "google",
    defaultModel: "gemini-2.5-pro",
    apiKeyEnvNames: ["GOOGLE_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "GEMINI_API_KEY"],
    source: "builtin",
  },
  openrouter: {
    id: "openrouter",
    displayName: "OpenRouter",
    authType: "apiKey",
    runtime: "openai-chat",
    defaultBaseUrl: "https://openrouter.ai/api/v1",
    defaultModel: "openai/gpt-4.1",
    apiKeyEnvNames: ["OPENROUTER_API_KEY", "OPENAI_API_KEY"],
    source: "builtin",
  },
  "custom-openai": {
    id: "custom-openai",
    displayName: "Custom OpenAI-Compatible",
    authType: "apiKey",
    runtime: "openai-chat",
    defaultModel: "gpt-4.1",
    baseUrlRequired: true,
    apiKeyEnvNames: ["OPENAI_API_KEY"],
    source: "builtin",
  },
};

const CATALOG_PROVIDERS: Record<string, ProviderDefinition> = Object.fromEntries(
  listProviderCatalogRecords()
    .filter((provider) => !(provider.id in BUILTIN_PROVIDERS))
    .map((provider) => {
      // The agent loop needs tool calling, so prefer a model that supports it.
      const defaultModel =
        (provider.models.find((model) => model.toolCall) ?? provider.models[0])?.id || "gpt-4.1";
      const defaultBaseUrl = resolveCatalogBaseUrl(provider);
      const requiresEnvironment = provider.runtime === "external";
      return [
        provider.id,
        {
          id: provider.id,
          displayName: provider.name,
          authType: requiresEnvironment ? "environment" : "apiKey",
          runtime: provider.runtime,
          ...(defaultBaseUrl ? { defaultBaseUrl } : {}),
          baseUrlRequired: provider.baseUrlRequired || requiresEnvironment,
          defaultModel,
          apiKeyEnvNames: provider.apiKeyEnvNames,
          environmentVariables: provider.env,
          catalogModels: provider.models,
          source: "models.dev",
        } satisfies ProviderDefinition,
      ];
    }),
);

export const PROVIDERS: Record<string, ProviderDefinition> = {
  ...BUILTIN_PROVIDERS,
  ...CATALOG_PROVIDERS,
};

export const DEFAULT_PROVIDER: ProviderId = "flixa";

export function isProviderId(value: string): value is ProviderId {
  return typeof value === "string" && Object.hasOwn(PROVIDERS, value);
}

export function getProviderDefinition(providerId: ProviderId): ProviderDefinition {
  const definition = PROVIDERS[providerId];
  if (!definition) {
    throw new Error(`Unsupported provider: ${providerId}`);
  }
  return definition;
}

export function listProviderDefinitions(): ProviderDefinition[] {
  return Object.values(PROVIDERS);
}
