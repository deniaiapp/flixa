import {
  needsApproval,
  type ApprovalDecision,
  type ApprovalMode,
  type ApprovalPolicy,
} from "./approval";
import {
  compactConversation,
  createResponsesSummarizer,
  estimateTokens,
  type SummaryGenerator,
} from "./compact";
import {
  streamResponse,
  type ResponseItem,
  type ResponsesClientConfig,
  type ResponseTurn,
  type ResponseUsage,
} from "./responses";
import type { SafetyReviewResult } from "./safety-review";
import { summarizeToolCall } from "./summary";
import { createDeniedToolResult, runTool } from "./tools/index";
import {
  toFunctionToolDefinition,
  type AgentTool,
  type ToolCategory,
  type ToolContext,
  type ToolHost,
  type ToolResult,
} from "./types";
import { createAbortError, getOptionalString, isAbortError, isRecord, shorten } from "./util";

export const DEFAULT_MAX_AGENT_STEPS = 40;

export interface AgentToolCall {
  callId: string;
  name: string;
  argumentsText: string;
  input: Record<string, unknown>;
  /** Undefined when the model named a tool that was not offered. */
  tool?: AgentTool;
  category: ToolCategory;
  /** One-line summary (CLI style), e.g. the command or file path. */
  summary: string;
  /** Short title for cards, e.g. `Edit src/a.ts`. */
  title: string;
}

export interface ToolApprovalRequest {
  call: AgentToolCall;
  /** Why the approval policy wants a decision. */
  reason: string;
  /** The model's own `reason` argument, when it gave one. */
  modelReason?: string;
}

export interface FinishedToolCall {
  call: AgentToolCall;
  result: ToolResult;
  /** True when the call was not executed (unknown tool, policy, hook, review, or user). */
  denied: boolean;
  /** Set with `denied`. */
  denialReason?: string;
}

export type AgentEvent =
  | { type: "step_started"; step: number }
  | { type: "text_delta"; delta: string }
  | { type: "reasoning_delta"; delta: string }
  | {
      type: "assistant_message";
      step: number;
      text: string;
      reasoning: string;
      toolCalls: AgentToolCall[];
    }
  | { type: "tool_call_started"; call: AgentToolCall }
  | { type: "safety_review_started"; call: AgentToolCall }
  | { type: "safety_review_finished"; call: AgentToolCall; review: SafetyReviewResult }
  | { type: "approval_requested"; request: ToolApprovalRequest }
  | { type: "tool_execution_started"; call: AgentToolCall }
  | { type: "tool_output"; call: AgentToolCall; output: string }
  | ({ type: "tool_call_finished" } & FinishedToolCall)
  | { type: "step_finished"; step: number; results: FinishedToolCall[] }
  | { type: "usage"; usage: ResponseUsage }
  | {
      type: "compacted";
      items: ResponseItem[];
      summary: string;
      tokensBefore: number;
      tokensAfter: number;
    }
  | { type: "compaction_failed"; error: unknown }
  | { type: "error"; error: unknown }
  | { type: "done"; result: AgentLoopResult };

export interface AgentLoopOptions {
  client: ResponsesClientConfig;
  model: string;
  instructions?: string;
  /** Conversation so far as Responses input items, ending with the new user message. */
  input: readonly unknown[];
  tools: readonly AgentTool[];
  host: ToolHost;
  /** One of the four modes, or a client-defined policy (the CLI's modes). */
  approval: ApprovalMode | ApprovalPolicy;
  /** Ask the user. Missing means every `ask` decision is denied. */
  requestApproval?: (request: ToolApprovalRequest) => Promise<boolean>;
  /** AI safety review. Missing means every `review` decision is denied. */
  reviewToolCall?: (request: ToolApprovalRequest) => Promise<SafetyReviewResult>;
  /** Client gate before the approval policy (permission rules, hooks). Return a denial reason. */
  beforeToolCall?: (
    call: AgentToolCall,
    signal?: AbortSignal,
  ) => Promise<string | null | undefined>;
  /** Extra text appended to a tool's output for the model (post-tool hooks). */
  afterToolCall?: (
    call: AgentToolCall,
    result: ToolResult,
    signal?: AbortSignal,
  ) => Promise<string | null | undefined>;
  toolContext?: Pick<ToolContext, "allowShell" | "allowFileEdits" | "onBeforeFileChange">;
  onEvent?: (event: AgentEvent) => void | Promise<void>;
  signal?: AbortSignal;
  /** Defaults to 40 model requests per turn. */
  maxSteps?: number;
  reasoningEffort?: string;
  maxOutputTokens?: number;
  /** Local compaction before a step when the input reaches the threshold (0 disables). */
  compaction?: { thresholdTokens: number; generate?: SummaryGenerator };
}

export type AgentStopReason = "completed" | "max_steps" | "cancelled";

