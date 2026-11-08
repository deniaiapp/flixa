import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, parse, resolve } from "node:path";
import { loadSkills, formatSkillsForPrompt } from "../skills/skills.ts";
import { formatSubagentListForPrompt, loadSubagents } from "../subagents/definitions.ts";

// Personal notes saved with `# note` / `/memory user`; loaded before repository files.
const USER_MEMORY_FILE = join(".flixa", "AGENTS.md");

const INSTRUCTION_CANDIDATES = ["CLAUDE.md", "AGENTS.md", join(".claude", "CLAUDE.md")] as const;

type LoadedInstructionFile = {
  path: string;
  content: string;
};

export function buildInstructionSystemPrompt(
  cwdValue: string,
  customSystemPrompt?: string,
  latestUserPrompt?: string,
): string | undefined {
  const parts: string[] = [];
  const instructionBlock = formatInstructionFiles(loadInstructionFiles(cwdValue));
  if (instructionBlock) {
    parts.push(instructionBlock);
  }

  const gitContextBlock = formatGitContext(cwdValue);
  if (gitContextBlock) {
    parts.push(gitContextBlock);
  }

  const skillsBlock = formatSkillsForPrompt(loadSkills(cwdValue));
  if (skillsBlock) {
    parts.push(skillsBlock);
  }

  const customSubagents = loadSubagents(cwdValue).filter((agent) => agent.source !== "builtin");
  if (customSubagents.length > 0) {
    parts.push(formatSubagentListForPrompt(loadSubagents(cwdValue)));
  }

  const commitWorkflowBlock = formatCommitWorkflowInstructions(latestUserPrompt);
  if (commitWorkflowBlock) {
    parts.push(commitWorkflowBlock);
  }

  const trimmedCustomPrompt = customSystemPrompt?.trim();
  if (trimmedCustomPrompt) {
    parts.push(trimmedCustomPrompt);
  }

  return parts.length > 0 ? parts.join("\n\n") : undefined;
}

export function loadInstructionFiles(cwdValue: string): LoadedInstructionFile[] {
  const root = resolve(cwdValue);
  const directories: string[] = [];
  let current = root;

  while (true) {
    directories.push(current);
    const parent = dirname(current);
    if (parent === current || current === parse(current).root) {
      break;
    }
    current = parent;
  }

  const loaded: LoadedInstructionFile[] = [];
  const seen = new Set<string>();

  // Loaded first so repository files stay "more specific" and win.
  const userMemoryPath = resolve(homedir(), USER_MEMORY_FILE);
  try {
    const userMemory = existsSync(userMemoryPath)
      ? readFileSync(userMemoryPath, "utf-8").trim()
      : "";
    if (userMemory) {
      seen.add(userMemoryPath);
      loaded.push({ path: userMemoryPath, content: userMemory });
    }
  } catch {
    // An unreadable personal file must not break the session.
  }

  for (const directory of directories.reverse()) {
    for (const candidate of INSTRUCTION_CANDIDATES) {
      const filePath = join(directory, candidate);
      const normalizedPath = resolve(filePath);
      if (seen.has(normalizedPath) || !existsSync(normalizedPath)) {
        continue;
      }

      try {
        const content = readFileSync(normalizedPath, "utf-8").trim();
        if (!content) {
          continue;
        }

        seen.add(normalizedPath);
        loaded.push({
          path: normalizedPath,
          content,
        });
      } catch {
        continue;
      }
    }
  }

  return loaded;
}

function formatInstructionFiles(files: readonly LoadedInstructionFile[]): string | undefined {
  if (files.length === 0) {
    return undefined;
  }

  return [
    "The following repository instruction files were loaded from the current directory hierarchy. Apply them in order, with later files being more specific.",
    ...files.map((file) => `\n[Instructions: ${file.path}]\n${file.content}`),
  ].join("\n");
}

function formatGitContext(cwdValue: string): string | undefined {
  const repoRoot = readGitOutput(cwdValue, ["rev-parse", "--show-toplevel"]);
  if (!repoRoot) {
    return undefined;
  }

  const branch = readGitOutput(cwdValue, ["branch", "--show-current"]) || "(detached HEAD)";
  const status = truncateForPrompt(
    readGitOutput(cwdValue, ["status", "--short"]) || "(clean)",
    2_000,
  );
  const recentCommits = truncateForPrompt(
    readGitOutput(cwdValue, ["log", "--oneline", "-5"]) || "(no commits yet)",
    2_000,
  );

  return [
    "The following git snapshot was captured at the start of this turn. It may become stale after tool calls; run fresh git commands before acting on it if you need exact current state.",
    `Repository root: ${repoRoot}`,
    `Current branch: ${branch}`,
    `Git status (\`git status --short\`):\n${status}`,
    `Recent commits (\`git log --oneline -5\`):\n${recentCommits}`,
  ].join("\n\n");
}

function formatCommitWorkflowInstructions(latestUserPrompt?: string): string | undefined {
  if (!looksLikeCommitRequest(latestUserPrompt)) {
    return undefined;
  }

  return [
    "Commit workflow guidance for this turn:",
    "- Before creating any commit, inspect the current state with `git status --short`.",
    "- Review the actual changes with `git diff --staged`; if nothing is staged yet, also inspect `git diff` before deciding what to commit.",
    "- Read `git log --oneline -10` before writing the commit message so the message matches the repository's existing style.",
    "- Stage only the files relevant to the requested change. Avoid broad staging commands such as `git add -A` or `git add .` unless the user explicitly asked to commit every current change.",
    "- Never use placeholder commit messages like `commit`, `update`, or `changes`.",
    "- Do not use `git commit --amend` and do not skip hooks unless the user explicitly requests it.",
    "- If there is nothing meaningful to commit, explain that instead of creating an empty commit.",
    "- After committing, run `git status --short` to confirm the resulting worktree state.",
  ].join("\n");
}

function looksLikeCommitRequest(prompt?: string): boolean {
  const normalized = prompt?.trim();
  if (!normalized) {
    return false;
  }

  return /\bgit\s+commit\b|\bcommit(?:ting|ted|s)?\b|コミット/i.test(normalized);
}

function readGitOutput(cwdValue: string, args: string[]): string | undefined {
  try {
    const output = execFileSync("git", args, {
      cwd: resolve(cwdValue),
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return output || undefined;
  } catch {
    return undefined;
  }
}

function truncateForPrompt(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength).trimEnd()}\n...truncated...`;
}
