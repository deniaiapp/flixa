import chalk from "chalk";
import { select } from "@inquirer/prompts";
import { cwd } from "node:process";
import type { Command } from "commander";
import { createResponse, extractOutputText, type ChatMessage } from "../flixa/api.ts";
import {
  generateProviderText,
  resolveProviderContext,
  runSharedAgentTurn,
  type SharedAgentRunEvent,
} from "../providers/runtime.ts";
import {
  runAgentTurn,
  type AgentRunEvent,
  type ToolApprovalRequest,
  type ToolSafetyReviewResult,
} from "../agent-tools/runner.ts";
import { executeToolCall, type ToolExecutionContext } from "../agent-tools/tools.ts";
import { buildInstructionSystemPrompt } from "../instructions/files.ts";
import { resolveGitHubIssuePrompt } from "../github/issues.ts";
import {
  createSession,
  loadLatestSessionForCwd,
  saveSession,
  type StoredChatSession,
} from "../sessions/store.ts";
import {
  buildShareCard,
  copyToClipboard,
  publishShareCard,
  writeShareCard,
  type VerificationEvidence,
} from "../runs/share-card.ts";
import { renderShareCard } from "../ui/share-card.ts";

type ShipOptions = {
  provider?: string;
  model?: string;
  baseUrl?: string;
  maxOutputTokens?: string;
  plan?: boolean;
  interactive?: boolean;
  yolo?: boolean;
  continue?: boolean;
  verify?: string;
  share?: string | boolean;
  shareUrl?: boolean;
  json?: boolean;
};

const SHIP_SYSTEM_PROMPT = [
  "You are Flixa Ship, a senior coding agent that owns the task from investigation to verification.",
  "Work in explicit phases: inspect the repository, form a focused plan, implement the smallest correct change, then verify it.",
  "Do not stop at advice when the user asked for an implementation. Keep unrelated working-tree changes intact.",
  "Use GitStatus and GitDiff near the end so the final report is grounded in the actual workspace.",
  "Before the final response, run the most relevant available verification command unless the task is purely explanatory.",
  "Your final response must contain exactly these sections: SHIPPED or NOT SHIPPED, Summary, Files changed, Verification, Follow-up.",
].join("\n");

export function registerShipCommand(program: Command): void {
  program
    .command("ship")
    .alias("run")
    .description("Build, verify, and summarize a coding task in one guarded run")
    .argument("[prompt...]", "Task to implement")
    .option("-p, --provider <provider>", "Provider to use")
    .option("-m, --model <model>", "Model to use")
    .option("--base-url <url>", "Override the provider API base URL")
    .option("--max-output-tokens <tokens>", "Limit response tokens")
    .option("--plan", "Inspect and propose a plan without editing")
    .option("--interactive", "Ask for approval before each shell command or file edit")
    .option("--yolo", "Skip approvals and safety review for this run")
    .option("-c, --continue", "Continue the latest session in this directory")
    .option("--verify <command>", "Run one explicit verification command afterward")
    .option("--share [path]", "Print a redacted share card, or write it to a Markdown path")
    .option("--share-url", "Publish the redacted card to Flixa Share")
    .option("--json", "Print machine-readable output")
    .action(async (promptParts: string[], options: ShipOptions, command: Command) => {
      await runShipCommand(promptParts, {
        ...(command.parent?.opts?.() as Partial<ShipOptions> | undefined),
        ...options,
      });
    });
}

