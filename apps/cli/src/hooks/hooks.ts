import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Claude Code style lifecycle hooks.
 *
 * Hooks execute arbitrary shell commands, so a freshly cloned repository must
 * never be able to run code just by being opened. Only user-level settings are
 * trusted by default; project-level settings load only when the operator opts in
 * with `FLIXA_TRUST_PROJECT_HOOKS=1`.
 */

export type HookEvent = "PreToolUse" | "PostToolUse" | "UserPromptSubmit" | "Stop";

export const HOOK_EVENTS: readonly HookEvent[] = [
  "PreToolUse",
  "PostToolUse",
  "UserPromptSubmit",
  "Stop",
];

export interface HookEntry {
  /** Regex tested against the tool name. Undefined means "match everything". */
  matcher?: string;
  command: string;
  timeoutSeconds: number;
  /** Settings file the entry was loaded from. */
  source: string;
}

export interface HookRegistry {
  hooks: Record<HookEvent, HookEntry[]>;
  isEmpty(): boolean;
}

export interface HookInput {
  event: HookEvent;
  cwd: string;
  sessionId?: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolOutput?: string;
  prompt?: string;
}

export interface HookOutcome {
  blocked: boolean;
  reason?: string;
  messages: string[];
}

const DEFAULT_TIMEOUT_SECONDS = 60;
const MAX_TIMEOUT_SECONDS = 600;
const MIN_TIMEOUT_SECONDS = 1;
const MAX_CAPTURE_CHARS = 16_000;
const MAX_SETTINGS_FILE_BYTES = 256 * 1024;
const MAX_DETAIL_CHARS = 200;
/** Grace period after a kill before we give up waiting for the child to close. */
const KILL_GRACE_MS = 2_000;
const TRUST_PROJECT_HOOKS_ENV = "FLIXA_TRUST_PROJECT_HOOKS";
/**
 * Windows PowerShell reports exit code 1 for *any* failing native command, so a
 * hook that exits with 2 would look like a generic failure. Re-exiting with
 * $LASTEXITCODE preserves the real code; the guard keeps pure-PowerShell hooks
 * (which never set it) working.
 */
const WINDOWS_EXIT_CODE_FORWARDER = "\nif ($null -ne $LASTEXITCODE) { exit $LASTEXITCODE }";
const SETTINGS_DIR_NAMES = [".claude", ".flixa"] as const;
const USER_SETTINGS_FILES = ["settings.json"] as const;
const PROJECT_SETTINGS_FILES = ["settings.json", "settings.local.json"] as const;

let cachedWindowsShellExecutable: string | null = null;

/**
 * Reads hook definitions from user-level settings, plus project-level settings
 * when project hooks are explicitly trusted. Missing or invalid files are
 * ignored silently; entries from every loaded file are concatenated.
 */
export function loadHooks(workspaceRoot: string): HookRegistry {
  const hooks: Record<HookEvent, HookEntry[]> = {
    PreToolUse: [],
    PostToolUse: [],
    UserPromptSubmit: [],
    Stop: [],
  };

  for (const filePath of getSettingsFiles(workspaceRoot)) {
    appendHooksFromFile(hooks, filePath);
  }

  return {
    hooks,
    isEmpty: () => HOOK_EVENTS.every((event) => hooks[event].length === 0),
  };
}

/** True when the registry contains at least one hook for `event`. */
export function hasHooks(registry: HookRegistry, event: HookEvent): boolean {
  return (registry.hooks[event]?.length ?? 0) > 0;
}

/**
 * Runs matching hooks for `input.event` sequentially, feeding each command a
 * JSON document on stdin. Exit code 2 blocks and stops the chain; every other
 * failure is reported as a non-blocking message.
 */
