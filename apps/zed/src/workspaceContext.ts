import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export interface WorkspaceContextOptions {
  cwd: string;
  additionalDirectories: string[];
  signal: AbortSignal;
}

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

export async function getWorkspaceContext(context: WorkspaceContextOptions): Promise<string> {
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

async function collectFiles(
  context: WorkspaceContextOptions,
  maxDepth: number,
  maxFiles: number,
): Promise<Array<{ absolute: string; relative: string }>> {
  const results: Array<{ absolute: string; relative: string }> = [];
  await collectFilesFromDirectory(
    context.cwd,
    context.cwd,
    0,
    maxDepth,
    maxFiles,
    context,
    results,
  );
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
  context: Pick<WorkspaceContextOptions, 'signal'>,
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
      await collectFilesFromDirectory(
        absolute,
        root,
        depth + 1,
        maxDepth,
        maxFiles,
        context,
        results,
      );
    } else if (entry.isFile()) {
      results.push({ absolute, relative: path.relative(root, absolute).replace(/\\/g, '/') });
    }
  }
}

async function readPackageInfo(cwd: string): Promise<string> {
  try {
    const content = JSON.parse(await readFile(path.join(cwd, 'package.json'), 'utf8')) as Record<
      string,
      unknown
    >;
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
    const content = JSON.parse(await readFile(path.join(cwd, 'tsconfig.json'), 'utf8')) as Record<
      string,
      unknown
    >;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object';
}
