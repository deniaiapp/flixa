import type { AgentTool, ToolContext, ToolResult } from "../types";
import { errorMessage, isAbortError, toJson } from "../util";
import { bashTool } from "./bash";
import { deleteTool, editTool, lsTool, readTool, writeTool } from "./files";
import { globTool, grepTool } from "./search";

export { bashTool, DEFAULT_BASH_TIMEOUT_MS, formatInlineCommand } from "./bash";
export { deleteTool, editTool, lsTool, readTool, writeTool } from "./files";
export { globTool, grepTool } from "./search";

/** Every tool implemented in core, in the order they are offered to the model. */
export const CORE_TOOLS: readonly AgentTool[] = [
  bashTool,
  readTool,
  writeTool,
  editTool,
  grepTool,
  globTool,
  lsTool,
  deleteTool,
];

export type CoreToolName = "Bash" | "Read" | "Write" | "Edit" | "Grep" | "Glob" | "LS" | "Delete";

export function getCoreTool(name: string): AgentTool | undefined {
  return CORE_TOOLS.find((tool) => tool.name === name);
}

/** Pick core tools by name, keeping the requested order. Unknown names are ignored. */
export function selectCoreTools(names: readonly CoreToolName[]): AgentTool[] {
  return names.flatMap((name) => {
    const tool = getCoreTool(name);
    return tool ? [tool] : [];
  });
}

/** A tool result for a call that was not executed (unknown tool, denied, rejected). */
export function createDeniedToolResult(
  toolName: string,
  summary: string,
  reason: string,
): ToolResult {
  return {
    ok: false,
    output: toJson({ ok: false, tool: toolName, denied: true, reason }),
    summary: `Denied ${toolName} ${summary}`.trim(),
  };
}

export function createFailedToolResult(
  toolName: string,
  summary: string,
  error: unknown,
): ToolResult {
  const message = errorMessage(error);
  const target = summary && summary !== toolName ? ` ${summary}` : "";
  return {
    ok: false,
    output: toJson({ ok: false, tool: toolName, error: message }),
    summary: `${toolName}${target} failed: ${message}`,
  };
}

/**
 * Execute a tool and turn thrown errors into a failed result. Aborts are rethrown so the
 * caller can stop the turn.
 */
export async function runTool(
  tool: AgentTool,
  input: Record<string, unknown>,
  context: ToolContext,
  summary: string,
): Promise<ToolResult> {
  try {
    return await tool.execute(input, context);
  } catch (error) {
    if (context.signal?.aborted || isAbortError(error)) {
      throw error;
    }
    return createFailedToolResult(tool.name, summary, error);
  }
}
