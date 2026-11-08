import { lstatSync, realpathSync } from "node:fs";
import { mkdir, readdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, normalize, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  CommandResult,
  DirectoryEntry,
  GlobOptions,
  GrepOptions,
  GrepResult,
  ResolvedPath,
  ToolHost,
} from "../types";
import { globToRegExp } from "../util";
import { backgroundProcesses, type BackgroundProcessManager } from "./background";
import { getShellInvocation, runProcess } from "./process";
import { displayPathFor, grepWithJavaScript, toPortable, walkFiles } from "./walk";

const SEARCH_TIMEOUT_MS = 30_000;

export interface NodeToolHostOptions {
  workspaceRoot: string;
  /** Extra roots the agent may read and write (Zed's additional workspace directories). */
  additionalRoots?: readonly string[];
  /** ripgrep executable (e.g. from @vscode/ripgrep). Defaults to `rg` on PATH, else pure JS. */
  ripgrepPath?: string;
  /** Background shell registry; `false` disables `run_in_background`. Defaults to a shared one. */
  background?: BackgroundProcessManager | false;
}

/** A ToolHost on node:fs and node:child_process, used by the CLI and the Zed agent. */
export function createNodeToolHost(options: NodeToolHostOptions): ToolHost {
  const workspaceRoot = resolve(options.workspaceRoot);
  const roots = [workspaceRoot, ...(options.additionalRoots ?? []).map((root) => resolve(root))];
  const ripgrep = createRipgrepRunner(options.ripgrepPath ?? "rg");
  const background = options.background === undefined ? backgroundProcesses : options.background;

  const host: ToolHost = {
    workspaceRoot,

    async resolvePath(input, resolveOptions) {
      return resolveGuardedPath(input, workspaceRoot, roots, resolveOptions?.forWrite === true);
    },

    async readFile(path) {
      return readFile(path, "utf-8");
    },

    async writeFile(path, content) {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, content, "utf-8");
    },

    async deleteFile(path) {
      await unlink(path);
    },

    async stat(path) {
      try {
        const info = await stat(path);
        return { type: info.isFile() ? "file" : info.isDirectory() ? "directory" : "other" };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return null;
        }
        throw error;
      }
    },

    async listDirectory(path) {
      const entries = await readdir(path, { withFileTypes: true });
      return entries.map((entry): DirectoryEntry => ({
        name: entry.name,
        type: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other",
      }));
    },

    async glob(globOptions: GlobOptions) {
      if (globOptions.pattern) {
        const viaRipgrep = await ripgrep.run(
          ["--files", "-g", globOptions.pattern, "--", searchArgument(globOptions.path)],
          workspaceRoot,
          globOptions.signal,
        );
        if (viaRipgrep) {
          return viaRipgrep.stdout
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean)
            .slice(0, globOptions.limit)
            .map((line) => normalizeListedPath(line));
        }
        const expression = globToRegExp(globOptions.pattern);
        const files = await walkFiles(globOptions.path, {
          limit: globOptions.limit,
          signal: globOptions.signal,
          filter: (path) => expression.test(path),
        });
        return files.map((file) => displayPathFor(file, workspaceRoot));
      }
      const files = await walkFiles(globOptions.path, {
        limit: globOptions.limit,
        signal: globOptions.signal,
      });
      return files.map((file) => displayPathFor(file, workspaceRoot));
    },

    async grep(grepOptions: GrepOptions): Promise<GrepResult> {
      // `-e` and `--` keep model-supplied values from being parsed as ripgrep flags
      // (e.g. `--pre=<cmd>` would execute an arbitrary program).
      const args = ["-n", "--no-heading", "--with-filename", "--color", "never"];
      if (grepOptions.caseInsensitive) args.push("-i");
      if (grepOptions.glob) args.push("-g", grepOptions.glob);
      args.push("-e", grepOptions.pattern, "--", searchArgument(grepOptions.path));
      const viaRipgrep = await ripgrep.run(args, workspaceRoot, grepOptions.signal);
      if (viaRipgrep) {
        return {
          stdout: viaRipgrep.stdout
            .split(/\r?\n/)
            .filter(Boolean)
            .map((line) => normalizeMatchLine(line))
            .join("\n"),
          stderr: viaRipgrep.stderr,
          exitCode: viaRipgrep.exitCode,
        };
      }
      return grepWithJavaScript({
        pattern: grepOptions.pattern,
        root: grepOptions.path,
        workspaceRoot,
        glob: grepOptions.glob,
        caseInsensitive: grepOptions.caseInsensitive,
        signal: grepOptions.signal,
      });
    },

    async runCommand(runOptions) {
      const { executable, executableArgs } = getShellInvocation(runOptions.command);
      return runProcess(executable, executableArgs, {
        cwd: workspaceRoot,
        timeoutMs: runOptions.timeoutMs,
        signal: runOptions.signal,
        onOutput: runOptions.onOutput,
      });
    },
  };

  if (background) {
    host.startBackgroundCommand = async (command) => background.start(command, workspaceRoot);
  }

  // ripgrep prints paths the way they were passed; pass workspace paths relative so the
  // output is workspace-relative.
  function searchArgument(absolute: string): string {
    const relativePath = relative(workspaceRoot, absolute);
    return isInside(workspaceRoot, absolute) ? relativePath || "." : absolute;
  }

  return host;
}

