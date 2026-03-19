import * as vscode from 'vscode';

export interface ScopeInfo {
	range: vscode.Range;
	text: string;
	type: 'function' | 'class' | 'module' | 'fallback';
}

export interface ImplementRequest {
	fullFileText: string;
	scopeRange: { startLine: number; endLine: number };
	scopeText: string;
	commentPayload: string;
	filePath: string;
	languageId: string;
}

export interface ReferencedContextFile {
	reference: string;
	filePath: string;
	content: string;
}

export interface ChatHistoryMessage {
	role: 'user' | 'assistant';
	content: string;
}

export interface SerializedActionResult {
	action: string;
	success: boolean;
	output?: string;
	error?: string;
	rejected?: boolean;
	rejectionReason?: string;
}

export interface SessionMessage {
	role: 'user' | 'assistant' | 'system' | 'result';
	content: string;
	results?: SerializedActionResult[];
	activeSelection?: string;
	activeFilePath?: string;
	activeSelectionLabel?: string;
	mentionedFiles?: ReferencedContextFile[];
}

export interface AutoContextData {
	fileList: string[];
	gitStatus: string;
	packageInfo: string;
	tsConfig: string;
}

export interface ChatContext {
	userMessage: string;
	activeSelection: string;
	activeFileText: string;
	activeFilePath: string;
	languageId: string;
	diagnostics: string[];
	gitDiff: string;
	history: ChatHistoryMessage[];
	sessionMessages: SessionMessage[];
	autoContext: AutoContextData;
	mentionedFiles: ReferencedContextFile[];
}

export interface LLMResponse {
	type: 'message' | 'diff' | 'full';
	message: string;
	diff?: string;
	newContent?: string;
}
