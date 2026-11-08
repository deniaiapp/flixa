import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { confirm } from "@inquirer/prompts";
import chalk from "chalk";

export function readJson(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
}

export function writeJson(path: string, data: Record<string, unknown>): void {
  const dir = join(path, "..");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
}

/** Update a field with optional confirmation. Skip if same value, confirm if different, set silently if unset. */
export async function updateField(
  obj: Record<string, unknown>,
  key: string,
  newValue: unknown,
  label: string,
): Promise<{ changed: boolean; skipped: boolean }> {
  const current = obj[key];

  if (current === newValue) {
    console.log(chalk.dim(`  ${label}: already set, skipping`));
    return { changed: false, skipped: true };
  }

  if (current !== undefined) {
    const looksSecret = /key|token|secret/i.test(key);
    const masked =
      typeof current === "string" && current.startsWith("deni_")
        ? current.slice(0, 10) + "****"
        : typeof current === "string" && looksSecret
          ? current.slice(0, 4) + "****"
          : String(current);
    const ok = await confirm({
      message: `  ${label}: current value is ${chalk.yellow(masked)}, replace?`,
      default: true,
    });
    if (!ok) {
      console.log(chalk.dim(`  ${label}: skipped`));
      return { changed: false, skipped: true };
    }
  }

  obj[key] = newValue;
  return { changed: true, skipped: false };
}
