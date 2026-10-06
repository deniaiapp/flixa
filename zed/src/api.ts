import {
  FLIXA_VERSION,
  getApiKey,
  getConfig,
} from './config.js';
import {
  normalizeReasoningEfforts,
  type ModelReasoningEfforts,
  type ReasoningEffort,
} from './reasoning.js';

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

export interface DeviceAuthInitiateResponse {
  userCode: string;
  deviceCode: string;
  expiresIn: number;
}

export interface DeviceAuthPollResponse {
  approved: boolean;
  apiKey?: string;
}

export class FlixaApiError extends Error {
  readonly status: number;
  readonly payload: unknown;
  readonly code: string | null;

  constructor(status: number, message: string, payload: unknown) {
    super(message);
    this.name = 'FlixaApiError';
    this.status = status;
    this.payload = payload;
    this.code = extractErrorCode(payload);
  }
}

export async function createResponse(
  request: CreateResponseRequest,
): Promise<CreateResponseResult> {
  const config = getConfig();
  const payload = await requestJson(`${config.apiBaseUrl}/v1/agent/responses`, {
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
  const config = getConfig();
  const payload = await requestJson(
    `${config.apiBaseUrl}/v1/agent/responses/compact`,
    {
      method: 'POST',
      body: { model, input, instructions },
    },
  );

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
  const config = getConfig();
  const endpoints = [
    `${config.apiBaseUrl}/v1/models`,
    `${config.apiBaseUrl}/api/v1/models`,
  ];

  for (const endpoint of endpoints) {
    try {
      const payload = await requestJson(endpoint, { method: 'GET' });
      const models = extractModels(payload);
      if (models.length > 0) {
        return models;
      }
    } catch (error) {
      console.error(
        '[Flixa] Failed to fetch models',
        endpoint,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  return [{ id: config.model, name: config.model }];
}

export async function initiateDeviceAuth(): Promise<DeviceAuthInitiateResponse> {
  const config = getConfig();
  const payload = await requestJson(`${config.deniAiBaseUrl}/api/device-auth`, {
    method: 'POST',
    includeAuth: false,
    body: { action: 'initiate' },
  });

  if (
    !isRecord(payload) ||
    typeof payload.userCode !== 'string' ||
    typeof payload.deviceCode !== 'string' ||
    typeof payload.expiresIn !== 'number'
  ) {
    throw new Error('Device auth response is invalid');
  }

  return payload as unknown as DeviceAuthInitiateResponse;
}

export async function pollDeviceAuth(
  deviceCode: string,
): Promise<DeviceAuthPollResponse> {
  const config = getConfig();
  const payload = await requestJson(`${config.deniAiBaseUrl}/api/device-auth`, {
    method: 'POST',
    includeAuth: false,
    body: { action: 'poll', deviceCode },
  });

  if (!isRecord(payload) || typeof payload.approved !== 'boolean') {
    throw new Error('Device auth poll response is invalid');
  }

  return payload as unknown as DeviceAuthPollResponse;
}

async function requestJson(
  url: string,
  options: {
    method: 'GET' | 'POST';
    body?: Record<string, unknown>;
    signal?: AbortSignal;
    includeAuth?: boolean;
  },
): Promise<unknown> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': `flixa-zed/${FLIXA_VERSION}`,
    'x-flixa-client': `zed/${FLIXA_VERSION}`,
    'x-client': 'flixa-zed',
  };
  const includeAuth = options.includeAuth !== false;
  if (includeAuth) {
    const apiKey = await getApiKey();
    if (apiKey) {
      headers.Authorization = `Bearer ${apiKey}`;
    }
  }

  const response = await fetch(url, {
    method: options.method,
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
    signal: options.signal,
  });
  const text = await response.text();
  const payload = parseResponseBody(text);

  if (!response.ok) {
    const message =
      extractErrorMessage(payload) ||
      text ||
      response.statusText ||
      `HTTP ${response.status}`;
    throw new FlixaApiError(response.status, message, payload);
  }

  return payload;
}

function extractModels(payload: unknown): ModelDefinition[] {
  const values = Array.isArray(payload)
    ? payload
    : isRecord(payload) && Array.isArray(payload.model_definitions)
      ? payload.model_definitions
      : isRecord(payload) && Array.isArray(payload.models)
        ? payload.models
        : isRecord(payload) && Array.isArray(payload.data)
          ? payload.data
          : [];

  const models = new Map<string, ModelDefinition>();
  for (const value of values) {
    if (typeof value === 'string') {
      models.set(value, { id: value, name: value });
    } else if (isRecord(value) && typeof value.id === 'string') {
      const name = [value.name, value.label, value.id].find(
        (candidate): candidate is string => typeof candidate === 'string' && candidate.trim().length > 0,
      )!;
      models.set(value.id, {
        id: value.id,
        name,
        reasoningEfforts: normalizeReasoningEfforts(
          value.efforts ??
            value.reasoningEfforts ??
            value.reasoning_efforts ??
            value.supportedReasoningEfforts ??
            value.supported_reasoning_efforts,
        ),
      });
    }
  }
  return [...models.values()];
}

function parseResponseBody(text: string): unknown {
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function extractErrorMessage(payload: unknown): string | null {
  if (typeof payload === 'string') {
    return payload;
  }
  if (!isRecord(payload)) {
    return null;
  }
  if (typeof payload.message === 'string') {
    return payload.message;
  }
  if (isRecord(payload.error) && typeof payload.error.message === 'string') {
    return payload.error.message;
  }
  return null;
}

function extractErrorCode(payload: unknown): string | null {
  if (!isRecord(payload)) {
    return null;
  }
  if (typeof payload.code === 'string') {
    return payload.code;
  }
  if (isRecord(payload.error) && typeof payload.error.code === 'string') {
    return payload.error.code;
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object';
}
