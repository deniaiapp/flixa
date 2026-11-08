import chalk from "chalk";
import type { Command } from "commander";
import { DEFAULT_FLIXA_BASE_URL, fetchDeniUsage, resolveFlixaApiKey } from "../flixa/api.ts";
import { formatUsageReport } from "../flixa/usage.ts";

type UsageCommandOptions = {
  json?: boolean;
  baseUrl?: string;
};

export function registerUsageCommand(program: Command): void {
  program
    .command("usage")
    .description("Show your Flixa plan and usage limits")
    .option("--json", "Print the raw JSON response")
    .option("--base-url <url>", "Override the Flixa API base URL", DEFAULT_FLIXA_BASE_URL)
    .action(async (options: UsageCommandOptions) => {
      const apiKey = resolveFlixaApiKey();
      if (!apiKey) {
        console.error(chalk.red("✗ Not logged in.") + " Run `flixa login` first.");
        process.exit(1);
      }

      try {
        const usage = await fetchDeniUsage({
          apiKey,
          baseUrl: options.baseUrl,
        });

        if (options.json) {
          console.log(JSON.stringify(usage, null, 2));
          return;
        }

        console.log(formatUsageReport(usage));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(chalk.red("✗ Usage request failed:") + ` ${message}`);
        process.exit(1);
      }
    });
}
