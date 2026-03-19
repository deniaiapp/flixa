import * as vscode from 'vscode';
import type { ChatContext, ChatHistoryMessage, SessionMessage, SerializedActionResult, AutoContextData } from '../types';
import { gatherAutoContext } from '../autoContext';
import { getWorkspaceRoot } from '../utils/workspace';
import * as fs from 'fs/promises';
import * as path from 'path';

export interface ChatMessage {
	role: 'user' | 'assistant' | 'system' | 'result' | 'executing';
	content: string;
	results?: SerializedActionResult[];
	executingAction?: string;
	executingOutput?: string;
}

export function extractMentionReferences(userMessage: string): string[] {
	const matches = userMessage.match(/@([A-Za-z0-9_./\\-]+)/g) ?? [];
	return [...new Set(matches.map((match) => match.slice(1)))];
}

async function readReferencedFile(filePath: string): Promise<string | null> {
	try {
		return await fs.readFile(filePath, 'utf8');
	} catch {
		return null;
	}
}

async function resolveMentionReference(reference: string): Promise<{ reference: string; filePath: string; content: string } | null> {
	const workspaceRoot = getWorkspaceRoot();
	if (!workspaceRoot) {
		return null;
	}

	const normalizedReference = reference.replace(/\\/g, '/');
	const directPath = path.resolve(workspaceRoot, normalizedReference);
	const directContent = await readReferencedFile(directPath);
	if (directContent !== null) {
		return {
			reference,
			filePath: directPath,
			content: directContent,
		};
	}

	const basename = path.posix.basename(normalizedReference);
	if (!basename) {
		return null;
	}

	const matches = await vscode.workspace.findFiles(
		`**/${basename}`,
		'**/{node_modules,.git,out,dist,build}/**',
		20
	);
	const exactRelativeMatch = matches.find((uri) => {
		const relativePath = path.relative(workspaceRoot, uri.fsPath).replace(/\\/g, '/');
		return relativePath === normalizedReference;
	});
	const target = exactRelativeMatch ?? matches[0];
	if (!target) {
		return null;
	}

	const content = await readReferencedFile(target.fsPath);
	if (content === null) {
		return null;
	}

	return {
		reference,
		filePath: target.fsPath,
		content,
	};
}

export async function resolveMentionedFiles(userMessage: string): Promise<Array<{ reference: string; filePath: string; content: string }>> {
	const references = extractMentionReferences(userMessage);
	const resolved = await Promise.all(references.map((reference) => resolveMentionReference(reference)));
	return resolved.filter((item): item is { reference: string; filePath: string; content: string } => item !== null);
}

export async function gatherChatContext(
	userMessage: string,
	getMessages: () => ChatMessage[],
	getSessionMessages: () => SessionMessage[]
): Promise<ChatContext> {
	const editor = vscode.window.activeTextEditor;

	let activeSelection = '';
	let activeFileText = '';
	let activeFilePath = '';
	let languageId = '';
	const diagnostics: string[] = [];
	let gitDiff = '';

	if (editor) {
		const document = editor.document;
		activeFilePath = document.uri.fsPath;
		languageId = document.languageId;
		activeFileText = document.getText();

		if (!editor.selection.isEmpty) {
			activeSelection = document.getText(editor.selection);
		}

		const fileDiagnostics = vscode.languages.getDiagnostics(document.uri);
		for (const diag of fileDiagnostics) {
			diagnostics.push(
				`Line ${diag.range.start.line + 1}: ${diag.message} (${vscode.DiagnosticSeverity[diag.severity]})`
			);
		}
	}

	try {
		const workspaceFolders = vscode.workspace.workspaceFolders;
		if (workspaceFolders && workspaceFolders.length > 0) {
			const gitExtension = vscode.extensions.getExtension('vscode.git');
			if (gitExtension) {
				const git = gitExtension.exports.getAPI(1);
				if (git.repositories.length > 0) {
					const repo = git.repositories[0];
					gitDiff = (await repo.diff()) || '';
				}
			}
		}
	} catch {
		gitDiff = '';
	}

	const history: ChatHistoryMessage[] = getMessages()
		.filter((m) => m.role === 'user' || m.role === 'assistant')
		.map((m) => ({
			role: m.role as 'user' | 'assistant',
			content: m.content,
		}));

	const sessionMessages = getSessionMessages();
	const mentionedFiles =
		[...sessionMessages]
			.reverse()
			.find((message) => message.role === 'user' && message.content === userMessage)?.mentionedFiles ?? [];

	const autoContext = await gatherAutoContext();

	return {
		userMessage,
		activeSelection,
		activeFileText,
		activeFilePath,
		languageId,
		diagnostics,
		gitDiff,
		history,
		sessionMessages,
		autoContext,
		mentionedFiles,
	};
}
