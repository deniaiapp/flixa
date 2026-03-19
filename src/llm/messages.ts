import type { ChatContext, SerializedActionResult } from '../types';
import { log } from '../logger';
import { formatSessionResults } from '../utils/format';
import { formatAutoContext } from '../autoContext';

function buildReferencedFilesText(
	mentionedFiles?: Array<{ reference: string; filePath: string; content: string }>
): string {
	if (!mentionedFiles || mentionedFiles.length === 0) {
		return '';
	}

	return mentionedFiles
		.map(
			(file) =>
				`Referenced file (${file.reference}): ${file.filePath}\n\`\`\`\n${file.content}\n\`\`\``
		)
		.join('\n\n');
}

function buildUserContextText(
	message: { activeSelection?: string; activeFilePath?: string; mentionedFiles?: Array<{ reference: string; filePath: string; content: string }> }
): string {
	let content = '';

	if (message.activeSelection) {
		if (message.activeFilePath) {
			content += `Selected code from ${message.activeFilePath}:\n\`\`\`\n${message.activeSelection}\n\`\`\`\n\n`;
		} else {
			content += `Selected code:\n\`\`\`\n${message.activeSelection}\n\`\`\`\n\n`;
		}
	}

	const referencedFilesText = buildReferencedFilesText(message.mentionedFiles);
	if (referencedFilesText) {
		content += `${referencedFilesText}\n\n`;
	}

	return content;
}

export function buildChatMessages(
	context: ChatContext
): Array<{ role: 'user' | 'assistant'; content: string }> {
	const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [];

	let isFirstUserMessage = true;
	for (const msg of context.sessionMessages) {
		if (msg.role === 'user') {
			if (isFirstUserMessage) {
				isFirstUserMessage = false;
				let content = `User message: ${msg.content}\n\n`;

				const autoContextText = formatAutoContext(context.autoContext);
				if (autoContextText) {
					content += `${autoContextText}\n\n`;
				}

				if (context.activeFilePath) {
					content += `Active file: ${context.activeFilePath}\nLanguage: ${context.languageId}\n\n`;
				}
				content += buildUserContextText({
					activeSelection: msg.activeSelection ?? context.activeSelection,
					activeFilePath: msg.activeFilePath ?? context.activeFilePath,
					mentionedFiles: msg.mentionedFiles ?? context.mentionedFiles,
				});
				if (context.activeFileText) {
					content += `Full file content:\n\`\`\`\n${context.activeFileText}\n\`\`\`\n\n`;
				}
				if (context.diagnostics.length > 0) {
					content += `Current diagnostics/problems:\n${context.diagnostics.join('\n')}\n\n`;
				}
				if (context.gitDiff) {
					content += `Current git diff:\n\`\`\`\n${context.gitDiff}\n\`\`\`\n\n`;
				}
				messages.push({ role: 'user', content });
			} else {
				messages.push({
					role: 'user',
					content: `${msg.content}\n\n${buildUserContextText(msg)}`.trim(),
				});
			}
		} else if (msg.role === 'assistant') {
			messages.push({ role: 'assistant', content: msg.content });
		} else if (msg.role === 'result' && msg.results) {
			const resultsText = formatSessionResults(msg.results);
			messages.push({ role: 'user', content: resultsText });
		}
	}

	return messages;
}

export function buildAgentMessages(
	context: ChatContext
): Array<{ role: 'user' | 'assistant'; content: string }> {
	const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [];

	let isFirstUserMessage = true;
	for (const msg of context.sessionMessages) {
		if (msg.role === 'user') {
			if (isFirstUserMessage) {
				isFirstUserMessage = false;
				let content = `User request: ${msg.content}\n\n`;

				const autoContextText = formatAutoContext(context.autoContext);
				if (autoContextText) {
					content += `${autoContextText}\n\n`;
				}

				if (context.activeFilePath) {
					content += `Active file: ${context.activeFilePath}\nLanguage: ${context.languageId}\n\n`;
				}
				content += buildUserContextText({
					activeSelection: msg.activeSelection ?? context.activeSelection,
					activeFilePath: msg.activeFilePath ?? context.activeFilePath,
					mentionedFiles: msg.mentionedFiles ?? context.mentionedFiles,
				});
				if (context.activeFileText) {
					content += `Full file content:\n\`\`\`\n${context.activeFileText}\n\`\`\`\n\n`;
				}
				messages.push({ role: 'user', content });
			} else {
				messages.push({
					role: 'user',
					content: `${msg.content}\n\n${buildUserContextText(msg)}`.trim(),
				});
			}
		} else if (msg.role === 'assistant') {
			if (msg.content.startsWith('[Agent - Step')) {
				continue;
			}
			messages.push({ role: 'assistant', content: msg.content });
		} else if (msg.role === 'result' && msg.results) {
			const resultsText = formatSessionResults(msg.results);
			log('[Flixa] agent result message to AI:', resultsText);
			messages.push({ role: 'user', content: resultsText });
		}
	}

	return messages;
}
