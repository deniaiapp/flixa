import { readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export interface MentionResult {
  prompt: string;
  attached: Array<{ path: string; bytes: number; truncated: boolean }>;
  warnings: string[];
}

const MAX_MENTIONS = 10;
const MAX_FILE_CHARS = 24_000;
const MAX_DIRECTORY_ENTRIES = 100;
const GIT_DIR = ".git";
const SKIPPED_DIRS = new Set([GIT_DIR, "node_modules"]);
const TRAILING_PUNCTUATION = /[,.;:)\]]+$/;
// The `(^|\s)` guard keeps emails like `user@example.com` from being mentions.
const MENTION_PATTERN = /(^|\s)@(?:"([^"]*)"|(\S+))/g;

interface Attachment {
  path: string;
  content: string;
  kind: "file" | "directory";
}

/** Expands Claude Code style `@path` mentions in a prompt into attached file/directory blocks. */
export function expandFileMentions(prompt: string, workspaceRoot: string): MentionResult {
  const root = resolve(workspaceRoot);
  const realRoot = realpath(resolve(root)) ?? root;
  const attached: MentionResult["attached"] = [];
  const blocks: string[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();
  let warnedTooMany = false;

  const pattern = new RegExp(MENTION_PATTERN.source, "g");
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(prompt)) !== null) {
    const quoted = match[2];
    const token = match[3];
    const candidates = quoted !== undefined ? [quoted] : punctuationCandidates(token ?? "");
    const resolved = resolveCandidate(root, candidates);
    if (resolved === null) {
      continue;
    }

    const real = realpath(resolved);
    if (real === null) {
      continue;
    }
    if (!isInside(realRoot, real)) {
      warnings.push(
        `Skipped @${toWorkspacePath(realRoot, resolved)}: resolves outside the workspace.`,
      );
      continue;
    }

    const rel = toWorkspacePath(realRoot, real);
    if (hasGitSegment(rel) || seen.has(rel)) {
      continue;
    }

    if (attached.length >= MAX_MENTIONS) {
      if (!warnedTooMany) {
        warnings.push(`Too many file mentions; only the first ${MAX_MENTIONS} were attached.`);
        warnedTooMany = true;
      }
      continue;
    }
    seen.add(rel);

    const attachment = buildAttachment(real, rel, warnings);
    if (attachment === null) {
      continue;
    }
    attached.push({
      path: rel,
      bytes: Buffer.byteLength(attachment.content, "utf-8"),
      truncated: attachment.truncated,
    });
    blocks.push(renderBlock(attachment));
  }

  return {
    prompt: blocks.length > 0 ? `${prompt}\n\n${blocks.join("\n\n")}` : prompt,
    attached,
    warnings,
  };
}

/**
 * Returns the partial path of the `@` mention the user is currently typing, or null.
 * Only the last token counts, and a trailing space closes the mention.
 */
export function getActiveMention(input: string): string | null {
  if (input.length === 0 || /\s$/.test(input)) {
    return null;
  }
  const token = /(\S+)$/.exec(input)?.[1];
  if (token === undefined || !token.startsWith("@")) {
    return null;
  }
  return token.slice(1);
}

/** Completions for an in-progress `@` path, directories first and paths workspace-relative. */
export function listMentionCandidates(partial: string, workspaceRoot: string, limit = 8): string[] {
  try {
    if (limit <= 0) {
      return [];
    }

    const root = resolve(workspaceRoot);
    const realRoot = realpath(resolve(root)) ?? root;
    const separator = Math.max(partial.lastIndexOf("/"), partial.lastIndexOf("\\"));
    const rawDir = separator === -1 ? "" : partial.slice(0, separator);
    const prefix = (separator === -1 ? partial : partial.slice(separator + 1)).toLowerCase();
    const dir = rawDir.replace(/\\/g, "/");

    const realDir = realpath(rawDir ? resolve(root, rawDir) : root);
    if (realDir === null || !isInside(realRoot, realDir)) {
      return [];
    }

    const directories: string[] = [];
    const files: string[] = [];
    for (const entry of readdirSync(realDir, { withFileTypes: true })) {
      if (SKIPPED_DIRS.has(entry.name) || !entry.name.toLowerCase().startsWith(prefix)) {
        continue;
      }
      const rel = dir ? `${dir}/${entry.name}` : entry.name;
      if (isDirectoryEntry(realDir, entry)) {
        directories.push(`${rel}/`);
      } else {
        files.push(rel);
      }
    }

    const byName = (left: string, right: string): number => left.localeCompare(right);
    return [...directories.sort(byName), ...files.sort(byName)].slice(0, limit);
  } catch {
    return [];
  }
}

