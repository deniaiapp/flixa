import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { homedir } from "node:os";

const MAX_GIT_OUTPUT_CHARS = 12_000;
// Larger than the kept output: exceeding maxBuffer kills git and would look like "not a repository".
const MAX_GIT_BUFFER_BYTES = 32 * 1024 * 1024;
const MAX_FINAL_TEXT_CHARS = 4_000;

export interface GitSnapshot {
  isRepository: boolean;
  branch: string;
  status: string[];
  diffStat: string;
  changedFiles: string[];
}

export interface VerificationEvidence {
  command: string;
  exitCode: number | null;
  timedOut: boolean;
  stdout?: string;
  stderr?: string;
}

export interface ShareCardInput {
  workspaceRoot: string;
  prompt: string;
  rerunPrompt?: string;
  provider: string;
  model: string;
  finalText: string;
  startedAt: string;
  endedAt: string;
  sessionId?: string;
  planMode?: boolean;
  verification?: VerificationEvidence;
}

export interface ClipboardCopyResult {
  copied: boolean;
  method?: string;
  reason?: string;
}

export interface ShareUrlResult {
  url?: string;
  method?: string;
  reason?: string;
}

export function copyToClipboard(value: string): ClipboardCopyResult {
  const candidates =
    process.platform === "win32"
      ? [
          {
            command: "pwsh",
            args: [
              "-NoLogo",
              "-NoProfile",
              "-NonInteractive",
              "-Command",
              "$value = [Console]::In.ReadToEnd(); Set-Clipboard -Value $value",
            ],
            method: "PowerShell clipboard",
          },
          {
            command: "powershell",
            args: [
              "-NoLogo",
              "-NoProfile",
              "-NonInteractive",
              "-Command",
              "$value = [Console]::In.ReadToEnd(); Set-Clipboard -Value $value",
            ],
            method: "PowerShell clipboard",
          },
        ]
      : process.platform === "darwin"
        ? [
            {
              command: "pbcopy",
              args: [],
              method: "pbcopy",
            },
          ]
        : [
            { command: "wl-copy", args: [], method: "wl-copy" },
            {
              command: "xclip",
              args: ["-selection", "clipboard"],
              method: "xclip",
            },
            {
              command: "xsel",
              args: ["--clipboard", "--input"],
              method: "xsel",
            },
          ];

  let lastReason = "No supported clipboard command was found.";
  for (const candidate of candidates) {
    try {
      const result = spawnSync(candidate.command, candidate.args, {
        input: value,
        encoding: "utf-8",
        windowsHide: true,
        timeout: 2_000,
        stdio: ["pipe", "ignore", "pipe"],
      });
      if (result.status === 0 && !result.error) {
        return { copied: true, method: candidate.method };
      }

      const errorOutput = typeof result.stderr === "string" ? result.stderr.trim() : "";
      lastReason =
        errorOutput || `${candidate.command} exited with status ${result.status ?? "unknown"}.`;
    } catch (error) {
      lastReason = error instanceof Error ? error.message : String(error);
    }
  }

  return { copied: false, reason: lastReason };
}

export async function publishShareCard(card: string): Promise<ShareUrlResult> {
  const endpoint = (
    process.env.FLIXA_SHARE_ENDPOINT || "https://share.flixa.engineer/api/cards"
  ).replace(/\/$/, "");
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: AbortSignal.timeout(15_000),
      body: JSON.stringify({ card, visibility: "unlisted" }),
    });
    const payload = (await response.json().catch(() => null)) as unknown;
    if (!response.ok) {
      const detail =
        isRecord(payload) && typeof payload.error === "string"
          ? payload.error
          : "The Share service rejected the card.";
      return { reason: `${detail} (${response.status})` };
    }
    if (!isRecord(payload) || typeof payload.url !== "string") {
      return { reason: "The Share service did not return a card URL." };
    }
    return { url: payload.url, method: "Flixa Share" };
  } catch (error) {
    return {
      reason:
        error instanceof Error
          ? `Could not reach Flixa Share: ${error.message}`
          : `Could not reach Flixa Share: ${String(error)}`,
    };
  }
}

