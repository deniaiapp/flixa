import { readFlixaApiError, tryParseJson } from "./errors";

/** Options shared by every request helper. */
export interface FlixaRequestOptions {
  /** Client identification headers (see createClientHeaders). */
  headers?: Record<string, string>;
  /** Custom fetch (tests, proxies). Defaults to the global fetch. */
  fetch?: typeof fetch;
  signal?: AbortSignal;
  /** Per-request timeout. Combined with `signal` when both are set. */
  timeoutMs?: number;
}

function combineSignals(signal?: AbortSignal, timeoutMs?: number): AbortSignal | undefined {
  const timeoutSignal =
    timeoutMs !== undefined && timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined;
  if (signal && timeoutSignal) {
    return AbortSignal.any([signal, timeoutSignal]);
  }
  return signal ?? timeoutSignal;
}

export interface JsonResponse {
  status: number;
  headers: Headers;
  payload: unknown;
}

/** Send a request and parse its JSON body. Throws FlixaApiError for non-ok responses. */
export async function requestJson(
  url: string,
  init: {
    method: "GET" | "POST";
    apiKey?: string;
    body?: unknown;
    headers?: Record<string, string>;
  },
  options: FlixaRequestOptions = {},
): Promise<JsonResponse> {
  const headers: Record<string, string> = { ...init.headers, ...options.headers };
  if (init.body !== undefined) {
    headers["Content-Type"] = "application/json";
  }
  if (init.apiKey) {
    headers["Authorization"] = `Bearer ${init.apiKey}`;
  }

  const response = await (options.fetch ?? globalThis.fetch)(url, {
    method: init.method,
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: combineSignals(options.signal, options.timeoutMs),
  });

  if (!response.ok) {
    throw await readFlixaApiError(response);
  }

  const text = await response.text();
  const payload = tryParseJson(text);
  if (payload === null && text.trim()) {
    throw new Error(`Unexpected non-JSON response from ${url}`);
  }
  return { status: response.status, headers: response.headers, payload };
}
