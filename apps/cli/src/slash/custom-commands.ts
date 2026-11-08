import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, parse, resolve } from "node:path";

export interface CustomCommand {
  /** Slash name including the leading slash, e.g. `/review` or `/frontend:review`. */
  name: string;
  description: string;
  argumentHint?: string;
  body: string;
  source: string;
  scope: "user" | "project";
}

const COMMAND_DIR_NAMES = [join(".claude", "commands"), join(".flixa", "commands")] as const;
const MAX_COMMAND_FILE_BYTES = 64 * 1024;
const MAX_COMMAND_DEPTH = 3;
const MAX_COMMANDS = 200;
const SEGMENT_PATTERN = /^[A-Za-z0-9][\w.-]*$/;

/**
 * Loads Markdown prompt templates from `.claude/commands` and `.flixa/commands`.
 * User-level commands load first so project-level commands with the same name win.
 * Built-in command names in `reservedNames` are never shadowed.
 */
export function loadCustomCommands(
  cwdValue: string,
  reservedNames: Iterable<string> = [],
): CustomCommand[] {
  const reserved = new Set([...reservedNames].map((name) => name.toLowerCase()));
  const byName = new Map<string, CustomCommand>();
  const seenDirs = new Set<string>();

  const collect = (directory: string, scope: CustomCommand["scope"]): void => {
    const resolved = resolve(directory);
    if (seenDirs.has(resolved) || !isDirectory(resolved)) {
      return;
    }
    seenDirs.add(resolved);

    for (const command of readCommandDirectory(resolved, [], scope, 0)) {
      if (reserved.has(command.name.toLowerCase())) {
        continue;
      }
      byName.set(command.name.toLowerCase(), command);
    }
  };

  for (const dirName of COMMAND_DIR_NAMES) {
    collect(join(homedir(), dirName), "user");
  }

  const ancestors: string[] = [];
  let current = resolve(cwdValue);
  while (true) {
    ancestors.push(current);
    const parent = dirname(current);
    if (parent === current || current === parse(current).root) {
      break;
    }
    current = parent;
  }
  for (const directory of ancestors.reverse()) {
    for (const dirName of COMMAND_DIR_NAMES) {
      collect(join(directory, dirName), "project");
    }
  }

  return [...byName.values()]
    .sort((left, right) => left.name.localeCompare(right.name))
    .slice(0, MAX_COMMANDS);
}

export function findCustomCommand(
  commands: readonly CustomCommand[],
  input: string,
): { command: CustomCommand; args: string } | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) {
    return null;
  }

  const firstSpace = trimmed.search(/\s/);
  const token = (firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace)).toLowerCase();
  const command = commands.find((candidate) => candidate.name.toLowerCase() === token);
  if (!command) {
    return null;
  }

  return { command, args: firstSpace === -1 ? "" : trimmed.slice(firstSpace + 1).trim() };
}

/**
 * Expands `$ARGUMENTS` and `$1`..`$9` in a single pass so that argument text
 * containing `$1` is never expanded a second time. When the template has no
 * placeholder, the raw arguments are appended like Claude Code does.
 */
export function expandCustomCommand(command: CustomCommand, args: string): string {
  const argv = splitArguments(args);
  let usedPlaceholder = false;

  const expanded = command.body.replace(/\$ARGUMENTS|\$([1-9])/g, (_match, digit?: string) => {
    usedPlaceholder = true;
    return digit ? (argv[Number(digit) - 1] ?? "") : args;
  });

  if (!usedPlaceholder && args) {
    return `${expanded.trimEnd()}\n\nARGUMENTS: ${args}`;
  }

  return expanded;
}

/** Returns the expanded prompt when `prompt` invokes a custom command, otherwise null. */
export function resolveCustomCommandPrompt(
  prompt: string,
  cwdValue: string,
  reservedNames: Iterable<string> = [],
): string | null {
  if (!prompt.trim().startsWith("/")) {
    return null;
  }

  const match = findCustomCommand(loadCustomCommands(cwdValue, reservedNames), prompt);
  return match ? expandCustomCommand(match.command, match.args) : null;
}

function readCommandDirectory(
  directory: string,
  prefix: string[],
  scope: CustomCommand["scope"],
  depth: number,
): CustomCommand[] {
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }

  const commands: CustomCommand[] = [];
  for (const entry of entries) {
    const entryPath = join(directory, entry.name);

    // Dirent.isFile()/isDirectory() are false for symlinks, so links are skipped.
    if (entry.isDirectory()) {
      if (depth + 1 < MAX_COMMAND_DEPTH && SEGMENT_PATTERN.test(entry.name)) {
        commands.push(
          ...readCommandDirectory(entryPath, [...prefix, entry.name], scope, depth + 1),
        );
      }
      continue;
    }

    if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".md")) {
      continue;
    }

    const baseName = entry.name.slice(0, -".md".length);
    if (!SEGMENT_PATTERN.test(baseName)) {
      continue;
    }

    const command = readCommandFile(entryPath, [...prefix, baseName].join(":"), scope);
    if (command) {
      commands.push(command);
    }
  }

  return commands;
}

function readCommandFile(
  filePath: string,
  name: string,
  scope: CustomCommand["scope"],
): CustomCommand | null {
  try {
    if (statSync(filePath).size > MAX_COMMAND_FILE_BYTES) {
      return null;
    }

    const { meta, body } = parseFrontmatter(readFileSync(filePath, "utf-8"));
    const trimmedBody = body.trim();
    if (!trimmedBody) {
      return null;
    }

    return {
      name: `/${name}`,
      description: meta["description"] || firstLine(trimmedBody),
      argumentHint: meta["argument-hint"] || undefined,
      body: trimmedBody,
      source: filePath,
      scope,
    };
  } catch {
    return null;
  }
}

function parseFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
  const text = raw.replace(/^﻿/, "");
  const match = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!match) {
    return { meta: {}, body: text };
  }

  const meta: Record<string, string> = {};
  for (const line of (match[1] ?? "").split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator <= 0) {
      continue;
    }
    const key = line.slice(0, separator).trim().toLowerCase();
    const value = line
      .slice(separator + 1)
      .trim()
      .replace(/^(["'])(.*)\1$/, "$2");
    if (key) {
      meta[key] = value;
    }
  }

  return { meta, body: text.slice(match[0].length) };
}

function firstLine(body: string): string {
  const line = body.split(/\r?\n/).find((candidate) => candidate.trim()) ?? "";
  const cleaned = line.replace(/^#+\s*/, "").trim();
  return cleaned.length > 80 ? `${cleaned.slice(0, 79)}…` : cleaned;
}

function splitArguments(args: string): string[] {
  const result: string[] = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(args)) !== null) {
    result.push(match[1] ?? match[2] ?? match[3] ?? "");
  }
  return result;
}

function isDirectory(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isDirectory();
  } catch {
    return false;
  }
}
