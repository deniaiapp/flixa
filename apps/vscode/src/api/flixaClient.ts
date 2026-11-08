import { resolveFlixaBaseUrl } from '@deniai/flixa-api-client';
import { getFlixaClientHeaders } from './flixaClientHeaders';
import { getApiKey } from '../llm/provider';

export interface CompactResponseUsage {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
}

export interface CreateResponseRequest {
  model: string;
  input: unknown;
  instructions?: string;
  tools?: unknown[];
  store?: boolean;
  include?: string[];
  reasoning?: { effort?: string; context?: string };
  abortSignal?: AbortSignal;
}

export interface CreateResponseResult {
  id?: string;
  output: unknown[];
  usage?: CompactResponseUsage;
  status?: string;
  error?: unknown;
}

function getAgentBaseUrl(): string {
  return resolveFlixaBaseUrl();
}

function buildAuthHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...getFlixaClientHeaders(),
  };
  const apiKey = getApiKey();
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  return headers;
}

async function parseErrorBody(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return text || response.statusText;
  } catch {
    return response.statusText;
  }
}

/**
 * Normal Responses API turn.
 * POST /v1/agent/responses
 */
export async function createResponse(
  request: CreateResponseRequest,
): Promise<CreateResponseResult> {
  const url = `${getAgentBaseUrl()}/responses`;
  const body: Record<string, unknown> = {
    model: request.model,
    input: request.input,
    store: request.store ?? false,
    include: request.include ?? ['reasoning.encrypted_content'],
  };
  if (request.instructions !== undefined) {
    body.instructions = request.instructions;
  }
  if (request.tools !== undefined) {
    body.tools = request.tools;
  }
  if (request.reasoning !== undefined) {
    body.reasoning = request.reasoning;
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: buildAuthHeaders(),
    body: JSON.stringify(body),
    signal: request.abortSignal,
  });

  if (!response.ok) {
    const errorBody = await parseErrorBody(response);
    throw new Error(`Responses request failed (${response.status}): ${errorBody}`);
  }

  const payload = (await response.json()) as CreateResponseResult;
  if (!payload || !Array.isArray(payload.output)) {
    throw new Error('Responses response missing output array');
  }

  return payload;
}
