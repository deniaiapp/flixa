/**
 * Deterministic shell-command safety heuristics shared by every client.
 *
 * - `blocked`: never runs, in any approval mode (the CLI's guardrails, null bytes, length).
 * - `risky`: needs a human. Rejected without an AI review in AUTO_APPROVE (the Zed agent's
 *   "obviously unsafe" checks), prompts in SAFE_APPROVE / MANUAL_APPROVE, runs in ALL_APPROVE.
 * - `ok`: no rule matched; the approval mode decides.
 *
 * Where the CLI and the editor clients had overlapping rules, the stricter one is kept.
 */
export type CommandSafetyLevel = "blocked" | "risky" | "ok";

export interface CommandSafetyAssessment {
  level: CommandSafetyLevel;
  /** Kept for the CLI's existing callers: false only when blocked. */
  allowed: boolean;
  reason: string;
}

export const MAX_COMMAND_LENGTH = 5000;

const BLOCKED_COMMANDS: readonly { pattern: RegExp; reason: string }[] = [
  {
    // Any ordering/spelling of the recursive + force flags: -rf, -fr, -r -f, -Rf, --recursive --force.
    pattern:
      /(^|[;&|]\s*)(?:sudo\s+)?rm(?=\s)(?=[^;&|]*\s(?:-[a-z]*r[a-z]*|--recursive)(?:\s|$))(?=[^;&|]*\s(?:-[a-z]*f[a-z]*|--force)(?:\s|$))/i,
    reason: "recursive forced deletion is blocked",
  },
  {
    pattern: /\b(remove-item|ri)\b[^\r\n]*(?:-recurse|-r)\b[^\r\n]*(?:-force|-f)\b/i,
    reason: "recursive forced deletion is blocked",
  },
  {
    pattern: /\b(del|erase|rmdir)\b[^\r\n]*(?:\/s|\/q)\b/i,
    reason: "recursive or quiet deletion is blocked",
  },
  {
    pattern:
      /\bgit\s+(?:reset\s+--hard\b|clean\s+-[a-z]*f|checkout\s+--\s+\.(?=[\s;&|]|$)|restore\s+\.(?=[\s;&|]|$))/i,
    reason: "destructive git reset/clean/restore is blocked",
  },
  {
    // Anchored to command position so `git log --format=...` is not caught.
    pattern:
      /(^|[;&|]\s*)(?:format(?:\.com)?\s+[a-z]:|(?:diskpart|shutdown|restart-computer|format-volume)\b)/i,
    reason: "system-destructive commands are blocked",
  },
  {
    pattern:
      /\b(?:curl|wget|iwr|irm|invoke-webrequest|invoke-restmethod)\b[^\r\n]*\|\s*(?:sh|bash|zsh|pwsh|powershell|iex|invoke-expression)\b/i,
    reason: "piping downloaded code into a shell is blocked",
  },
  {
    pattern: /\bgit\s+push\b[^\r\n]*\s(?:--force(?:-with-lease)?|-f)\b/i,
    reason: "force-pushing is blocked",
  },
  {
    pattern: /\b(?:npm|pnpm|yarn|bun)\s+publish\b/i,
    reason: "publishing packages is blocked",
  },
];

const RISKY_COMMANDS: readonly { pattern: RegExp; reason: string }[] = [
  { pattern: /(^|[;&|])\s*rm\s+[^\n]*\/($|\s)/i, reason: "deleting a directory path" },
  { pattern: /(^|[;&|])\s*del\s+[^\n]*[a-z]:\\?($|\s)/i, reason: "deleting from a drive root" },
  { pattern: /(^|[;&|\s])sudo\s+/i, reason: "privilege escalation with sudo" },
];

export function assessCommandSafety(command: string): CommandSafetyAssessment {
  if (command.includes("\0")) {
    return blocked("commands containing null bytes are blocked");
  }
  if (command.length > MAX_COMMAND_LENGTH) {
    return blocked(`commands longer than ${MAX_COMMAND_LENGTH} characters are blocked`);
  }

  // A newline separates commands just like `;`, so the command-position patterns must see it.
  const normalized = command
    .replace(/\r\n|\r|\n/g, " ; ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) {
    return blocked("empty shell commands are blocked");
  }

  for (const candidate of BLOCKED_COMMANDS) {
    if (candidate.pattern.test(normalized)) {
      return blocked(candidate.reason);
    }
  }

  for (const candidate of RISKY_COMMANDS) {
    if (candidate.pattern.test(normalized)) {
      return { level: "risky", allowed: true, reason: candidate.reason };
    }
  }

  return { level: "ok", allowed: true, reason: "command passed deterministic safety checks" };
}

function blocked(reason: string): CommandSafetyAssessment {
  return { level: "blocked", allowed: false, reason };
}
