import {
  createClientHeaders,
  fetchFlixaModels,
  readFlixaApiError,
  resolveFlixaBaseUrl,
} from '@deniai/flixa-api-client';
import { FLIXA_VERSION, getApiKey, getConfig } from './config.js';
import {
  normalizeReasoningEfforts,
  type ModelReasoningEfforts,
  type ReasoningEffort,
} from './reasoning.js';

export { FlixaApiError } from '@deniai/flixa-api-client';

export interface CreateResponseRequest {
  model: string;
  input: unknown[];
  instructions?: string;
  tools?: unknown[];
  reasoningEffort?: ReasoningEffort;
  abortSignal?: AbortSignal;
}

export interface ResponseUsage {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
}

export interface CreateResponseResult {
  id?: string;
  output: unknown[];
  usage?: ResponseUsage;
}

export function getClientHeaders(): Record<string, string> {
  return createClientHeaders({ kind: 'zed', version: FLIXA_VERSION });
}

export async function createResponse(
  request: CreateResponseRequest,
): Promise<CreateResponseResult> {
  const payload = await requestJson(`${resolveFlixaBaseUrl()}/responses`, {
    method: 'POST',
    signal: request.abortSignal,
    body: {
      model: request.model,
      input: request.input,
      instructions: request.instructions,
      tools: request.tools,
      store: false,
      include: ['reasoning.encrypted_content'],
      ...(request.reasoningEffort
        ? {
            reasoning: {
              effort: request.reasoningEffort,
              context: 'all_turns',
            },
          }
        : {}),
    },
  });

  if (!isRecord(payload) || !Array.isArray(payload.output)) {
    throw new Error('Responses response missing output array');
  }

  return payload as unknown as CreateResponseResult;
}

export async function compactResponse(
  model: string,
  input: unknown[],
  instructions: string,
): Promise<CreateResponseResult> {
  const payload = await requestJson(`${resolveFlixaBaseUrl()}/responses/compact`, {
    method: 'POST',
    body: { model, input, instructions },
  });

  if (!isRecord(payload) || !Array.isArray(payload.output)) {
    throw new Error('Compact response missing output array');
  }

  return payload as unknown as CreateResponseResult;
}

export interface ModelDefinition {
  id: string;
  name: string;
  reasoningEfforts?: ModelReasoningEfforts;
}

export async function listModels(): Promise<ModelDefinition[]> {
  try {
    const models = await fetchFlixaModels({
      apiKey: await getApiKey(),
      headers: getClientHeaders(),
    });
    if (models.length > 0) {
      return models.map((model) => ({
        id: model.id,
        name: model.label,
        reasoningEfforts: normalizeReasoningEfforts(model.efforts),
      }));
    }
  } catch (error) {
    console.error(
      '[Flixa] Failed to fetch models',
      error instanceof Error ? error.message : String(error),
    );
  }

  const { model } = getConfig();
  return [{ id: model, name: model }];
}

async function requestJson(
  url: string,
  options: {
    method: 'GET' | 'POST';
    body?: Record<string, unknown>;
    signal?: AbortSignal;
  },
): Promise<unknown> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...getClientHeaders(),
  };
  const apiKey = await getApiKey();
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  const response = await fetch(url, {
    method: options.method,
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
    signal: options.signal,
  });

  if (!response.ok) {
    throw await readFlixaApiError(response);
  }

  const text = await response.text();
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object';
}
