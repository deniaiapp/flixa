import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { getWorkspaceRoot } from '../utils/workspace';

export interface AutoContextConfig {
	enabled: boolean;
	includeFileList: boolean;
	includeGitStatus: boolean;
	includePackageInfo: boolean;
	includeTsConfig: boolean;
	maxFileListDepth: number;
	maxFiles: number;
	excludePatterns: string[];
}

export interface AutoContextData {
	fileList: string[];
	gitStatus: string;
	packageInfo: string;
	tsConfig: string;
}

const DEFAULT_EXCLUDE_PATTERNS = [
	'node_modules',
	'.git',
	'dist',
	'out',
	'build',
	'.next',
	'.nuxt',
	'coverage',
	'.cache',
	'.vscode',
	'.idea',
	'__pycache__',
	'.pytest_cache',
	'*.log',
	'*.lock',
	'package-lock.json',
	'yarn.lock',
	'pnpm-lock.yaml',
	'bun.lockb',
];

export function getAutoContextConfig(): AutoContextConfig {
	const config = vscode.workspace.getConfiguration('flixa');
	return {
		enabled: config.get<boolean>('autoContext.enabled', true),
		includeFileList: config.get<boolean>('autoContext.includeFileList', true),
		includeGitStatus: config.get<boolean>('autoContext.includeGitStatus', true),
		includePackageInfo: config.get<boolean>('autoContext.includePackageInfo', true),
		includeTsConfig: config.get<boolean>('autoContext.includeTsConfig', true),
		maxFileListDepth: config.get<number>('autoContext.maxFileListDepth', 4),
		maxFiles: config.get<number>('autoContext.maxFiles', 500),
		excludePatterns: config.get<string[]>('autoContext.excludePatterns', DEFAULT_EXCLUDE_PATTERNS),
	};
}

function shouldExclude(name: string, excludePatterns: string[]): boolean {
	for (const pattern of excludePatterns) {
		if (pattern.startsWith('*')) {
			const ext = pattern.slice(1);
			if (name.endsWith(ext)) {
				return true;
			}
		} else if (name === pattern) {
			return true;
		}
	}
	return false;
}

function collectFiles(
	dirPath: string,
	basePath: string,
	depth: number,
	maxDepth: number,
	maxFiles: number,
	excludePatterns: string[],
	result: string[]
): void {
	if (depth > maxDepth || result.length >= maxFiles) {
		return;
	}

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dirPath, { withFileTypes: true });
	} catch {
		return;
	}

	entries.sort((a, b) => {
		if (a.isDirectory() && !b.isDirectory()) {
			return -1;
		}
		if (!a.isDirectory() && b.isDirectory()) {
			return 1;
		}
		return a.name.localeCompare(b.name);
	});

	for (const entry of entries) {
		if (result.length >= maxFiles) {
			break;
		}

		if (shouldExclude(entry.name, excludePatterns)) {
			continue;
		}

		const relativePath = path.relative(basePath, path.join(dirPath, entry.name));
		const prefix = entry.isDirectory() ? '📁 ' : '  ';
		result.push(prefix + relativePath.replace(/\\/g, '/'));

		if (entry.isDirectory()) {
			collectFiles(
				path.join(dirPath, entry.name),
				basePath,
				depth + 1,
				maxDepth,
				maxFiles,
				excludePatterns,
				result
			);
		}
	}
}

async function getFileList(config: AutoContextConfig): Promise<string[]> {
	const workspaceRoot = getWorkspaceRoot();
	if (!workspaceRoot) {
		return [];
	}

	const result: string[] = [];
	collectFiles(
		workspaceRoot,
		workspaceRoot,
		0,
		config.maxFileListDepth,
		config.maxFiles,
		config.excludePatterns,
		result
	);

	return result;
}

async function getGitStatus(): Promise<string> {
	const workspaceRoot = getWorkspaceRoot();
	if (!workspaceRoot) {
		return '';
	}

	try {
		const gitExtension = vscode.extensions.getExtension('vscode.git');
		if (!gitExtension) {
			return '';
		}

		const git = gitExtension.exports.getAPI(1);
		if (!git || git.repositories.length === 0) {
			return '';
		}

		const repo = git.repositories[0];
		const state = repo.state;

		const lines: string[] = [];

		if (state.HEAD?.name) {
			lines.push(`Branch: ${state.HEAD.name}`);
		}

		if (state.workingTreeChanges && state.workingTreeChanges.length > 0) {
			lines.push('Modified:');
			for (const change of state.workingTreeChanges.slice(0, 20)) {
				const relativePath = path.relative(workspaceRoot, change.uri.fsPath);
				lines.push(`  M ${relativePath.replace(/\\/g, '/')}`);
			}
			if (state.workingTreeChanges.length > 20) {
				lines.push(`  ... and ${state.workingTreeChanges.length - 20} more`);
			}
		}

		if (state.indexChanges && state.indexChanges.length > 0) {
			lines.push('Staged:');
			for (const change of state.indexChanges.slice(0, 20)) {
				const relativePath = path.relative(workspaceRoot, change.uri.fsPath);
				lines.push(`  S ${relativePath.replace(/\\/g, '/')}`);
			}
			if (state.indexChanges.length > 20) {
				lines.push(`  ... and ${state.indexChanges.length - 20} more`);
			}
		}

		if (state.untrackedChanges && state.untrackedChanges.length > 0) {
			lines.push('Untracked:');
			for (const change of state.untrackedChanges.slice(0, 20)) {
				const relativePath = path.relative(workspaceRoot, change.uri.fsPath);
				lines.push(`  ? ${relativePath.replace(/\\/g, '/')}`);
			}
			if (state.untrackedChanges.length > 20) {
				lines.push(`  ... and ${state.untrackedChanges.length - 20} more`);
			}
		}

		return lines.join('\n');
	} catch {
		return '';
	}
}