export interface AgentLoopResult {
  /** The full conversation after this turn (input plus every output and tool result). */
  items: ResponseItem[];
  finalText: string;
  reasoningText: string;
  steps: number;
  stopReason: AgentStopReason;
  /** Usage of the last model request. */
  usage?: ResponseUsage;
  toolResults: FinishedToolCall[];
}

/**
 * Run one agent turn: stream a Responses request, execute the requested tools through the
 * approval policy, feed the results back, and repeat until the model stops calling tools,
 * the step limit is hit, or the signal aborts.
 */
export async function runAgentLoop(options: AgentLoopOptions): Promise<AgentLoopResult> {
  const maxSteps = options.maxSteps ?? DEFAULT_MAX_AGENT_STEPS;
  const offered = new Map(options.tools.map((tool) => [tool.name, tool]));
  const toolDefinitions = options.tools.map(toFunctionToolDefinition);
  const signal = options.signal;

  let queue: Promise<void> = Promise.resolve();
  const emit = (event: AgentEvent): Promise<void> => {
    queue = queue.then(() => options.onEvent?.(event));
    return queue;
  };

  let items: ResponseItem[] = options.input.filter(isRecord);
  const toolResults: FinishedToolCall[] = [];
  let reasoningText = "";
  let lastUsage: ResponseUsage | undefined;
  let step = 0;

  const finish = async (
    stopReason: AgentStopReason,
    finalText: string,
  ): Promise<AgentLoopResult> => {
    const result: AgentLoopResult = {
      items,
      finalText,
      reasoningText,
      steps: step,
      stopReason,
      usage: lastUsage,
      toolResults,
    };
    await emit({ type: "done", result });
    return result;
  };

  try {
    while (step < maxSteps) {
      if (signal?.aborted) {
        return await finish("cancelled", "");
      }

      items = await maybeCompact(items, options, emit);
      step += 1;
      await emit({ type: "step_started", step });

      let turn: ResponseTurn;
      try {
        turn = await streamResponse(
          options.client,
          {
            model: options.model,
            input: items,
            instructions: options.instructions,
            tools: toolDefinitions,
            toolChoice: toolDefinitions.length > 0 ? "auto" : undefined,
            reasoningEffort: options.reasoningEffort,
            maxOutputTokens: options.maxOutputTokens,
          },
          {
            signal,
            onTextDelta: (delta) => void emit({ type: "text_delta", delta }),
            onReasoningDelta: (delta) => void emit({ type: "reasoning_delta", delta }),
          },
        );
      } catch (error) {
        if (signal?.aborted || isAbortError(error)) {
          return await finish("cancelled", "");
        }
        throw error;
      }

      items = [...items, ...turn.output];
      if (turn.usage) {
        lastUsage = turn.usage;
        await emit({ type: "usage", usage: turn.usage });
      }
      if (turn.reasoning) {
        reasoningText = reasoningText ? `${reasoningText}\n\n${turn.reasoning}` : turn.reasoning;
      }

      const calls = turn.toolCalls.map((call): AgentToolCall => {
        const tool = offered.get(call.name);
        return {
          callId: call.callId,
          name: call.name,
          argumentsText: call.argumentsText,
          input: call.input,
          tool,
          category: tool?.category ?? "other",
          summary: summarizeToolCall(call.name, call.argumentsText),
          title: tool?.title?.(call.input) ?? call.name,
        };
      });
      await emit({
        type: "assistant_message",
        step,
        text: turn.text,
        reasoning: turn.reasoning,
        toolCalls: calls,
      });

      if (calls.length === 0) {
        return await finish("completed", turn.text.trim() || buildFallbackText(toolResults));
      }

      const stepResults: FinishedToolCall[] = [];
      for (let index = 0; index < calls.length; index += 1) {
        const call = calls[index] as AgentToolCall;
        if (signal?.aborted) {
          items = [...items, ...cancelledOutputs(calls.slice(index))];
          await emit({ type: "step_finished", step, results: stepResults });
          return await finish("cancelled", "");
        }

        let finished: FinishedToolCall;
        let feedback = "";
        try {
          finished = await handleToolCall(call, options, emit);
          if (!finished.denied && options.afterToolCall) {
            feedback = (await options.afterToolCall(call, finished.result, signal)) ?? "";
          }
        } catch (error) {
          if (signal?.aborted || isAbortError(error)) {
            items = [...items, ...cancelledOutputs(calls.slice(index))];
            await emit({ type: "step_finished", step, results: stepResults });
            return await finish("cancelled", "");
          }
          throw error;
        }

        stepResults.push(finished);
        if (!finished.denied) {
          toolResults.push(finished);
        }
        items = [
          ...items,
          {
            type: "function_call_output",
            call_id: call.callId,
            output: `${finished.result.output}${feedback}`,
          },
        ];
      }
      await emit({ type: "step_finished", step, results: stepResults });
    }

    return await finish("max_steps", buildFallbackText(toolResults));
  } catch (error) {
    await emit({ type: "error", error }).catch(() => undefined);
    throw error;
  } finally {
    await queue.catch(() => undefined);
  }
}

