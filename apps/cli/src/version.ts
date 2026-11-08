import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const FALLBACK_VERSION = "0.0.0";

export const CLI_VERSION = resolveCliVersion(import.meta.url);

function resolveCliVersion(moduleUrl: string): string {
  let currentDir = dirname(fileURLToPath(moduleUrl));

  for (let depth = 0; depth < 6; depth += 1) {
    const packageJsonPath = join(currentDir, "package.json");

    if (existsSync(packageJsonPath)) {
      try {
        const parsed = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
          version?: unknown;
        };

        if (typeof parsed.version === "string" && parsed.version.trim()) {
          return parsed.version;
        }
      } catch {
        break;
      }
    }

    const parentDir = dirname(currentDir);
    if (parentDir === currentDir) {
      break;
    }
    currentDir = parentDir;
  }

  return FALLBACK_VERSION;
}
