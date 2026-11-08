import {
  CORE_TOOLS,
  runAgentLoop,
  type AgentEvent,
  type AgentLoopResult,
  type ApprovalMode,
  type ResponsesClientConfig,
  type SafetyReviewResult,
  type ToolApprovalRequest,
} from '@deniai/flixa-core';
import { getFlixaClientHeaders } from '../api/flixaClientHeaders';
import { getCompactTokenThreshold } from '../llm/compact';
import { AGENT_SYSTEM_PROMPT } from '../llm/prompts';
import { getApiKey, getModel, getReasoningEffort } from '../llm/provider';
import { createVscodeToolHost } from './host';

export interface ExtensionAgentTurnOptions {
  /** Responses input for the conversation so far, ending with the new user message. */
  input: unknown[];
  workspaceRoot: string;
  approvalMode: ApprovalMode;
  signal: AbortSignal;
  onEvent: (event: AgentEvent) => void | Promise<void>;
  requestApproval: (request: ToolApprovalRequest) => Promise<boolean>;
  reviewToolCall: (request: ToolApprovalRequest) => Promise<SafetyReviewResult>;
}

export function getAgentResponsesClient(): ResponsesClientConfig {
  return { apiKey: getApiKey(), headers: getFlixaClientHeaders() };
}

/** One agent-mode turn on the shared core loop with the extension's VS Code tool host. */
export function runExtensionAgentTurn(
  options: ExtensionAgentTurnOptions,
): Promise<AgentLoopResult> {
  return runAgentLoop({
    client: getAgentResponsesClient(),
    model: getModel(),
    instructions: AGENT_SYSTEM_PROMPT,
    input: options.input,
    tools: CORE_TOOLS,
    host: createVscodeToolHost({
      workspaceRoot: options.workspaceRoot,
      getApprovalMode: () => options.approvalMode,
    }),
    approval: options.approvalMode,
    requestApproval: options.requestApproval,
    reviewToolCall: options.reviewToolCall,
    reasoningEffort: getReasoningEffort(),
    signal: options.signal,
    maxSteps: Number.POSITIVE_INFINITY,
    compaction: { thresholdTokens: getCompactTokenThreshold() },
    onEvent: options.onEvent,
  });
}
