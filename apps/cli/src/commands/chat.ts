import chalk from "chalk";
import { select } from "@inquirer/prompts";
import { cwd } from "node:process";
import type { Command } from "commander";
import {
  DEFAULT_FLIXA_MODEL,
  createResponse,
  extractOutputText,
  type FlixaResponse,
} from "../flixa/api.ts";
import {
  resolveProviderContext,
  generateProviderText,
  runSharedAgentTurn,
} from "../providers/runtime.ts";
import {
  runAgentTurn,
  type ToolApprovalRequest,
  type ToolSafetyReviewResult,
} from "../agent-tools/runner.ts";
import { buildInstructionSystemPrompt } from "../instructions/files.ts";
import { runInteractiveChatApp } from "../ui/chat-app.tsx";
import { resolveCustomCommandPrompt } from "../slash/custom-commands.ts";
import { loadToolGuards, prepareUserPrompt } from "../agent-tools/guards.ts";
import {
  compactHistory,
  createSummaryGenerator,
  formatCompactResult,
  shouldAutoCompact,
} from "../compact/compact.ts";
import { getPersistedModeDefaults, getPersistedModel, setPersistedModel } from "../config/store.ts";
import {
  createSession,
  formatRecentSessionLabel,
  listRecentSessions,
  loadLatestSessionForCwd,
  loadSessionById,
  saveSession,
  type StoredChatSession,
} from "../sessions/store.ts";

type RawChatOptions = {
  provider?: string;
  model?: string;
  system?: string;
  stream?: boolean;
  json?: boolean;
  baseUrl?: string;
  maxOutputTokens?: string;
  continue?: boolean;
  resume?: string | boolean;
  auto?: boolean;
  yoloMode?: boolean;
  plan?: boolean;
  acceptEdits?: boolean;
  yolo?: boolean;
  print?: boolean;
};

type ChatOptions = {
  provider?: string;
  model: string;
  system?: string;
  rawSystem?: string;
  stream: boolean;
  json: boolean;
  baseUrl?: string;
  maxOutputTokens?: number;
  continue: boolean;
  resume?: string | boolean;
  autoMode: boolean;
  yoloMode: boolean;
  planMode: boolean;
  acceptEdits: boolean;
  modeOverride: FooterModeOverride;
  yolo: boolean;
  print: boolean;
};

type FooterModeOverride = "default" | "accept-edits" | "plan" | "auto" | "yolo" | null;

export function registerChatCommand(program: Command): void {
  applyChatOptions(program);
  program
    .argument("[prompt...]", "Prompt to send to Flixa")
    .action(async (promptParts: string[], options: RawChatOptions, command: Command) => {
      await runChatCommandWithExit(promptParts, mergeInheritedChatOptions(options, command));
    });

  const chatCommand = program.command("chat").description("Chat with Flixa from the terminal");

  applyChatOptions(chatCommand);
  chatCommand
    .argument("[prompt...]", "Prompt to send to Flixa")
    .action(async (promptParts: string[], options: RawChatOptions, command: Command) => {
      await runChatCommandWithExit(promptParts, mergeInheritedChatOptions(options, command));
    });

  const resumeCommand = program.command("resume").description("Resume a saved Flixa conversation");

  applyChatOptions(resumeCommand);
  resumeCommand
    .argument("[sessionId]", "Session id to resume")
    .argument("[prompt...]", "Optional prompt to send after resuming")
    .action(
      async (
        sessionId: string | undefined,
        promptParts: string[],
        options: RawChatOptions,
        command: Command,
      ) => {
        await runChatCommandWithExit(promptParts, {
          ...mergeInheritedChatOptions(options, command),
          resume: sessionId || true,
        });
      },
    );
}

function applyChatOptions(command: Command): void {
  command
    .option("-p, --provider <provider>", "Provider to use (defaults to configured provider)")
    .option("-m, --model <model>", "Model to use (defaults to configured provider's model)")
    .option("-s, --system <prompt>", "System prompt")
    .option("--base-url <url>", "Override the API base URL for providers that support it")
    .option("--json", "Print the raw JSON response")
    .option("--no-stream", "Disable streaming output (responses are currently shown once complete)")
    .option("--max-output-tokens <tokens>", "Limit response tokens")
    .option("-c, --continue", "Continue the latest conversation in this directory")
    .option("-r, --resume [sessionId]", "Resume a conversation by session id or pick from recent")
    .option("--auto", "Start in auto mode")
    .option("--yolo-mode", "Start in yolo mode")
    .option("--plan", "Start in plan mode")
    .option("--accept-edits", "Start in accept edits mode")
    .option("--yolo", "Always allow approvals for one-shot runs")
    .option(
      "--print",
      "Non-interactive: print only the final answer to stdout (progress goes to stderr)",
    );
}

