import { spawn, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";

const MAX_RUNNING = 8;
const MAX_BUFFER_CHARS = 200_000;
const MAX_FINISHED = 20;
const KILL_ESCALATION_MS = 3_000;

export interface BackgroundStartResult {
  id: string;
  pid: number | undefined;
}

export interface BackgroundReadResult {
  id: string;
  command: string;
  status: "running" | "exited";
  exitCode: number | null;
  /** Only NEW output since the previous read of this id. */
  output: string;
  /** Chars lost to the rolling cap since the previous read, usually 0. */
  droppedChars: number;
}

export interface BackgroundListEntry {
  id: string;
  command: string;
  status: "running" | "exited";
  exitCode: number | null;
  startedAt: string;
}

interface BackgroundProcess {
  id: string;
  command: string;
  child: ChildProcess | null;
  pid: number | undefined;
  status: "running" | "exited";
  exitCode: number | null;
  buffer: string;
  readOffset: number;
  droppedSinceRead: number;
  startedAt: Date;
}

export class BackgroundProcessManager {
  private readonly processes = new Map<string, BackgroundProcess>();
  private nextId = 1;
  private exitHandlerRegistered = false;

  start(command: string, cwd: string): BackgroundStartResult {
    if (this.countRunning() >= MAX_RUNNING) {
      throw new Error("Too many background processes (max 8). Kill one first.");
    }

    const id = `bg_${this.nextId}`;
    this.nextId += 1;

    const entry: BackgroundProcess = {
      id,
      command,
      child: null,
      pid: undefined,
      status: "running",
      exitCode: null,
      buffer: "",
      readOffset: 0,
      droppedSinceRead: 0,
      startedAt: new Date(),
    };
    this.processes.set(id, entry);
    this.ensureExitHandler();

    const { executable, executableArgs } = getShellInvocation(command);

    try {
      const child = spawn(executable, executableArgs, {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
      });
      entry.child = child;
      entry.pid = child.pid;

      child.stdout?.on("data", (chunk: Buffer) => {
        appendOutput(entry, chunk.toString());
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        appendOutput(entry, chunk.toString());
      });
      // A failed spawn emits 'error'; never let it go unhandled.
      child.on("error", (error: Error) => {
        this.finalize(entry, -1, `\n${error.message}`);
      });
      child.on("close", (code: number | null) => {
        this.finalize(entry, code ?? null);
      });

      detachChild(child);
    } catch (error) {
      this.finalize(entry, -1, `\n${error instanceof Error ? error.message : String(error)}`);
    }

    return { id, pid: entry.pid };
  }

  read(id: string): BackgroundReadResult {
    const entry = this.require(id);
    const output = entry.buffer.slice(entry.readOffset);
    entry.readOffset = entry.buffer.length;
    const droppedChars = entry.droppedSinceRead;
    entry.droppedSinceRead = 0;

    return {
      id: entry.id,
      command: entry.command,
      status: entry.status,
      exitCode: entry.exitCode,
      output,
      droppedChars,
    };
  }

  kill(id: string): boolean {
    const entry = this.require(id);
    if (entry.status !== "running") {
      return false;
    }
    this.killProcessTree(entry);
    return true;
  }

  list(): BackgroundListEntry[] {
    return [...this.processes.values()].map((entry) => ({
      id: entry.id,
      command: entry.command,
      status: entry.status,
      exitCode: entry.exitCode,
      startedAt: entry.startedAt.toISOString(),
    }));
  }

  killAll(): void {
    for (const entry of this.processes.values()) {
      if (entry.status === "running") {
        this.killProcessTree(entry);
      }
    }
  }

  private require(id: string): BackgroundProcess {
    const entry = this.processes.get(id);
    if (!entry) {
      throw new Error(`Unknown background process: ${id}`);
    }
    return entry;
  }

  private countRunning(): number {
    let running = 0;
    for (const entry of this.processes.values()) {
      if (entry.status === "running") {
        running += 1;
      }
    }
    return running;
  }

  private finalize(entry: BackgroundProcess, exitCode: number | null, extraOutput?: string): void {
    if (entry.status === "exited") {
      return;
    }
    entry.status = "exited";
    entry.exitCode = exitCode;
    entry.child = null;
    if (extraOutput) {
      appendOutput(entry, extraOutput);
    }
    this.pruneFinished();
  }

  // Keep at most MAX_FINISHED finished entries, dropping the oldest ones.
  // Map iteration order is insertion order, so the first finished entries are oldest.
  private pruneFinished(): void {
    const finished: BackgroundProcess[] = [];
    for (const entry of this.processes.values()) {
      if (entry.status === "exited") {
        finished.push(entry);
      }
    }
    const excess = finished.length - MAX_FINISHED;
    for (let index = 0; index < excess; index += 1) {
      const entry = finished[index];
      if (entry) {
        this.processes.delete(entry.id);
      }
    }
  }

  private ensureExitHandler(): void {
    if (this.exitHandlerRegistered) {
      return;
    }
    this.exitHandlerRegistered = true;
    process.once("exit", () => {
      this.killAll();
    });
  }

  private killProcessTree(entry: BackgroundProcess): void {
    const pid = entry.pid;

    if (pid === undefined) {
      try {
        entry.child?.kill();
      } catch {
        // Already gone.
      }
      return;
    }

    if (process.platform === "win32") {
      try {
        spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
      } catch {
        // Ignore taskkill failures; the process may already be gone.
      }
      return;
    }

    // detached: true makes the child a group leader, so -pid targets the whole tree.
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      try {
        entry.child?.kill("SIGTERM");
      } catch {
        // Already gone.
      }
    }

    const timer = setTimeout(() => {
      if (entry.status !== "running") {
        return;
      }
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        try {
          entry.child?.kill("SIGKILL");
        } catch {
          // Already gone.
        }
      }
    }, KILL_ESCALATION_MS);
    timer.unref();
  }
}

function appendOutput(entry: BackgroundProcess, chunk: string): void {
  if (chunk.length === 0) {
    return;
  }
  entry.buffer += chunk;
  if (entry.buffer.length > MAX_BUFFER_CHARS) {
    const excess = entry.buffer.length - MAX_BUFFER_CHARS;
    entry.buffer = entry.buffer.slice(excess);
    // Only characters the reader had not consumed yet count as lost.
    entry.droppedSinceRead += Math.max(0, excess - entry.readOffset);
    entry.readOffset = Math.max(0, entry.readOffset - excess);
  }
}

// Background children must not hold the event loop open; the caller invokes killAll on exit.
function detachChild(child: ChildProcess): void {
  try {
    child.unref();
  } catch {
    // Ignore: some runtimes do not implement unref.
  }

  for (const stream of [child.stdout, child.stderr]) {
    if (!stream) {
      continue;
    }
    const candidate = stream as unknown as { unref?: () => void };
    if (typeof candidate.unref === "function") {
      try {
        candidate.unref();
      } catch {
        // Ignore.
      }
    }
  }
}

let cachedWindowsShellExecutable: string | null = null;

function getShellInvocation(command: string): {
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
    executable: process.env.SHELL || "bash",
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

export const backgroundProcesses = new BackgroundProcessManager();
