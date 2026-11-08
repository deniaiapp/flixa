import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type MemoryScope = "project" | "user";

const MAX_NOTE_LENGTH = 2000;
const PROJECT_FILE_NAMES = ["CLAUDE.md", "AGENTS.md"] as const;

/**
 * Resolves the instructions file that a quick memory (`# ...`) note is written to.
 * Project scope prefers an existing `CLAUDE.md`, then `AGENTS.md`, falling back to `AGENTS.md`.
 */
export function getMemoryFilePath(workspaceRoot: string, scope: MemoryScope): string {
  if (scope === "user") {
    return join(homedir(), ".flixa", "AGENTS.md");
  }

  for (const fileName of PROJECT_FILE_NAMES) {
    const candidate = join(workspaceRoot, fileName);
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return join(workspaceRoot, "AGENTS.md");
}

/**
 * Appends a single `- <note>` line to the memory file. Idempotent: an identical
 * note already present is not added again. `created` reports whether the file was made.
 */
export function appendMemory(
  workspaceRoot: string,
  scope: MemoryScope,
  note: string,
): { path: string; created: boolean } {
  const cleaned = note
    .trim()
    .replace(/^#+\s*/, "")
    .trim()
    .replace(/\s+/g, " ");

  if (!cleaned) {
    throw new Error("Memory note is empty.");
  }
  if (cleaned.length > MAX_NOTE_LENGTH) {
    throw new Error(`Memory note is too long (max ${MAX_NOTE_LENGTH} characters).`);
  }

  const filePath = getMemoryFilePath(workspaceRoot, scope);
  const exists = existsSync(filePath);
  mkdirSync(dirname(filePath), {
    recursive: true,
    ...(scope === "user" ? { mode: 0o700 } : {}),
  });

  const existing = exists ? readFileSync(filePath, "utf-8") : "";
  const line = `- ${cleaned}`;
  const alreadyPresent = existing.split(/\r?\n/).some((candidate) => candidate.trim() === line);

  if (!alreadyPresent) {
    let content = exists
      ? existing
      : scope === "user"
        ? "# Personal memory\n\n"
        : "# AGENTS.md\n\n";
    if (content.length > 0 && !content.endsWith("\n")) {
      content += "\n";
    }
    writeFileSync(filePath, `${content}${line}\n`, "utf-8");
  }

  return { path: filePath, created: !exists };
}

/** Returns the raw contents of the memory file, or an empty string when it is missing. */
export function readMemoryNotes(workspaceRoot: string, scope: MemoryScope): string {
  const filePath = getMemoryFilePath(workspaceRoot, scope);
  try {
    return readFileSync(filePath, "utf-8");
  } catch {
    return "";
  }
}

/**
 * Recognises the `# note` quick-memory shortcut. Returns the note text, or null for
 * plain input, a lone `#`, or Markdown headings such as `## Section`.
 */
export function parseMemoryShortcut(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith("#") || trimmed.startsWith("##") || trimmed === "#") {
    return null;
  }

  return trimmed.slice(1).trim();
}
