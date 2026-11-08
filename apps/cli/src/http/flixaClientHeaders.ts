import { CLI_VERSION } from "../version.ts";

/** Canonical client id for Flixa CLI (backend `client: "flixa_cli"`). */
export const FLIXA_CLI_CLIENT_ID = "flixa-cli";

/** Value for `x-flixa-client` product segment (`cli` / `cli/<version>`). */
export const FLIXA_CLI_CLIENT_KIND = "cli";

export function getFlixaCliVersion(): string {
  return CLI_VERSION;
}

/**
 * Client signal headers required by the Flixa / Deni AI backend.
 * Attach to every authenticated request to Flixa agent/model/usage APIs.
 */
export function getFlixaCliClientHeaders(
  version: string = getFlixaCliVersion(),
): Record<string, string> {
  const platformTag = `${process.platform}-${process.arch}`;
  return {
    "User-Agent": `${FLIXA_CLI_CLIENT_ID}/${version} (${platformTag})`,
    "x-client": FLIXA_CLI_CLIENT_ID,
    "x-flixa-client": `${FLIXA_CLI_CLIENT_KIND}/${version}`,
    originator: FLIXA_CLI_CLIENT_ID,
  };
}

/**
 * Merge existing request headers with Flixa CLI client signals.
 * Client signal headers always win so they cannot be dropped accidentally.
 */
export function mergeFlixaCliClientHeaders(
  headers?: HeadersInit,
  version?: string,
): Record<string, string> {
  return {
    ...headersInitToRecord(headers),
    ...getFlixaCliClientHeaders(version),
  };
}

/**
 * fetch wrapper that always attaches Flixa CLI client signals.
 * Use for raw requests to Flixa / Deni AI APIs (not login/device-auth).
 *
 * Also suitable as a custom `fetch` for AI SDKs: they often overwrite
 * User-Agent with `ai/...`; this re-applies Flixa CLI signals last.
 */
export async function flixaFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return fetch(input, {
    ...init,
    headers: mergeFlixaCliClientHeaders(init?.headers),
  });
}

/** Bound fetch for AI SDK `fetch` options (preserves `this`-free call style). */
export function createFlixaFetch(): typeof fetch {
  return flixaFetch as typeof fetch;
}

function headersInitToRecord(headers?: HeadersInit): Record<string, string> {
  if (!headers) {
    return {};
  }

  if (headers instanceof Headers) {
    const record: Record<string, string> = {};
    headers.forEach((value, key) => {
      record[key] = value;
    });
    return record;
  }

  if (Array.isArray(headers)) {
    const record: Record<string, string> = {};
    for (const [key, value] of headers) {
      record[key] = value;
    }
    return record;
  }

  const record: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === "string") {
      record[key] = value;
    }
  }
  return record;
}
