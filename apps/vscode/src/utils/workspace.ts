import * as path from 'path';
import * as vscode from 'vscode';

export function getWorkspaceRoot(): string | null {
	const workspaceFolders = vscode.workspace.workspaceFolders;
	if (workspaceFolders && workspaceFolders.length > 0) {
		return workspaceFolders[0].uri.fsPath;
	}
	return null;
}

export function isPathInsideWorkspace(filePath: string): boolean {
	const workspaceRoot = getWorkspaceRoot();
	if (!workspaceRoot) {
		return false;
	}
	const normalizedPath = path.normalize(path.resolve(workspaceRoot, filePath));
	const normalizedWorkspace = path.normalize(workspaceRoot);
	const relativePath = path.relative(normalizedWorkspace, normalizedPath);
	return relativePath === '' || (
		relativePath !== '..' &&
		!relativePath.startsWith(`..${path.sep}`) &&
		!path.isAbsolute(relativePath)
	);
}

export function resolveFilePath(filePath: string): string {
	const workspaceRoot = getWorkspaceRoot();
	if (!workspaceRoot) {
		throw new Error('No workspace folder open');
	}
	if (path.isAbsolute(filePath)) {
		return filePath;
	}
	return path.join(workspaceRoot, filePath);
}
