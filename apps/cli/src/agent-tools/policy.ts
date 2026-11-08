export interface CommandSafetyAssessment {
  allowed: boolean;
  reason: string;
}

/**
 * A deliberately small, deterministic guardrail for commands that are too
 * destructive or have an external side effect to be inferred safe from a
 * model-generated reason alone. User approval and auto-mode review still sit
 * on top of this policy.
 */
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
    pattern: /\bgit\s+(?:reset\s+--hard|clean\s+-[a-z]*f|checkout\s+--\s+\.|restore\s+\.)\b/i,
    reason: "destructive git reset/clean/restore is blocked",
  },
  {
    // Anchored to command position so `git log --format=...` is not caught.
    pattern:
      /(^|[;&|]\s*)(?:format(?:\.com)?\s+[a-z]:|(?:diskpart|shutdown|restart-computer|format-volume)\b)/i,
    reason: "system-destructive commands are blocked",
  },
  {
    pattern: /(?:curl|wget|invoke-webrequest)\b[^\r\n]*\|\s*(?:sh|bash|zsh|pwsh|powershell|iex)\b/i,
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

export function assessCommandSafety(command: string): CommandSafetyAssessment {
  // A newline separates commands just like `;`, so the command-position patterns must see it.
  const normalized = command
    .replace(/\r\n|\r|\n/g, " ; ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) {
    return {
      allowed: false,
      reason: "empty shell commands are blocked",
    };
  }

  for (const candidate of BLOCKED_COMMANDS) {
    if (candidate.pattern.test(normalized)) {
      return { allowed: false, reason: candidate.reason };
    }
  }

  return { allowed: true, reason: "command passed deterministic safety checks" };
}
