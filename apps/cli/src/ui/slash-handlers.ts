import { relative } from "node:path";
import { getCheckpointStore } from "../agent-tools/tools.ts";
import type { ChatMessage } from "../flixa/api.ts";
import { exportConversationMarkdown, resolveExportPath, writeExport } from "../export/markdown.ts";
import { HOOK_EVENTS, loadHooks } from "../hooks/hooks.ts";
import { appendMemory, getMemoryFilePath, readMemoryNotes } from "../memory/memory.ts";
import { TRUST_PROJECT_SETTINGS_ENV, loadPermissionRules } from "../permissions/rules.ts";
import { loadSkills } from "../skills/skills.ts";
import { loadSubagents } from "../subagents/definitions.ts";

// Text builders for the informational slash commands. They return plain strings so the
// chat UI only has to append them as system messages.

const MAX_MEMORY_PREVIEW_LINES = 30;

export function runMemoryCommand(args: string, workspaceRoot: string): string {
  const trimmed = args.trim();
  if (!trimmed) {
    return (["project", "user"] as const)
      .map((scope) => {
        const path = getMemoryFilePath(workspaceRoot, scope);
        const notes = readMemoryNotes(workspaceRoot, scope).trim();
        const preview = notes
          ? notes.split(/\r?\n/).slice(0, MAX_MEMORY_PREVIEW_LINES).join("\n")
          : "(empty)";
        return `${scope}: ${path}\n${preview}`;
      })
      .concat("Add a note with `# your note`, or `/memory user <note>` for a personal note.")
      .join("\n\n");
  }

  const [scopeWord = "", ...rest] = trimmed.split(/\s+/);
  const note = rest.join(" ");
  if ((scopeWord === "user" || scopeWord === "project") && note) {
    try {
      const saved = appendMemory(workspaceRoot, scopeWord, note);
      return `Saved to ${saved.path}`;
    } catch (error) {
      return `Could not save note: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  return "Usage: /memory | /memory project <note> | /memory user <note>";
}

export function runRewindCommand(args: string, workspaceRoot: string): string {
  const store = getCheckpointStore(workspaceRoot);
  const trimmed = args.trim();

  if (trimmed === "list") {
    const turns = store.listTurns();
    if (turns.length === 0) {
      return "No file edits recorded in this session.";
    }
    return [
      "Turns with file edits (oldest first):",
      ...turns.map(
        (turn, position) => `  ${position + 1}. ${turn.label} -> ${turn.files.join(", ")}`,
      ),
    ].join("\n");
  }

  const steps = trimmed ? Number.parseInt(trimmed, 10) : 1;
  if (!Number.isFinite(steps) || steps < 1) {
    return "Usage: /rewind [turns] | /rewind list";
  }

  const result = store.rewind(steps);
  if (result.turnsRewound === 0) {
    return "Nothing to rewind: no file edits were recorded in this session.";
  }

  return [
    `Rewound ${result.turnsRewound} turn(s) of file edits.`,
    ...(result.restored.length > 0 ? [`restored: ${result.restored.join(", ")}`] : []),
    ...(result.deleted.length > 0 ? [`deleted: ${result.deleted.join(", ")}`] : []),
    ...(result.skipped.length > 0 ? [`skipped: ${result.skipped.join(", ")}`] : []),
    "Only files were rolled back; the conversation itself is unchanged.",
  ].join("\n");
}

export function runExportCommand(
  args: string,
  workspaceRoot: string,
  session: { id: string; model: string; provider?: string; cwd: string; createdAt: string },
  history: readonly ChatMessage[],
): string {
  if (history.length === 0) {
    return "Nothing to export yet.";
  }

  try {
    const path = resolveExportPath(workspaceRoot, args.trim() || undefined, session.id);
    writeExport(
      path,
      exportConversationMarkdown(
        {
          sessionId: session.id,
          model: session.model,
          provider: session.provider,
          cwd: session.cwd,
          createdAt: session.createdAt,
        },
        history,
      ),
    );
    return `Conversation exported to ${relative(workspaceRoot, path) || path}`;
  } catch (error) {
    return `Export failed: ${error instanceof Error ? error.message : String(error)}`;
  }
}

export function formatAgentsList(workspaceRoot: string): string {
  const agents = loadSubagents(workspaceRoot);
  return [
    "Sub-agents (the model starts them with the Task tool):",
    ...agents.map((agent) => {
      const tools = agent.tools ? ` [tools: ${agent.tools.join(", ")}]` : "";
      return `  ${agent.name} (${agent.source})  ${agent.description}${tools}`;
    }),
    "Add your own as Markdown files in .claude/agents/ or .flixa/agents/.",
  ].join("\n");
}

export function formatSkillsList(workspaceRoot: string): string {
  const skills = loadSkills(workspaceRoot);
  if (skills.length === 0) {
    return "No skills found. Add .claude/skills/<name>/SKILL.md or .flixa/skills/<name>/SKILL.md.";
  }

  return [
    "Skills (the model loads one with the Skill tool when the task matches):",
    ...skills.map((skill) => `  ${skill.name} (${skill.scope})  ${skill.description}`),
  ].join("\n");
}

export function formatPermissionsReport(workspaceRoot: string): string {
  const rules = loadPermissionRules(workspaceRoot);
  const section = (label: string, values: readonly string[]): string[] =>
    values.length > 0
      ? [`${label}:`, ...values.map((value) => `  ${value}`)]
      : [`${label}: (none)`];

  return [
    ...section("allow", rules.allow),
    ...section("ask", rules.ask),
    ...section("deny", rules.deny),
    process.env[TRUST_PROJECT_SETTINGS_ENV] === "1"
      ? "Project-level allow rules are trusted (FLIXA_TRUST_PROJECT_SETTINGS=1)."
      : `Project-level allow rules are ignored; set ${TRUST_PROJECT_SETTINGS_ENV}=1 to trust them. Project deny/ask rules always apply.`,
    "Rules go in settings.json under permissions.allow / ask / deny, e.g. Bash(pnpm test:*), Read(src/**), WebFetch(domain:docs.example.com).",
  ].join("\n");
}

export function formatHooksReport(workspaceRoot: string): string {
  const registry = loadHooks(workspaceRoot);
  if (registry.isEmpty()) {
    return [
      "No hooks configured.",
      "Add a hooks section to ~/.flixa/settings.json (PreToolUse, PostToolUse, UserPromptSubmit, Stop).",
      "Project-level hooks run only when FLIXA_TRUST_PROJECT_HOOKS=1.",
    ].join("\n");
  }

  return HOOK_EVENTS.flatMap((event) => {
    const entries = registry.hooks[event];
    if (entries.length === 0) {
      return [];
    }
    return [
      `${event}:`,
      ...entries.map(
        (entry) =>
          `  ${entry.matcher ? `[${entry.matcher}] ` : ""}${entry.command}  (${entry.source})`,
      ),
    ];
  }).join("\n");
}