async function runShipCommand(promptParts: string[], options: ShipOptions): Promise<void> {
  if (options.plan && options.yolo) {
    throw new Error("--plan and --yolo cannot be used together.");
  }

  const requestedPrompt = promptParts.join(" ").trim() || (await readPromptFromStdin());
  if (!requestedPrompt) {
    throw new Error('Usage: flixa ship "your coding task"');
  }
  const issuePrompt = resolveGitHubIssuePrompt(requestedPrompt);
  const prompt = issuePrompt?.prompt ?? requestedPrompt;
  const displayPrompt = issuePrompt?.displayPrompt ?? requestedPrompt;

  const providerContext = resolveProviderContext({
    provider: options.provider,
    model: options.model,
    baseUrl: options.baseUrl,
  });
  if (!providerContext.apiKey) {
    throw new Error(
      `Not logged in for ${providerContext.displayName}. Run \`flixa login --provider ${providerContext.provider}\` first.`,
    );
  }

  const maxOutputTokens = parseMaxOutputTokens(options.maxOutputTokens);
  const workspaceRoot = cwd();
  const session = options.continue ? loadLatestSessionForCwd(workspaceRoot) : null;
  const activeSession =
    session ||
    createSession(workspaceRoot, providerContext.model, undefined, {
      provider: providerContext.provider,
      planMode: options.plan,
    });
  const startedAt = new Date().toISOString();
  const system = [
    buildInstructionSystemPrompt(workspaceRoot, undefined, prompt),
    SHIP_SYSTEM_PROMPT,
    options.verify
      ? `After implementation, the user explicitly requested this verification command: ${options.verify}`
      : "If the project exposes a build, test, typecheck, or lint command, choose the most relevant one yourself.",
    options.plan
      ? "Plan mode is active: inspect freely but do not modify files. Explain the exact implementation plan and verification plan."
      : "Implementation mode is active: make the requested changes and verify them.",
  ].join("\n\n");

  if (!options.json) {
    console.log(chalk.yellow("\n⚡ FLIXA SHIP"));
    console.log(
      chalk.dim(
        `${options.plan ? "plan" : options.yolo ? "yolo" : options.interactive ? "interactive" : "guarded auto"} · ${providerContext.provider}/${providerContext.model}`,
      ),
    );
    console.log(chalk.cyan(`› ${displayPrompt}`));
    console.log();
  }

  const reviewToolSafety = createToolSafetyReviewer(providerContext);
  const requestToolApproval = options.interactive ? promptForToolApproval : undefined;
  const onEvent = options.json
    ? undefined
    : (event: AgentRunEvent | SharedAgentRunEvent): void => {
        if (event.type === "round_start") {
          console.log(chalk.dim(`  round ${event.round}`));
          return;
        }
        if (event.type === "tool_start") {
          console.log(chalk.dim(`  ◌ ${event.toolName} ${event.summary}`));
          return;
        }
        if (event.type === "tool_result") {
          const color = event.summary.startsWith("Denied ") ? chalk.yellow : chalk.dim;
          console.log(color(`  ${event.summary}`));
        }
      };

  let finalText: string;
  let history: ChatMessage[];
  let model = providerContext.model;
  let provider = providerContext.provider;

  if (providerContext.provider === "flixa") {
    const result = await runAgentTurn({
      apiKey: providerContext.apiKey,
      model: providerContext.model,
      history: activeSession.history,
      prompt,
      system,
      baseUrl: providerContext.baseUrl,
      maxOutputTokens,
      autoMode: !options.plan && !options.interactive && !options.yolo,
      yoloMode: Boolean(options.yolo),
      planMode: Boolean(options.plan),
      acceptEdits: false,
      reviewToolSafety:
        options.plan || options.interactive || options.yolo ? undefined : reviewToolSafety,
      requestToolApproval: options.yolo ? allowAllToolApprovals : requestToolApproval,
      onEvent,
    });
    finalText = result.finalText.trim();
    history = result.history;
  } else {
    const result = await runSharedAgentTurn({
      provider: providerContext.provider,
      model: providerContext.model,
      baseUrl: providerContext.baseUrl,
      history: activeSession.history,
      prompt,
      system,
      maxOutputTokens,
      autoMode: !options.plan && !options.interactive && !options.yolo,
      yoloMode: Boolean(options.yolo),
      planMode: Boolean(options.plan),
      acceptEdits: false,
      reviewToolSafety:
        options.plan || options.interactive || options.yolo ? undefined : reviewToolSafety,
      requestToolApproval: options.yolo ? allowAllToolApprovals : requestToolApproval,
      onEvent,
    });
    finalText = result.text.trim();
    history = result.history;
    model = result.context.model;
    provider = result.context.provider;
  }

  const verification = options.verify
    ? await runVerificationCommand(options.verify, workspaceRoot)
    : undefined;
  const endedAt = new Date().toISOString();
  const savedSession: StoredChatSession = {
    ...activeSession,
    provider,
    model,
    history,
    system,
    planMode: Boolean(options.plan),
    autoMode: !options.plan && !options.interactive && !options.yolo,
    yoloMode: Boolean(options.yolo),
    acceptEdits: false,
    taskDisplayPrompt: displayPrompt,
    taskSourceUrl: issuePrompt?.sourceUrl,
    updatedAt: endedAt,
  };
  saveSession(savedSession);

  const shareRequested = options.share !== undefined || options.shareUrl === true;
  const shareCard = shareRequested
    ? buildShareCard({
        workspaceRoot,
        prompt: displayPrompt,
        rerunPrompt: issuePrompt?.sourceUrl,
        provider,
        model,
        finalText,
        startedAt,
        endedAt,
        sessionId: savedSession.id,
        planMode: options.plan,
        verification,
      })
    : undefined;
  let sharePath: string | undefined;
  if (typeof options.share === "string" && shareCard) {
    sharePath = writeShareCard(shareCard, options.share, workspaceRoot);
  }
  const shareUrl = options.shareUrl && shareCard ? await publishShareCard(shareCard) : undefined;
  const clipboard = shareCard ? copyToClipboard(shareCard) : undefined;

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          shipped: !options.plan && (!verification || verification.exitCode === 0),
          provider,
          model,
          session_id: savedSession.id,
          output_text: finalText,
          text: finalText,
          verification: verification || null,
          share_path: sharePath || null,
          share_url: shareUrl?.url || null,
          share_url_error: shareUrl?.reason || null,
          copied_to_clipboard: clipboard?.copied || false,
          clipboard_method: clipboard?.method || null,
          share_card: sharePath ? null : shareCard || null,
        },
        null,
        2,
      ),
    );
  } else {
    console.log();
    console.log(finalText || chalk.dim("No final text returned."));
    if (verification) {
      console.log(
        verification.timedOut
          ? chalk.yellow(`\n⚠ Verification timed out: ${verification.command}`)
          : verification.exitCode === 0
            ? chalk.green(`\n✓ Verification passed: ${verification.command}`)
            : chalk.red(`\n✗ Verification failed: ${verification.command}`),
      );
    }
    if (sharePath) {
      console.log(chalk.green(`\n✓ Share card saved to ${sharePath}`));
    } else if (shareCard) {
      console.log(`\n${renderShareCard(shareCard)}`);
    }
    if (shareUrl?.url) {
      console.log(chalk.green(`\n✓ Share URL: ${shareUrl.url}`));
    } else if (shareUrl?.reason) {
      console.log(chalk.yellow(`\nShare URL unavailable: ${shareUrl.reason}`));
    }
    if (clipboard?.copied) {
      console.log(chalk.green(`\n✓ Share card copied to clipboard (${clipboard.method})`));
    } else if (shareCard) {
      console.log(chalk.dim(`\nClipboard unavailable: ${clipboard?.reason}`));
    }
  }

  if (verification && verification.exitCode !== 0) {
    process.exitCode = 1;
  }
}

