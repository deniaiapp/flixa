import { getFlixaClientHeaders } from './flixaClientHeaders';
import { getApiKey } from '../llm/provider';
import { getFlixaApiBaseUrl } from '../usage/service';
import { log } from '../logger';

export interface CompactResponseRequest {
	model: string;
	input?: unknown;
	messages?: unknown[];
	instructions?: string;
}

export interface CompactResponseUsage {
	input_tokens?: number;
	output_tokens?: number;
	total_tokens?: number;
}

export interface CompactResponseResult {
	id?: string;
	object?: string;
	created_at?: number;
	output: unknown[];
	usage?: CompactResponseUsage;
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
	return `${getFlixaApiBaseUrl().replace(/\/+$/, '')}/v1/agent`;
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
 * Explicit compaction of the current context window.
 * POST /v1/agent/responses/compact
 */
export async function compactResponse(
	request: CompactResponseRequest
): Promise<CompactResponseResult> {
	const url = `${getAgentBaseUrl()}/responses/compact`;
	const body: Record<string, unknown> = {
		model: request.model,
	};
	if (request.input !== undefined) {
		body.input = request.input;
	}
	if (request.messages !== undefined) {
		body.messages = request.messages;
	}
	if (request.instructions !== undefined) {
		body.instructions = request.instructions;
	}

	log('[Flixa] compactResponse request', {
		model: request.model,
		hasInput: request.input !== undefined,
		hasMessages: request.messages !== undefined,
	});

	const response = await fetch(url, {
		method: 'POST',
		headers: buildAuthHeaders(),
		body: JSON.stringify(body),
	});

	if (!response.ok) {
		const errorBody = await parseErrorBody(response);
		throw new Error(
			`Compact request failed (${response.status}): ${errorBody}`
		);
	}

	const payload = (await response.json()) as CompactResponseResult;
	if (!payload || !Array.isArray(payload.output)) {
		throw new Error('Compact response missing output array');
	}

	log('[Flixa] compactResponse done', {
		outputItems: payload.output.length,
		usage: payload.usage,
	});

	return payload;
}

/**
 * Normal Responses API turn.
 * POST /v1/agent/responses
 */
export async function createResponse(
	request: CreateResponseRequest
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
		throw new Error(
			`Responses request failed (${response.status}): ${errorBody}`
		);
	}

	const payload = (await response.json()) as CreateResponseResult;
	if (!payload || !Array.isArray(payload.output)) {
		throw new Error('Responses response missing output array');
	}

	return payload;
}