async function runChatCommand(promptParts: string[], rawOptions: RawChatOptions): Promise<void> {
  const options = normalizeOptions(rawOptions);
  const providerContext = resolveProviderContext({
    provider: options.provider,
    model: options.model,
    baseUrl: options.baseUrl,
  });
  if (!providerContext.apiKey) {
    console.error(
      chalk.red("✗ Not logged in.") +
        ` Run \`flixa login --provider ${providerContext.provider}\` first.`,
    );
    process.exit(1);
  }

  const apiKey = providerContext.apiKey;
  options.provider = providerContext.provider;
  options.model = providerContext.model;
  options.baseUrl = providerContext.baseUrl || options.baseUrl;
  const session = await resolveSession(options);
  const promptFromArgs = promptParts.join(" ").trim();
  const promptFromStdin = promptFromArgs ? null : await readPromptFromStdin();

  if (options.print && !promptFromArgs && !promptFromStdin) {
    throw new Error("--print requires a prompt: pass it as an argument or pipe it on stdin.");
  }

  if (promptFromArgs || promptFromStdin) {
    const rawPrompt = promptFromArgs || promptFromStdin || "";
    const prompt = resolveCustomCommandPrompt(rawPrompt, session.cwd || cwd()) ?? rawPrompt;
    options.system = buildInstructionSystemPrompt(session.cwd || cwd(), options.rawSystem, prompt);
    await runSingleTurn(apiKey, options, session, prompt);
    return;
  }

  options.system = buildInstructionSystemPrompt(session.cwd || cwd(), options.rawSystem);
  restoreInteractiveStdin();
  await runInteractiveChat(apiKey, options, session);
}

async function runChatCommandWithExit(
  promptParts: string[],
  rawOptions: RawChatOptions,
): Promise<void> {
  try {
    await runChatCommand(promptParts, rawOptions);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(chalk.red("✗ Command failed:") + ` ${message}`);
    process.exit(1);
  }
}

function mergeInheritedChatOptions(options: RawChatOptions, command: Command): RawChatOptions {
  return {
    ...(command.parent?.opts?.() as Partial<RawChatOptions> | undefined),
    ...options,
  };
}

function normalizeOptions(rawOptions: RawChatOptions): ChatOptions {
  const defaults = getPersistedModeDefaults();
  const maxOutputTokens = parseIntegerOption(rawOptions.maxOutputTokens, "--max-output-tokens");
  const modeFlags = resolveModeFlags(rawOptions, defaults);

  const providerContext = resolveProviderContext({
    provider: rawOptions.provider,
    model: rawOptions.model,
    baseUrl: rawOptions.baseUrl,
  });

  return {
    provider: providerContext.provider,
    model: providerContext.model || getPersistedModel() || DEFAULT_FLIXA_MODEL,
    system: undefined,
    rawSystem: rawOptions.system?.trim() || undefined,
    stream: rawOptions.stream ?? true,
    json: rawOptions.json ?? false,
    baseUrl: providerContext.baseUrl,
    maxOutputTokens,
    continue: rawOptions.continue ?? false,
    resume: rawOptions.resume,
    autoMode: modeFlags.autoMode,
    yoloMode: modeFlags.yoloMode,
    planMode: modeFlags.planMode,
    acceptEdits: modeFlags.acceptEdits,
    modeOverride: modeFlags.modeOverride,
    yolo: rawOptions.yolo ?? false,
    print: rawOptions.print ?? false,
  };
}

async function readPromptFromStdin(): Promise<string | null> {
  if (process.stdin.isTTY) {
    return null;
  }

  const chunks: Uint8Array[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }

  const prompt = Buffer.concat(chunks).toString("utf-8").trim();
  return prompt || null;
}

async function runInteractiveChat(
  apiKey: string,
  options: ChatOptions,
  session: StoredChatSession,
): Promise<void> {
  await runInteractiveChatApp(apiKey, options, session);
}

