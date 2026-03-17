export interface ActionResult {
  action: string;
  success: boolean;
  rejected?: boolean;
  rejectionReason?: string;
  output?: string;
  error?: string;
}

export interface FileChange {
  filePath: string;
  status: 'modified' | 'created' | 'deleted';
}

export interface ImageAttachment {
  id: string;
  data: string;
  mimeType: string;
  name?: string;
}

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system' | 'result' | 'executing';
  content: string;
  images?: ImageAttachment[];
  results?: ActionResult[];
  executingAction?: string;
  executingOutput?: string;
}

export interface ChatSession {
  id: string;
  name: string;
}

export type Tier = 'free' | 'plus' | 'pro';
export type ModelTierRequirement = 'free' | 'plus' | 'pro';
export type ReasoningEffort = 'low' | 'medium' | 'high';

export interface ModelDefinition {
  id: string;
  label?: string;
  description?: string;
  tags?: string[];
  premium?: boolean;
  tier?: ModelTierRequirement;
}

export interface UsageItem {
  category: 'basic' | 'premium';
  limit: number;
  used: number;
  remaining: number;
  periodStart: string;
  periodEnd: string;
}

export interface UsageData {
  tier: Tier;
  planId: string | null;
  status: 'active' | 'trialing' | 'canceled' | null;
  periodEnd: string | null;
  maxModeEnabled: boolean;
  maxModeEligible: boolean;
  usage: UsageItem[];
}

export interface AppState {
  messages: ChatMessage[];
  sessions: ChatSession[];
  currentSessionId: string;
  agentMode: boolean;
  approvalMode: string;
  selectedModel: string;
  selectedReasoningEffort: ReasoningEffort;
  isLoading: boolean;
  agentRunning: boolean;
  usageData: UsageData | null;
  isLoggedIn: boolean;
}

export function canUseTier(userTier: Tier | null, requiredTier: ModelTierRequirement): boolean {
  if (!userTier) {
    return false;
  }
  if (requiredTier === 'free') {
    return true;
  }
  if (requiredTier === 'plus') {
    return userTier === 'plus' || userTier === 'pro';
  }
  if (requiredTier === 'pro') {
    return userTier === 'pro';
  }
  return false;
}
