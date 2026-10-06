import { readdir, readFile, stat, unlink, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

export interface ToolExecutionContext {
  cwd: string;
  additionalDirectories: string[];
  signal: AbortSignal;
  onOutput?: (output: string) => Promise<void>;
}

export interface ToolExecutionResult {
  success: boolean;
  output?: string;
  error?: string;
  path?: string;
  oldText?: string | null;
  newText?: string;
}

export interface ToolMetadata {
  title: string;
  kind: 'read' | 'edit' | 'delete' | 'search' | 'execute' | 'other';
  locations: Array<{ path: string }>;
}

const MAX_COMMAND_LENGTH = 5000;
const MAX_OUTPUT_LENGTH = 200_000;
const MAX_FILE_SIZE = 100_000;
const DEFAULT_EXCLUDES = new Set([
  '.git',
  'node_modules',
  'out',
  'dist',
  'build',
  'coverage',
  '.next',
  '.cache',
  '.vscode',
  '.idea',
  '__pycache__',
  '.pytest_cache',
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lock',
  'bun.lockb',
]);
const execFileAsync = promisify(execFile);

export const AGENT_TOOLS: unknown[] = [
  {
    type: 'function',
    name: 'codebase_search',
    description: 'Find the most relevant code snippets in the workspace for a semantic query.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The search query.' },
        target_directories: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional workspace-relative directories to search.',
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'read_file',
    description: 'Read a workspace file with optional one-indexed line bounds.',
    parameters: {
      type: 'object',
      properties: {
        target_file: { type: 'string', description: 'Workspace-relative or absolute file path.' },
        start_line: { type: 'number', description: 'One-indexed inclusive start line.' },
        end_line: { type: 'number', description: 'One-indexed inclusive end line.' },
      },
      required: ['target_file'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'list_dir',
    description: 'List the contents of a workspace directory.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Workspace-relative directory path.' },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'grep_search',
    description: 'Search workspace text files using a regular expression.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Regular expression to search for.' },
        case_sensitive: { type: 'boolean' },
        include_pattern: { type: 'string' },
        exclude_pattern: { type: 'string' },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'file_search',
    description: 'Find workspace files by fuzzy path matching.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'File name or path fragment.' },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'edit_file',
    description: 'Edit an existing file with a unified diff.',
    parameters: {
      type: 'object',
      properties: {
        target_file: { type: 'string', description: 'Workspace-relative or absolute file path.' },
        instructions: { type: 'string', description: 'Short description of the edit.' },
        diff: { type: 'string', description: 'Unified diff containing the requested edit.' },
      },
      required: ['target_file', 'instructions', 'diff'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'write_file',
    description: 'Create or completely overwrite a workspace file.',
    parameters: {
      type: 'object',
      properties: {
        target_file: { type: 'string', description: 'Workspace-relative file path.' },
        content: { type: 'string', description: 'Complete file content.' },
      },
      required: ['target_file', 'content'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'delete_file',
    description: 'Delete a workspace file.',
    parameters: {
      type: 'object',
      properties: {
        target_file: { type: 'string', description: 'Workspace-relative file path.' },
      },
      required: ['target_file'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'run_terminal_cmd',
    description: 'Run a non-interactive terminal command in the workspace.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Terminal command to run.' },
        is_background: { type: 'boolean', description: 'Start and return without waiting.' },
      },
      required: ['command'],
      additionalProperties: false,
    },
  },
];

export function getToolMetadata(
  name: string,
  input: Record<string, unknown>,
  context: ToolExecutionContext,
): ToolMetadata {
  const fileValue =
    typeof input.target_file === 'string'
      ? input.target_file
      : typeof input.path === 'string'
        ? input.path
        : null;
  const location = fileValue ? resolveAllowedPath(fileValue, context) : null;
  const locations = location ? [{ path: location.absolute }] : [];
  const shortCommand =
    typeof input.command === 'string' ? input.command.slice(0, 80) : '';

  switch (name) {
    case 'read_file':
      return { title: `Read ${fileValue || 'file'}`, kind: 'read', locations };
    case 'list_dir':
      return { title: `List ${fileValue || 'directory'}`, kind: 'read', locations };
    case 'grep_search':
      return { title: `Search ${typeof input.query === 'string' ? input.query.slice(0, 60) : 'workspace'}`, kind: 'search', locations: [{ path: context.cwd }] };
    case 'file_search':
    case 'codebase_search':
      return { title: `Search ${typeof input.query === 'string' ? input.query.slice(0, 60) : 'workspace'}`, kind: 'search', locations: [{ path: context.cwd }] };
    case 'edit_file':
      return { title: `Edit ${fileValue || 'file'}`, kind: 'edit', locations };
    case 'write_file':
      return { title: `Write ${fileValue || 'file'}`, kind: 'edit', locations };
    case 'delete_file':
      return { title: `Delete ${fileValue || 'file'}`, kind: 'delete', locations };
    case 'run_terminal_cmd':
      return { title: `Run ${shortCommand}`, kind: 'execute', locations: [{ path: context.cwd }] };
    default:
      return { title: name, kind: 'other', locations: [] };
  }
}

export async function executeTool(
  name: string,
  input: Record<string, unknown>,
  context: ToolExecutionContext,
): Promise<ToolExecutionResult> {
  try {
    if (context.signal.aborted) {
      return { success: false, error: 'Action cancelled' };
    }

    switch (name) {
      case 'read_file':
        return await readWorkspaceFile(input, context);
      case 'list_dir':
        return await listWorkspaceDirectory(input, context);
      case 'grep_search':
        return await grepWorkspace(input, context);
      case 'file_search':
        return await searchWorkspaceFiles(input, context);
      case 'codebase_search':
        return await searchWorkspaceCode(input, context);
      case 'edit_file':
        return await editWorkspaceFile(input, context);
      case 'write_file':
        return await writeWorkspaceFile(input, context);
      case 'delete_file':
        return await deleteWorkspaceFile(input, context);
      case 'run_terminal_cmd':
        return await runTerminalCommand(input, context);
      default:
        return { success: false, error: `Unknown tool: ${name}` };
    }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function isWriteTool(name: string): boolean {
  return name === 'edit_file' || name === 'write_file' || name === 'delete_file';
}

export function isExecuteTool(name: string): boolean {
  return name === 'run_terminal_cmd';
}

export async function getWorkspaceContext(
  context: Pick<ToolExecutionContext, 'cwd' | 'additionalDirectories' | 'signal'>,
): Promise<string> {
  const sections: string[] = [];
  const packageInfo = await readPackageInfo(context.cwd);
  const tsConfigInfo = await readTsConfigInfo(context.cwd);
  const gitStatus = await readGitStatus(context.cwd);
  const files = await collectFiles(context, 4, 500);

  if (packageInfo) {
    sections.push(`## Project Info\n${packageInfo}`);
  }
  if (tsConfigInfo) {
    sections.push(`## TypeScript Config\n${tsConfigInfo}`);
  }
  if (gitStatus) {
    sections.push(`## Git Status\n${gitStatus}`);
  }
  if (files.length > 0) {
    sections.push(`## File Structure\n${files.map((file) => `  ${file.relative}`).join('\n')}`);
  }

  return sections.length > 0 ? `# Workspace Context\n\n${sections.join('\n\n')}` : '';
}

export function isObviouslyUnsafeCommand(command: string): boolean {
  const unsafePatterns = [
    /(^|[;&|])\s*rm\s+[^\n]*\/($|\s)/i,
    /(^|[;&|])\s*del\s+[^\n]*[A-Za-z]:\\?($|\s)/i,
    /(^|[;&|])\s*format\s+[A-Za-z]:/i,
    /curl\s+[^\n|]*\|\s*(ba)?sh/i,
    /wget\s+[^\n|]*\|\s*(ba)?sh/i,
    /(^|\s)sudo\s+/i,
    /git\s+push\s+[^\n]*--force/i,
    /git\s+reset\s+--hard\s+(origin\/)?(main|master)\b/i,
  ];
  return unsafePatterns.some((pattern) => pattern.test(command));
}

export function applyUnifiedDiff(original: string, diff: string): string | null {
  const lines = diff.replace(/\r\n/g, '\n').split('\n');
  const hunks: DiffHunk[] = [];
  let current: DiffHunk | null = null;

  for (const line of lines) {
    if (line.startsWith('@@')) {
      const match = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
      if (!match) {
        return null;
      }
      current = {
        oldStart: Number(match[1]),
        oldCount: Number(match[2] || 1),
        newStart: Number(match[3]),
        newCount: Number(match[4] || 1),
        lines: [],
      };
      hunks.push(current);
      continue;
    }

    if (current && (line.startsWith(' ') || line.startsWith('+') || line.startsWith('-'))) {
      current.lines.push(line);
    }
  }

  if (hunks.length === 0) {
    return null;
  }

  const result = original.replace(/\r\n/g, '\n').split('\n');
  for (const hunk of [...hunks].reverse()) {
    const oldLines = hunk.lines
      .filter((line) => line.startsWith(' ') || line.startsWith('-'))
      .map((line) => line.slice(1));
    const newLines = hunk.lines
      .filter((line) => line.startsWith(' ') || line.startsWith('+'))
      .map((line) => line.slice(1));
    const expectedIndex = Math.max(0, hunk.oldStart - 1);
    const index = findHunkIndex(result, oldLines, expectedIndex);

    if (index < 0 || (oldLines.length > 0 && hunk.oldCount !== oldLines.length)) {
      return null;
    }

    result.splice(index, hunk.oldCount, ...newLines);
  }

  return result.join('\n');
}

function resolveAllowedPath(
  value: string,
  context: Pick<ToolExecutionContext, 'cwd' | 'additionalDirectories'>,
): { absolute: string; relative: string } | null {
  const normalizedValue = value.startsWith('file://') ? fileURLToPath(value) : value;
  const absolute = path.normalize(path.isAbsolute(normalizedValue) ? normalizedValue : path.resolve(context.cwd, normalizedValue));
  const roots = [context.cwd, ...context.additionalDirectories].map((root) => path.normalize(path.resolve(root)));
  const root = roots.find((candidate) => isPathInside(candidate, absolute));
  if (!root) {
    return null;
  }
  return {
    absolute,
    relative: path.relative(context.cwd, absolute).replace(/\\/g, '/'),
  };
}

function isPathInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function readWorkspaceFile(
  input: Record<string, unknown>,
  context: ToolExecutionContext,
): Promise<ToolExecutionResult> {
  const target = typeof input.target_file === 'string' ? input.target_file : '';
  const resolved = resolveAllowedPath(target, context);
  if (!resolved) {
    return { success: false, error: `Path ${target} is outside the workspace` };
  }
  const content = await readFile(resolved.absolute, 'utf8');
  const lines = content.split('\n');
  const start = typeof input.start_line === 'number' ? Math.max(1, Math.floor(input.start_line)) : 1;
  const end = typeof input.end_line === 'number' ? Math.min(lines.length, Math.floor(input.end_line)) : lines.length;
  const output = lines.slice(start - 1, end).map((line, index) => `${start + index}\t${line}`).join('\n');
  const prefix = start > 1 ? `[Lines 1-${start - 1} not shown]\n` : '';
  const suffix = end < lines.length ? `\n[Lines ${end + 1}-${lines.length} not shown]` : '';
  return { success: true, output: `${prefix}${output}${suffix}`, path: resolved.absolute };
}

async function listWorkspaceDirectory(
  input: Record<string, unknown>,
  context: ToolExecutionContext,
): Promise<ToolExecutionResult> {
  const target = typeof input.path === 'string' ? input.path : '';
  const resolved = resolveAllowedPath(target, context);
  if (!resolved) {
    return { success: false, error: `Path ${target} is outside the workspace` };
  }
  const entries = await readdir(resolved.absolute, { withFileTypes: true });
  const output = entries
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((entry) => `${entry.isDirectory() ? '[dir]' : '[file]'} ${entry.name}`)
    .join('\n');
  return { success: true, output: output || '(empty directory)', path: resolved.absolute };
}

async function grepWorkspace(
  input: Record<string, unknown>,
  context: ToolExecutionContext,
): Promise<ToolExecutionResult> {
  const query = typeof input.query === 'string' ? input.query : '';
  const caseSensitive = input.case_sensitive === true;
  let expression: RegExp;
  try {
    expression = new RegExp(query, caseSensitive ? '' : 'i');
  } catch (error) {
    return { success: false, error: `Invalid regex pattern: ${error instanceof Error ? error.message : String(error)}` };
  }

  const files = await collectFiles(context, 8, 1000);
  const results: string[] = [];
  for (const file of files) {
    if (context.signal.aborted || results.length >= 50) {
      break;
    }
    if (!matchesPattern(file.relative, input.include_pattern) || matchesPattern(file.relative, input.exclude_pattern)) {
      continue;
    }
    const content = await readTextIfSmall(file.absolute);
    if (content === null) {
      continue;
    }
    const lines = content.split('\n');
    for (let index = 0; index < lines.length && results.length < 50; index += 1) {
      expression.lastIndex = 0;
      if (expression.test(lines[index])) {
        results.push(`${file.relative}:${index + 1}: ${lines[index].trim()}`);
      }
    }
  }
  return { success: true, output: results.join('\n') || 'No matches found' };
}

async function searchWorkspaceFiles(
  input: Record<string, unknown>,
  context: ToolExecutionContext,
): Promise<ToolExecutionResult> {
  const query = typeof input.query === 'string' ? input.query.toLowerCase() : '';
  const files = await collectFiles(context, 12, 2000);
  const ranked = files
    .map((file) => ({ file, score: fuzzyScore(file.relative.toLowerCase(), query) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.file.relative.localeCompare(b.file.relative))
    .slice(0, 10);
  return { success: true, output: ranked.map((entry) => entry.file.relative).join('\n') || 'No files found' };
}

async function searchWorkspaceCode(
  input: Record<string, unknown>,
  context: ToolExecutionContext,
): Promise<ToolExecutionResult> {
  const query = typeof input.query === 'string' ? input.query.toLowerCase() : '';
  const terms = query.split(/[^a-z0-9_]+/i).filter(Boolean);
  const requestedDirectories = Array.isArray(input.target_directories)
    ? input.target_directories.filter((value): value is string => typeof value === 'string')
    : [];
  const files = await collectFiles(context, 12, 500);
  const ranked: Array<{ score: number; relative: string; lines: string[] }> = [];

  for (const file of files) {
    if (requestedDirectories.length > 0 && !requestedDirectories.some((directory) => file.relative.startsWith(directory.replace(/\\/g, '/')))) {
      continue;
    }
    const content = await readTextIfSmall(file.absolute);
    if (content === null) {
      continue;
    }
    const lower = content.toLowerCase();
    const score = terms.reduce((total, term) => total + countOccurrences(lower, term), 0) + (lower.includes(query) ? 5 : 0);
    if (score === 0) {
      continue;
    }
    const matchingLines = content.split('\n')
      .map((line, index) => ({ line, index }))
      .filter(({ line }) => terms.some((term) => line.toLowerCase().includes(term)))
      .slice(0, 3)
      .map(({ line, index }) => `  ${index + 1}: ${line}`);
    ranked.push({ score, relative: file.relative, lines: matchingLines });
  }

  ranked.sort((a, b) => b.score - a.score || a.relative.localeCompare(b.relative));
  return {
    success: true,
    output: ranked.slice(0, 20).map((entry) => `${entry.relative} (score: ${entry.score})${entry.lines.length ? `:\n${entry.lines.join('\n')}` : ''}`).join('\n\n') || 'No relevant code found',
  };
}

async function editWorkspaceFile(
  input: Record<string, unknown>,
  context: ToolExecutionContext,
): Promise<ToolExecutionResult> {
  const target = typeof input.target_file === 'string' ? input.target_file : '';
  const diff = typeof input.diff === 'string' ? input.diff : '';
  const resolved = resolveAllowedPath(target, context);
  if (!resolved) {
    return { success: false, error: `Path ${target} is outside the workspace` };
  }
  if (diff.includes('\0')) {
    return { success: false, error: 'Diff contains null bytes' };
  }
  let oldText = '';
  try {
    oldText = await readFile(resolved.absolute, 'utf8');
  } catch {
    oldText = '';
  }
  const newText = applyUnifiedDiff(oldText, diff);
  if (newText === null) {
    return { success: false, error: 'Failed to apply unified diff to file content' };
  }
  await mkdir(path.dirname(resolved.absolute), { recursive: true });
  await writeFile(resolved.absolute, newText, 'utf8');
  return { success: true, output: `File edited: ${resolved.relative}`, path: resolved.absolute, oldText, newText };
}

async function writeWorkspaceFile(
  input: Record<string, unknown>,
  context: ToolExecutionContext,
): Promise<ToolExecutionResult> {
  const target = typeof input.target_file === 'string' ? input.target_file : '';
  const content = typeof input.content === 'string' ? input.content : '';
  const resolved = resolveAllowedPath(target, context);
  if (!resolved) {
    return { success: false, error: `Path ${target} is outside the workspace` };
  }
  if (content.includes('\0')) {
    return { success: false, error: 'Content contains null bytes' };
  }
  let oldText: string | null = null;
  try {
    oldText = await readFile(resolved.absolute, 'utf8');
  } catch {
    oldText = null;
  }
  await mkdir(path.dirname(resolved.absolute), { recursive: true });
  await writeFile(resolved.absolute, content, 'utf8');
  return { success: true, output: `File written: ${resolved.relative}`, path: resolved.absolute, oldText, newText: content };
}

async function deleteWorkspaceFile(
  input: Record<string, unknown>,
  context: ToolExecutionContext,
): Promise<ToolExecutionResult> {
  const target = typeof input.target_file === 'string' ? input.target_file : '';
  const resolved = resolveAllowedPath(target, context);
  if (!resolved) {
    return { success: false, error: `Path ${target} is outside the workspace` };
  }
  const oldText = await readFile(resolved.absolute, 'utf8');
  await unlink(resolved.absolute);
  return { success: true, output: `File deleted: ${resolved.relative}`, path: resolved.absolute, oldText, newText: '' };
}

async function runTerminalCommand(
  input: Record<string, unknown>,
  context: ToolExecutionContext,
): Promise<ToolExecutionResult> {
  const command = typeof input.command === 'string' ? input.command : '';
  if (command.length > MAX_COMMAND_LENGTH) {
    return { success: false, error: `Command length ${command.length} exceeds maximum ${MAX_COMMAND_LENGTH}` };
  }
  if (command.includes('\0')) {
    return { success: false, error: 'Command contains null bytes' };
  }
  if (input.is_background === true) {
    const child = spawn(getShell(), getShellArgs(command), {
      cwd: context.cwd,
      env: process.env,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
    return { success: true, output: 'Background command started' };
  }

  return await new Promise<ToolExecutionResult>((resolve) => {
    const child = spawn(getShell(), getShellArgs(command), {
      cwd: context.cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let output = '';
    let settled = false;
    const timeout = setTimeout(() => {
      child.kill();
      finish({ success: false, output: trimOutput(output), error: 'Command timed out after 60 seconds' });
    }, 60_000);
    const abort = () => {
      child.kill();
      finish({ success: false, output: trimOutput(output), error: 'Command cancelled' });
    };
    const finish = (result: ToolExecutionResult) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      context.signal.removeEventListener('abort', abort);
      resolve(result);
    };
    context.signal.addEventListener('abort', abort, { once: true });
    const consume = (chunk: Buffer) => {
      output = `${output}${chunk.toString('utf8')}`.slice(-MAX_OUTPUT_LENGTH);
      void context.onOutput?.(trimOutput(output));
    };
    child.stdout.on('data', consume);
    child.stderr.on('data', consume);
    child.on('error', (error) => finish({ success: false, output: trimOutput(output), error: error.message }));
    child.on('close', (code) => {
      finish(code === 0 ? { success: true, output: trimOutput(output) || '(no output)' } : { success: false, output: trimOutput(output), error: `Exit code: ${code}` });
    });
  });
}

async function collectFiles(
  context: Pick<ToolExecutionContext, 'cwd' | 'additionalDirectories' | 'signal'>,
  maxDepth: number,
  maxFiles: number,
): Promise<Array<{ absolute: string; relative: string }>> {
  const results: Array<{ absolute: string; relative: string }> = [];
  await collectFilesFromDirectory(context.cwd, context.cwd, 0, maxDepth, maxFiles, context, results);
  for (const directory of context.additionalDirectories) {
    if (results.length >= maxFiles) {
      break;
    }
    await collectFilesFromDirectory(directory, directory, 0, maxDepth, maxFiles, context, results);
  }
  return results;
}

async function collectFilesFromDirectory(
  directory: string,
  root: string,
  depth: number,
  maxDepth: number,
  maxFiles: number,
  context: Pick<ToolExecutionContext, 'signal'>,
  results: Array<{ absolute: string; relative: string }>,
): Promise<void> {
  if (depth > maxDepth || results.length >= maxFiles || context.signal.aborted) {
    return;
  }
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (results.length >= maxFiles || context.signal.aborted || isExcludedName(entry.name)) {
      continue;
    }
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await collectFilesFromDirectory(absolute, root, depth + 1, maxDepth, maxFiles, context, results);
    } else if (entry.isFile()) {
      results.push({ absolute, relative: path.relative(root, absolute).replace(/\\/g, '/') });
    }
  }
}

async function readTextIfSmall(filePath: string): Promise<string | null> {
  try {
    const fileStat = await stat(filePath);
    if (fileStat.size > MAX_FILE_SIZE) {
      return null;
    }
    const content = await readFile(filePath);
    if (content.includes(0)) {
      return null;
    }
    return content.toString('utf8');
  } catch {
    return null;
  }
}

function matchesPattern(filePath: string, pattern: unknown): boolean {
  if (typeof pattern !== 'string' || !pattern.trim()) {
    return false;
  }
  const normalized = pattern.replace(/\\/g, '/');
  const normalizedPattern = normalized.includes('/') || normalized.includes('**') ? normalized : `**/${normalized}`;
  let expression = '^';
  for (let index = 0; index < normalizedPattern.length; index += 1) {
    const character = normalizedPattern[index];
    if (character === '*' && normalizedPattern[index + 1] === '*') {
      index += 2;
      if (normalizedPattern[index] === '/') {
        expression += '(?:.*/)?';
      } else {
        expression += '.*';
        index -= 1;
      }
    } else if (character === '*') {
      expression += '[^/]*';
    } else if (character === '?') {
      expression += '[^/]';
    } else {
      expression += escapeRegExp(character);
    }
  }
  return new RegExp(`${expression}$`, 'i').test(filePath);
}

function fuzzyScore(value: string, query: string): number {
  if (!query) {
    return 0;
  }
  if (value === query) {
    return 100;
  }
  if (value.includes(query)) {
    return 80 - value.length / 1000;
  }
  let queryIndex = 0;
  let score = 0;
  for (const character of value) {
    if (character === query[queryIndex]) {
      queryIndex += 1;
      score += 1;
      if (queryIndex === query.length) {
        return 40 + score;
      }
    }
  }
  return 0;
}

function countOccurrences(value: string, term: string): number {
  let count = 0;
  let index = value.indexOf(term);
  while (index >= 0) {
    count += 1;
    index = value.indexOf(term, index + term.length);
  }
  return count;
}

function trimOutput(value: string): string {
  return value.length > MAX_OUTPUT_LENGTH ? value.slice(-MAX_OUTPUT_LENGTH) : value.trim();
}

async function readPackageInfo(cwd: string): Promise<string> {
  try {
    const content = JSON.parse(await readFile(path.join(cwd, 'package.json'), 'utf8')) as Record<string, unknown>;
    const lines: string[] = [];
    if (typeof content.name === 'string') {
      lines.push(`Name: ${content.name}`);
    }
    if (typeof content.version === 'string') {
      lines.push(`Version: ${content.version}`);
    }
    if (typeof content.description === 'string') {
      lines.push(`Description: ${content.description}`);
    }
    if (isRecord(content.scripts)) {
      lines.push('Scripts:');
      for (const [name, command] of Object.entries(content.scripts).slice(0, 10)) {
        if (typeof command === 'string') {
          lines.push(`  ${name}: ${command}`);
        }
      }
    }
    if (isRecord(content.dependencies)) {
      lines.push(`Dependencies: ${Object.keys(content.dependencies).length} packages`);
    }
    if (isRecord(content.devDependencies)) {
      lines.push(`DevDependencies: ${Object.keys(content.devDependencies).length} packages`);
    }
    return lines.join('\n');
  } catch {
    return '';
  }
}

async function readTsConfigInfo(cwd: string): Promise<string> {
  try {
    const content = JSON.parse(await readFile(path.join(cwd, 'tsconfig.json'), 'utf8')) as Record<string, unknown>;
    const compilerOptions = isRecord(content.compilerOptions) ? content.compilerOptions : {};
    const lines: string[] = [];
    for (const key of ['target', 'module', 'strict', 'outDir']) {
      const value = compilerOptions[key];
      if (typeof value === 'string' || typeof value === 'boolean') {
        lines.push(`${key}: ${value}`);
      }
    }
    if (content.include !== undefined) {
      lines.push(`include: ${JSON.stringify(content.include)}`);
    }
    if (content.exclude !== undefined) {
      lines.push(`exclude: ${JSON.stringify(content.exclude)}`);
    }
    return lines.join('\n');
  } catch {
    return '';
  }
}

async function readGitStatus(cwd: string): Promise<string> {
  try {
    const result = await execFileAsync('git', ['status', '--short', '--branch'], {
      cwd,
      maxBuffer: 50_000,
      windowsHide: true,
    });
    return result.stdout.trim();
  } catch {
    return '';
  }
}

function isExcludedName(name: string): boolean {
  return DEFAULT_EXCLUDES.has(name) || name.endsWith('.log') || name.endsWith('.lock');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getShell(): string {
  return process.platform === 'win32' ? 'powershell.exe' : '/bin/sh';
}

function getShellArgs(command: string): string[] {
  return process.platform === 'win32'
    ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command]
    : ['-lc', command];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object';
}

interface DiffHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: string[];
}

function findHunkIndex(lines: string[], oldLines: string[], expectedIndex: number): number {
  if (oldLines.length === 0) {
    return Math.min(expectedIndex, lines.length);
  }
  if (lines.slice(expectedIndex, expectedIndex + oldLines.length).every((line, index) => line === oldLines[index])) {
    return expectedIndex;
  }
  for (let index = 0; index <= lines.length - oldLines.length; index += 1) {
    if (lines.slice(index, index + oldLines.length).every((line, lineIndex) => line === oldLines[lineIndex])) {
      return index;
    }
  }
  return -1;
}
