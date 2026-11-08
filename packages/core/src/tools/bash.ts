import { assessCommandSafety } from "../safety";
import type { AgentTool, CommandResult } from "../types";
import { getOptionalInteger, getRequiredString, shorten, toJson, truncate } from "../util";

export const DEFAULT_BASH_TIMEOUT_MS = 30_000;
export const MAX_BASH_TIMEOUT_MS = 300_000;

export const bashTool: AgentTool = {
  name: "Bash",
  description:
    "Run a shell command in the workspace. Uses PowerShell on Windows and bash on Unix-like systems.",
  parameters: {
    type: "object",
    properties: {
      command: {
        type: "string",
        description: "Shell command to execute.",
      },
      timeout_ms: {
        type: "integer",
        description: "Optional timeout in milliseconds. Defaults to 30000.",
      },
      run_in_background: {
        type: "boolean",
        description:
          "Start the command in the background (dev servers, watchers) and return an id. Read its output with BashOutput and stop it with KillShell when those tools are available.",
      },
      reason: {
        type: "string",
        description: "Why this command is needed and why it is safe to run.",
      },
    },
    required: ["command", "reason"],
    additionalProperties: false,
  },
  category: "execute",
  title: (input) =>
    `Run ${typeof input["command"] === "string" ? shorten(input["command"], 80) : "command"}`,
  async execute(input, context) {
    if (context.allowShell === false) {
      throw new Error("Bash is disabled until auto mode is enabled.");
    }

    const command = getRequiredString(input, "command");
    const safety = assessCommandSafety(command);
    if (!safety.allowed) {
      throw new Error(`Command blocked: ${safety.reason}.`);
    }

    if (input["run_in_background"] === true) {
      if (!context.host.startBackgroundCommand) {
        throw new Error("Background commands are not supported in this client.");
      }
      const started = await context.host.startBackgroundCommand(command);
      return {
        ok: true,
        output: toJson({
          ok: true,
          bash_id: started.id,
          pid: started.pid ?? null,
          command,
          note: "Running in the background. Use BashOutput to read output and KillShell to stop it.",
        }),
        summary: `Bash ${formatInlineCommand(command)} started in background as ${started.id}`,
      };
    }

    const timeoutMs = Math.min(
      MAX_BASH_TIMEOUT_MS,
      Math.max(1_000, getOptionalInteger(input, "timeout_ms") ?? DEFAULT_BASH_TIMEOUT_MS),
    );

    let streamed = "";
    const result = await context.host.runCommand({
      command,
      timeoutMs,
      signal: context.signal,
      onOutput: context.onOutput
        ? (chunk) => {
            streamed += chunk;
            context.onOutput?.(streamed);
          }
        : undefined,
    });
    const ok = result.exitCode === 0 && !result.timedOut;

    return {
      ok,
      output: truncate(toJson({ ok, command, ...toCliShape(result) })),
      summary: formatShellResultSummary(command, result.exitCode, result.timedOut, timeoutMs),
      displayOutput: [result.stdout, result.stderr].filter((part) => part.trim()).join("\n"),
    };
  },
};

function toCliShape(result: CommandResult): Record<string, unknown> {
  return {
    stdout: truncate(result.stdout),
    stderr: truncate(result.stderr),
    exit_code: result.exitCode,
    timed_out: result.timedOut,
  };
}

export function formatInlineCommand(command: string, maxLength = 100): string {
  const singleLine = command.replace(/\s+/g, " ").trim();
  return JSON.stringify(shorten(singleLine, maxLength) || command);
}

function formatShellResultSummary(
  command: string,
  exitCode: number | null,
  timedOut: boolean,
  timeoutMs: number,
): string {
  const formattedCommand = formatInlineCommand(command);
  if (timedOut) {
    return `Bash ${formattedCommand} timed out after ${timeoutMs}ms`;
  }
  if (exitCode === 0) {
    return `Bash ${formattedCommand} finished with exit code 0`;
  }
  return `Bash ${formattedCommand} failed with exit code ${exitCode}`;
}
