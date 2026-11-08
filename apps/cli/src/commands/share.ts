import chalk from "chalk";
import { cwd } from "node:process";
import type { Command } from "commander";
import { getDefaultProvider } from "../config/store.ts";
import {
  buildShareCard,
  copyToClipboard,
  publishShareCard,
  writeShareCard,
} from "../runs/share-card.ts";
import { renderShareCard } from "../ui/share-card.ts";
import { loadLatestSessionForCwd, loadSessionById } from "../sessions/store.ts";

type ShareOptions = {
  session?: string;
  output?: string;
  shareUrl?: boolean;
  json?: boolean;
};

export function registerShareCommand(program: Command): void {
  program
    .command("share")
    .alias("recap")
    .description("Create a redacted, shareable card from a coding session")
    .option("--session <sessionId>", "Use a specific saved session")
    .option("-o, --output <path>", "Write the card to a Markdown file")
    .option("--share-url", "Publish the redacted card to Flixa Share")
    .option("--json", "Print card metadata as JSON")
    .action(async (options: ShareOptions, command: Command) => {
      const resolvedOptions = {
        ...(command.parent?.opts?.() as Partial<ShareOptions> | undefined),
        ...options,
      };
      const session = resolvedOptions.session
        ? loadSessionById(resolvedOptions.session)
        : loadLatestSessionForCwd(cwd());
      if (!session) {
        throw new Error(
          resolvedOptions.session
            ? `Session not found: ${resolvedOptions.session}`
            : "No saved session found in this directory.",
        );
      }

      const lastUserPrompt = [...session.history]
        .reverse()
        .find((message) => message.role === "user")?.content;
      const lastAssistantText = [...session.history]
        .reverse()
        .find((message) => message.role === "assistant")?.content;
      const card = buildShareCard({
        workspaceRoot: session.cwd || cwd(),
        prompt: session.taskDisplayPrompt || lastUserPrompt || "Flixa coding session",
        rerunPrompt: session.taskSourceUrl,
        provider: session.provider || getDefaultProvider(),
        model: session.model,
        finalText: lastAssistantText || "No assistant result yet.",
        startedAt: session.createdAt,
        endedAt: session.updatedAt,
        sessionId: session.id,
        planMode: session.planMode,
      });

      let outputPath: string | undefined;
      if (resolvedOptions.output) {
        outputPath = writeShareCard(card, resolvedOptions.output, session.cwd || cwd());
      }
      const clipboard = copyToClipboard(card);
      const shareUrl = resolvedOptions.shareUrl ? await publishShareCard(card) : undefined;

      if (resolvedOptions.json) {
        console.log(
          JSON.stringify(
            {
              session_id: session.id,
              provider: session.provider || getDefaultProvider(),
              model: session.model,
              output_path: outputPath || null,
              share_url: shareUrl?.url || null,
              share_url_error: shareUrl?.reason || null,
              copied_to_clipboard: clipboard.copied,
              clipboard_method: clipboard.method || null,
              card,
            },
            null,
            2,
          ),
        );
        return;
      }

      if (outputPath) {
        console.log(chalk.green(`✓ Share card saved to ${outputPath}`));
      } else {
        console.log(renderShareCard(card));
      }
      if (clipboard.copied) {
        console.log(chalk.green(`✓ Share card copied to clipboard (${clipboard.method})`));
      } else {
        console.log(chalk.dim(`Clipboard unavailable: ${clipboard.reason}`));
      }
      if (shareUrl?.url) {
        console.log(chalk.green(`✓ Share URL: ${shareUrl.url}`));
      } else if (shareUrl?.reason) {
        console.log(chalk.yellow(`Share URL unavailable: ${shareUrl.reason}`));
      }
    });
}
