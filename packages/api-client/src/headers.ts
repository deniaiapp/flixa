type FetchInput = Parameters<typeof fetch>[0];
type FetchHeadersInit = NonNullable<RequestInit["headers"]>;

export type FlixaClientKind = "cli" | "vscode" | "zed";

export interface FlixaClientIdentity {
  kind: FlixaClientKind;
  version: string;
  /** Defaults to `process.platform`. */
  platform?: string;
  /** Defaults to `process.arch` (only the CLI reports it). */
  arch?: string;
}

/** `x-client` / `originator` value per client kind. */
export const FLIXA_CLIENT_IDS: Readonly<Record<FlixaClientKind, string>> = {
  cli: "flixa-cli",
  vscode: "flixa-vscode",
  zed: "flixa-zed",
};

function currentProcess(): { platform?: string; arch?: string } {
  return (globalThis as { process?: { platform?: string; arch?: string } }).process ?? {};
}

/**
 * Client signal headers required by the Flixa / Deni AI backend. Attach them to every
 * request to Flixa agent/model/usage APIs.
 */
export function createClientHeaders(identity: FlixaClientIdentity): Record<string, string> {
  const clientId = FLIXA_CLIENT_IDS[identity.kind];
  const platform = identity.platform ?? currentProcess().platform ?? "unknown";
  const { version } = identity;

  switch (identity.kind) {
    case "cli": {
      const arch = identity.arch ?? currentProcess().arch ?? "unknown";
      return {
        "User-Agent": `${clientId}/${version} (${platform}-${arch})`,
        "x-client": clientId,
        "x-flixa-client": `cli/${version}`,
        originator: clientId,
      };
    }
    case "vscode":
      return {
        "User-Agent": `${clientId}/${version}`,
        "x-flixa-client": `vscode/${version} (${platform})`,
        "x-client": clientId,
      };
    case "zed":
      return {
        "User-Agent": `${clientId}/${version}`,
        "x-flixa-client": `zed/${version}`,
        "x-client": clientId,
      };
  }
}

export function headersInitToRecord(headers?: FetchHeadersInit): Record<string, string> {
  if (!headers) {
    return {};
  }

  const record: Record<string, string> = {};
  if (headers instanceof Headers) {
    headers.forEach((value, key) => {
      record[key] = value;
    });
    return record;
  }

  if (Array.isArray(headers)) {
    for (const [key, value] of headers) {
      if (key !== undefined && value !== undefined) {
        record[key] = value;
      }
    }
    return record;
  }

  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === "string") {
      record[key] = value;
    }
  }
  return record;
}

/** Merge request headers with client signals; client signals always win. */
export function mergeClientHeaders(
  headers: FetchHeadersInit | undefined,
  clientHeaders: Record<string, string>,
): Record<string, string> {
  return { ...headersInitToRecord(headers), ...clientHeaders };
}

/**
 * fetch wrapper that always re-applies the client signals last. Suitable as a custom
 * `fetch` for AI SDKs, which otherwise overwrite User-Agent with `ai/...`.
 */
export function createClientFetch(
  clientHeaders: Record<string, string>,
  baseFetch?: typeof fetch,
): typeof fetch {
  const clientFetch = (input: FetchInput, init?: RequestInit): Promise<Response> =>
    (baseFetch ?? globalThis.fetch)(input, {
      ...init,
      headers: mergeClientHeaders(init?.headers, clientHeaders),
    });
  return clientFetch as typeof fetch;
}
