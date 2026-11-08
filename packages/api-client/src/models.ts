import { isRecord } from "./errors";
import { requestJson, type FlixaRequestOptions } from "./http";
import { resolveFlixaApiRoot } from "./urls";

export type FlixaModelTier = "free" | "plus" | "pro";

/** One entry of `GET /v1/models`. */
export interface FlixaModel {
  id: string;
  label: string;
  description: string;
  tags: string[];
  /**
   * Supported reasoning efforts (`low`, `medium`, `high`, `xhigh`, `max`), `false` when the
   * model has no reasoning control, or undefined when the server did not say.
   */
  efforts: string[] | false | undefined;
  contextWindow?: number;
  maxOutputTokens?: number;
  /** Usage tier: 1 = 1x, 2 = 1.5x, 3 = 2x, 4 = 3x, 5+ = premium. Null when not reported. */
  usageTier: number | null;
  tier: FlixaModelTier;
  premium: boolean;
  tokenUsageMultiplier: number;
  default: boolean;
}

export interface FetchModelsOptions extends FlixaRequestOptions {
  /** Optional: the model list is also served without auth. */
  apiKey?: string;
  /** Flixa agent base URL override (`…/v1/agent`). */
  baseUrl?: string;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalizeEfforts(value: unknown): string[] | false | undefined {
  if (value === false) {
    return false;
  }
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value.filter((effort): effort is string => typeof effort === "string");
}

/** Validate one model entry; returns null for entries without an id. */
export function parseFlixaModel(value: unknown): FlixaModel | null {
  if (typeof value === "string" && value) {
    return parseFlixaModel({ id: value });
  }
  if (!isRecord(value) || typeof value["id"] !== "string" || !value["id"]) {
    return null;
  }

  const id = value["id"];
  const label =
    [value["label"], value["name"]].find(
      (candidate): candidate is string => typeof candidate === "string" && !!candidate.trim(),
    ) ?? id;
  const tier = value["tier"];
  const usageTier = finiteNumber(value["usageTier"]);
  const contextWindow = finiteNumber(value["contextWindow"]);
  const maxOutputTokens = finiteNumber(value["maxOutputTokens"]);

  return {
    id,
    label,
    description: typeof value["description"] === "string" ? value["description"] : "",
    tags: Array.isArray(value["tags"])
      ? value["tags"].filter((tag): tag is string => typeof tag === "string")
      : [],
    efforts: normalizeEfforts(
      value["efforts"] ??
        value["reasoningEfforts"] ??
        value["reasoning_efforts"] ??
        value["supportedReasoningEfforts"] ??
        value["supported_reasoning_efforts"],
    ),
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
    usageTier:
      usageTier !== undefined && Number.isInteger(usageTier) && usageTier >= 1 ? usageTier : null,
    tier: tier === "plus" || tier === "pro" ? tier : "free",
    premium: value["premium"] === true,
    tokenUsageMultiplier: finiteNumber(value["tokenUsageMultiplier"]) ?? 1,
    default: value["default"] === true,
  };
}

/** Parse the `/v1/models` body: a bare array (a `{ data: [...] }` wrapper is tolerated). */
export function parseFlixaModels(payload: unknown): FlixaModel[] {
  const list = Array.isArray(payload)
    ? payload
    : isRecord(payload) && Array.isArray(payload["data"])
      ? payload["data"]
      : null;
  if (!list) {
    throw new Error("Unexpected models response format.");
  }

  const models = new Map<string, FlixaModel>();
  for (const entry of list) {
    const model = parseFlixaModel(entry);
    if (model && !models.has(model.id)) {
      models.set(model.id, model);
    }
  }
  return [...models.values()];
}

/** `GET {apiRoot}/models` (bearer auth when an API key is given). */
export async function fetchFlixaModels(options: FetchModelsOptions = {}): Promise<FlixaModel[]> {
  const { payload } = await requestJson(
    `${resolveFlixaApiRoot(options.baseUrl)}/models`,
    { method: "GET", apiKey: options.apiKey },
    options,
  );
  return parseFlixaModels(payload);
}

/** The model the server marks as default, if any. */
export function findDefaultModel(models: readonly FlixaModel[]): FlixaModel | undefined {
  return models.find((model) => model.default);
}