export async function runHooks(
  registry: HookRegistry,
  input: HookInput,
  options: { signal?: AbortSignal } = {},
): Promise<HookOutcome> {
  const outcome: HookOutcome = { blocked: false, messages: [] };
  const signal = options.signal;

  const selected = (registry.hooks[input.event] ?? []).filter((hook) =>
    matchesToolName(hook.matcher, input.toolName),
  );
  if (selected.length === 0) {
    return outcome;
  }

  const payload = buildHookPayload(input);

  for (const hook of selected) {
    if (signal?.aborted) {
      outcome.messages.push("hook cancelled (aborted)");
      break;
    }

    const result = await runHookCommand(hook, payload, input.cwd, signal);

    if (result.spawnError !== undefined) {
      outcome.messages.push(`hook failed (spawn error): ${clipDetail(result.spawnError)}`);
      continue;
    }

    if (result.aborted) {
      outcome.messages.push("hook cancelled (aborted)");
      break;
    }

    if (result.timedOut) {
      outcome.messages.push(
        `hook failed (timeout after ${hook.timeoutSeconds}s): ${clipDetail(result.stderr || result.stdout)}`,
      );
      continue;
    }

    if (result.exitCode === 2) {
      outcome.blocked = true;
      outcome.reason = result.stderr.trim() || result.stdout.trim() || "Blocked by hook";
      break;
    }

    if (result.exitCode !== 0) {
      const exitLabel = result.exitCode === null ? "unknown" : String(result.exitCode);
      const detail = result.stderr.trim() ? result.stderr : result.stdout;
      outcome.messages.push(`hook failed (exit ${exitLabel}): ${clipDetail(detail)}`);
      continue;
    }

    const stdout = result.stdout.trim();
    if (stdout) {
      outcome.messages.push(stdout);
    }
  }

  return outcome;
}

function getSettingsFiles(workspaceRoot: string): string[] {
  const files: string[] = [];
  const home = homedir();

  for (const dirName of SETTINGS_DIR_NAMES) {
    for (const fileName of USER_SETTINGS_FILES) {
      files.push(join(home, dirName, fileName));
    }
  }

  if (process.env[TRUST_PROJECT_HOOKS_ENV] === "1") {
    for (const dirName of SETTINGS_DIR_NAMES) {
      for (const fileName of PROJECT_SETTINGS_FILES) {
        files.push(join(workspaceRoot, dirName, fileName));
      }
    }
  }

  // Avoid reading the same file twice when home and the workspace root coincide.
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const file of files) {
    const key = resolve(file);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(file);
  }

  return unique;
}

function appendHooksFromFile(hooks: Record<HookEvent, HookEntry[]>, filePath: string): void {
  const raw = readSettingsFile(filePath);
  if (raw === null) {
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return;
  }

  const hooksSection = asRecord(asRecord(parsed)?.["hooks"]);
  if (!hooksSection) {
    return;
  }

  for (const event of HOOK_EVENTS) {
    const groups = hooksSection[event];
    if (!Array.isArray(groups)) {
      continue;
    }

    for (const group of groups) {
      const groupRecord = asRecord(group);
      const commands = groupRecord?.["hooks"];
      if (!groupRecord || !Array.isArray(commands)) {
        continue;
      }

      const matcher = normalizeMatcher(groupRecord["matcher"]);
      for (const command of commands) {
        const commandRecord = asRecord(command);
        if (!commandRecord || commandRecord["type"] !== "command") {
          continue;
        }

        const commandText =
          typeof commandRecord["command"] === "string" ? commandRecord["command"].trim() : "";
        if (!commandText) {
          continue;
        }

        hooks[event].push({
          matcher,
          command: commandText,
          timeoutSeconds: normalizeTimeout(commandRecord["timeout"]),
          source: filePath,
        });
      }
    }
  }
}

function readSettingsFile(filePath: string): string | null {
  try {
    if (!existsSync(filePath) || statSync(filePath).size > MAX_SETTINGS_FILE_BYTES) {
      return null;
    }
    return readFileSync(filePath, "utf-8").replace(/^\uFEFF/, "");
  } catch {
    return null;
  }
}

function normalizeMatcher(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const matcher = value.trim();
  if (!matcher || matcher === "*") {
    return undefined;
  }

  return matcher;
}

function normalizeTimeout(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_TIMEOUT_SECONDS;
  }

  return Math.min(MAX_TIMEOUT_SECONDS, Math.max(MIN_TIMEOUT_SECONDS, Math.round(value)));
}

function matchesToolName(matcher: string | undefined, toolName: string | undefined): boolean {
  // Without a tool name (e.g. UserPromptSubmit/Stop) the matcher is ignored.
  if (matcher === undefined || toolName === undefined) {
    return true;
  }

  try {
    return new RegExp(`^(?:${matcher})$`).test(toolName);
  } catch {
    return false;
  }
}

function buildHookPayload(input: HookInput): string {
  const payload: Record<string, unknown> = {
    hook_event_name: input.event,
    cwd: input.cwd,
  };

  if (input.sessionId !== undefined) {
    payload["session_id"] = input.sessionId;
  }
  if (input.toolName !== undefined) {
    payload["tool_name"] = input.toolName;
  }
  if (input.toolInput !== undefined) {
    payload["tool_input"] = input.toolInput;
  }
  if (input.toolOutput !== undefined) {
    payload["tool_output"] = input.toolOutput;
  }
  if (input.prompt !== undefined) {
    payload["prompt"] = input.prompt;
  }

  return JSON.stringify(payload);
}

