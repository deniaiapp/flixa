import { createOpenAI } from '@ai-sdk/openai';
import { fetchFlixaModels, resolveFlixaBaseUrl, type FlixaModel } from '@deniai/flixa-api-client';
import { getFlixaClientHeaders } from '../api/flixaClientHeaders';
import { setModelAccessDefinitions, type ModelAccessDefinition } from '../usage/types';
import {
  getAvailableReasoningEfforts,
  isReasoningEffort,
  normalizeReasoningEfforts,
  type ReasoningEffort,
} from './reasoning';

const DEFAULT_MODEL = 'openai/gpt-6-luna';
const DEFAULT_REASONING_EFFORT = 'medium';
const MODELS_CACHE_DURATION_MS = 5 * 60 * 1000;
const FALLBACK_MODEL_DEFINITIONS: ModelAccessDefinition[] = [
  {
    id: DEFAULT_MODEL,
    label: 'GPT-6 Luna',
    description: 'OpenAI flagship coding model',
    tags: ['coding', 'fast'],
    premium: false,
    tier: 'free',
  },
];
const FALLBACK_MODELS = FALLBACK_MODEL_DEFINITIONS.map((model) => model.id);

let _apiKey: string | undefined;
let _cachedModels: string[] | null = null;
let _cachedModelDefinitions: ModelAccessDefinition[] | null = null;
let _modelsFetchedAt = 0;
let _selectedModel = DEFAULT_MODEL;
let _backendDefaultModel: string | undefined;
let _modelSelectedByUser = false;
let _selectedReasoningEffort: ReasoningEffort | undefined = DEFAULT_REASONING_EFFORT;

export function setApiKey(apiKey: string | undefined): void {
  _apiKey = apiKey;
  _cachedModels = null;
  _cachedModelDefinitions = null;
  _modelsFetchedAt = 0;
}

export function getApiKey(): string | undefined {
  return _apiKey;
}

export function getFlixaProvider() {
  return createOpenAI({
    apiKey: _apiKey || 'anonymous',
    baseURL: `${resolveFlixaBaseUrl()}/`,
    headers: getFlixaClientHeaders(),
  }).chat;
}

export function getModel(): string {
  return _selectedModel;
}

export function getReasoningEffort(): ReasoningEffort | undefined {
  return _selectedReasoningEffort;
}

export function getAvailableReasoningEffortsForModel(model = getModel()): ReasoningEffort[] {
  const definition = _cachedModelDefinitions?.find((item) => item.id === model);
  return getAvailableReasoningEfforts(model, definition?.reasoningEfforts);
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
  return [{ id: currentModel, label: currentModel, tags: [], tier: 'free' }, ...modelDefinitions];
}

function toModelAccessDefinition(model: FlixaModel): ModelAccessDefinition {
  return {
    id: model.id,
    label: model.label,
    description: model.description,
    tags: model.tags,
    premium: model.premium,
    tier: model.tier,
    tokenUsageMultiplier: model.tokenUsageMultiplier,
    usageTier: model.usageTier ?? undefined,
    reasoningEfforts: normalizeReasoningEfforts(model.efforts),
    default: model.default ? true : undefined,
  };
}

export async function getAvailableModels(force = false): Promise<string[]> {
  const now = Date.now();
  if (!force && _cachedModels && now - _modelsFetchedAt < MODELS_CACHE_DURATION_MS) {
    return withCurrentModel(_cachedModels);
  }

  try {
    const modelDefinitions = (
      await fetchFlixaModels({ apiKey: _apiKey, headers: getFlixaClientHeaders() })
    ).map(toModelAccessDefinition);
    const models = modelDefinitions.map((model) => model.id);
    if (models.length > 0) {
      setModelAccessDefinitions(modelDefinitions);
      _cachedModels = models;
      _cachedModelDefinitions = modelDefinitions;
      _modelsFetchedAt = Date.now();
      _backendDefaultModel = modelDefinitions.find((model) => model.default === true)?.id;
      if (_backendDefaultModel && !_modelSelectedByUser) {
        await setModel(_backendDefaultModel);
        _modelSelectedByUser = false;
      }
      return withCurrentModel(models);
    }
  } catch (error) {
    console.log('[Flixa] Failed to fetch models', error);
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
  _selectedModel = model || _backendDefaultModel || DEFAULT_MODEL;
  _modelSelectedByUser = !!model;
  const availableEfforts = getAvailableReasoningEffortsForModel();
  if (availableEfforts.length === 0) {
    _selectedReasoningEffort = undefined;
  } else if (!_selectedReasoningEffort || !availableEfforts.includes(_selectedReasoningEffort)) {
    _selectedReasoningEffort = availableEfforts.includes(DEFAULT_REASONING_EFFORT)
      ? DEFAULT_REASONING_EFFORT
      : availableEfforts[0];
  }
}

export async function setReasoningEffort(reasoningEffort: string): Promise<void> {
  const availableEfforts = getAvailableReasoningEffortsForModel();
  if (isReasoningEffort(reasoningEffort) && availableEfforts.includes(reasoningEffort)) {
    _selectedReasoningEffort = reasoningEffort;
    return;
  }

  _selectedReasoningEffort = availableEfforts.includes(DEFAULT_REASONING_EFFORT)
    ? DEFAULT_REASONING_EFFORT
    : availableEfforts[0];
}
