import { readdir, readFile, stat } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import type { GrepResult } from "../types";
import { globToRegExp } from "../util";

/** Directories never walked by the pure-JS fallbacks (ripgrep also honors .gitignore). */
export const DEFAULT_EXCLUDED_DIRECTORIES: ReadonlySet<string> = new Set([".git", "node_modules"]);

const MAX_GREP_FILE_BYTES = 1_000_000;
const MAX_GREP_MATCHES = 2_000;

export function toPortable(value: string): string {
  return value.replace(/\\/g, "/");
}

/** Walk regular files under `root` (depth-first, sorted), stopping at `limit`. */
export async function walkFiles(
  root: string,
  options: { limit: number; signal?: AbortSignal; filter?: (relativePath: string) => boolean },
): Promise<string[]> {
  const files: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    if (files.length >= options.limit || options.signal?.aborted) {
      return;
    }
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (files.length >= options.limit || options.signal?.aborted) {
        return;
      }
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!DEFAULT_EXCLUDED_DIRECTORIES.has(entry.name)) {
          await visit(absolute);
        }
      } else if (entry.isFile()) {
        if (!options.filter || options.filter(toPortable(relative(root, absolute)))) {
          files.push(absolute);
        }
      }
    }
  };

  const rootStat = await stat(root).catch(() => null);
  if (rootStat?.isFile()) {
    return [root];
  }
  await visit(root);
  return files;
}

/** ripgrep-compatible output from a pure-JS search, used when `rg` is not available. */
export async function grepWithJavaScript(options: {
  pattern: string;
  root: string;
  workspaceRoot: string;
  glob?: string;
  caseInsensitive?: boolean;
  signal?: AbortSignal;
}): Promise<GrepResult> {
  let expression: RegExp;
  try {
    expression = new RegExp(options.pattern, options.caseInsensitive ? "i" : "");
  } catch (error) {
    return {
      stdout: "",
      stderr: `regex parse error: ${error instanceof Error ? error.message : String(error)}`,
      exitCode: 2,
    };
  }

  const globExpression = options.glob ? globToRegExp(options.glob) : null;
  const files = await walkFiles(options.root, {
    limit: 50_000,
    signal: options.signal,
    filter: globExpression ? (path) => globExpression.test(path) : undefined,
  });

  const lines: string[] = [];
  for (const file of files) {
    if (options.signal?.aborted || lines.length >= MAX_GREP_MATCHES) {
      break;
    }
    const content = await readTextIfSmall(file);
    if (content === null) {
      continue;
    }
    const displayPath = displayPathFor(file, options.workspaceRoot);
    const fileLines = content.split(/\r?\n/);
    for (let index = 0; index < fileLines.length && lines.length < MAX_GREP_MATCHES; index += 1) {
      const line = fileLines[index] as string;
      if (expression.test(line)) {
        lines.push(`${displayPath}:${index + 1}:${line}`);
      }
    }
  }

  return { stdout: lines.join("\n"), stderr: "", exitCode: lines.length > 0 ? 0 : 1 };
}

export function displayPathFor(absolute: string, workspaceRoot: string): string {
  const relativePath = relative(workspaceRoot, absolute);
  const outside =
    relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath);
  return relativePath && !outside ? toPortable(relativePath) : toPortable(absolute);
}

async function readTextIfSmall(file: string): Promise<string | null> {
  try {
    const info = await stat(file);
    if (info.size > MAX_GREP_FILE_BYTES) {
      return null;
    }
    const content = await readFile(file);
    if (content.includes(0)) {
      return null;
    }
    return content.toString("utf8");
  } catch {
    return null;
  }
}
