import { cwd } from "node:process";
import { hasHooks, loadHooks, runHooks, type HookRegistry } from "../hooks/hooks.ts";
import { expandFileMentions } from "../mentions/files.ts";
import {
  evaluatePermission,
  loadPermissionRules,
  type PermissionDecision,
  type PermissionRules,
} from "../permissions/rules.ts";

/** Permission rules and lifecycle hooks, loaded once per agent turn and shared with sub-agents. */
export interface ToolGuards {
  rules: PermissionRules;
  hooks: HookRegistry;
  sessionId?: string;
}

const MAX_HOOK_FEEDBACK_CHARS = 4_000;

export function loadToolGuards(workspaceRoot: string = cwd(), sessionId?: string): ToolGuards {
  return {
    rules: loadPermissionRules(workspaceRoot),
    hooks: loadHooks(workspaceRoot),
    sessionId,
  };
}

export function evaluateToolPermission(
  guards: ToolGuards | undefined,
  toolName: string,
  argumentsText: string,
): { decision: PermissionDecision; rule?: string } {
  if (!guards) {
    return { decision: "none" };
  }

  return evaluatePermission(guards.rules, toolName, parseToolArguments(argumentsText), cwd());
}

/** Returns a denial reason when a deny rule matches, otherwise null. Deny wins in every mode. */
export function getPermissionDenial(
  guards: ToolGuards | undefined,
  toolName: string,
  argumentsText: string,
): string | null {
  const result = evaluateToolPermission(guards, toolName, argumentsText);
  return result.decision === "deny"
    ? `Denied by permission rule ${result.rule ?? ""}`.trim()
    : null;
}

/** Runs PreToolUse hooks. Returns the block reason when a hook vetoed the call, otherwise null. */
export async function runPreToolUseHooks(
  guards: ToolGuards | undefined,
  toolName: string,
  argumentsText: string,
  signal?: AbortSignal,
): Promise<string | null> {
  if (!guards || !hasHooks(guards.hooks, "PreToolUse")) {
    return null;
  }

  const outcome = await runHooks(
    guards.hooks,
    {
      event: "PreToolUse",
      cwd: cwd(),
      sessionId: guards.sessionId,
      toolName,
      toolInput: parseToolArguments(argumentsText),
    },
    { signal },
  );

  return outcome.blocked
    ? `Blocked by PreToolUse hook: ${outcome.reason ?? "no reason given"}`
    : null;
}

/** Runs PostToolUse hooks and returns feedback text to append to the tool output (possibly empty). */
export async function runPostToolUseHooks(
  guards: ToolGuards | undefined,
  toolName: string,
  argumentsText: string,
  output: string,
  signal?: AbortSignal,
): Promise<string> {
  if (!guards || !hasHooks(guards.hooks, "PostToolUse")) {
    return "";
  }

  const outcome = await runHooks(
    guards.hooks,
    {
      event: "PostToolUse",
      cwd: cwd(),
      sessionId: guards.sessionId,
      toolName,
      toolInput: parseToolArguments(argumentsText),
      toolOutput: output,
    },
    { signal },
  );

  const lines = [...outcome.messages];
  if (outcome.blocked) {
    lines.push(`PostToolUse hook reported a problem: ${outcome.reason ?? "no reason given"}`);
  }

  return lines.length > 0
    ? `\n\n[PostToolUse hook feedback]\n${lines.join("\n").slice(0, MAX_HOOK_FEEDBACK_CHARS)}`
    : "";
}

export interface PreparedPrompt {
  /** Prompt to send to the model: mentions expanded and hook context appended. */
  prompt: string;
  /** Short informational lines for the user (attached files, warnings). */
  notices: string[];
  /** Set when a UserPromptSubmit hook refused the prompt. */
  blockedReason?: string;
}

/** Expands `@file` mentions and runs UserPromptSubmit hooks for a user prompt. */
export async function prepareUserPrompt(
  prompt: string,
  guards: ToolGuards | undefined,
  signal?: AbortSignal,
): Promise<PreparedPrompt> {
  const workspaceRoot = cwd();
  const notices: string[] = [];

  const mentions = expandFileMentions(prompt, workspaceRoot);
  if (mentions.attached.length > 0) {
    notices.push(
      `Attached ${mentions.attached
        .map((file) => (file.truncated ? `${file.path} (truncated)` : file.path))
        .join(", ")}`,
    );
  }
  notices.push(...mentions.warnings);

  let finalPrompt = mentions.prompt;
  if (guards && hasHooks(guards.hooks, "UserPromptSubmit")) {
    const outcome = await runHooks(
      guards.hooks,
      { event: "UserPromptSubmit", cwd: workspaceRoot, sessionId: guards.sessionId, prompt },
      { signal },
    );

    if (outcome.blocked) {
      return {
        prompt: finalPrompt,
        notices,
        blockedReason: `Prompt blocked by hook: ${outcome.reason ?? "no reason given"}`,
      };
    }

    if (outcome.messages.length > 0) {
      finalPrompt = `${finalPrompt}\n\n[UserPromptSubmit hook context]\n${outcome.messages
        .join("\n")
        .slice(0, MAX_HOOK_FEEDBACK_CHARS)}`;
    }
  }

  return { prompt: finalPrompt, notices };
}

/** Runs Stop hooks after a finished turn; failures only surface as notices. */
export async function runStopHooks(
  guards: ToolGuards | undefined,
  signal?: AbortSignal,
): Promise<string[]> {
  if (!guards || !hasHooks(guards.hooks, "Stop")) {
    return [];
  }

  const outcome = await runHooks(
    guards.hooks,
    { event: "Stop", cwd: cwd(), sessionId: guards.sessionId },
    { signal },
  );

  return outcome.blocked
    ? [...outcome.messages, `Stop hook: ${outcome.reason ?? "no reason given"}`]
    : outcome.messages;
}

function parseToolArguments(argumentsText: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(argumentsText) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}
