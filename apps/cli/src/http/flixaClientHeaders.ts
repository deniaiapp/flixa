import { createClientFetch, createClientHeaders } from "@deniai/flixa-api-client";
import { CLI_VERSION } from "../version.ts";

/**
 * Client signal headers required by the Flixa / Deni AI backend.
 * Attach to every authenticated request to Flixa agent/model/usage APIs.
 */
export function getFlixaCliClientHeaders(version: string = CLI_VERSION): Record<string, string> {
  return createClientHeaders({ kind: "cli", version });
}

/**
 * fetch that always attaches Flixa CLI client signals (not used for device auth).
 * Also suitable as a custom `fetch` for AI SDKs, which often overwrite User-Agent.
 */
export function createFlixaFetch(): typeof fetch {
  return createClientFetch(getFlixaCliClientHeaders());
}
