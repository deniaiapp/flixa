import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import type {
	ActionExecutionResult,
	AgentActionDeleteFile,
	AgentActionEditFile,
	AgentActionWriteFile,
	AgentActionReadFile,
	AgentActionListDir,
	AgentActionGrepSearch,
	AgentActionSearchReplace,
	AgentActionFileSearch,
	AgentActionCodebaseSearch,
	AgentActionEditFileNew,
	AgentActionDeleteFileNew,
} from '../../types';
import { isPathInsideWorkspace, resolveFilePath, getWorkspaceRoot } from '../../utils/workspace';
import { containsNullBytes } from '../../utils/validation';
import { applyDiffToContent } from '../../diff/validator';
import { buildDocumentStats, searchDocuments, type DocumentStats } from '../../search/scorer';

function normalizeGlobPattern(pattern?: string): string | undefined {
	if (!pattern) {
		return undefined;
	}
	const trimmed = pattern.trim();
	if (!trimmed) {
		return undefined;
	}
	if (trimmed.includes('**') || trimmed.includes('/') || trimmed.includes('\\')) {
		return trimmed;
	}
	return `**/${trimmed}`;
}

export async function executeWriteFileAction(
	action: AgentActionWriteFile,
	abortSignal?: AbortSignal
): Promise<ActionExecutionResult> {
	try {
		if (abortSignal?.aborted) {
			return {
				action,
				success: false,
				error: 'Action cancelled',
			};
		}
		console.log('[Flixa] executeWriteFileAction start', action.filePath);
		const resolvedPath = resolveFilePath(action.filePath);

		if (!isPathInsideWorkspace(action.filePath)) {
			return {
				action,
				success: false,
				error: `Path ${action.filePath} is outside workspace`,
			};
		}

		if (containsNullBytes(action.content)) {
			return {
				action,
				success: false,
				error: 'Content contains null bytes',
			};
		}

		const uri = vscode.Uri.file(resolvedPath);
		const content = Buffer.from(action.content, 'utf-8');
		await vscode.workspace.fs.writeFile(uri, content);

		return {
			action,
			success: true,
			output: `File written: ${resolvedPath}`,
		};
	} catch (error) {
		console.log(
			'[Flixa] executeWriteFileAction error',
			action.filePath,
			error instanceof Error ? error.message : String(error)
		);
		return {
			action,
			success: false,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

export async function executeEditFileAction(
	action: AgentActionEditFile,
	abortSignal?: AbortSignal
): Promise<ActionExecutionResult> {
	try {
		if (abortSignal?.aborted) {
			return {
				action,
				success: false,
				error: 'Action cancelled',
			};
		}
		console.log('[Flixa] executeEditFileAction start', action.filePath);
		const resolvedPath = resolveFilePath(action.filePath);

		if (!isPathInsideWorkspace(action.filePath)) {
			return {
				action,
				success: false,
				error: `Path ${action.filePath} is outside workspace`,
			};
		}

		if (containsNullBytes(action.search) || containsNullBytes(action.replace)) {
			return {
				action,
				success: false,
				error: 'Search or replace contains null bytes',
			};
		}

		const uri = vscode.Uri.file(resolvedPath);
		const document = await vscode.workspace.openTextDocument(uri);
		const content = document.getText();

		if (!content.includes(action.search)) {
			return {
				action,
				success: false,
				error: 'Search string not found in file',
			};
		}

		const newContent = content.replace(action.search, action.replace);
		const edit = new vscode.WorkspaceEdit();
		const fullRange = new vscode.Range(
			new vscode.Position(0, 0),
			new vscode.Position(
				document.lineCount - 1,
				document.lineAt(document.lineCount - 1).text.length
			)
		);
		edit.replace(uri, fullRange, newContent);
		await vscode.workspace.applyEdit(edit);

		return {
			action,
			success: true,
			output: `File edited: ${resolvedPath}`,
		};
	} catch (error) {
		console.log(
			'[Flixa] executeEditFileAction error',
			action.filePath,
			error instanceof Error ? error.message : String(error)
		);
		return {
			action,
			success: false,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

export async function executeDeleteFileAction(
	action: AgentActionDeleteFile,
	abortSignal?: AbortSignal
): Promise<ActionExecutionResult> {
	try {
		if (abortSignal?.aborted) {
			return {
				action,
				success: false,
				error: 'Action cancelled',
			};
		}
		console.log('[Flixa] executeDeleteFileAction start', action.filePath);
		const resolvedPath = resolveFilePath(action.filePath);

		if (!isPathInsideWorkspace(action.filePath)) {
			return {
				action,
				success: false,
				error: `Path ${action.filePath} is outside workspace`,
			};
		}

		const uri = vscode.Uri.file(resolvedPath);
		await vscode.workspace.fs.delete(uri);

		return {
			action,
			success: true,
			output: `File deleted: ${resolvedPath}`,
		};
	} catch (error) {
		console.log(
			'[Flixa] executeDeleteFileAction error',
			action.filePath,
			error instanceof Error ? error.message : String(error)
		);
		return {
			action,
			success: false,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

export async function executeReadFileAction(
	action: AgentActionReadFile,
	abortSignal?: AbortSignal
): Promise<ActionExecutionResult> {
	try {
		if (abortSignal?.aborted) {
			return {
				action,
				success: false,
				error: 'Action cancelled',
			};
		}
		console.log('[Flixa] executeReadFileAction start', action.target_file);
		const resolvedPath = resolveFilePath(action.target_file);

		if (!isPathInsideWorkspace(action.target_file)) {
			return {
				action,
				success: false,
				error: `Path ${action.target_file} is outside workspace`,
			};
		}

		const uri = vscode.Uri.file(resolvedPath);
		const document = await vscode.workspace.openTextDocument(uri);
		const content = document.getText();
		const lines = content.split('\n');

		let output: string;
		if (action.should_read_entire_file) {
			output = lines.map((line, i) => `${i + 1}\t${line}`).join('\n');
		} else {
			const start = Math.max(1, action.start_line_one_indexed) - 1;
			const end = Math.min(lines.length, action.end_line_one_indexed_inclusive);
			const selectedLines = lines.slice(start, end);
			output = selectedLines.map((line, i) => `${start + i + 1}\t${line}`).join('\n');

			if (start > 0) {
				output = `[Lines 1-${start} not shown]\n` + output;
			}
			if (end < lines.length) {
				output = output + `\n[Lines ${end + 1}-${lines.length} not shown]`;
			}
		}

		return {
			action,
			success: true,
			output,
		};
	} catch (error) {
		console.log(
			'[Flixa] executeReadFileAction error',
			action.target_file,
			error instanceof Error ? error.message : String(error)
		);
		return {
			action,
			success: false,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

export async function executeListDirAction(
	action: AgentActionListDir,
	abortSignal?: AbortSignal
): Promise<ActionExecutionResult> {
	try {
		if (abortSignal?.aborted) {
			return {
				action,
				success: false,
				error: 'Action cancelled',
			};
		}
		console.log('[Flixa] executeListDirAction start', action.relative_workspace_path);
		const workspaceRoot = getWorkspaceRoot();
		if (!workspaceRoot) {
			return {
				action,
				success: false,
				error: 'No workspace folder open',
			};
		}

		const targetPath = path.join(workspaceRoot, action.relative_workspace_path);

		if (!isPathInsideWorkspace(action.relative_workspace_path)) {
			return {
				action,
				success: false,
				error: `Path ${action.relative_workspace_path} is outside workspace`,
			};
		}

		const uri = vscode.Uri.file(targetPath);
		const entries = await vscode.workspace.fs.readDirectory(uri);

		const output = entries
			.map(([name, type]) => {
				const typeStr = type === vscode.FileType.Directory ? '[dir]' : '[file]';
				return `${typeStr} ${name}`;
			})
			.join('\n');

		return {
			action,
			success: true,
			output,
		};
	} catch (error) {
		console.log(
			'[Flixa] executeListDirAction error',
			action.relative_workspace_path,
			error instanceof Error ? error.message : String(error)
		);
		return {
			action,
			success: false,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

export async function executeGrepSearchAction(
	action: AgentActionGrepSearch,
	abortSignal?: AbortSignal
): Promise<ActionExecutionResult> {
	try {
		if (abortSignal?.aborted) {
			return {
				action,
				success: false,
				error: 'Action cancelled',
			};
		}
		console.log('[Flixa] executeGrepSearchAction start', action.query);
		const workspaceRoot = getWorkspaceRoot();
		if (!workspaceRoot) {
			return {
				action,
				success: false,
				error: 'No workspace folder open',
			};
		}

		const includePattern = normalizeGlobPattern(action.include_pattern) || '**/*';
		const excludePattern =
			normalizeGlobPattern(action.exclude_pattern) || '**/node_modules/**';

		try {
			new RegExp(action.query);
		} catch (error) {
			return {
				action,
				success: false,
				error: `Invalid regex pattern: ${error instanceof Error ? error.message : String(error)}`,
			};
		}

		const results: string[] = [];
		const files = await vscode.workspace.findFiles(includePattern, excludePattern, 200);
		const flags = action.case_sensitive === true ? 'g' : 'gi';
		const searchPattern = new RegExp(action.query, flags);

		for (const file of files) {
			if (abortSignal?.aborted || results.length >= 50) break;
			try {
				const document = await vscode.workspace.openTextDocument(file);
				for (let lineIndex = 0; lineIndex < document.lineCount; lineIndex += 1) {
					if (abortSignal?.aborted || results.length >= 50) break;
					const lineText = document.lineAt(lineIndex).text;
					searchPattern.lastIndex = 0;
					if (!searchPattern.test(lineText)) {
						continue;
					}
					const relativePath = path.relative(workspaceRoot, file.fsPath);
					results.push(`${relativePath}:${lineIndex + 1}: ${lineText.trim()}`);
				}
			} catch {
				// Skip files that can't be read
			}
		}

		return {
			action,
			success: true,
			output: results.length > 0 ? results.join('\n') : 'No matches found',
		};
	} catch (error) {
		console.log(
			'[Flixa] executeGrepSearchAction error',
			action.query,
			error instanceof Error ? error.message : String(error)
		);
		return {
			action,
			success: false,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

export async function executeSearchReplaceAction(
	action: AgentActionSearchReplace,
	abortSignal?: AbortSignal
): Promise<ActionExecutionResult> {
	try {
		if (abortSignal?.aborted) {
			return {
				action,
				success: false,
				error: 'Action cancelled',
			};
		}
		console.log('[Flixa] executeSearchReplaceAction start', action.file_path);
		const resolvedPath = resolveFilePath(action.file_path);

		if (!isPathInsideWorkspace(action.file_path)) {
			return {
				action,
				success: false,
				error: `Path ${action.file_path} is outside workspace`,
			};
		}

		if (containsNullBytes(action.old_string) || containsNullBytes(action.new_string)) {
			return {
				action,
				success: false,
				error: 'Old string or new string contains null bytes',
			};
		}

		const uri = vscode.Uri.file(resolvedPath);
		const document = await vscode.workspace.openTextDocument(uri);
		const content = document.getText();

		if (!content.includes(action.old_string)) {
			return {
				action,
				success: false,
				error: 'Old string not found in file',
			};
		}

		const newContent = content.replace(action.old_string, action.new_string);
		const edit = new vscode.WorkspaceEdit();
		const fullRange = new vscode.Range(
			new vscode.Position(0, 0),
			new vscode.Position(
				document.lineCount - 1,
				document.lineAt(document.lineCount - 1).text.length
			)
		);
		edit.replace(uri, fullRange, newContent);
		await vscode.workspace.applyEdit(edit);

		return {
			action,
			success: true,
			output: `Search and replace completed: ${resolvedPath}`,
		};
	} catch (error) {
		console.log(
			'[Flixa] executeSearchReplaceAction error',
			action.file_path,
			error instanceof Error ? error.message : String(error)
		);
		return {
			action,
			success: false,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

export async function executeFileSearchAction(
	action: AgentActionFileSearch,
	abortSignal?: AbortSignal
): Promise<ActionExecutionResult> {
	try {
		if (abortSignal?.aborted) {
			return {
				action,
				success: false,
				error: 'Action cancelled',
			};
		}
		console.log('[Flixa] executeFileSearchAction start', action.query);
		const workspaceRoot = getWorkspaceRoot();
		if (!workspaceRoot) {
			return {
				action,
				success: false,
				error: 'No workspace folder open',
			};
		}

		const pattern = `**/*${action.query}*`;
		const files = await vscode.workspace.findFiles(pattern, '**/node_modules/**', 10);

		const results = files.map((file) => path.relative(workspaceRoot, file.fsPath));

		return {
			action,
			success: true,
			output: results.length > 0 ? results.join('\n') : 'No files found',
		};
	} catch (error) {
		console.log(
			'[Flixa] executeFileSearchAction error',
			action.query,
			error instanceof Error ? error.message : String(error)
		);
		return {
			action,
			success: false,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

export async function executeCodebaseSearchAction(
	action: AgentActionCodebaseSearch,
	abortSignal?: AbortSignal
): Promise<ActionExecutionResult> {
	try {
		if (abortSignal?.aborted) {
			return {
				action,
				success: false,
				error: 'Action cancelled',
			};
		}
		console.log('[Flixa] executeCodebaseSearchAction start', action.query);
		const workspaceRoot = getWorkspaceRoot();
		if (!workspaceRoot) {
			return {
				action,
				success: false,
				error: 'No workspace folder open',
			};
		}

		const includePattern = action.target_directories?.length
			? `{${action.target_directories.join(',')}}/**/*`
			: '**/*';

		// Exclude common non-code directories
		const excludePattern = '{**/node_modules/**,**/.git/**,**/dist/**,**/out/**,**/build/**,**/*.min.js,**/*.map}';

		const files = await vscode.workspace.findFiles(includePattern, excludePattern, 500);

		// Build document stats for TF-IDF scoring
		const documents: DocumentStats[] = [];

		for (const file of files) {
			if (abortSignal?.aborted) break;

			try {
				// Skip binary and large files
				const stat = await vscode.workspace.fs.stat(file);
				if (stat.size > 100000) continue; // Skip files > 100KB

				const document = await vscode.workspace.openTextDocument(file);

				// Skip binary files by checking if the language is plaintext and content looks binary
				if (document.languageId === 'plaintext') {
					const firstLine = document.lineAt(0).text;
					// Check for null bytes or other control characters indicating binary
					const hasBinaryChars = firstLine.split('').some(
						(c) => {
							const code = c.charCodeAt(0);
							return (code >= 0 && code <= 8) || (code >= 14 && code <= 31);
						}
					);
					if (hasBinaryChars) continue;
				}

				const content = document.getText();
				const relativePath = path.relative(workspaceRoot, file.fsPath);

				documents.push(buildDocumentStats(relativePath, content));
			} catch {
				// Skip files that can't be read
			}
		}

		// Use TF-IDF based search
		const searchResults = searchDocuments(documents, action.query, 20);

		if (searchResults.length === 0) {
			return {
				action,
				success: true,
				output: 'No relevant code found',
			};
		}

		// Format results
		const formattedResults = searchResults.map((result) => {
			const lines = result.matchingLines
				.slice(0, 3)
				.map((line) => `  ${line.lineNumber}: ${line.content}`)
				.join('\n');
			return `${result.filePath} (score: ${result.score.toFixed(1)}):\n${lines}`;
		});

		return {
			action,
			success: true,
			output: formattedResults.join('\n\n'),
		};
	} catch (error) {
		console.log(
			'[Flixa] executeCodebaseSearchAction error',
			action.query,
			error instanceof Error ? error.message : String(error)
		);
		return {
			action,
			success: false,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

export async function executeEditFileNewAction(
	action: AgentActionEditFileNew,
	abortSignal?: AbortSignal
): Promise<ActionExecutionResult> {
	try {
		if (abortSignal?.aborted) {
			return {
				action,
				success: false,
				error: 'Action cancelled',
			};
		}
		console.log('[Flixa] executeEditFileNewAction start', action.target_file);
		console.log('[Flixa] executeEditFileNewAction diff:\n', action.diff);
		const resolvedPath = resolveFilePath(action.target_file);

		if (!isPathInsideWorkspace(action.target_file)) {
			return {
				action,
				success: false,
				error: `Path ${action.target_file} is outside workspace`,
			};
		}

		if (containsNullBytes(action.diff)) {
			return {
				action,
				success: false,
				error: 'Diff contains null bytes',
			};
		}

		const uri = vscode.Uri.file(resolvedPath);

		let existingContent = '';
		try {
			const document = await vscode.workspace.openTextDocument(uri);
			existingContent = document.getText();
		} catch {
			// File doesn't exist, will create new
		}

		// Apply the unified diff
		const newContent = applyDiffToContent(existingContent, action.diff);

		if (newContent === null) {
			return {
				action,
				success: false,
				error: 'Failed to apply diff to file content',
			};
		}

		const content = Buffer.from(newContent, 'utf-8');
		await vscode.workspace.fs.writeFile(uri, content);

		return {
			action,
			success: true,
			output: `File edited: ${resolvedPath}`,
		};
	} catch (error) {
		console.log(
			'[Flixa] executeEditFileNewAction error',
			action.target_file,
			error instanceof Error ? error.message : String(error)
		);
		return {
			action,
			success: false,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

export async function executeDeleteFileNewAction(
	action: AgentActionDeleteFileNew,
	abortSignal?: AbortSignal
): Promise<ActionExecutionResult> {
	try {
		if (abortSignal?.aborted) {
			return {
				action,
				success: false,
				error: 'Action cancelled',
			};
		}
		console.log('[Flixa] executeDeleteFileNewAction start', action.target_file);
		const resolvedPath = resolveFilePath(action.target_file);

		if (!isPathInsideWorkspace(action.target_file)) {
			return {
				action,
				success: false,
				error: `Path ${action.target_file} is outside workspace`,
			};
		}

		const uri = vscode.Uri.file(resolvedPath);
		await vscode.workspace.fs.delete(uri);

		return {
			action,
			success: true,
			output: `File deleted: ${resolvedPath}`,
		};
	} catch (error) {
		console.log(
			'[Flixa] executeDeleteFileNewAction error',
			action.target_file,
			error instanceof Error ? error.message : String(error)
		);
		return {
			action,
			success: false,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}