export function readGitSnapshot(workspaceRoot: string): GitSnapshot {
  const statusResult = runGit(workspaceRoot, ["status", "--short", "--branch"]);
  if (statusResult.exitCode !== 0) {
    return {
      isRepository: false,
      branch: "(not a git repository)",
      status: [],
      diffStat: "(unavailable)",
      changedFiles: [],
    };
  }

  const statusLines = statusResult.stdout
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean);
  const branchLine = statusLines.find((line) => line.startsWith("## ")) ?? "## detached";
  const branch = branchLine.slice(3).trim() || "detached";
  const status = statusLines.filter((line) => !line.startsWith("## "));
  const changedFiles = unique(
    status
      .map((line) => line.slice(3).trim())
      .filter(Boolean)
      .map((line) => (line.includes(" -> ") ? line.slice(line.lastIndexOf(" -> ") + 4) : line)),
  );

  const diffResult = runGit(workspaceRoot, ["diff", "--no-ext-diff", "--stat", "HEAD"]);
  const fallbackDiffResult =
    diffResult.exitCode === 0
      ? diffResult
      : runGit(workspaceRoot, ["diff", "--no-ext-diff", "--stat"]);

  return {
    isRepository: true,
    branch,
    status,
    diffStat: fallbackDiffResult.stdout.trim() || "(no tracked diff)",
    changedFiles,
  };
}

export function formatGitSnapshot(snapshot: GitSnapshot): string {
  if (!snapshot.isRepository) {
    return "Git is not available in this workspace.";
  }

  return [
    `branch: ${snapshot.branch}`,
    snapshot.status.length > 0
      ? `status:\n${snapshot.status.map((line) => `  ${line}`).join("\n")}`
      : "status: clean",
    `diff:\n${snapshot.diffStat}`,
  ].join("\n");
}

export function buildShareCard(input: ShareCardInput): string {
  const workspaceRoot = resolve(input.workspaceRoot);
  const snapshot = readGitSnapshot(workspaceRoot);
  const duration = formatDuration(input.startedAt, input.endedAt);
  const verificationFailed =
    input.verification && (input.verification.timedOut || input.verification.exitCode !== 0);
  const resultLabel = input.planMode
    ? "PLAN READY"
    : verificationFailed
      ? "NOT SHIPPED"
      : "SHIPPED";
  const changedFiles = snapshot.changedFiles.length
    ? snapshot.changedFiles
        .map((file) => `- \`${redactShareText(file, workspaceRoot)}\``)
        .join("\n")
    : "- (no changed files detected)";
  const verification = input.verification
    ? formatVerification(input.verification, workspaceRoot)
    : "Not supplied; see the agent transcript for verification details.";
  const summary = compactText(extractShareSummary(input.finalText), MAX_FINAL_TEXT_CHARS);
  const rerunPrompt = redactShareText(input.rerunPrompt ?? input.prompt, workspaceRoot);

  return [
    "# ⚡ Flixa Ship Card",
    "",
    `> ${redactShareText(input.prompt, workspaceRoot)}`,
    "",
    `**${resultLabel}** · ${redactShareText(input.provider, workspaceRoot)} / ${redactShareText(input.model, workspaceRoot)} · ${duration}`,
    "",
    "## Evidence",
    "",
    `- Branch: \`${redactShareText(snapshot.branch, workspaceRoot)}\``,
    `- Changed files: ${snapshot.changedFiles.length}`,
    `- Verification: ${verification}`,
    "",
    "### Files",
    "",
    changedFiles,
    "",
    "### Diff stat",
    "",
    "```text",
    redactShareText(snapshot.diffStat, workspaceRoot),
    "```",
    "",
    "## Result",
    "",
    redactShareText(summary, workspaceRoot) || "(the agent returned no summary)",
    "",
    "## Try this task with Flixa",
    "",
    `[Try this task with Flixa](https://github.com/deniaiapp/flixa-cli)`,
    "",
    "```sh",
    `npx @deniai/flixa@canary ship ${shellQuote(rerunPrompt)} --share-url`,
    "```",
    "",
    "---",
    `Generated by Flixa Ship · session ${input.sessionId ? input.sessionId.slice(0, 8) : "one-shot"}`,
  ].join("\n");
}

