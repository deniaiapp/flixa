import { copyFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import chalk from "chalk";
import { getApiKey } from "../auth/service.ts";
import { getDefaultProvider, getPersistedProviderBaseUrl } from "../config/store.ts";
import { getProviderDefinition, isProviderId, type ProviderId } from "../providers/registry.ts";
import { readJson, writeJson, updateField } from "./utils.ts";
import type { Command } from "commander";

const CLAUDE_JSON = join(homedir(), ".claude.json");
const CLAUDE_SETTINGS_JSON = join(homedir(), ".claude", "settings.json");

export function registerClaudeCodeCommand(program: Command): void {
  const claudeCode = program
    .command("claude-code")
    .description("Configure Claude Code to use a supported provider")
    .option("-p, --provider <provider>", "Provider to use for Claude Code")
    .option("--dry-run", "Show planned Claude Code changes without writing files")
    .action(async (options: { provider?: string; dryRun?: boolean }) => {
      const provider = resolveProvider(options.provider);
      const providerDefinition = getProviderDefinition(provider);
      const claudeCodeEnv = providerDefinition.claudeCodeEnv;

      if (!claudeCodeEnv) {
        console.error(
          chalk.red("✗ Unsupported provider for Claude Code:") +
            ` ${providerDefinition.displayName}. Supported providers: flixa, anthropic.`,
        );
        process.exit(1);
      }

      const apiKey = getApiKey(provider);
      if (!apiKey) {
        console.error(
          chalk.red("✗ Not logged in.") + ` Run \`flixa login --provider ${provider}\` first.`,
        );
        process.exit(1);
      }

      if (options.dryRun) {
        console.log(chalk.yellow("Dry run only. No files will be written."));
      }

      let totalChanged = 0;

      console.log(chalk.bold("\nPlanned Claude Code changes:"));
      console.log(chalk.dim(`  Provider: ${providerDefinition.displayName}`));
      console.log(chalk.dim(`  ${CLAUDE_JSON}: hasCompletedOnboarding, primaryApiKey`));
      console.log(
        chalk.dim(
          `  ${CLAUDE_SETTINGS_JSON}: env.${claudeCodeEnv.apiKeyEnv}` +
            (claudeCodeEnv.baseUrlEnv ? `, env.${claudeCodeEnv.baseUrlEnv}` : ""),
        ),
      );

      console.log(chalk.bold("\n~/.claude.json"));
      const claudeJson = readJsonOrExit(CLAUDE_JSON, "~/.claude.json");

      const r1 = await updateField(
        claudeJson,
        "hasCompletedOnboarding",
        true,
        "hasCompletedOnboarding",
      );
      const r2 = await updateField(claudeJson, "primaryApiKey", apiKey, "primaryApiKey");

      if (r1.changed || r2.changed) {
        if (options.dryRun) {
          console.log(chalk.dim("  dry-run: skipping write"));
        } else {
          backupIfExists(CLAUDE_JSON);
          writeJson(CLAUDE_JSON, claudeJson);
        }
        totalChanged++;
      }

      console.log(chalk.bold("\n~/.claude/settings.json → env"));
      const settings = readJsonOrExit(CLAUDE_SETTINGS_JSON, "~/.claude/settings.json");
      if (typeof settings["env"] !== "object" || settings["env"] === null) {
        settings["env"] = {};
      }
      const env = settings["env"] as Record<string, unknown>;

      let settingsChanged = false;

      if (claudeCodeEnv.baseUrlEnv) {
        const baseUrl = getPersistedProviderBaseUrl(provider) ?? providerDefinition.defaultBaseUrl;
        if (baseUrl) {
          const r3 = await updateField(
            env,
            claudeCodeEnv.baseUrlEnv,
            baseUrl,
            claudeCodeEnv.baseUrlEnv,
          );
          settingsChanged = settingsChanged || r3.changed;
        }
      }

      const r4 = await updateField(env, claudeCodeEnv.apiKeyEnv, apiKey, claudeCodeEnv.apiKeyEnv);
      settingsChanged = settingsChanged || r4.changed;

      if (settingsChanged) {
        if (options.dryRun) {
          console.log(chalk.dim("  dry-run: skipping write"));
        } else {
          backupIfExists(CLAUDE_SETTINGS_JSON);
          writeJson(CLAUDE_SETTINGS_JSON, settings);
        }
        totalChanged++;
      }

      console.log();
      if (totalChanged > 0) {
        console.log(
          chalk.green(
            options.dryRun
              ? `✓ Claude Code changes previewed for ${providerDefinition.displayName}.`
              : `✓ Claude Code configured to use ${providerDefinition.displayName}.`,
          ),
        );
      } else {
        console.log(chalk.dim("No changes made."));
      }

      if (!options.dryRun && totalChanged > 0) {
        console.log(
          chalk.dim(
            "Backups created as *.bak next to changed Claude files when originals existed.",
          ),
        );
      }

      console.log();
      console.log(chalk.dim("Start Claude Code with:"));
      console.log(chalk.cyan("  claude"));
    });

  claudeCode
    .command("unset")
    .description("Remove the provider settings written by `flixa claude-code`")
    .option("-p, --provider <provider>", "Provider whose settings should be removed")
    .option("--dry-run", "Show planned changes without writing files")
    .action((_options: unknown, command: Command) => {
      // The parent `claude-code` command declares the same flags and swallows them.
      const options = command.optsWithGlobals<{ provider?: string; dryRun?: boolean }>();
      const provider = resolveProvider(options.provider);
      const providerDefinition = getProviderDefinition(provider);
      const claudeCodeEnv = providerDefinition.claudeCodeEnv;

      if (!claudeCodeEnv) {
        console.error(
          chalk.red("✗ Unsupported provider for Claude Code:") +
            ` ${providerDefinition.displayName}. Supported providers: flixa, anthropic.`,
        );
        process.exit(1);
      }

      if (options.dryRun) {
        console.log(chalk.yellow("Dry run only. No files will be written."));
      }

      const apiKey = getApiKey(provider);
      // Only remove keys that look like ours, so a user's own key is never deleted.
      // Without a stored key (e.g. after logout) fall back to the Flixa key prefix.
      const isOurs = (value: unknown): boolean => {
        if (typeof value !== "string") {
          return false;
        }
        if (apiKey) {
          return value === apiKey;
        }
        return provider === "flixa" && value.startsWith("deni_");
      };

      let totalChanged = 0;

      console.log(chalk.bold("\n~/.claude.json"));
      const claudeJson = readJsonOrExit(CLAUDE_JSON, "~/.claude.json");
      if (!("primaryApiKey" in claudeJson)) {
        console.log(chalk.dim("  primaryApiKey: not set, skipping"));
      } else if (!isOurs(claudeJson["primaryApiKey"])) {
        console.log(chalk.dim("  primaryApiKey: differs from the stored key, skipping"));
      } else {
        delete claudeJson["primaryApiKey"];
        console.log(chalk.green("  primaryApiKey: removed"));
        if (!options.dryRun) {
          backupIfExists(CLAUDE_JSON);
          writeJson(CLAUDE_JSON, claudeJson);
        }
        totalChanged++;
      }

      console.log(chalk.bold("\n~/.claude/settings.json → env"));
      const settings = readJsonOrExit(CLAUDE_SETTINGS_JSON, "~/.claude/settings.json");
      const env =
        typeof settings["env"] === "object" && settings["env"] !== null
          ? (settings["env"] as Record<string, unknown>)
          : {};

      let settingsChanged = false;
      const removeKey = (key: string, remove: boolean, reason: string): void => {
        if (!(key in env)) {
          console.log(chalk.dim(`  ${key}: not set, skipping`));
        } else if (!remove) {
          console.log(chalk.dim(`  ${key}: ${reason}, skipping`));
        } else {
          delete env[key];
          console.log(chalk.green(`  ${key}: removed`));
          settingsChanged = true;
        }
      };

      removeKey(
        claudeCodeEnv.apiKeyEnv,
        isOurs(env[claudeCodeEnv.apiKeyEnv]),
        "differs from the stored key",
      );
      if (claudeCodeEnv.baseUrlEnv) {
        const baseUrl = getPersistedProviderBaseUrl(provider) ?? providerDefinition.defaultBaseUrl;
        removeKey(
          claudeCodeEnv.baseUrlEnv,
          baseUrl === undefined || env[claudeCodeEnv.baseUrlEnv] === baseUrl,
          "differs from the provider base URL",
        );
      }

      if (settingsChanged) {
        if (Object.keys(env).length === 0) delete settings["env"];
        if (!options.dryRun) {
          backupIfExists(CLAUDE_SETTINGS_JSON);
          writeJson(CLAUDE_SETTINGS_JSON, settings);
        }
        totalChanged++;
      }

      console.log();
      if (totalChanged > 0) {
        console.log(
          chalk.green(
            options.dryRun
              ? "✓ Claude Code unset previewed."
              : `✓ Removed ${providerDefinition.displayName} settings from Claude Code.`,
          ),
        );
      } else {
        console.log(chalk.dim("No changes made."));
      }
    });
}

function backupIfExists(path: string): void {
  if (!existsSync(path)) {
    return;
  }

  const backupPath = `${path}.bak`;
  copyFileSync(path, backupPath);
}

function readJsonOrExit(path: string, displayPath: string): Record<string, unknown> {
  try {
    return readJson(path);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(chalk.red(`✗ ${displayPath} contains invalid JSON.`));
    console.error(chalk.dim(`  File: ${path}`));
    console.error(chalk.dim(`  ${message}`));
    console.error(
      chalk.dim(
        "  Fix the file manually or restore it from a backup, then run `flixa claude-code` again.",
      ),
    );
    process.exit(1);
  }
}

function resolveProvider(rawProvider: string | undefined): ProviderId {
  if (!rawProvider) {
    return getDefaultProvider();
  }

  const normalized = rawProvider.trim().toLowerCase();
  if (!isProviderId(normalized)) {
    throw new Error(`Unsupported provider: ${rawProvider}`);
  }
  return normalized;
}
