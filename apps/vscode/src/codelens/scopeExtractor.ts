import * as vscode from "vscode";
import type { ScopeInfo } from "../types";

export async function extractScope(
	document: vscode.TextDocument,
	commentLine: number,
): Promise<ScopeInfo> {
	const supportedLanguages = [
		"typescript",
		"typescriptreact",
		"javascript",
		"javascriptreact",
		"python",
		"java",
		"csharp",
		"cpp",
		"c",
		"go",
		"rust",
		"ruby",
		"php",
		"swift",
		"kotlin",
		"html",
		"css",
	];

	if (supportedLanguages.includes(document.languageId)) {
		const symbols = await vscode.commands.executeCommand<
			vscode.DocumentSymbol[]
		>("vscode.executeDocumentSymbolProvider", document.uri);

		if (symbols && symbols.length > 0) {
			const scope = findContainingSymbol(symbols, commentLine);
			if (scope) {
				return scope;
			}
		}
	}

	return getFallbackScope(document, commentLine);
}

function findContainingSymbol(
	symbols: vscode.DocumentSymbol[],
	line: number,
): ScopeInfo | null {
	for (const symbol of symbols) {
		if (symbol.range.start.line <= line && symbol.range.end.line >= line) {
			if (
				symbol.kind === vscode.SymbolKind.Function ||
				symbol.kind === vscode.SymbolKind.Method
			) {
				return {
					range: symbol.range,
					text: "",
					type: "function",
				};
			}

			if (symbol.children && symbol.children.length > 0) {
				const childScope = findContainingSymbol(symbol.children, line);
				if (childScope) {
					return childScope;
				}
			}

			if (symbol.kind === vscode.SymbolKind.Class) {
				return {
					range: symbol.range,
					text: "",
					type: "class",
				};
			}

			if (
				symbol.kind === vscode.SymbolKind.Module ||
				symbol.kind === vscode.SymbolKind.Namespace
			) {
				return {
					range: symbol.range,
					text: "",
					type: "module",
				};
			}
		}
	}
	return null;
}

function getFallbackScope(
	document: vscode.TextDocument,
	commentLine: number,
): ScopeInfo {
	const startLine = Math.max(0, commentLine - 60);
	const endLine = Math.min(document.lineCount - 1, commentLine + 60);

	const range = new vscode.Range(
		new vscode.Position(startLine, 0),
		new vscode.Position(endLine, document.lineAt(endLine).text.length),
	);

	return {
		range,
		text: document.getText(range),
		type: "fallback",
	};
}

export function getScopeText(
	document: vscode.TextDocument,
	scopeInfo: ScopeInfo,
): string {
	if (scopeInfo.text) {
		return scopeInfo.text;
	}
	return document.getText(scopeInfo.range);
}
