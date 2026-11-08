import {
  getUsageSummary,
  type DeniUsageInfo,
  type UsageCategory,
  type UsageLimitExceededDetails,
  type UsageTier,
} from '@deniai/flixa-api-client';
import type { ModelReasoningEfforts } from '../llm/reasoning';

export type Tier = UsageTier;

export type { UsageCategory };

/** `GET /v1/deni/usage` response (see @deniai/flixa-api-client). */
export type UsageResponse = DeniUsageInfo;

/** The shared monthly pool when it has a finite limit. */
export interface UsagePool {
  limit: number;
  used: number;
  remaining: number;
  periodEnd: string | null;
}

export type QuotaExceededErrorMeta = UsageLimitExceededDetails;

export interface CachedUsage {
  data: UsageResponse;
  fetchedAt: number;
}

export type ModelTierRequirement = 'free' | 'plus' | 'pro';

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
  'anthropic/claude-opus-4.6',
  'anthropic/claude-sonnet-4.5',
  'google/gemini-3-pro-preview',
]);

const FALLBACK_TIER_BY_MODEL: Record<string, ModelTierRequirement> = {
  'anthropic/claude-sonnet-4.5': 'plus',
  'anthropic/claude-opus-4.5': 'pro',
  'anthropic/claude-opus-4.6': 'pro',
  'google/gemini-3-pro-preview': 'pro',
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
  return _tierByModel[model] ?? 'free';
}

export function canUseTier(userTier: Tier, requiredTier: ModelTierRequirement): boolean {
  if (requiredTier === 'free') {
    return true;
  }
  // Go unlocks free-tier models only.
  if (requiredTier === 'plus') {
    return userTier === 'plus' || userTier === 'pro';
  }
  if (requiredTier === 'pro') {
    return userTier === 'pro';
  }
  return false;
}

/**
 * Usage is not split by model class: Deni AI chat, Flixa, and Deni Run share one
 * monthly pool. Prefer `pool`, else the basic usage entry. Unlimited pools return undefined.
 */
export function primaryUsage(data: UsageResponse): UsagePool | undefined {
  const summary = getUsageSummary(data);
  if (!summary || summary.limit === null || summary.remaining === null) {
    return undefined;
  }
  return {
    limit: summary.limit,
    used: summary.used,
    remaining: summary.remaining,
    periodEnd: summary.periodEnd,
  };
}

export function remainingPercent(item: UsagePool): number {
  return item.limit > 0 ? Math.max(0, Math.min(100, (item.remaining / item.limit) * 100)) : 0;
}
