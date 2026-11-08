import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import type { ChatMessage } from "../flixa/api.ts";

export interface ConversationExportMeta {
  sessionId: string;
  model: string;
  provider?: string;
  cwd: string;
  createdAt: string;
}

/** Renders a session transcript as portable Markdown, ending with one trailing newline. */
export function exportConversationMarkdown(
  meta: ConversationExportMeta,
  history: readonly ChatMessage[],
): string {
  const lines: string[] = ["# Flixa conversation", "", `- Session ID: ${meta.sessionId}`];
  lines.push(`- Model: ${meta.model}`);
  if (meta.provider) {
    lines.push(`- Provider: ${meta.provider}`);
  }
  lines.push(`- Working directory: ${meta.cwd}`, `- Created: ${meta.createdAt}`);

  for (const message of history) {
    lines.push("", message.role === "user" ? "## User" : "## Assistant", "");
    lines.push(message.content.trimEnd());
  }

  return `${lines.join("\n").replace(/\n*$/, "")}\n`;
}

/**
 * Resolves the export destination. Defaults to `flixa-export-<id8>.md` in the
 * workspace; a requested path is kept inside the workspace and gets `.md` added.
 */
export function resolveExportPath(
  workspaceRoot: string,
  requested: string | undefined,
  sessionId: string,
): string {
  const root = resolve(workspaceRoot);

  if (requested === undefined || requested.trim() === "") {
    return join(root, `flixa-export-${sessionId.slice(0, 8)}.md`);
  }

  const resolved = resolve(root, requested);
  const rel = relative(root, resolved);
  // An empty `rel` is the workspace root itself, which would write `<root>.md` outside it.
  if (rel === "" || /^\.\.(?:[\\/]|$)/.test(rel) || isAbsolute(rel)) {
    throw new Error("Export path must stay inside the workspace.");
  }

  return extname(resolved) === "" ? `${resolved}.md` : resolved;
}

/** Writes the export to disk, creating parent directories and refusing to overwrite. */
export function writeExport(path: string, markdown: string): void {
  if (existsSync(path)) {
    throw new Error(`File already exists: ${path}`);
  }

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, markdown, "utf-8");
}
