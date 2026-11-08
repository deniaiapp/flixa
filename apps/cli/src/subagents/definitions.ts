import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, parse, resolve } from "node:path";

export interface SubagentDefinition {
  name: string;
  description: string;
  systemPrompt: string;
  /** `null` means "all tools except Task". */
  tools: string[] | null;
  model?: string;
  source: "builtin" | "user" | "project";
}

const AGENT_DIR_NAMES = [join(".claude", "agents"), join(".flixa", "agents")] as const;
const MAX_AGENT_FILE_BYTES = 64 * 1024;
const MAX_DEFINITIONS = 100;
const MAX_DESCRIPTION_CHARS = 200;
const NAME_PATTERN = /^[A-Za-z0-9][\w-]*$/;

const BUILTIN_DEFINITIONS: readonly SubagentDefinition[] = [
  {
    name: "general-purpose",
    description:
      "General-purpose agent for researching complex questions, searching code and executing multi-step tasks.",
    systemPrompt: [
      "You are a general-purpose sub-agent working on one focused task for a calling agent.",
      "Search the codebase and the web as needed, follow the task instructions exactly, and stay on scope.",
      "Prefer verifying assumptions against the real files instead of guessing.",
      "Your tool calls are not visible to the caller, so finish with a concise final report containing",
      "the answer, the evidence (file paths and line references), and any open questions.",
    ].join(" "),
    tools: null,
    source: "builtin",
  },
  {
    name: "explore",
    description:
      "Fast read-only agent for finding files, searching code and answering questions about the codebase. Cannot modify anything.",
    systemPrompt: [
      "You are a read-only exploration sub-agent. You cannot modify anything, so never attempt to write,",
      "edit, or run state-changing commands.",
      "Search efficiently, then answer the caller's question directly.",
      "Report findings as concrete file paths (with line numbers when useful) plus a short explanation of",
      "what each location contains, and note anything you could not find.",
    ].join(" "),
    tools: ["Read", "Grep", "Glob", "GitStatus", "GitDiff", "WebFetch", "TodoWrite"],
    source: "builtin",
  },
];

/**
 * Loads sub-agent definitions from `.claude/agents` and `.flixa/agents`.
 * User-level definitions load first, then project directories from the filesystem
 * root down to `workspaceRoot`, so nearer definitions override earlier ones with the
 * same name (case-insensitive). Built-in definitions are overridden by same-named files.
 */
export function loadSubagents(workspaceRoot: string): SubagentDefinition[] {
  const loaded = new Map<string, SubagentDefinition>();
  const seenDirs = new Set<string>();

  const collect = (directory: string, source: SubagentDefinition["source"]): void => {
    const resolved = resolve(directory);
    if (seenDirs.has(resolved) || !isDirectory(resolved)) {
      return;
    }
    seenDirs.add(resolved);

    for (const definition of readAgentDirectory(resolved, source)) {
      loaded.set(definition.name.toLowerCase(), definition);
    }
  };

  for (const dirName of AGENT_DIR_NAMES) {
    collect(join(homedir(), dirName), "user");
  }

  const ancestors: string[] = [];
  let current = resolve(workspaceRoot);
  while (true) {
    ancestors.push(current);
    const parent = dirname(current);
    if (parent === current || current === parse(current).root) {
      break;
    }
    current = parent;
  }
  for (const directory of ancestors.reverse()) {
    for (const dirName of AGENT_DIR_NAMES) {
      collect(join(directory, dirName), "project");
    }
  }

  const byName = new Map<string, SubagentDefinition>();
  for (const builtin of BUILTIN_DEFINITIONS) {
    byName.set(builtin.name.toLowerCase(), builtin);
  }

  const candidates = [...loaded.values()].sort((left, right) =>
    left.name.localeCompare(right.name),
  );
  for (const definition of candidates) {
    if (byName.size >= MAX_DEFINITIONS) {
      break;
    }
    byName.set(definition.name.toLowerCase(), definition);
  }

  return [...byName.values()].sort((left, right) => left.name.localeCompare(right.name));
}

/** Looks up a sub-agent definition by name, ignoring case. */
export function findSubagent(
  list: readonly SubagentDefinition[],
  name: string,
): SubagentDefinition | undefined {
  const wanted = name.trim().toLowerCase();
  return list.find((definition) => definition.name.toLowerCase() === wanted);
}

/**
 * Resolves the tool names a sub-agent may use. `null` tools means every available tool.
 * Listed tools are matched exactly (case-sensitive, after trimming) against `allToolNames`;
 * `Task` is always removed so sub-agents cannot spawn other sub-agents.
 */
export function resolveSubagentTools(
  def: SubagentDefinition,
  allToolNames: readonly string[],
): string[] {
  const available = new Set(allToolNames);
  const resolved: string[] = [];

  const requested = def.tools ?? allToolNames;
  for (const rawName of requested) {
    const name = typeof rawName === "string" ? rawName.trim() : "";
    if (!name || name === "Task" || !available.has(name)) {
      continue;
    }
    if (!resolved.includes(name)) {
      resolved.push(name);
    }
  }

  return resolved;
}

/** Renders the sub-agent catalogue for inclusion in a Task tool description. */
export function formatSubagentListForPrompt(list: readonly SubagentDefinition[]): string {
  const lines = ["Available subagent types for the Task tool:"];
  for (const definition of list) {
    const description = truncate(definition.description.trim(), MAX_DESCRIPTION_CHARS);
    const suffix = definition.tools ? ` (tools: ${definition.tools.join(", ")})` : "";
    lines.push(`- ${definition.name}: ${description}${suffix}`);
  }
  return lines.join("\n");
}

function readAgentDirectory(
  directory: string,
  source: SubagentDefinition["source"],
): SubagentDefinition[] {
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }

  const definitions: SubagentDefinition[] = [];
  for (const entry of entries) {
    // Dirent.isFile()/isDirectory() are false for symlinks, so links are skipped.
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".md")) {
      continue;
    }

    const baseName = entry.name.slice(0, -".md".length);
    const definition = readAgentFile(join(directory, entry.name), baseName, source);
    if (definition) {
      definitions.push(definition);
    }
  }

  return definitions;
}

function readAgentFile(
  filePath: string,
  baseName: string,
  source: SubagentDefinition["source"],
): SubagentDefinition | null {
  try {
    if (statSync(filePath).size > MAX_AGENT_FILE_BYTES) {
      return null;
    }

    const { meta, body } = parseFrontmatter(readFileSync(filePath, "utf-8"));
    const systemPrompt = body.trim();
    if (!systemPrompt) {
      return null;
    }

    const description = meta["description"]?.trim() ?? "";
    if (!description) {
      return null;
    }

    const declaredName = meta["name"]?.trim() ?? "";
    const name = declaredName || baseName;
    if (!NAME_PATTERN.test(name)) {
      return null;
    }

    const model = meta["model"]?.trim() ?? "";
    const definition: SubagentDefinition = {
      name,
      description,
      systemPrompt,
      tools: parseTools(meta["tools"]),
      source,
    };
    if (model) {
      definition.model = model;
    }

    return definition;
  } catch {
    return null;
  }
}

function parseFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
  const text = raw.replace(/^\uFEFF/, "");
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

function parseTools(raw: string | undefined): string[] | null {
  if (raw === undefined) {
    return null;
  }

  const tools = raw
    .split(",")
    .map((tool) => tool.trim())
    .filter((tool) => tool.length > 0);

  return tools.length > 0 ? tools : null;
}

function truncate(text: string, maxChars: number): string {
  return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text;
}

function isDirectory(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isDirectory();
  } catch {
    return false;
  }
}