async function getPackageInfo(): Promise<string> {
	const workspaceRoot = getWorkspaceRoot();
	if (!workspaceRoot) {
		return '';
	}

	const packageJsonPath = path.join(workspaceRoot, 'package.json');
	try {
		const content = fs.readFileSync(packageJsonPath, 'utf-8');
		const pkg = JSON.parse(content);

		const lines: string[] = [];
		if (pkg.name) {
			lines.push(`Name: ${pkg.name}`);
		}
		if (pkg.version) {
			lines.push(`Version: ${pkg.version}`);
		}
		if (pkg.description) {
			lines.push(`Description: ${pkg.description}`);
		}

		if (pkg.scripts && Object.keys(pkg.scripts).length > 0) {
			lines.push('Scripts:');
			for (const [name, cmd] of Object.entries(pkg.scripts).slice(0, 10)) {
				lines.push(`  ${name}: ${cmd}`);
			}
			if (Object.keys(pkg.scripts).length > 10) {
				lines.push(`  ... and ${Object.keys(pkg.scripts).length - 10} more`);
			}
		}

		if (pkg.dependencies && Object.keys(pkg.dependencies).length > 0) {
			lines.push(`Dependencies: ${Object.keys(pkg.dependencies).length} packages`);
		}
		if (pkg.devDependencies && Object.keys(pkg.devDependencies).length > 0) {
			lines.push(`DevDependencies: ${Object.keys(pkg.devDependencies).length} packages`);
		}

		return lines.join('\n');
	} catch {
		return '';
	}
}

async function getTsConfig(): Promise<string> {
	const workspaceRoot = getWorkspaceRoot();
	if (!workspaceRoot) {
		return '';
	}

	const tsConfigPath = path.join(workspaceRoot, 'tsconfig.json');
	try {
		const content = fs.readFileSync(tsConfigPath, 'utf-8');
		const tsConfig = JSON.parse(content);

		const lines: string[] = [];
		const compilerOptions = tsConfig.compilerOptions || {};

		if (compilerOptions.target) {
			lines.push(`Target: ${compilerOptions.target}`);
		}
		if (compilerOptions.module) {
			lines.push(`Module: ${compilerOptions.module}`);
		}
		if (compilerOptions.strict !== undefined) {
			lines.push(`Strict: ${compilerOptions.strict}`);
		}
		if (compilerOptions.outDir) {
			lines.push(`OutDir: ${compilerOptions.outDir}`);
		}
		if (tsConfig.include) {
			lines.push(`Include: ${JSON.stringify(tsConfig.include)}`);
		}
		if (tsConfig.exclude) {
			lines.push(`Exclude: ${JSON.stringify(tsConfig.exclude)}`);
		}

		return lines.join('\n');
	} catch {
		return '';
	}
}

export async function gatherAutoContext(): Promise<AutoContextData> {
	const config = getAutoContextConfig();

	if (!config.enabled) {
		return {
			fileList: [],
			gitStatus: '',
			packageInfo: '',
			tsConfig: '',
		};
	}

	const [fileList, gitStatus, packageInfo, tsConfig] = await Promise.all([
		config.includeFileList ? getFileList(config) : Promise.resolve([]),
		config.includeGitStatus ? getGitStatus() : Promise.resolve(''),
		config.includePackageInfo ? getPackageInfo() : Promise.resolve(''),
		config.includeTsConfig ? getTsConfig() : Promise.resolve(''),
	]);

	return {
		fileList,
		gitStatus,
		packageInfo,
		tsConfig,
	};
}

export function formatAutoContext(data: AutoContextData): string {
	const sections: string[] = [];

	if (data.packageInfo) {
		sections.push(`## Project Info\n${data.packageInfo}`);
	}

	if (data.tsConfig) {
		sections.push(`## TypeScript Config\n${data.tsConfig}`);
	}

	if (data.gitStatus) {
		sections.push(`## Git Status\n${data.gitStatus}`);
	}

	if (data.fileList.length > 0) {
		sections.push(`## File Structure\n${data.fileList.join('\n')}`);
	}

	if (sections.length === 0) {
		return '';
	}

	return `# Workspace Context\n\n${sections.join('\n\n')}`;
}