function normalizeListedPath(line: string): string {
  return toPortable(line).replace(/^\.\//, "");
}

function normalizeMatchLine(line: string): string {
  const match = /^(.*?):(\d+):/.exec(line.replace(/^([a-z]):/i, "$1\u0000"));
  if (!match) {
    return line;
  }
  const pathPart = (match[1] as string).replace("\u0000", ":");
  return `${normalizeListedPath(pathPart)}${line.slice(pathPart.length)}`;
}

function createRipgrepRunner(executable: string) {
  let available: boolean | undefined;
  return {
    async run(args: string[], cwd: string, signal?: AbortSignal): Promise<CommandResult | null> {
      if (available === false) {
        return null;
      }
      try {
        const result = await runProcess(executable, args, {
          cwd,
          timeoutMs: SEARCH_TIMEOUT_MS,
          signal,
        });
        available = true;
        return result;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          available = false;
          return null;
        }
        throw error;
      }
    },
  };
}

function isInside(root: string, path: string): boolean {
  const relativePath = relative(root, path);
  return (
    relativePath === "" ||
    (!isAbsolute(relativePath) && relativePath !== ".." && !relativePath.startsWith(`..${sep}`))
  );
}

/** Resolve existing ancestors too, so new files cannot escape through a linked directory. */
function resolveRealPath(path: string): string {
  try {
    lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const parent = dirname(path);
    if (parent === path) throw error;
    return resolve(resolveRealPath(parent), relative(parent, path));
  }
  // A dangling link must fail here instead of being treated as a new file.
  return realpathSync(path);
}

function safeRealpath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * The CLI's path guard: the logical path and the real path (links resolved) must both stay
 * inside an allowed root. With `forWrite`, nothing inside `.git` may be written, because hooks
 * and config there run code on later git commands.
 */
export function resolveGuardedPath(
  input: string,
  workspaceRoot: string,
  roots: readonly string[],
  forWrite: boolean,
): ResolvedPath {
  const value = input.startsWith("file://") ? fileURLToPath(input) : input;
  const absolute = normalize(isAbsolute(value) ? resolve(value) : resolve(workspaceRoot, value));

  const root = roots.find((candidate) => {
    if (!isInside(candidate, absolute)) {
      return false;
    }
    try {
      return isInside(safeRealpath(candidate), resolveRealPath(absolute));
    } catch {
      return false;
    }
  });
  if (!root) {
    throw new Error(`Path must stay inside the workspace: ${toPortable(input)}`);
  }

  if (forWrite) {
    const isGitSegment = (segment: string): boolean => segment.toLowerCase() === ".git";
    const logicalSegments = relative(root, absolute).split(/[\\/]/);
    // A link inside the workspace can point at .git, so check where the path really lands too.
    const realSegments = relative(safeRealpath(root), resolveRealPath(absolute)).split(/[\\/]/);
    if (logicalSegments.some(isGitSegment) || realSegments.some(isGitSegment)) {
      throw new Error("Writing inside .git is not allowed.");
    }
  }

  const relativePath = relative(workspaceRoot, absolute);
  return { absolute, relative: relativePath ? toPortable(relativePath) : "." };
}
