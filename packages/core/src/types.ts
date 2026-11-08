/** A JSON Schema object describing a tool's input. */
export type JsonSchema = Record<string, unknown>;

/**
 * What a tool does, used by the approval policy and by client UIs.
 * - `read` / `search`: inspect the workspace without changing it.
 * - `edit` / `delete`: change files.
 * - `execute`: run a shell command.
 * - `network`: send data outside the machine.
 * - `other`: anything else (task lists, sub-agents, background-shell control).
 */
export type ToolCategory = "read" | "search" | "edit" | "delete" | "execute" | "network" | "other";

/** A workspace path after the host checked that it stays inside an allowed root. */
export interface ResolvedPath {
  /** Absolute, normalized path. */
  absolute: string;
  /** Path relative to the workspace root, with `/` separators (`.` for the root itself). */
  relative: string;
}

export interface DirectoryEntry {
  name: string;
  type: "file" | "directory" | "other";
}

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
}

export interface RunCommandOptions {
  command: string;
  timeoutMs: number;
  signal?: AbortSignal;
  /** Receives every chunk of combined stdout/stderr as it arrives. */
  onOutput?: (chunk: string) => void;
}

export interface GrepOptions {
  pattern: string;
  /** Absolute file or directory to search. */
  path: string;
  /** Optional glob filter such as `*.ts` or `src/**\/*.tsx`. */
  glob?: string;
  caseInsensitive?: boolean;
  signal?: AbortSignal;
}

export interface GrepResult {
  /** Matches as `relative/path:line:text`, one per line. */
  stdout: string;
  stderr: string;
  /** ripgrep-style: 0 = matches, 1 = no matches, 2 = error. */
  exitCode: number | null;
}

export interface GlobOptions {
  /** Optional glob such as `*.ts` or `src/**\/*.tsx`; every file when omitted. */
  pattern?: string;
  /** Absolute directory to list. */
  path: string;
  limit: number;
  signal?: AbortSignal;
}

export interface BackgroundCommandStart {
  id: string;
  pid?: number | null;
}

/**
 * Everything a tool needs from its environment. The Node host (CLI, Zed) uses fs and
 * child_process; the VS Code extension implements it with workspace.fs and its terminal
 * runner. Tools never touch Node or VS Code APIs directly.
 */
export interface ToolHost {
  /** Primary workspace root (absolute). */
  readonly workspaceRoot: string;
  /**
   * Resolve a model-supplied path against the workspace and enforce the path guard.
   * Throws when the path escapes every allowed root, or (with `forWrite`) targets `.git`.
   */
  resolvePath(input: string, options?: { forWrite?: boolean }): Promise<ResolvedPath>;
  /** Read a UTF-8 text file. Throws when it does not exist. */
  readFile(path: string): Promise<string>;
  /** Write a UTF-8 text file, creating parent directories. */
  writeFile(path: string, content: string): Promise<void>;
  deleteFile(path: string): Promise<void>;
  /** `null` when the path does not exist. */
  stat(path: string): Promise<{ type: "file" | "directory" | "other" } | null>;
  listDirectory(path: string): Promise<DirectoryEntry[]>;
  /** Workspace-relative file paths (with `/` separators), at most `limit`. */
  glob(options: GlobOptions): Promise<string[]>;
  grep(options: GrepOptions): Promise<GrepResult>;
  /** Run a shell command in the workspace root. Rejects with an AbortError when aborted. */
  runCommand(options: RunCommandOptions): Promise<CommandResult>;
  /** Start a long-running command without waiting for it. Optional. */
  startBackgroundCommand?(command: string): Promise<BackgroundCommandStart>;
}

/** A change a tool made to one file, for diff views and change tracking. */
export interface FileChange {
  path: ResolvedPath;
  /** `null` when the file did not exist before. */
  oldText: string | null;
  /** Empty string when the file was deleted. */
  newText: string;
  kind: "create" | "update" | "delete";
}

export interface ToolResult {
  /** False when the tool ran but reported a failure (non-zero exit, denial, error). */
  ok: boolean;
  /** Text sent back to the model as the function_call_output. */
  output: string;
  /** One-line human summary, e.g. `Read src/index.ts`. */
  summary: string;
  /** Set by file tools. */
  fileChange?: FileChange;
  /** Set by Bash: combined stdout/stderr for display. */
  displayOutput?: string;
}

export interface ToolContext {
  host: ToolHost;
  signal?: AbortSignal;
  /** Defaults to true. When false, Bash refuses to run. */
  allowShell?: boolean;
  /** Defaults to true. When false, Write/Edit/Delete refuse to run. */
  allowFileEdits?: boolean;
  /** Called with combined command output as it streams (accumulated text). */
  onOutput?: (output: string) => void;
  /** Called right before a file tool changes a file (checkpoints, change tracking). */
  onBeforeFileChange?: (path: ResolvedPath) => void | Promise<void>;
}

/** A tool the agent loop can offer to the model. */
export interface AgentTool {
  name: string;
  description: string;
  parameters: JsonSchema;
  category: ToolCategory;
  /** Short title for approval cards and tool-call rows, e.g. `Edit src/a.ts`. */
  title?: (input: Record<string, unknown>) => string;
  /** Throws on invalid input or failure; the agent loop turns errors into a failed result. */
  execute(input: Record<string, unknown>, context: ToolContext): Promise<ToolResult>;
}

/** The `{ type: "function", ... }` tool shape the Responses API expects. */
export interface FunctionToolDefinition {
  type: "function";
  name: string;
  description: string;
  parameters: JsonSchema;
}

export function toFunctionToolDefinition(tool: AgentTool): FunctionToolDefinition {
  return {
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  };
}
