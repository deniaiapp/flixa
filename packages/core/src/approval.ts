import { assessCommandSafety } from "./safety";
import type { ToolCategory } from "./types";

/**
 * User-facing approval modes (the VS Code extension's contract, shared with Zed):
 * - ALL_APPROVE: run everything without confirmation.
 * - AUTO_APPROVE: an AI safety review gates shell commands; everything else runs.
 * - SAFE_APPROVE: shell commands need user confirmation; everything else runs.
 * - MANUAL_APPROVE: every action needs user confirmation.
 * Commands the shell-safety heuristics block never run in any mode.
 */
export type ApprovalMode = "ALL_APPROVE" | "AUTO_APPROVE" | "SAFE_APPROVE" | "MANUAL_APPROVE";

export const APPROVAL_MODES: readonly ApprovalMode[] = [
  "ALL_APPROVE",
  "AUTO_APPROVE",
  "SAFE_APPROVE",
  "MANUAL_APPROVE",
];

/** `allow`: run; `ask`: ask the user; `review`: ask an AI safety reviewer. */
export type ApprovalAction = "allow" | "ask" | "review";

/** What to do for each tool category. Clients with their own modes (the CLI) define more. */
export type ApprovalPolicy = Readonly<Record<ToolCategory, ApprovalAction>>;

function policy(
  base: ApprovalAction,
  overrides: Partial<Record<ToolCategory, ApprovalAction>> = {},
): ApprovalPolicy {
  return {
    read: base,
    search: base,
    edit: base,
    delete: base,
    execute: base,
    network: base,
    other: base,
    ...overrides,
  };
}

export const APPROVAL_MODE_POLICIES: Readonly<Record<ApprovalMode, ApprovalPolicy>> = {
  ALL_APPROVE: policy("allow"),
  AUTO_APPROVE: policy("allow", { execute: "review", network: "review" }),
  SAFE_APPROVE: policy("allow", { execute: "ask", network: "ask" }),
  MANUAL_APPROVE: policy("ask"),
};

export type ApprovalDecision =
  | { action: "allow"; reason: string }
  | { action: "ask"; reason: string }
  | { action: "review"; reason: string }
  | { action: "deny"; reason: string };

export interface ApprovalSubject {
  name: string;
  category: ToolCategory;
}

export function isApprovalMode(value: unknown): value is ApprovalMode {
  return typeof value === "string" && (APPROVAL_MODES as readonly string[]).includes(value);
}

export function resolveApprovalPolicy(mode: ApprovalMode | ApprovalPolicy): ApprovalPolicy {
  return typeof mode === "string" ? APPROVAL_MODE_POLICIES[mode] : mode;
}

/** Decide whether a tool call may run, needs the user, needs an AI review, or is denied. */
export function needsApproval(
  tool: ApprovalSubject,
  input: Record<string, unknown>,
  mode: ApprovalMode | ApprovalPolicy,
): ApprovalDecision {
  const action = resolveApprovalPolicy(mode)[tool.category];

  if (tool.category === "execute" && typeof input["command"] === "string") {
    const safety = assessCommandSafety(input["command"]);
    if (safety.level === "blocked") {
      return { action: "deny", reason: `Command blocked: ${safety.reason}.` };
    }
    if (safety.level === "risky") {
      if (action === "review") {
        return {
          action: "deny",
          reason: `Command rejected by the Flixa safety check: ${safety.reason}.`,
        };
      }
      return { action, reason: `Risky command: ${safety.reason}.` };
    }
  }

  switch (action) {
    case "allow":
      return { action, reason: "Allowed by the approval mode." };
    case "ask":
      return { action, reason: `${tool.name} needs your approval in this mode.` };
    case "review":
      return { action, reason: `${tool.name} needs an AI safety review in this mode.` };
  }
}

/** Parse `auto`, `safe`, `manual`, `all` (and the full names) as typed in slash commands. */
export function parseApprovalMode(value: string | undefined): ApprovalMode | null {
  switch (value?.trim().toLowerCase()) {
    case "auto":
    case "auto_approve":
    case "auto-approve":
      return "AUTO_APPROVE";
    case "safe":
    case "safe_approve":
    case "safe-approve":
      return "SAFE_APPROVE";
    case "manual":
    case "manual_approve":
    case "manual-approve":
      return "MANUAL_APPROVE";
    case "all":
    case "all_approve":
    case "all-approve":
    case "yolo":
      return "ALL_APPROVE";
    default:
      return null;
  }
}

/** The short form used in slash commands (`auto`, `safe`, `manual`, `all`). */
export function formatApprovalMode(mode: ApprovalMode): "all" | "auto" | "safe" | "manual" {
  switch (mode) {
    case "ALL_APPROVE":
      return "all";
    case "AUTO_APPROVE":
      return "auto";
    case "SAFE_APPROVE":
      return "safe";
    case "MANUAL_APPROVE":
      return "manual";
  }
}
