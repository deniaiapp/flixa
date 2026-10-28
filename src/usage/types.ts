export type Tier = "free" | "go" | "plus" | "pro";

export type UsageCategory = "basic" | "premium";

import type { ModelReasoningEfforts } from "../llm/reasoning";

export interface UsageItem {
  category: UsageCategory;
  limit: number;
  used: number;
  /**
   * Pool usage units (1M units = $0.50). Current servers return "units"; older servers
   * return "tokens" (same scale) or "requests" (guests). Kept as a string so unknown values
   * from other server versions are tolerated.
   */
  unit: string;
  remaining: number;
  periodStart: string;
  periodEnd: string;
}

export interface UsageResponse {
  tier: Tier;
  planId: string | null;
  status: "active" | "trialing" | "canceled" | null;
  periodEnd: string | null;
  maxModeEnabled: boolean;
  maxModeEligible: boolean;
  isTeam: boolean;
  hasVerifiedPaymentMethod: boolean;
  cardVerifiedAt: string | null;
  cardFunding: string | null;
  verifyUrl: string | null;
  upgradeUrl: string | null;
  usage: UsageItem[];
}

export interface QuotaExceededErrorMeta {
  message: string;
  type: string;
  param: null;
  code: "USAGE_LIMIT_EXCEEDED";
  category?: UsageCategory;
  tier?: Tier;
  canVerifyForBoost?: boolean;
  canUpgrade?: boolean;
  verifyUrl?: string;
  upgradeUrl?: string;
}

export interface UsageErrorResponse {
  error: {
    message: string;
    type: "authentication_error" | "server_error" | "quota_exceeded";
    param: null;
    code:
      | "missing_auth_header"
      | "missing_api_key"
      | "invalid_key"
      | "expired_key"
      | "db_error"
      | "usage_fetch_error"
      | "USAGE_LIMIT_EXCEEDED";
  };
}

export interface CachedUsage {
  data: UsageResponse;
  fetchedAt: number;
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

export type ModelTierRequirement = "free" | "plus" | "pro";

export interface ModelAccessDefinition {
  id: string;
  premium?: boolean;
  tier?: ModelTierRequirement;
  label?: string;
  description?: string;
  tags?: string[];
  tokenUsageMultiplier?: number;
  /** Usage tier from the Flixa API: Tier 1 = 1x, 2 = 1.5x, 3 = 2x, 4 = 3x, 5+ = premium. */
  usageTier?: number;
  reasoningEfforts?: ModelReasoningEfforts;
  default?: boolean;
}

const FALLBACK_PREMIUM_MODELS = new Set<string>([
  "anthropic/claude-opus-4.6",
  "anthropic/claude-sonnet-4.5",
  "google/gemini-3-pro-preview",
]);

const FALLBACK_TIER_BY_MODEL: Record<string, ModelTierRequirement> = {
  "anthropic/claude-sonnet-4.5": "plus",
  "anthropic/claude-opus-4.5": "pro",
  "anthropic/claude-opus-4.6": "pro",
  "google/gemini-3-pro-preview": "pro",
};

let _premiumModels = new Set<string>(FALLBACK_PREMIUM_MODELS);
let _tierByModel: Record<string, ModelTierRequirement> = { ...FALLBACK_TIER_BY_MODEL };

export function setModelAccessDefinitions(models: ModelAccessDefinition[]): void {
  const premiumModels = new Set<string>(FALLBACK_PREMIUM_MODELS);
  const tierByModel: Record<string, ModelTierRequirement> = { ...FALLBACK_TIER_BY_MODEL };

  for (const model of models) {
    if (!model.id) {
      continue;
    }

    if (model.premium === true) {
      premiumModels.add(model.id);
    } else if (model.premium === false) {
      premiumModels.delete(model.id);
    }

    if (model.tier) {
      tierByModel[model.id] = model.tier;
    }
  }

  _premiumModels = premiumModels;
  _tierByModel = tierByModel;
}

export function isPremiumModel(model: string): boolean {
  return _premiumModels.has(model);
}

export function getModelTierRequirement(model: string): ModelTierRequirement {
  return _tierByModel[model] ?? "free";
}

export function canUseTier(userTier: Tier, requiredTier: ModelTierRequirement): boolean {
  if (requiredTier === "free") {
    return true;
  }
  // Go unlocks free-tier models only.
  if (requiredTier === "plus") {
    return userTier === "plus" || userTier === "pro";
  }
  if (requiredTier === "pro") {
    return userTier === "pro";
  }
  return false;
}

/**
 * Usage is not split by model class: Deni AI chat, Flixa, and Deni Run share one
 * monthly pool. Every entry reports that pool; older servers split it into
 * basic/premium, and then the basic entry stands for it.
 */
export function primaryUsage(data: UsageResponse): UsageItem | undefined {
	return data.usage.find((u) => u.category === 'basic') ?? data.usage[0];
}

export function remainingPercent(item: UsageItem): number {
	return item.limit > 0 ? Math.max(0, Math.min(100, (item.remaining / item.limit) * 100)) : 0;
}
