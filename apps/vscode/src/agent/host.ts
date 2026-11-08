import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import * as vscode from 'vscode';
import type {
  ApprovalMode,
  CommandResult,
  DirectoryEntry,
  GlobOptions,
  GrepOptions,
  GrepResult,
  RunCommandOptions,
  ToolHost,
} from '@deniai/flixa-core';
import { globToRegExp } from '@deniai/flixa-core';
import { resolveGuardedPath } from '@deniai/flixa-core/node';

const COMMAND_TIMEOUT_FLOOR_MS = 60_000;
const SEARCH_EXCLUDE = '{**/node_modules/**,**/.git/**}';
const MAX_GREP_FILES = 2_000;
const MAX_GREP_MATCHES = 200;
const MAX_GREP_FILE_BYTES = 1_000_000;

export interface VscodeToolHostOptions {
  workspaceRoot: string;
  /** Read at run time: shell commands use the terminal in SAFE/MANUAL and spawn in ALL/AUTO. */
  getApprovalMode: () => ApprovalMode;
}

/**
 * The extension's ToolHost: files through workspace.fs, search through findFiles, and shell
 * commands through the existing runner (a visible terminal when the user approves commands,
 * a captured process that answers interactive prompts otherwise).
 */
export function createVscodeToolHost(options: VscodeToolHostOptions): ToolHost {
  const workspaceRoot = path.resolve(options.workspaceRoot);
  const toUri = (absolute: string) => vscode.Uri.file(absolute);
  const toRelative = (absolute: string) => {
    const relative = path.relative(workspaceRoot, absolute);
    return relative.replace(/\\/g, '/') || '.';
  };

  const statPath = async (absolute: string) => {
    try {
      const info = await vscode.workspace.fs.stat(toUri(absolute));
      return { type: toEntryType(info.type) };
    } catch {
      return null;
    }
  };

  return {
    workspaceRoot,

    async resolvePath(input, resolveOptions) {
      return resolveGuardedPath(
        input,
        workspaceRoot,
        [workspaceRoot],
        resolveOptions?.forWrite === true,
      );
    },

    async readFile(absolute) {
      const document = await vscode.workspace.openTextDocument(toUri(absolute));
      return document.getText();
    },

    async writeFile(absolute, content) {
      await vscode.workspace.fs.writeFile(toUri(absolute), Buffer.from(content, 'utf-8'));
    },

    async deleteFile(absolute) {
      await vscode.workspace.fs.delete(toUri(absolute));
    },

    stat: statPath,

    async listDirectory(absolute): Promise<DirectoryEntry[]> {
      const entries = await vscode.workspace.fs.readDirectory(toUri(absolute));
      return entries.map(([name, type]) => ({ name, type: toEntryType(type) }));
    },

    async glob(globOptions: GlobOptions) {
      const files = await vscode.workspace.findFiles(
        new vscode.RelativePattern(toUri(globOptions.path), normalizeGlob(globOptions.pattern)),
        SEARCH_EXCLUDE,
        globOptions.limit,
      );
      return files.map((file) => toRelative(file.fsPath)).sort((a, b) => a.localeCompare(b));
    },

    async grep(grepOptions: GrepOptions): Promise<GrepResult> {
      let expression: RegExp;
      try {
        expression = new RegExp(grepOptions.pattern, grepOptions.caseInsensitive ? 'i' : '');
      } catch (error) {
        return {
          stdout: '',
          stderr: `regex parse error: ${error instanceof Error ? error.message : String(error)}`,
          exitCode: 2,
        };
      }

      const target = await statPath(grepOptions.path);
      const files =
        target?.type === 'file'
          ? [toUri(grepOptions.path)]
          : await vscode.workspace.findFiles(
              new vscode.RelativePattern(toUri(grepOptions.path), normalizeGlob(grepOptions.glob)),
              SEARCH_EXCLUDE,
              MAX_GREP_FILES,
            );
      const globFilter = grepOptions.glob ? globToRegExp(grepOptions.glob) : null;

      const lines: string[] = [];
      for (const file of files) {
        if (grepOptions.signal?.aborted || lines.length >= MAX_GREP_MATCHES) {
          break;
        }
        const relative = toRelative(file.fsPath);
        if (globFilter && target?.type === 'file' && !globFilter.test(relative)) {
          continue;
        }
        const content = await readTextIfSmall(file);
        if (content === null) {
          continue;
        }
        const fileLines = content.split(/\r?\n/);
        for (
          let index = 0;
          index < fileLines.length && lines.length < MAX_GREP_MATCHES;
          index += 1
        ) {
          if (expression.test(fileLines[index])) {
            lines.push(`${relative}:${index + 1}:${fileLines[index]}`);
          }
        }
      }
      return { stdout: lines.join('\n'), stderr: '', exitCode: lines.length > 0 ? 0 : 1 };
    },

    async runCommand(runOptions: RunCommandOptions): Promise<CommandResult> {
      const timeoutMs = Math.max(runOptions.timeoutMs, COMMAND_TIMEOUT_FLOOR_MS);
      const mode = options.getApprovalMode();
      if (mode === 'SAFE_APPROVE' || mode === 'MANUAL_APPROVE') {
        return runInTerminal(runOptions.command, workspaceRoot, timeoutMs, runOptions.signal);
      }
      return runWithSpawn(runOptions.command, workspaceRoot, {
        timeoutMs,
        signal: runOptions.signal,
        onOutput: runOptions.onOutput,
        autoRespond: true,
      });
    },

    async startBackgroundCommand(command) {
      const id = `bg_${Date.now().toString(36)}`;
      const terminal = vscode.window.createTerminal({
        name: `Flixa ${id}`,
        cwd: workspaceRoot,
        shellPath: getShell(),
      });
      terminal.show(true);
      terminal.sendText(command, true);
      return { id };
    },
  };
}

