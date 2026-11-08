import * as vscode from 'vscode';

let outputChannel: vscode.OutputChannel | null = null;

export function setOutputChannel(channel: vscode.OutputChannel): void {
	outputChannel = channel;
}

export function log(...args: unknown[]): void {
	const message = args
		.map((arg) =>
			typeof arg === 'string' ? arg : JSON.stringify(arg, null, 2)
		)
		.join(' ');

	if (outputChannel) {
		outputChannel.appendLine(message);
	}
	console.log(...args);
}
