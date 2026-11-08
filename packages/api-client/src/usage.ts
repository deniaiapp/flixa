import { FlixaApiError, isRecord, type UsageCategory, type UsageTier } from "./errors";
import { requestJson, type FlixaRequestOptions } from "./http";
import { resolveFlixaApiRoot } from "./urls";

/** Usage pool units: 2,000,000 units = $1. */
export const USAGE_UNITS_PER_USD = 2_000_000;

export function usageUnitsToUsd(units: number): number {
  return units / USAGE_UNITS_PER_USD;
}

export type UsageUnit = "units" | "tokens" | "requests";

export interface DeniUsageItem {
  category: UsageCategory;
  unit: UsageUnit;
  /** null = unlimited. */
  limit: number | null;
  used: number;
  remaining: number | null;
  periodStart: string;
  periodEnd: string | null;
}

/** The monthly pool shared by Flixa, Deni AI chat, and Deni Run. */
export interface DeniUsagePool {
  limit: number;
  used: number;
  remaining: number;
  periodEnd: string | null;
}

export interface DeniUsageInfo {
  tier: UsageTier;
  planId: string | null;
  status: string | null;
  hasVerifiedPaymentMethod: boolean;
  cardVerifiedAt: string | null;
  verifyUrl: string | null;
  upgradeUrl: string | null;
  isTeam: boolean;
  periodEnd: string | null;
  maxModeEnabled: boolean;
  maxModeEligible: boolean;
  pool?: DeniUsagePool;
  usage: DeniUsageItem[];
}

/** The usage figures to show: `pool` when present, else the basic usage item. */
export interface UsageSummary {
  limit: number | null;
  used: number;
  remaining: number | null;
  periodEnd: string | null;
}

export interface FetchUsageOptions extends FlixaRequestOptions {
  apiKey: string;
  /** Flixa agent base URL override (`…/v1/agent`). */
  baseUrl?: string;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function normalizeTier(value: unknown): UsageTier {
  return value === "go" || value === "plus" || value === "pro" ? value : "free";
}

function normalizeUnit(value: unknown): UsageUnit {
  return value === "tokens" || value === "requests" ? value : "units";
}

function normalizeUsageItem(value: unknown): DeniUsageItem | null {
  if (!isRecord(value)) {
    return null;
  }
  const category = value["category"];
  const used = finiteNumber(value["used"]);
  if ((category !== "basic" && category !== "premium") || used === null) {
    return null;
  }
  const limit = finiteNumber(value["limit"]);
  const remaining =
    finiteNumber(value["remaining"]) ?? (limit === null ? null : Math.max(limit - used, 0));
  return {
    category,
    unit: normalizeUnit(value["unit"]),
    limit,
    used,
    remaining,
    periodStart: typeof value["periodStart"] === "string" ? value["periodStart"] : "",
    periodEnd: stringOrNull(value["periodEnd"]),
  };
}

function normalizePool(value: unknown): DeniUsagePool | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const limit = finiteNumber(value["limit"]);
  const used = finiteNumber(value["used"]);
  if (limit === null || used === null) {
    return undefined;
  }
  return {
    limit,
    used,
    remaining: finiteNumber(value["remaining"]) ?? Math.max(limit - used, 0),
    periodEnd: stringOrNull(value["periodEnd"]),
  };
}

/** Validate a usage payload, filling defaults for fields older servers omit. */
export function parseDeniUsageInfo(payload: unknown): DeniUsageInfo {
  if (!isRecord(payload)) {
    throw new Error("Unexpected usage response format.");
  }

  const usage = Array.isArray(payload["usage"])
    ? payload["usage"]
        .map(normalizeUsageItem)
        .filter((item): item is DeniUsageItem => item !== null)
    : [];
  const pool = normalizePool(payload["pool"]);

  return {
    tier: normalizeTier(payload["tier"]),
    planId: stringOrNull(payload["planId"]),
    status: stringOrNull(payload["status"]),
    hasVerifiedPaymentMethod: payload["hasVerifiedPaymentMethod"] === true,
    cardVerifiedAt: stringOrNull(payload["cardVerifiedAt"]),
    verifyUrl: stringOrNull(payload["verifyUrl"]),
    upgradeUrl: stringOrNull(payload["upgradeUrl"]),
    isTeam: payload["isTeam"] === true,
    periodEnd: stringOrNull(payload["periodEnd"]) ?? pool?.periodEnd ?? usage[0]?.periodEnd ?? null,
    maxModeEnabled: payload["maxModeEnabled"] === true,
    maxModeEligible: payload["maxModeEligible"] === true,
    ...(pool ? { pool } : {}),
    usage,
  };
}

/**
 * Usage is one monthly pool shared with Deni AI chat and Deni Run. Prefer `pool`; older
 * servers only send `usage[]` (split into basic/premium, where basic stands for the pool).
 */
export function getUsageSummary(info: DeniUsageInfo): UsageSummary | null {
  if (info.pool) {
    return { ...info.pool };
  }
  const item = info.usage.find((entry) => entry.category === "basic") ?? info.usage[0];
  if (!item) {
    return null;
  }
  return {
    limit: item.limit,
    used: item.used,
    remaining: item.remaining,
    periodEnd: item.periodEnd,
  };
}

/** Percentage of the pool left (0–100), or null when unlimited/unknown. */
export function getRemainingPercent(summary: UsageSummary): number | null {
  if (summary.limit === null || summary.limit <= 0 || summary.remaining === null) {
    return null;
  }
  return Math.max(0, Math.min(100, (summary.remaining / summary.limit) * 100));
}

/**
 * `GET {apiRoot}/deni/usage` with bearer auth. Falls back to `/deni/billing-status`
 * only when the usage endpoint does not exist (404).
 */
export async function fetchDeniUsage(options: FetchUsageOptions): Promise<DeniUsageInfo> {
  const apiRoot = resolveFlixaApiRoot(options.baseUrl);
  try {
    const { payload } = await requestJson(
      `${apiRoot}/deni/usage`,
      { method: "GET", apiKey: options.apiKey },
      options,
    );
    return parseDeniUsageInfo(payload);
  } catch (error) {
    if (!(error instanceof FlixaApiError) || error.status !== 404) {
      throw error;
    }
  }

  const { payload } = await requestJson(
    `${apiRoot}/deni/billing-status`,
    { method: "GET", apiKey: options.apiKey },
    options,
  );
  return parseDeniUsageInfo(payload);
}
