import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { confirm } from "@inquirer/prompts";
import chalk from "chalk";
import { getApiKey } from "../auth/service.ts";
import type { Command } from "commander";

const CODEX_DIR = join(homedir(), ".codex");
const CODEX_CONFIG_TOML = join(CODEX_DIR, "config.toml");

function buildFlixaSection(apiKey: string): string {
  const token = `Bearer ${apiKey}`.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `[model_providers.flixa]
name = "flixa"
base_url = "https://flixa-api.deniai.app/v1/agent"
wire_api = "responses"
requires_openai_auth = false

[model_providers.flixa.http_headers]
Authorization = "${token}"`;
}

function readToml(path: string): string {
  if (!existsSync(path)) return "";
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return "";
  }
}

function writeToml(path: string, content: string): void {
  const dir = join(path, "..");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, content, { mode: 0o600 });
}

/** Insert or replace the [model_providers.flixa] section in a TOML string. */
function upsertFlixaSection(content: string, section: string): string {
  const header = "[model_providers.flixa]";
  const idx = content.indexOf(header);

  if (idx === -1) {
    const sep = content.length > 0 && !content.endsWith("\n\n") ? "\n\n" : "";
    return content + sep + section + "\n";
  }

  const afterHeader = idx + header.length;
  const nextSection = content.slice(afterHeader).search(/\n\[(?!model_providers\.flixa\.)/);
  const end = nextSection === -1 ? content.length : afterHeader + nextSection + 1;

  return content.slice(0, idx) + section + "\n" + content.slice(end);
}

const MODEL_PROVIDER_LINE = /^model_provider[ 	]*=[ 	]*(.*?)[ 	]*$/m;

/** Split TOML into the top-level key region (before the first table) and the rest. */
function splitTopLevel(content: string): { top: string; rest: string } {
  const m = /^\[/m.exec(content);
  return m
    ? { top: content.slice(0, m.index), rest: content.slice(m.index) }
    : { top: content, rest: "" };
}

function getModelProvider(content: string): string | null {
  const m = MODEL_PROVIDER_LINE.exec(splitTopLevel(content).top);
  return m ? m[1]!.replace(/^["']|["']$/g, "") : null;
}

/** Set top-level model_provider = "flixa" (must live before any [table]). */
function setModelProvider(content: string): string {
  const { top, rest } = splitTopLevel(content);
  const line = 'model_provider = "flixa"';
  if (MODEL_PROVIDER_LINE.test(top)) {
    return top.replace(MODEL_PROVIDER_LINE, line) + rest;
  }
  const head = top.length > 0 && !top.endsWith("\n") ? top + "\n" : top;
  return head + line + "\n" + (rest ? "\n" : "") + rest;
}

function removeModelProvider(content: string): string {
  const { top, rest } = splitTopLevel(content);
  const stripped = top.replace(new RegExp(MODEL_PROVIDER_LINE.source + "\r?\n?", "m"), "");
  return (rest ? stripped.replace(/(\r?\n){2,}$/, "\n\n") : stripped) + rest;
}

/** Same pattern as updateField but for a TOML section. */
async function updateTomlSection(
  path: string,
  label: string,
  apiKey: string,
): Promise<{ changed: boolean; skipped: boolean }> {
  const current = readToml(path);
  const section = buildFlixaSection(apiKey);
  const hasSection = current.includes("[model_providers.flixa]");

  if (hasSection && current.includes(section)) {
    console.log(chalk.dim(`  ${label}: already set, skipping`));
    return { changed: false, skipped: true };
  }

  if (hasSection) {
    const ok = await confirm({
      message: `  ${label}: [model_providers.flixa] already exists, replace?`,
      default: true,
    });
    if (!ok) {
      console.log(chalk.dim(`  ${label}: skipped`));
      return { changed: false, skipped: true };
    }
  }

  writeToml(path, upsertFlixaSection(current, section));
  return { changed: true, skipped: false };
}

async function enableModelProvider(path: string, label: string): Promise<boolean> {
  const current = readToml(path);
  const existing = getModelProvider(current);
  if (existing === "flixa") {
    console.log(chalk.dim(`  ${label}: model_provider already "flixa", skipping`));
    return false;
  }
  if (existing !== null) {
    const ok = await confirm({
      message: `  ${label}: model_provider is "${existing}", replace with "flixa"?`,
      default: true,
    });
    if (!ok) {
      console.log(chalk.dim(`  ${label}: skipped`));
      return false;
    }
  }
  writeToml(path, setModelProvider(current));
  return true;
}

export function registerCodexCommand(program: Command): void {
  const codex = program
    .command("codex")
    .description("Configure Codex to use Flixa as the API backend")
    .action(async () => {
      const apiKey = getApiKey();
      if (!apiKey) {
        console.error(chalk.red("✗ Not logged in.") + " Run `flixa login` first.");
        process.exit(1);
      }

      let totalChanged = 0;

      console.log(chalk.bold("\n~/.codex/config.toml"));
      const r1 = await updateTomlSection(CODEX_CONFIG_TOML, "config.toml", apiKey);
      if (r1.changed) totalChanged++;
      if (await enableModelProvider(CODEX_CONFIG_TOML, "config.toml")) totalChanged++;

      console.log();
      if (totalChanged > 0) {
        console.log(chalk.green("✓ Codex configured to use Flixa."));
      } else {
        console.log(chalk.dim("No changes made."));
      }
      console.log(
        chalk.dim("Run `flixa codex unset` to switch Codex back to its default provider."),
      );
    });

  codex
    .command("unset")
    .description('Remove model_provider = "flixa" from ~/.codex/config.toml')
    .action(() => {
      const current = readToml(CODEX_CONFIG_TOML);
      const existing = getModelProvider(current);
      if (existing !== "flixa") {
        console.log(chalk.dim('model_provider is not "flixa", nothing to remove.'));
        return;
      }
      writeToml(CODEX_CONFIG_TOML, removeModelProvider(current));
      console.log(chalk.green("✓ Removed model_provider from ~/.codex/config.toml."));
    });
}
