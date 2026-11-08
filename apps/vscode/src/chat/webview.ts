import * as path from 'path';
import * as vscode from 'vscode';
import { generateNonce } from '../utils/format';

export function getWebviewHtml(
	webview: vscode.Webview,
	extensionUri: vscode.Uri
): string {
	const webviewUiBuildPath = path.join(
		extensionUri.fsPath,
		'webview-ui',
		'build'
	);

	const scriptUri = webview.asWebviewUri(
		vscode.Uri.file(path.join(webviewUiBuildPath, 'assets', 'index.js'))
	);
	const styleUri = webview.asWebviewUri(
		vscode.Uri.file(path.join(webviewUiBuildPath, 'assets', 'index.css'))
	);

	const nonce = generateNonce();

	return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src data: blob:;">
  <link rel="stylesheet" href="${styleUri}">
  <title>Flixa Chat</title>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}