/** Single-quotes a value for POSIX shells so `$`, backticks and `\` stay literal. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function writeShareCard(card: string, outputPath: string, workspaceRoot: string): string {
  const resolvedPath = isAbsolute(outputPath)
    ? resolve(outputPath)
    : resolve(workspaceRoot, outputPath);
  const parent = dirname(resolvedPath);
  if (!existsSync(parent)) {
    mkdirSync(parent, { recursive: true });
  }
  writeFileSync(resolvedPath, `${card}\n`, "utf-8");
  return resolvedPath;
}

function formatVerification(evidence: VerificationEvidence, workspaceRoot: string): string {
  if (evidence.timedOut) {
    return `⚠️ timed out: \`${redactShareText(evidence.command, workspaceRoot)}\``;
  }

  const icon = evidence.exitCode === 0 ? "✅" : "❌";
  return `${icon} \`${redactShareText(evidence.command, workspaceRoot)}\` (exit ${evidence.exitCode ?? "unknown"})`;
}

function runGit(
  workspaceRoot: string,
  args: string[],
): { stdout: string; stderr: string; exitCode: number | null } {
  try {
    const result = spawnSync("git", args, {
      cwd: workspaceRoot,
      encoding: "utf-8",
      windowsHide: true,
      maxBuffer: MAX_GIT_BUFFER_BYTES,
    });
    return {
      stdout: truncate(result.stdout ?? ""),
      stderr: truncate(result.stderr ?? ""),
      exitCode: result.status,
    };
  } catch (error) {
    return {
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
      exitCode: null,
    };
  }
}

function redactShareText(value: string, workspaceRoot: string): string {
  const normalizedRoot = resolve(workspaceRoot);
  const relativeRoot = relative(process.cwd(), normalizedRoot);
  let redacted = value
    .replaceAll(normalizedRoot, ".")
    .replaceAll(normalizedRoot.replace(/\\/g, "/"), ".");

  if (relativeRoot && relativeRoot !== ".") {
    redacted = redacted.replaceAll(relativeRoot, ".");
  }

  const home = homedir();
  if (home.length > 1) {
    redacted = redacted.replaceAll(home, "~").replaceAll(home.replace(/\\/g, "/"), "~");
  }

  return redacted
    .replace(
      /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
      "[redacted-private-key]",
    )
    .replace(/Bearer\s+[^\s)]+/gi, "Bearer [redacted]")
    .replace(
      /\b(?:deni_[A-Za-z0-9_-]{8,}|(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})/g,
      "[redacted-key]",
    )
    .replace(/((?:api[_-]?key|token|secret|password)\s*[:=]\s*)([^\s,;]+)/gi, "$1[redacted]");
}

function compactText(value: string, maxLength: number): string {
  const normalized = value.trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 24).trimEnd()}\n\n…(truncated for sharing)…`;
}

function extractShareSummary(value: string): string {
  const normalized = value.trim();
  if (!normalized) {
    return "";
  }

  const summaryHeading = /(?:^|\r?\n)(?:#{1,6}\s*)?Summary\s*:?\s*\r?\n/i;
  const headingMatch = summaryHeading.exec(normalized);
  const summary = headingMatch
    ? normalized.slice(headingMatch.index + headingMatch[0].length)
    : normalized;
  const nextSection = summary.search(
    /\r?\n(?:#{1,6}\s*)?(?:Files changed|Verification|Follow-up)\s*:?\s*(?:\r?\n|$)/i,
  );
  const section = nextSection >= 0 ? summary.slice(0, nextSection) : summary;

  return section.replace(/```[\s\S]*?```/g, "[code omitted from share card]").trim();
}

function truncate(value: string): string {
  return value.length <= MAX_GIT_OUTPUT_CHARS
    ? value
    : `${value.slice(0, MAX_GIT_OUTPUT_CHARS)}\n…(truncated)…`;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function formatDuration(startedAt: string, endedAt: string): string {
  const start = Date.parse(startedAt);
  const end = Date.parse(endedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
    return "duration unknown";
  }

  const seconds = Math.max(0, Math.round((end - start) / 1000));
  if (seconds < 60) {
    return `${seconds}s`;
  }
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}