function buildAttachment(
  absolutePath: string,
  rel: string,
  warnings: string[],
): (Attachment & { truncated: boolean }) | null {
  let stats: import("node:fs").Stats;
  try {
    stats = statSync(absolutePath);
  } catch {
    warnings.push(`Could not read @${rel}.`);
    return null;
  }

  if (stats.isDirectory()) {
    const { listing, truncated } = readDirectoryListing(absolutePath);
    return { path: rel, content: listing, kind: "directory", truncated };
  }
  if (!stats.isFile()) {
    return null;
  }

  let buffer: Buffer;
  try {
    buffer = readFileSync(absolutePath);
  } catch {
    warnings.push(`Could not read @${rel}.`);
    return null;
  }

  // A NUL byte is the cheapest reliable signal that the file is not text.
  if (buffer.indexOf(0) !== -1) {
    warnings.push(`Skipped @${rel}: binary file.`);
    return null;
  }

  const text = buffer.toString("utf-8");
  const truncated = text.length > MAX_FILE_CHARS;
  return {
    path: rel,
    content: truncated ? text.slice(0, MAX_FILE_CHARS) : text,
    kind: "file",
    truncated,
  };
}

function readDirectoryListing(directory: string): { listing: string; truncated: boolean } {
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return { listing: "", truncated: false };
  }

  const names = entries
    .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
    .sort((left, right) => left.localeCompare(right));

  return {
    listing: names.slice(0, MAX_DIRECTORY_ENTRIES).join("\n"),
    truncated: names.length > MAX_DIRECTORY_ENTRIES,
  };
}

function renderBlock(attachment: Attachment): string {
  const tag = attachment.kind === "directory" ? "directory" : "file";
  return `<${tag} path="${attachment.path}">\n${attachment.content}\n</${tag}>`;
}

/** Tries the raw token first, then the same token with trailing sentence punctuation removed. */
function punctuationCandidates(token: string): string[] {
  const stripped = token.replace(TRAILING_PUNCTUATION, "");
  return stripped.length > 0 && stripped !== token ? [token, stripped] : [token];
}

function resolveCandidate(root: string, candidates: readonly string[]): string | null {
  for (const candidate of candidates) {
    if (candidate.length === 0) {
      continue;
    }
    const absolute = isAbsolute(candidate) ? resolve(candidate) : resolve(root, candidate);
    if (realpath(absolute) !== null) {
      return absolute;
    }
  }
  return null;
}

function realpath(pathValue: string): string | null {
  try {
    return realpathSync(pathValue);
  } catch {
    return null;
  }
}

function isDirectoryEntry(directory: string, entry: import("node:fs").Dirent): boolean {
  if (entry.isDirectory()) {
    return true;
  }
  if (!entry.isSymbolicLink()) {
    return false;
  }
  try {
    return statSync(join(directory, entry.name)).isDirectory();
  } catch {
    return false;
  }
}

function isInside(root: string, pathValue: string): boolean {
  const rel = relative(root, pathValue);
  return !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`);
}

function toWorkspacePath(root: string, pathValue: string): string {
  const rel = relative(root, pathValue);
  return rel === "" ? "." : rel.split(sep).join("/");
}

function hasGitSegment(rel: string): boolean {
  return rel.split("/").some((segment) => segment.toLowerCase() === GIT_DIR);
}
