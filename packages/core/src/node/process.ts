import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import type { CommandResult } from "../types";
import { createAbortError, MAX_TOOL_OUTPUT_CHARS, truncate } from "../util";

let cachedWindowsShellExecutable: string | null = null;

/** PowerShell (pwsh, else Windows PowerShell) on Windows; `$SHELL -lc` (or bash) elsewhere. */
export function getShellInvocation(command: string): {
  executable: string;
  executableArgs: string[];
} {
  if (process.platform === "win32") {
    return {
      executable: getWindowsShellExecutable(),
      executableArgs: ["-NoProfile", "-Command", command],
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
      { stdio: ["ignore", "pipe", "ignore"], encoding: "utf-8", windowsHide: true },
    );
    if (result.status === 0) {
      cachedWindowsShellExecutable = candidate;
      return candidate;
    }
  }
  cachedWindowsShellExecutable = "powershell";
  return cachedWindowsShellExecutable;
}

/** Stop a child and everything it started. */
export function killProcessTree(child: ChildProcess, escalateAfterMs = 2_000): void {
  const pid = child.pid;
  if (pid === undefined) {
    child.kill();
    return;
  }
  if (process.platform === "win32") {
    try {
      spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
    } catch {
      child.kill();
    }
    return;
  }
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
  const escalate = setTimeout(() => {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }, escalateAfterMs);
  escalate.unref();
}

/**
 * Run a process with a timeout and abort support. Output is capped so a chatty command
 * cannot exhaust memory. Rejects with an AbortError when the signal aborts.
 */
export async function runProcess(
  executable: string,
  args: string[],
  options: {
    cwd: string;
    timeoutMs: number;
    signal?: AbortSignal;
    onOutput?: (chunk: string) => void;
  },
): Promise<CommandResult> {
  return await new Promise((resolvePromise, reject) => {
    if (options.signal?.aborted) {
      reject(createAbortError());
      return;
    }

    const child = spawn(executable, args, {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      // A process group lets us stop grandchildren that would otherwise keep the pipes open.
      detached: process.platform !== "win32",
    });

    let stdout = "";
    let stderr = "";
    let resolved = false;
    let timedOut = false;
    let forceTimer: NodeJS.Timeout | undefined;

    const onAbort = (): void => {
      clearTimeout(timeout);
      killProcessTree(child);
      if (!resolved) {
        resolved = true;
        reject(createAbortError());
      }
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });

    const cleanup = (): void => {
      clearTimeout(timeout);
      if (forceTimer) {
        clearTimeout(forceTimer);
      }
      options.signal?.removeEventListener("abort", onAbort);
    };

    const timeout = setTimeout(() => {
      timedOut = true;
      killProcessTree(child);
      // Do not wait for `close`: a stubborn descendant can hold the pipes open indefinitely.
      forceTimer = setTimeout(() => {
        if (resolved) {
          return;
        }
        resolved = true;
        cleanup();
        resolvePromise({
          stdout: truncate(stdout),
          stderr: truncate(stderr),
          exitCode: null,
          timedOut: true,
        });
      }, 3000);
    }, options.timeoutMs);

    // Keep only what truncate() can ever return.
    const append = (current: string, chunk: string): string =>
      current.length > MAX_TOOL_OUTPUT_CHARS ? current : current + chunk;
    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stdout = append(stdout, text);
      options.onOutput?.(text);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stderr = append(stderr, text);
      options.onOutput?.(text);
    });
    child.on("error", (error) => {
      cleanup();
      if (!resolved) {
        resolved = true;
        reject(error);
      }
    });
    child.on("close", (code) => {
      cleanup();
      if (resolved) {
        return;
      }
      resolved = true;
      resolvePromise({
        stdout: truncate(stdout),
        stderr: truncate(stderr),
        exitCode: code,
        timedOut,
      });
    });
  });
}
