import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { FLIXA_CONFIG_PATH, ensurePrivateParent, enforcePrivateFile } from "../security/paths.ts";
import { DEFAULT_PROVIDER, type ProviderId } from "../providers/registry.ts";

export interface StoredProviderConfig {
  baseUrl?: string;
  defaultModel?: string;
}

export interface FlixaConfig {
  defaultModel?: string;
  defaultAutoMode?: boolean;
  defaultYoloMode?: boolean;
  defaultPlanMode?: boolean;
  defaultAcceptEdits?: boolean;
  defaultProvider?: ProviderId;
  providers?: Partial<Record<ProviderId, StoredProviderConfig>>;
}

const CONFIG_PATH = FLIXA_CONFIG_PATH;

export function loadConfig(): FlixaConfig {
  if (!existsSync(CONFIG_PATH)) {
    return {};
  }

  try {
    const raw = readFileSync(CONFIG_PATH, "utf-8");
    const parsed = JSON.parse(raw) as FlixaConfig;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function saveConfig(config: FlixaConfig): void {
  ensurePrivateParent(CONFIG_PATH);
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n", {
    encoding: "utf-8",
    mode: 0o600,
  });
  enforcePrivateFile(CONFIG_PATH);
}

export function getDefaultProvider(): ProviderId {
  return loadConfig().defaultProvider ?? DEFAULT_PROVIDER;
}

export function setDefaultProvider(provider: ProviderId): void {
  const current = loadConfig();
  if (current.defaultProvider === provider) {
    return;
  }

  saveConfig({
    ...current,
    defaultProvider: provider,
  });
}

export function getPersistedModel(provider?: ProviderId): string | undefined {
  const config = loadConfig();

  if (provider) {
    const model = config.providers?.[provider]?.defaultModel;
    return typeof model === "string" && model.length > 0 ? model : undefined;
  }

  const model = config.defaultModel;
  return typeof model === "string" && model.length > 0 ? model : undefined;
}

export function setPersistedModel(model: string, provider?: ProviderId): void {
  const trimmed = model.trim();
  if (!trimmed) {
    return;
  }

  const current = loadConfig();

  if (provider) {
    if (current.providers?.[provider]?.defaultModel === trimmed) {
      return;
    }

    saveConfig({
      ...current,
      providers: {
        ...current.providers,
        [provider]: {
          ...current.providers?.[provider],
          defaultModel: trimmed,
        },
      },
    });
    return;
  }

  if (current.defaultModel === trimmed) {
    return;
  }

  saveConfig({
    ...current,
    defaultModel: trimmed,
  });
}

export function getPersistedProviderBaseUrl(provider: ProviderId): string | undefined {
  const baseUrl = loadConfig().providers?.[provider]?.baseUrl;
  return typeof baseUrl === "string" && baseUrl.length > 0 ? baseUrl : undefined;
}

export function setPersistedProviderBaseUrl(
  provider: ProviderId,
  baseUrl: string | undefined,
): void {
  const trimmed = baseUrl?.trim();
  const current = loadConfig();
  const existing = current.providers?.[provider]?.baseUrl;

  if (!trimmed) {
    if (!existing) {
      return;
    }

    saveConfig({
      ...current,
      providers: {
        ...current.providers,
        [provider]: {
          ...current.providers?.[provider],
          baseUrl: undefined,
        },
      },
    });
    return;
  }

  if (existing === trimmed) {
    return;
  }

  saveConfig({
    ...current,
    providers: {
      ...current.providers,
      [provider]: {
        ...current.providers?.[provider],
        baseUrl: trimmed,
      },
    },
  });
}

export function getPersistedModeDefaults(): {
  autoMode: boolean;
  yoloMode: boolean;
  planMode: boolean;
  acceptEdits: boolean;
} {
  const config = loadConfig();
  return {
    autoMode: config.defaultAutoMode ?? false,
    yoloMode: config.defaultYoloMode ?? false,
    planMode: config.defaultPlanMode ?? false,
    acceptEdits: config.defaultAcceptEdits ?? false,
  };
}

export function setPersistedModeDefaults(next: {
  autoMode?: boolean;
  yoloMode?: boolean;
  planMode?: boolean;
  acceptEdits?: boolean;
}): void {
  const current = loadConfig();
  saveConfig({
    ...current,
    ...(typeof next.autoMode === "boolean" ? { defaultAutoMode: next.autoMode } : {}),
    ...(typeof next.yoloMode === "boolean" ? { defaultYoloMode: next.yoloMode } : {}),
    ...(typeof next.planMode === "boolean" ? { defaultPlanMode: next.planMode } : {}),
    ...(typeof next.acceptEdits === "boolean" ? { defaultAcceptEdits: next.acceptEdits } : {}),
  });
}