function toEntryType(type: vscode.FileType): DirectoryEntry['type'] {
  if (type & vscode.FileType.Directory) return 'directory';
  if (type & vscode.FileType.File) return 'file';
  return 'other';
}

function normalizeGlob(pattern?: string): string {
  const trimmed = pattern?.trim();
  if (!trimmed) {
    return '**/*';
  }
  if (trimmed.includes('**') || trimmed.includes('/') || trimmed.includes('\\')) {
    return trimmed;
  }
  return `**/${trimmed}`;
}

async function readTextIfSmall(uri: vscode.Uri): Promise<string | null> {
  try {
    const info = await vscode.workspace.fs.stat(uri);
    if (info.size > MAX_GREP_FILE_BYTES) {
      return null;
    }
    const bytes = await vscode.workspace.fs.readFile(uri);
    if (bytes.includes(0)) {
      return null;
    }
    return Buffer.from(bytes).toString('utf-8');
  } catch {
    return null;
  }
}

function getShell(): string {
  return process.platform === 'win32' ? 'powershell.exe' : '/bin/sh';
}

function abortError(): Error {
  const error = new Error('Command cancelled');
  error.name = 'AbortError';
  return error;
}

/** Detect if output ends with an interactive prompt. */
export function detectInteractivePrompt(output: string): {
  isPrompt: boolean;
  promptType: 'yesno' | 'enter' | 'input' | 'select';
} {
  const trimmed = output.trimEnd();
  const lastLines = trimmed.split('\n').slice(-10).join('\n');
  const lastLine = trimmed.split('\n').pop() || '';

  const selectPatterns = [
    /use arrow[- ]?keys/i,
    /arrow keys to move/i,
    /move up and down to reveal/i,
    /❯|›|▸|▶/,
    />\s+\w+.*\n\s+\w+/,
  ];
  if (selectPatterns.some((pattern) => pattern.test(lastLines))) {
    return { isPrompt: true, promptType: 'select' };
  }

  const yesNoPatterns = [
    /\[y\/n\]/i,
    /\(y\/n\)/i,
    /yes\/no/i,
    /\[yes\/no\]/i,
    /\(yes\)/i,
    /\[Y\/n\]/i,
    /\[y\/N\]/i,
    /\(Y\/n\)/i,
    /\(y\/N\)/i,
  ];
  if (yesNoPatterns.some((pattern) => pattern.test(lastLine))) {
    return { isPrompt: true, promptType: 'yesno' };
  }

  const enterPatterns = [
    /press enter to continue/i,
    /hit enter to continue/i,
    /press any key/i,
    /return to submit/i,
    /enter to confirm/i,
  ];
  if (enterPatterns.some((pattern) => pattern.test(lastLines))) {
    return { isPrompt: true, promptType: 'enter' };
  }

  const inputPatterns = [/password:\s*$/i, /passphrase.*:\s*$/i, /enter.*:\s*$/i, /input.*:\s*$/i];
  if (inputPatterns.some((pattern) => pattern.test(lastLine))) {
    return { isPrompt: true, promptType: 'input' };
  }

  return { isPrompt: false, promptType: 'input' };
}

