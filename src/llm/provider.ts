import { createOpenAI } from "@ai-sdk/openai";
import { getFlixaApiBaseUrl } from "../usage/service";
import { setModelAccessDefinitions, type ModelAccessDefinition } from "../usage/types";

const FLIXA_BASE_URL = getFlixaApiBaseUrl();

const OPENAI_BASE_URL = `${FLIXA_BASE_URL}/v1/agent/`;
const DEFAULT_MODEL = "openai/gpt-5.4";
const DEFAULT_REASONING_EFFORT = "medium";
const MODELS_CACHE_DURATION_MS = 5 * 60 * 1000;
const FALLBACK_MODEL_DEFINITIONS: ModelAccessDefinition[] = [
  {
    id: DEFAULT_MODEL,
    label: "GPT-5.4",
    description: "OpenAI flagship coding model",
    tags: ["coding", "fast"],
    premium: false,
    tier: "free",
  },
];
const FALLBACK_MODELS = FALLBACK_MODEL_DEFINITIONS.map((model) => model.id);

export type ReasoningEffort = "low" | "medium" | "high";

let _apiKey: string | undefined;
let _cachedModels: string[] | null = null;
let _cachedModelDefinitions: ModelAccessDefinition[] | null = null;
let _modelsFetchedAt = 0;
let _selectedModel = DEFAULT_MODEL;
let _selectedReasoningEffort: ReasoningEffort = DEFAULT_REASONING_EFFORT;

export function setApiKey(apiKey: string | undefined): void {
  _apiKey = apiKey;
  _cachedModels = null;
  _cachedModelDefinitions = null;
  _modelsFetchedAt = 0;
}

export function getApiKey(): string | undefined {
  return _apiKey;
}

export function getAnthropicProvider() {
  console.log("[Flixa] Creating OpenAI provider with base URL:", OPENAI_BASE_URL);
  return createOpenAI({ apiKey: _apiKey || "anonymous", baseURL: OPENAI_BASE_URL }).chat;
}

export function getModel(): string {
  console.log("[Flixa] Using model:", _selectedModel);
  return _selectedModel;
}

export function getReasoningEffort(): ReasoningEffort {
  console.log("[Flixa] Using reasoning effort:", _selectedReasoningEffort);
  return _selectedReasoningEffort;
}

function withCurrentModel(models: string[]): string[] {
  const uniqueModels = [...new Set(models)];
  const currentModel = getModel();
  if (!uniqueModels.includes(currentModel)) {
    return [currentModel, ...uniqueModels];
  }
  return uniqueModels;
}

function withCurrentModelDefinition(
  modelDefinitions: ModelAccessDefinition[],
): ModelAccessDefinition[] {
  const currentModel = getModel();
  if (modelDefinitions.some((model) => model.id === currentModel)) {
    return modelDefinitions;
  }
  return [{ id: currentModel, label: currentModel, tags: [], tier: "free" }, ...modelDefinitions];
}

function normalizeTier(value: unknown): "free" | "plus" | "pro" | "max" | undefined {
  if (value === "free" || value === "plus" || value === "pro" || value === "max") {
    return value;
  }
  return undefined;
}

function normalizeTags(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value.filter((tag): tag is string => typeof tag === "string");
}

function extractModelDefinition(model: unknown): ModelAccessDefinition | null {
  if (typeof model === "string") {
    return { id: model, label: model, tags: [] };
  }
  if (model && typeof model === "object") {
    const record = model as Record<string, unknown>;
    if (typeof record.id === "string") {
      return {
        id: record.id,
        label: typeof record.label === "string" ? record.label : record.id,
        description: typeof record.description === "string" ? record.description : "",
        tags: normalizeTags(record.tags) ?? [],
        premium: typeof record.premium === "boolean" ? record.premium : undefined,
        tier: normalizeTier(record.tier),
      };
    }
  }
  return null;
}

function parseModelDefinitions(payload: unknown): ModelAccessDefinition[] {
  const normalizeList = (value: unknown): ModelAccessDefinition[] => {
    if (!Array.isArray(value)) {
      return [];
    }
    return value
      .map(extractModelDefinition)
      .filter((model): model is ModelAccessDefinition => !!model);
  };

  if (Array.isArray(payload)) {
    return normalizeList(payload);
  }
  if (payload && typeof payload === "object") {
    const record = payload as Record<string, unknown>;
    if (Array.isArray(record.model_definitions)) {
      return normalizeList(record.model_definitions);
    }
    if (record.model_definitions && typeof record.model_definitions === "object") {
      const entries = Object.entries(record.model_definitions as Record<string, unknown>).map(
        ([id, value]) => {
          if (value && typeof value === "object") {
            return { id, ...(value as Record<string, unknown>) };
          }
          return { id };
        },
      );
      return normalizeList(entries);
    }
    if (Array.isArray(record.models)) {
      return normalizeList(record.models);
    }
    if (Array.isArray(record.data)) {
      return normalizeList(record.data);
    }
  }
  return [];
}

function getModelEndpoints(): string[] {
  const rawBaseUrl = getFlixaApiBaseUrl();
  const normalizedBaseUrl = rawBaseUrl.replace(/\/+$/, "");
  const endpoints = new Set<string>();
  endpoints.add(`${normalizedBaseUrl}/v1/models`);
  endpoints.add(`${normalizedBaseUrl}/api/v1/models`);
  return [...endpoints];
}

export async function getAvailableModels(force = false): Promise<string[]> {
  const now = Date.now();
  if (!force && _cachedModels && now - _modelsFetchedAt < MODELS_CACHE_DURATION_MS) {
    return withCurrentModel(_cachedModels);
  }

  const headers: Record<string, string> = {};
  if (_apiKey) {
    headers.Authorization = `Bearer ${_apiKey}`;
  }

  for (const endpoint of getModelEndpoints()) {
    try {
      const response = await fetch(endpoint, { headers });
      if (!response.ok) {
        console.log("[Flixa] Failed to fetch models from", endpoint, response.status);
        continue;
      }
      const payload = await response.json();
      const modelDefinitions = parseModelDefinitions(payload);
      const models = [
        ...new Set(
          modelDefinitions
            .map((model) => model.id)
            .filter((modelId): modelId is string => !!modelId),
        ),
      ];
      if (models.length > 0) {
        setModelAccessDefinitions(modelDefinitions);
        _cachedModels = models;
        _cachedModelDefinitions = modelDefinitions;
        _modelsFetchedAt = Date.now();
        return withCurrentModel(models);
      }
    } catch (error) {
      console.log("[Flixa] Failed to fetch models from", endpoint, error);
    }
  }

  setModelAccessDefinitions(FALLBACK_MODEL_DEFINITIONS);
  _cachedModels = FALLBACK_MODELS;
  _cachedModelDefinitions = FALLBACK_MODEL_DEFINITIONS;
  _modelsFetchedAt = Date.now();
  return FALLBACK_MODELS;
}

export function getModelDefinitions(): ModelAccessDefinition[] {
  const modelDefinitions = _cachedModelDefinitions ?? FALLBACK_MODEL_DEFINITIONS;
  return withCurrentModelDefinition(modelDefinitions);
}

export async function setModel(model: string): Promise<void> {
  _selectedModel = model || DEFAULT_MODEL;
}

export async function setReasoningEffort(reasoningEffort: string): Promise<void> {
  if (
    reasoningEffort === "low" ||
    reasoningEffort === "medium" ||
    reasoningEffort === "high"
  ) {
    _selectedReasoningEffort = reasoningEffort;
    return;
  }

  _selectedReasoningEffort = DEFAULT_REASONING_EFFORT;
}