async function runSingleTurn(
  apiKey: string,
  options: ChatOptions,
  session: StoredChatSession,
  prompt: string,
): Promise<void> {
  let assistantText = "";
  let rawResponse: FlixaResponse | undefined;
  const turnSystemPrompt = buildInstructionSystemPrompt(
    session.cwd || cwd(),
    options.rawSystem,
    prompt,
  );

  // In --print mode stdout carries only the answer, so progress goes to stderr.
  const progress = options.print ? process.stderr : process.stdout;

  if (!options.json && !options.print) {
    process.stdout.write(chalk.green("flixa: "));
  }

  try {
    const guards = loadToolGuards(cwd(), session.id);
    const prepared = await prepareUserPrompt(prompt, guards);
    if (prepared.blockedReason) {
      throw new Error(prepared.blockedReason);
    }
    if (!options.json) {
      for (const notice of prepared.notices) {
        progress.write(`\n${chalk.dim(`· ${notice}`)}\n`);
      }
    }
    const modelPrompt = prepared.prompt;

    let historyForTurn = session.history;
    if (shouldAutoCompact(session.history)) {
      try {
        const compacted = await compactHistory({
          history: session.history,
          generate: createSummaryGenerator({
            context: resolveProviderContext({
              provider: options.provider,
              model: options.model,
              baseUrl: options.baseUrl,
            }),
            apiKey,
            model: options.model,
            baseUrl: options.baseUrl,
          }),
        });
        historyForTurn = compacted.history;
        if (!options.json) {
          progress.write(`\n${chalk.dim(`· Auto-compact: ${formatCompactResult(compacted)}`)}\n`);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!options.json) {
          progress.write(`\n${chalk.yellow(`· Auto-compact skipped: ${message}`)}\n`);
        }
      }
    }

    if (options.provider && options.provider !== "flixa") {
      const result = await runSharedAgentTurn({
        provider: options.provider,
        model: options.model,
        baseUrl: options.baseUrl,
        prompt: modelPrompt,
        guards,
        history: historyForTurn,
        sessionId: session.id,
        system: turnSystemPrompt,
        maxOutputTokens: options.maxOutputTokens,
        planMode: options.planMode,
        autoMode: options.autoMode,
        yoloMode: false,
        acceptEdits: options.acceptEdits,
        reviewToolSafety: options.autoMode
          ? createProviderToolSafetyReviewer(options.provider, options.model, options.baseUrl)
          : undefined,
        requestToolApproval:
          options.yolo || (!options.print && process.stdin.isTTY && process.stdout.isTTY)
            ? options.yolo
              ? allowAllToolApprovals
              : promptForToolApproval
            : undefined,
        onEvent: options.json
          ? undefined
          : (event) => {
              if (event.type === "tool_start") {
                progress.write(`\n${chalk.dim(`· ${event.summary}`)}\n`);
              } else if (event.type === "tool_result" && event.summary.startsWith("Denied ")) {
                progress.write(`\n${chalk.yellow(`· ${event.summary}`)}\n`);
              }
            },
      });
      assistantText = result.text.trim();
      if (options.json) {
        console.log(
          JSON.stringify(
            {
              provider: result.context.provider,
              model: result.context.model,
              output_text: assistantText,
            },
            null,
            2,
          ),
        );
      } else {
        process.stdout.write(assistantText);
        process.stdout.write("\n");
      }
      saveSession({
        ...session,
        provider: result.context.provider,
        model: result.context.model,
        history: result.history,
        updatedAt: new Date().toISOString(),
      });
      return;
    }

    const reviewToolSafety = createToolSafetyReviewer(apiKey, options.model, options.baseUrl);
    const resolvedModes = getEffectiveModes(options, session);
    const result = await runAgentTurn({
      apiKey,
      model: options.model,
      history: historyForTurn,
      prompt: modelPrompt,
      guards,
      system: turnSystemPrompt,
      baseUrl: options.baseUrl,
      maxOutputTokens: options.maxOutputTokens,
      autoMode: resolvedModes.autoMode,
      yoloMode: resolvedModes.yoloMode,
      planMode: resolvedModes.planMode,
      acceptEdits: resolvedModes.acceptEdits,
      reviewToolSafety: resolvedModes.yoloMode ? undefined : reviewToolSafety,
      requestToolApproval: options.yolo
        ? allowAllToolApprovals
        : options.json || options.print || !process.stdin.isTTY || !process.stdout.isTTY
          ? undefined
          : promptForToolApproval,
      onEvent: options.json
        ? undefined
        : (event) => {
            if (event.type === "tool_start") {
              progress.write(`\n${chalk.dim(`· ${event.summary}`)}\n`);
              return;
            }

            if (event.type === "tool_result" && event.summary.startsWith("Denied ")) {
              progress.write(`\n${chalk.yellow(`· ${event.summary}`)}\n`);
            }
          },
    });

    assistantText = result.finalText.trim();
    rawResponse = result.finalResponse;
    session.history = result.history;
    session.provider = options.provider;
    session.model = options.model;
    session.system = turnSystemPrompt;
    session.autoMode = resolvedModes.autoMode;
    session.yoloMode = resolvedModes.yoloMode;
    session.planMode = resolvedModes.planMode;
    session.acceptEdits = resolvedModes.acceptEdits;
    setPersistedModel(options.model);
    saveSession(session);

    if (options.json) {
      console.log(JSON.stringify(rawResponse, null, 2));
      console.log();
    } else if (options.print) {
      if (assistantText) {
        process.stdout.write(`${assistantText}\n`);
      }
    } else {
      if (result.thinkingText?.trim()) {
        console.log(`\n${chalk.dim("thinking")}`);
        console.log(chalk.dim(result.thinkingText.trim()));
      }
      if (assistantText) {
        console.log(`\n${assistantText}\n`);
      } else {
        console.log(`\n${chalk.dim("No assistant text returned.")}\n`);
      }
    }
  } catch (error) {
    if (!options.json && !options.print) {
      process.stdout.write("\n");
    }
    const message = error instanceof Error ? error.message : String(error);
    console.error(chalk.red("✗ Request failed:") + ` ${message}`);
    process.exitCode = 1;
    return;
  }
}