/** Run a command with captured output, answering interactive prompts when `autoRespond`. */
export function runWithSpawn(
  command: string,
  cwd: string | undefined,
  options: {
    timeoutMs: number;
    signal?: AbortSignal;
    onOutput?: (chunk: string) => void;
    autoRespond: boolean;
  },
): Promise<CommandResult> {
  const isWindows = process.platform === 'win32';
  const shellFlag = isWindows ? '-Command' : '-c';

  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(abortError());
      return;
    }
    let combined = '';
    let settled = false;
    let promptDebounceTimer: NodeJS.Timeout | undefined;

    const child = spawn(getShell(), [shellFlag, command], {
      cwd: cwd || undefined,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const cleanup = () => {
      clearTimeout(commandTimeout);
      if (promptDebounceTimer) clearTimeout(promptDebounceTimer);
      options.signal?.removeEventListener('abort', abortHandler);
    };
    const finish = (result: CommandResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };
    const abortHandler = () => {
      child.kill();
      if (settled) return;
      settled = true;
      cleanup();
      reject(abortError());
    };
    options.signal?.addEventListener('abort', abortHandler, { once: true });

    const checkAndRespondToPrompt = () => {
      if (!options.autoRespond || settled || !child.stdin?.writable) return;
      if (promptDebounceTimer) clearTimeout(promptDebounceTimer);
      promptDebounceTimer = setTimeout(() => {
        if (settled || !child.stdin?.writable) return;
        const { isPrompt, promptType } = detectInteractivePrompt(combined);
        if (!isPrompt) return;
        console.log('[Flixa] Auto-responding to interactive prompt:', promptType);
        try {
          child.stdin.write(promptType === 'yesno' ? 'y\n' : '\n');
        } catch (err) {
          console.log('[Flixa] Failed to write to stdin:', err);
        }
      }, 300);
    };

    const onData = (data: Buffer) => {
      const text = data.toString();
      combined += text;
      options.onOutput?.(text);
      checkAndRespondToPrompt();
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('close', (code) => {
      finish({ stdout: combined.trim(), stderr: '', exitCode: code, timedOut: false });
    });
    child.on('error', (err) => {
      finish({ stdout: combined.trim(), stderr: err.message, exitCode: null, timedOut: false });
    });
    const commandTimeout = setTimeout(() => {
      if (settled) return;
      child.kill();
      finish({ stdout: combined.trim(), stderr: '', exitCode: null, timedOut: true });
    }, options.timeoutMs);
  });
}

/** Run a command in a visible terminal and wait for its exit code (output is not captured). */
function runInTerminal(
  command: string,
  cwd: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<CommandResult> {
  const isWindows = process.platform === 'win32';
  const exitFilePath = path.join(
    os.tmpdir(),
    `flixa_exit_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
  );
  const psExitPath = `"${exitFilePath.replace(/`/g, '``').replace(/"/g, '`"')}"`;
  const shExitPath = `"${exitFilePath.replace(/(["\\$`])/g, '\\$1')}"`;

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    let settled = false;
    const terminal = vscode.window.createTerminal({
      name: 'Flixa Shell',
      cwd,
      shellPath: getShell(),
    });

    const cleanup = () => {
      signal?.removeEventListener('abort', abortHandler);
      clearTimeout(timeout);
      clearInterval(fileCheckInterval);
      try {
        if (fs.existsSync(exitFilePath)) fs.unlinkSync(exitFilePath);
      } catch {}
      closeSubscription.dispose();
    };
    const finish = (result: CommandResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };
    const abortHandler = () => {
      terminal.dispose();
      if (settled) return;
      settled = true;
      cleanup();
      reject(abortError());
    };
    signal?.addEventListener('abort', abortHandler, { once: true });

    const closeSubscription = vscode.window.onDidCloseTerminal((closed) => {
      if (closed !== terminal || settled) return;
      finish({ stdout: '', stderr: 'Terminal closed', exitCode: null, timedOut: false });
    });
    const timeout = setTimeout(() => {
      if (settled) return;
      terminal.dispose();
      finish({ stdout: '', stderr: '', exitCode: null, timedOut: true });
    }, timeoutMs);

    const exitSuffix = isWindows
      ? `; $exitCode = $LASTEXITCODE; Set-Content -Path ${psExitPath} -Value $exitCode`
      : `; exit_code=$?; printf '%s\\n' "$exit_code" > ${shExitPath}`;
    terminal.show(true);
    terminal.sendText(`${command}${exitSuffix}`, true);

    const fileCheckInterval = setInterval(() => {
      if (settled || !fs.existsSync(exitFilePath)) return;
      let exitCode: number | null = null;
      try {
        const value = Number.parseInt(fs.readFileSync(exitFilePath, 'utf-8').trim(), 10);
        if (!Number.isNaN(value)) exitCode = value;
      } catch {}
      if (exitCode === null) return;
      finish({
        stdout: '',
        stderr: exitCode === 0 ? '' : 'Output was shown in the Flixa Shell terminal.',
        exitCode,
        timedOut: false,
      });
    }, 200);
  });
}