async function maybeCompact(
  items: ResponseItem[],
  options: AgentLoopOptions,
  emit: (event: AgentEvent) => Promise<void>,
): Promise<ResponseItem[]> {
  const threshold = options.compaction?.thresholdTokens ?? 0;
  if (threshold <= 0 || items.length < 2) {
    return items;
  }
  const tokens = estimateTokens(items) + estimateTokens(options.instructions ?? "");
  if (tokens < threshold) {
    return items;
  }

  try {
    const generate =
      options.compaction?.generate ??
      createResponsesSummarizer({
        client: options.client,
        model: options.model,
        signal: options.signal,
      });
    const compacted = await compactConversation({
      items,
      generate,
      maxTailTokens: Math.floor(threshold / 2),
    });
    await emit({
      type: "compacted",
      items: compacted.items,
      summary: compacted.summary,
      tokensBefore: compacted.tokensBefore,
      tokensAfter: compacted.tokensAfter,
    });
    return compacted.items;
  } catch (error) {
    if (options.signal?.aborted || isAbortError(error)) {
      throw error;
    }
    await emit({ type: "compaction_failed", error });
    return items;
  }
}

async function handleToolCall(
  call: AgentToolCall,
  options: AgentLoopOptions,
  emit: (event: AgentEvent) => Promise<void>,
): Promise<FinishedToolCall> {
  const signal = options.signal;
  await emit({ type: "tool_call_started", call });

  const deny = async (reason: string): Promise<FinishedToolCall> => {
    const finished: FinishedToolCall = {
      call,
      result: createDeniedToolResult(call.name, call.summary, reason),
      denied: true,
      denialReason: reason,
    };
    await emit({ type: "tool_call_finished", ...finished });
    return finished;
  };

  const tool = call.tool;
  if (!tool) {
    return deny(`Tool ${call.name} is not available in this context.`);
  }

  const hookDenial = await options.beforeToolCall?.(call, signal);
  if (hookDenial) {
    return deny(hookDenial);
  }

  const decision: ApprovalDecision = needsApproval(tool, call.input, options.approval);
  const request: ToolApprovalRequest = {
    call,
    reason: decision.reason,
    modelReason: getOptionalString(call.input, "reason"),
  };
  if (decision.action === "deny") {
    return deny(decision.reason);
  }
  if (decision.action === "review") {
    await emit({ type: "safety_review_started", call });
    const review = options.reviewToolCall
      ? await options.reviewToolCall(request)
      : { safe: false, reason: "No safety reviewer is configured." };
    await emit({ type: "safety_review_finished", call, review });
    if (signal?.aborted) {
      throw createAbortError();
    }
    if (!review.safe) {
      return deny(`AI safety check: ${review.reason}`);
    }
  }
  if (decision.action === "ask") {
    await emit({ type: "approval_requested", request });
    const approved = options.requestApproval ? await options.requestApproval(request) : false;
    if (signal?.aborted) {
      throw createAbortError();
    }
    if (!approved) {
      return deny("User rejected action");
    }
  }

  await emit({ type: "tool_execution_started", call });
  const context: ToolContext = {
    ...options.toolContext,
    host: options.host,
    signal,
    onOutput: (output) => void emit({ type: "tool_output", call, output }),
  };
  const result = await runTool(tool, call.input, context, call.summary);
  const finished: FinishedToolCall = { call, result, denied: false };
  await emit({ type: "tool_call_finished", ...finished });
  return finished;
}

function cancelledOutputs(calls: readonly AgentToolCall[]): ResponseItem[] {
  return calls.map((call) => ({
    type: "function_call_output",
    call_id: call.callId,
    output: JSON.stringify({ ok: false, tool: call.name, error: "Cancelled by the user." }),
  }));
}

/** Text to show when the model ended a turn without a final message (ported from the CLI). */
export function buildFallbackText(results: readonly FinishedToolCall[]): string {
  const last = results[results.length - 1];
  if (!last) {
    return "";
  }
  let payload: Record<string, unknown> | null = null;
  try {
    const parsed = JSON.parse(last.result.output) as unknown;
    payload = isRecord(parsed) ? parsed : null;
  } catch {
    payload = null;
  }
  if (!payload) {
    return last.result.summary;
  }

  if (last.call.name === "Bash") {
    const command = getOptionalString(payload, "command");
    const stderr = getOptionalString(payload, "stderr")?.trim();
    const exitCode = typeof payload["exit_code"] === "number" ? payload["exit_code"] : null;
    if (payload["timed_out"] === true) {
      return command ? `Command timed out: ${command}` : "Command timed out.";
    }
    if (exitCode !== null && exitCode !== 0) {
      if (command && stderr) {
        return `Command failed: ${command}\n${shorten(stderr, 240)}`;
      }
      if (command) {
        return `Command failed: ${command} (exit code ${exitCode})`;
      }
    }
  }

  const error = getOptionalString(payload, "error")?.trim();
  if (error) {
    return `${last.call.name} failed: ${error}`;
  }
  return last.result.summary;
}

export type { ToolHost };