async function resolveSession(options: ChatOptions): Promise<StoredChatSession> {
  const currentCwd = cwd();

  if (options.resume) {
    if (typeof options.resume === "string") {
      const session = loadSessionById(options.resume);
      if (!session) {
        throw new Error(`Session not found: ${options.resume}`);
      }
      return session;
    }

    const recent = listRecentSessions(20);
    if (recent.length === 0) {
      throw new Error("No saved sessions found.");
    }

    const pickedId = await select({
      message: "Resume which conversation?",
      choices: recent.map((session) => ({
        name: formatRecentSessionLabel(session),
        value: session.id,
      })),
    });

    const picked = loadSessionById(pickedId);
    if (!picked) {
      throw new Error(`Session not found: ${pickedId}`);
    }
    return picked;
  }

  if (options.continue) {
    const session = loadLatestSessionForCwd(currentCwd);
    if (!session) {
      throw new Error("No conversation found to continue in this directory.");
    }
    return session;
  }

  const session = createSession(currentCwd, options.model, options.system, {
    provider: options.provider,
    autoMode: options.autoMode,
    planMode: options.planMode,
    acceptEdits: options.acceptEdits,
  });
  saveSession(session);
  return session;
}
function parseIntegerOption(value: string | undefined, optionName: string): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${optionName} must be a positive integer.`);
  }

  return parsed;
}

function restoreInteractiveStdin(): void {
  if (!process.stdin.isTTY) {
    return;
  }

  process.stdin.resume();
}

function resolveModeFlags(
  rawOptions: RawChatOptions,
  defaults: ReturnType<typeof getPersistedModeDefaults>,
): {
  autoMode: boolean;
  yoloMode: boolean;
  planMode: boolean;
  acceptEdits: boolean;
  modeOverride: FooterModeOverride;
} {
  if (rawOptions.plan) {
    return {
      autoMode: false,
      yoloMode: false,
      planMode: true,
      acceptEdits: false,
      modeOverride: "plan",
    };
  }

  if (rawOptions.yoloMode) {
    return {
      autoMode: false,
      yoloMode: true,
      planMode: false,
      acceptEdits: false,
      modeOverride: "yolo",
    };
  }

  if (rawOptions.auto) {
    return {
      autoMode: true,
      yoloMode: false,
      planMode: false,
      acceptEdits: false,
      modeOverride: "auto",
    };
  }

  if (rawOptions.acceptEdits) {
    return {
      autoMode: false,
      yoloMode: false,
      planMode: false,
      acceptEdits: true,
      modeOverride: "accept-edits",
    };
  }

  if (defaults.planMode) {
    return {
      autoMode: false,
      yoloMode: false,
      planMode: true,
      acceptEdits: false,
      modeOverride: null,
    };
  }

  if (defaults.yoloMode) {
    return {
      autoMode: false,
      yoloMode: true,
      planMode: false,
      acceptEdits: false,
      modeOverride: null,
    };
  }

  if (defaults.autoMode) {
    return {
      autoMode: true,
      yoloMode: false,
      planMode: false,
      acceptEdits: false,
      modeOverride: null,
    };
  }

  if (defaults.acceptEdits) {
    return {
      autoMode: false,
      yoloMode: false,
      planMode: false,
      acceptEdits: true,
      modeOverride: null,
    };
  }

  return {
    autoMode: false,
    yoloMode: false,
    planMode: false,
    acceptEdits: false,
    modeOverride: null,
  };
}

function getEffectiveModes(
  options: Pick<ChatOptions, "autoMode" | "yoloMode" | "planMode" | "acceptEdits" | "modeOverride">,
  session: Pick<StoredChatSession, "autoMode" | "yoloMode" | "planMode" | "acceptEdits">,
): {
  autoMode: boolean;
  yoloMode: boolean;
  planMode: boolean;
  acceptEdits: boolean;
} {
  if (options.modeOverride) {
    return {
      autoMode: options.autoMode,
      yoloMode: options.yoloMode,
      planMode: options.planMode,
      acceptEdits: options.acceptEdits,
    };
  }

  return {
    autoMode: session.autoMode ?? options.autoMode,
    yoloMode: session.yoloMode ?? options.yoloMode,
    planMode: session.planMode ?? options.planMode,
    acceptEdits: session.acceptEdits ?? options.acceptEdits,
  };
}

function createToolSafetyReviewer(
  apiKey: string,
  model: string,
  baseUrl?: string,
): (request: ToolApprovalRequest) => Promise<ToolSafetyReviewResult> {
  return async (request: ToolApprovalRequest): Promise<ToolSafetyReviewResult> => {
    try {
      const response = await createResponse({
        apiKey,
        model,
        system:
          "You are a safety reviewer for CLI tool calls. Respond with a short verdict only. Approve only if the request is narrowly scoped, justified by the provided reason, and appears safe for the local workspace. Reject if the reason is missing, vague, risky, destructive, or unrelated to the requested action. Format: SAFE: <brief reason> or UNSAFE: <brief reason>.",
        input: [
          {
            role: "user",
            content: [
              `Tool: ${request.toolName}`,
              `Title: ${request.title}`,
              `Reason: ${request.reason}`,
              `Summary: ${request.summary}`,
              `Details:\n${request.details.join("\n")}`,
            ].join("\n"),
          },
        ],
        baseUrl,
        maxOutputTokens: 120,
        toolChoice: "none",
      });
      const verdict = extractOutputText(response).trim() || "UNSAFE: Empty review response.";
      const normalizedVerdict = verdict.toUpperCase();
      return {
        safe: normalizedVerdict.startsWith("SAFE:"),
        verdict,
      };
    } catch (error) {
      return {
        safe: false,
        verdict:
          error instanceof Error
            ? `UNSAFE: Safety review failed: ${error.message}`
            : `UNSAFE: Safety review failed: ${String(error)}`,
      };
    }
  };
}

function createProviderToolSafetyReviewer(
  provider: string | undefined,
  model: string,
  baseUrl?: string,
): (request: ToolApprovalRequest) => Promise<ToolSafetyReviewResult> {
  return async (request: ToolApprovalRequest): Promise<ToolSafetyReviewResult> => {
    try {
      const result = await generateProviderText({
        provider,
        model,
        baseUrl,
        system:
          "You are a safety reviewer for CLI tool calls. Respond with a short verdict only. Approve only if the request is narrowly scoped, justified by the provided reason, and appears safe for the local workspace. Reject if the reason is missing, vague, risky, destructive, or unrelated to the requested action. Format: SAFE: <brief reason> or UNSAFE: <brief reason>.",
        prompt: [
          `Tool: ${request.toolName}`,
          `Title: ${request.title}`,
          `Reason: ${request.reason}`,
          `Summary: ${request.summary}`,
          `Details:\n${request.details.join("\n")}`,
        ].join("\n"),
        maxOutputTokens: 120,
      });
      const verdict = result.text.trim() || "UNSAFE: Empty review response.";
      return {
        safe: verdict.toUpperCase().startsWith("SAFE:"),
        verdict,
      };
    } catch (error) {
      return {
        safe: false,
        verdict:
          error instanceof Error
            ? `UNSAFE: Safety review failed: ${error.message}`
            : `UNSAFE: Safety review failed: ${String(error)}`,
      };
    }
  };
}

async function promptForToolApproval(request: ToolApprovalRequest): Promise<boolean> {
  const detailText = request.details.length > 0 ? `\n${request.details.join("\n")}` : "";
  return select<boolean>({
    message: `${request.title}\n${request.reason}\n${request.toolName}: ${request.summary}${detailText}`,
    choices: [
      {
        name: "Approve",
        value: true,
        description: "Run this tool call once",
      },
      {
        name: "Deny",
        value: false,
        description: "Block this tool call",
      },
    ],
  });
}

async function allowAllToolApprovals(_request: ToolApprovalRequest): Promise<boolean> {
  return true;
}