interface HookCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  aborted: boolean;
  spawnError?: string;
}

function runHookCommand(
  hook: HookEntry,
  payload: string,
  cwd: string,
  signal: AbortSignal | undefined,
): Promise<HookCommandResult> {
  if (signal?.aborted) {
    return Promise.resolve(emptyResult({ aborted: true }));
  }

  const { executable, executableArgs } = getShellInvocation(hook.command);

  return new Promise((resolvePromise) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(executable, executableArgs, {
        cwd,
        env: {
          ...process.env,
          FLIXA_PROJECT_DIR: cwd,
          CLAUDE_PROJECT_DIR: cwd,
        },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      resolvePromise(emptyResult({ spawnError: errorMessage(error) }));
      return;
    }

    let stdout = "";
    let stderr = "";
    let exitCode: number | null = null;
    let timedOut = false;
    let aborted = false;
    let settled = false;
    let graceTimer: NodeJS.Timeout | undefined;

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      killChild(child);
      graceTimer = setTimeout(() => finish(), KILL_GRACE_MS);
    }, hook.timeoutSeconds * 1000);

    const onAbort = (): void => {
      aborted = true;
      killChild(child);
      graceTimer ??= setTimeout(() => finish(), KILL_GRACE_MS);
    };

    const finish = (spawnError?: string): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutTimer);
      if (graceTimer) {
        clearTimeout(graceTimer);
      }
      signal?.removeEventListener("abort", onAbort);
      resolvePromise({
        stdout,
        stderr,
        exitCode,
        timedOut,
        aborted,
        ...(spawnError === undefined ? {} : { spawnError }),
      });
    };

    const append = (current: string, chunk: Buffer): string =>
      current.length >= MAX_CAPTURE_CHARS
        ? current
        : (current + chunk.toString("utf-8")).slice(0, MAX_CAPTURE_CHARS);

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout = append(stdout, chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = append(stderr, chunk);
    });

    // The child may exit before reading stdin; EPIPE must not crash the hook run.
    child.stdin?.on("error", () => {});
    try {
      child.stdin?.end(payload);
    } catch {
      // Ignore: a closed stdin pipe is handled by the exit code path.
    }

    child.on("error", (error) => {
      finish(errorMessage(error));
    });
    child.on("close", (code) => {
      exitCode = code;
      finish();
    });

    if (signal) {
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) {
        onAbort();
      }
    }
  });
}

function emptyResult(overrides: Partial<HookCommandResult>): HookCommandResult {
  return {
    stdout: "",
    stderr: "",
    exitCode: null,
    timedOut: false,
    aborted: false,
    ...overrides,
  };
}

function killChild(child: ReturnType<typeof spawn>): void {
  try {
    child.kill();
  } catch {
    // The process may already be gone.
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function clipDetail(value: string): string {
  const text = value.trim();
  return text.length > MAX_DETAIL_CHARS ? text.slice(0, MAX_DETAIL_CHARS) : text;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function getShellInvocation(command: string): {
  executable: string;
  executableArgs: string[];
} {
  if (process.platform === "win32") {
    return {
      executable: getWindowsShellExecutable(),
      // Windows PowerShell collapses any non-zero native exit code to 1, which
      // would hide a hook's `exit 2` block signal, so forward $LASTEXITCODE.
      executableArgs: ["-NoProfile", "-Command", `${command}${WINDOWS_EXIT_CODE_FORWARDER}`],
    };
  }

  return {
    executable: process.env["SHELL"] || "bash",
    executableArgs: ["-lc", command],
  };
}

function getWindowsShellExecutable(): string {
  if (cachedWindowsShellExecutable) {
    return cachedWindowsShellExecutable;
  }

  for (const candidate of ["pwsh", "powershell"]) {
    const result = spawnSync(
      candidate,
      ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.Major"],
      {
        stdio: ["ignore", "pipe", "ignore"],
        encoding: "utf-8",
      },
    );
    if (result.status === 0) {
      cachedWindowsShellExecutable = candidate;
      return candidate;
    }
  }

  cachedWindowsShellExecutable = "powershell";
  return cachedWindowsShellExecutable;
}
