import { createClientHeaders, fetchFlixaModels } from '@deniai/flixa-api-client';
import type { ResponsesClientConfig } from '@deniai/flixa-core';
import { FLIXA_VERSION, getApiKey, getConfig } from './config.js';
import { normalizeReasoningEfforts, type ModelReasoningEfforts } from './reasoning.js';

export { FlixaApiError } from '@deniai/flixa-api-client';

export type { ResponseUsage } from '@deniai/flixa-core';

export function getClientHeaders(): Record<string, string> {
  return createClientHeaders({ kind: 'zed', version: FLIXA_VERSION });
}

/** Connection settings for the shared agent loop (base URL from FLIXA_BASE_URL). */
export async function getResponsesClient(): Promise<ResponsesClientConfig> {
  return { apiKey: await getApiKey(), headers: getClientHeaders() };
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