function createToolSafetyReviewer(
  context: ReturnType<typeof resolveProviderContext>,
): (request: ToolApprovalRequest) => Promise<ToolSafetyReviewResult> {
  return async (request): Promise<ToolSafetyReviewResult> => {
    const reviewPrompt = [
      `Tool: ${request.toolName}`,
      `Title: ${request.title}`,
      `Reason: ${request.reason}`,
      `Summary: ${request.summary}`,
      `Details:\n${request.details.join("\n")}`,
    ].join("\n");

    try {
      if (context.provider === "flixa") {
        const response = await createResponse({
          apiKey: context.apiKey || "",
          model: context.model,
          system:
            "You are a strict safety reviewer for CLI tool calls. Respond only with SAFE: <reason> or UNSAFE: <reason>. Reject destructive, vague, unrelated, or externally publishing actions.",
          input: [{ role: "user", content: reviewPrompt }],
          baseUrl: context.baseUrl,
          maxOutputTokens: 120,
          toolChoice: "none",
        });
        const verdict = extractOutputText(response).trim() || "UNSAFE: empty review";
        return { safe: verdict.toUpperCase().startsWith("SAFE:"), verdict };
      }

      const result = await generateProviderText({
        provider: context.provider,
        model: context.model,
        baseUrl: context.baseUrl,
        system:
          "You are a strict safety reviewer for CLI tool calls. Respond only with SAFE: <reason> or UNSAFE: <reason>. Reject destructive, vague, unrelated, or externally publishing actions.",
        prompt: reviewPrompt,
        maxOutputTokens: 120,
      });
      const verdict = result.text.trim() || "UNSAFE: empty review";
      return { safe: verdict.toUpperCase().startsWith("SAFE:"), verdict };
    } catch (error) {
      return {
        safe: false,
        verdict:
          error instanceof Error
            ? `UNSAFE: safety review failed: ${error.message}`
            : `UNSAFE: safety review failed: ${String(error)}`,
      };
    }
  };
}

async function promptForToolApproval(request: ToolApprovalRequest): Promise<boolean> {
  return select({
    message: `${request.title}\n${request.reason}\n${request.toolName}: ${request.summary}${request.details.length ? `\n${request.details.join("\n")}` : ""}`,
    choices: [
      { name: "Approve once", value: true },
      { name: "Deny", value: false },
    ],
  });
}

async function allowAllToolApprovals(_request: ToolApprovalRequest): Promise<boolean> {
  return true;
}

async function runVerificationCommand(
  command: string,
  workspaceRoot: string,
): Promise<VerificationEvidence> {
  const context: ToolExecutionContext = {
    workspaceRoot,
    allowShell: true,
    allowFileEdits: false,
  };

  try {
    const result = await executeToolCall(
      {
        name: "Bash",
        callId: `verify-${Date.now()}`,
        argumentsText: JSON.stringify({
          command,
          reason: "The user explicitly requested this verification command.",
        }),
      },
      context,
    );
    const payload = JSON.parse(result.output) as Record<string, unknown>;
    return {
      command,
      exitCode: typeof payload.exit_code === "number" ? payload.exit_code : null,
      timedOut: payload.timed_out === true,
      stdout: typeof payload.stdout === "string" ? payload.stdout : undefined,
      stderr: typeof payload.stderr === "string" ? payload.stderr : undefined,
    };
  } catch (error) {
    return {
      command,
      exitCode: null,
      timedOut: false,
      stderr: error instanceof Error ? error.message : String(error),
    };
  }
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

function parseMaxOutputTokens(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error("--max-output-tokens must be a positive integer.");
  }
  return parsed;
}
