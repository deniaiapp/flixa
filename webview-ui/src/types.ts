export interface ActionResult {
  action: string;
  success: boolean;
  rejected?: boolean;
  rejectionReason?: string;
  output?: string;
  error?: string;
}

export interface ChatCompletionToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface ToolResult {
  tool_call_id: string;
  toolName: string;
  content: string;
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

export interface ReferencedContextFile {
  reference: string;
  filePath: string;
  content: string;
}

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system' | 'result' | 'tool' | 'executing';
  content: string;
  images?: ImageAttachment[];
  results?: ActionResult[];
  tool_calls?: ChatCompletionToolCall[];
  toolResults?: ToolResult[];
  executingAction?: string;
  executingOutput?: string;
  activeSelection?: string;
  activeFilePath?: string;
  activeSelectionLabel?: string;
  mentionedFiles?: ReferencedContextFile[];
}

export interface ChatSession {
  id: string;
  name: string;
}

export type Tier = 'free' | 'plus' | 'pro' | "max";
export type ModelTierRequirement = 'free' | 'plus' | 'pro' | "max";
export type ReasoningEffort = 'low' | 'medium' | 'high';

export interface ModelDefinition {
  id: string;
  label?: string;
  description?: string;
  tags?: string[];
  premium?: boolean;
  tier?: ModelTierRequirement;
  tokenUsageMultiplier?: number;
}

export interface UsageItem {
  category: 'basic' | 'premium';
  limit: number;
  used: number;
  unit: string;
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
  hasVerifiedPaymentMethod: boolean;
  cardVerifiedAt: string | null;
  cardFunding: string | null;
  verifyUrl: string | null;
  upgradeUrl: string | null;
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
  workspaceFiles?: string[];
  activeFilePath?: string;
  activeSelection?: string;
  activeSelectionLabel?: string;
}

export function canUseTier(userTier: Tier | null, requiredTier: ModelTierRequirement): boolean {
  if (!userTier) {
    return false;
  }
  if (requiredTier === 'free') {
    return true;
  }
  if (requiredTier === 'plus') {
    return userTier === 'plus' || userTier === 'pro' || userTier === 'max';
  }
  if (requiredTier === 'pro') {
    return userTier === 'pro' || userTier === 'max';
  }
  if (requiredTier === 'max') {
    return userTier === 'max';
  }
  return false;
}
