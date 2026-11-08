import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import * as vscode from 'vscode';
import type {
	ActionExecutionResult,
	AgentActionShell,
	ApprovalMode,
} from '../../types';
import { getWorkspaceRoot } from '../../utils/workspace';
import {
	containsNullBytes,
	MAX_COMMAND_LENGTH,
} from '../../utils/validation';
import { checkShellCommandSafety } from '../safetyChecker';

/**
 * Detect if output ends with an interactive prompt
 */
function detectInteractivePrompt(output: string): { isPrompt: boolean; promptType: 'yesno' | 'enter' | 'input' | 'select' } {
	const trimmed = output.trimEnd();
	const lastLines = trimmed.split('\n').slice(-10).join('\n');
	const lastLine = trimmed.split('\n').pop() || '';
	
	// Check for arrow-key selection prompts (inquirer, prompts, etc.)
	// These typically show:
	// - "Use arrow-keys" or "arrow keys to move"
	// - ">" marker indicating current selection
	// - Multiple choice options listed
	const selectPatterns = [
		/use arrow[- ]?keys/i,
		/arrow keys to move/i,
		/move up and down to reveal/i,
		/❯|›|▸|▶/,  // Selection indicators
		/>\s+\w+.*\n\s+\w+/,  // ">" followed by option, then another option on next line
	];
	
	for (const pattern of selectPatterns) {
		if (pattern.test(lastLines)) {
			return { isPrompt: true, promptType: 'select' };
		}
	}
	
	// Check for yes/no prompts
	const yesNoPatterns = [
		/\[y\/n\]/i,
		/\(y\/n\)/i,
		/yes\/no/i,
		/\[yes\/no\]/i,
		/\(yes\)/i,
		/\[Y\/n\]/i,
		/\[y\/N\]/i,
		/\(Y\/n\)/i,
		/\(y\/N\)/i,
	];
	
	for (const pattern of yesNoPatterns) {
		if (pattern.test(lastLine)) {
			return { isPrompt: true, promptType: 'yesno' };
		}
	}
	
	// Check for enter prompts
	const enterPatterns = [
		/press enter to continue/i,
		/hit enter to continue/i,
		/press any key/i,
		/return to submit/i,
		/enter to confirm/i,
	];
	
	for (const pattern of enterPatterns) {
		if (pattern.test(lastLines)) {
			return { isPrompt: true, promptType: 'enter' };
		}
	}
	
	// Check for general input prompts (be more conservative here)
	const inputPatterns = [
		/password:\s*$/i,
		/passphrase.*:\s*$/i,
		/enter.*:\s*$/i,
		/input.*:\s*$/i,
	];
	
	for (const pattern of inputPatterns) {
		if (pattern.test(lastLine)) {
			return { isPrompt: true, promptType: 'input' };
		}
	}
	
	return { isPrompt: false, promptType: 'input' };
}

async function executeWithSpawn(
	action: AgentActionShell,
	workspaceRoot: string | undefined,
	onOutput?: (actionDesc: string, output: string) => void,
	abortSignal?: AbortSignal,
	autoRespond: boolean = false
): Promise<ActionExecutionResult> {
	const actionDesc = `Shell: ${action.command.substring(0, 50)}`;
	const isWindows = process.platform === 'win32';
	const shell = isWindows ? 'powershell.exe' : '/bin/sh';
	const shellFlag = isWindows ? '-Command' : '-c';

	return new Promise((resolve) => {
		let combined = '';
		let settled = false;
		let promptDebounceTimer: NodeJS.Timeout | undefined;
		let commandTimeout: NodeJS.Timeout | undefined;

		const child = spawn(shell, [shellFlag, action.command], {
			cwd: workspaceRoot || undefined,
			env: process.env,
			stdio: ['pipe', 'pipe', 'pipe'],
		});

		const finalize = (result: ActionExecutionResult) => {
			if (settled) return;
			settled = true;
			if (commandTimeout) {
				clearTimeout(commandTimeout);
			}
			if (promptDebounceTimer) {
				clearTimeout(promptDebounceTimer);
			}
			if (abortSignal && abortHandler) {
				abortSignal.removeEventListener('abort', abortHandler);
			}
			resolve(result);
		};

		const abortHandler = abortSignal
			? () => {
					child.kill();
					finalize({
						action,
						success: false,
						output: combined.trim() || '(no output)',
						error: 'Command cancelled',
					});
				}
			: undefined;

		if (abortSignal && abortHandler) {
			abortSignal.addEventListener('abort', abortHandler);
		}

		const checkAndRespondToPrompt = () => {
			if (!autoRespond || settled || !child.stdin?.writable) return;
			
			// Debounce: only check if output hasn't changed for 300ms
			if (promptDebounceTimer) {
				clearTimeout(promptDebounceTimer);
			}
			
			promptDebounceTimer = setTimeout(() => {
				if (settled || !child.stdin?.writable) return;
				
				const { isPrompt, promptType } = detectInteractivePrompt(combined);
					
				if (isPrompt) {
					console.log('[Flixa] Auto-responding to interactive prompt:', promptType);
					try {
						if (promptType === 'yesno') {
							child.stdin.write('y\n');
						} else if (promptType === 'enter' || promptType === 'select') {
							// For select prompts, Enter selects the current/first option
							child.stdin.write('\n');
						} else if (promptType === 'input') {
							// For password/passphrase prompts, send empty line to skip or fail gracefully
							child.stdin.write('\n');
						}
					} catch (err) {
						console.log('[Flixa] Failed to write to stdin:', err);
					}
				}
			}, 300);
		};

		child.stdout.on('data', (data: Buffer) => {
			const text = data.toString();
			combined += text;
			if (onOutput) {
				onOutput(actionDesc, combined);
			}
			checkAndRespondToPrompt();
		});

		child.stderr.on('data', (data: Buffer) => {
			const text = data.toString();
			combined += text;
			if (onOutput) {
				onOutput(actionDesc, combined);
			}
			checkAndRespondToPrompt();
		});

		child.on('close', (code) => {
			const output = combined.trim() || '(no output)';
			if (code !== 0) {
				finalize({
					action,
					success: false,
					output,
					error: `Exit code: ${code}`,
				});
			} else {
				finalize({
					action,
					success: true,
					output,
				});
			}
		});

		child.on('error', (err) => {
			finalize({
				action,
				success: false,
				output: combined.trim() || '(no output)',
				error: err.message,
			});
		});

		commandTimeout = setTimeout(() => {
			if (settled) return;
			child.kill();
			finalize({
				action,
				success: false,
				output: combined.trim() || '(no output)',
				error: 'Command timed out after 60 seconds',
			});
		}, 60000);
	});
}

async function executeWithTerminal(
	action: AgentActionShell,
	workspaceRoot: string | undefined,
	abortSignal?: AbortSignal
): Promise<ActionExecutionResult> {
	const isWindows = process.platform === 'win32';
	const shell = isWindows ? 'powershell.exe' : '/bin/sh';
	const exitFilePath = path.join(
		os.tmpdir(),
		`flixa_exit_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`
	);
	const psExitPath = `"${exitFilePath.replace(/`/g, '``').replace(/"/g, '`"')}"`;
	const shExitPath = `"${exitFilePath.replace(/(["\\$`])/g, '\\$1')}"`;

	return new Promise((resolve) => {
		let settled = false;
		let timeout: NodeJS.Timeout | undefined;
		let fileCheckInterval: NodeJS.Timeout | undefined;

		const terminal = vscode.window.createTerminal({
			name: 'Flixa Shell',
			cwd: workspaceRoot || undefined,
			shellPath: shell,
		});

		const finalize = (result: ActionExecutionResult) => {
			if (settled) return;
			settled = true;
			if (abortSignal && abortHandler) {
				abortSignal.removeEventListener('abort', abortHandler);
			}
			if (timeout) {
				clearTimeout(timeout);
			}
			if (fileCheckInterval) {
				clearInterval(fileCheckInterval);
			}
			try {
				if (fs.existsSync(exitFilePath)) {
					fs.unlinkSync(exitFilePath);
				}
			} catch {}
			closeSubscription.dispose();
			resolve(result);
		};

		const abortHandler = abortSignal
			? () => {
					terminal.dispose();
					finalize({
						action,
						success: false,
						error: 'Command cancelled',
					});
				}
			: undefined;

		if (abortSignal && abortHandler) {
			abortSignal.addEventListener('abort', abortHandler);
		}

		const closeSubscription = vscode.window.onDidCloseTerminal((closed) => {
			if (closed !== terminal || settled) return;
			finalize({
				action,
				success: false,
				error: 'Terminal closed',
			});
		});

		timeout = setTimeout(() => {
			if (settled) return;
			terminal.dispose();
			finalize({
				action,
				success: false,
				error: 'Command timed out after 60 seconds',
			});
		}, 60000);

		const exitSuffix = isWindows
			? `; $exitCode = $LASTEXITCODE; Set-Content -Path ${psExitPath} -Value $exitCode`
			: `; exit_code=$?; printf '%s\\n' "$exit_code" > ${shExitPath}`;
		const commandToRun = `${action.command}${exitSuffix}`;

		terminal.show(true);
		terminal.sendText(commandToRun, true);

		fileCheckInterval = setInterval(() => {
			if (settled) return;
			if (!fs.existsSync(exitFilePath)) return;

			let exitCode: number | null = null;
			try {
				const content = fs.readFileSync(exitFilePath, 'utf-8').trim();
				const value = Number.parseInt(content, 10);
				if (!Number.isNaN(value)) {
					exitCode = value;
				}
			} catch {}

			if (exitCode === null) return;

			if (exitCode !== 0) {
				finalize({
					action,
					success: false,
					error: `Exit code: ${exitCode}`,
				});
			} else {
				finalize({
					action,
					success: true,
				});
			}
		}, 200);
	});
}

/**
 * Execute a shell command action.
 *
 * Approval modes:
 * - 'ALL_APPROVE': YOLO mode - execute immediately without any checks
 * - 'AUTO_APPROVE': AI checks if command is safe before execution
 * - 'SAFE_APPROVE': Shell commands need manual approval (handled by executor)
 * - 'MANUAL_APPROVE': All actions need manual approval (handled by executor)
 */
export async function executeShellAction(
	action: AgentActionShell,
	approvalMode: ApprovalMode,
	onOutput?: (actionDesc: string, output: string) => void,
	onSafetyCheck?: (actionDesc: string, checking: boolean) => void,
	abortSignal?: AbortSignal
): Promise<ActionExecutionResult> {
	if (abortSignal?.aborted) {
		return {
			action,
			success: false,
			error: 'Command cancelled',
		};
	}
	console.log('[Flixa] executeShellAction start', action.command, approvalMode);

	// Validate command
	if (action.command.length > MAX_COMMAND_LENGTH) {
		return {
			action,
			success: false,
			error: `Command length ${action.command.length} exceeds maximum ${MAX_COMMAND_LENGTH}`,
		};
	}

	if (containsNullBytes(action.command)) {
		return {
			action,
			success: false,
			error: 'Command contains null bytes',
		};
	}

	if (abortSignal?.aborted) {
		return {
			action,
			success: false,
			error: 'Command cancelled',
		};
	}

	const actionDesc = `Shell: ${action.command.substring(0, 50)}`;
	const workspaceRoot = getWorkspaceRoot() ?? undefined;
	console.log('[Flixa] shell execute', action.command, workspaceRoot || '', approvalMode);

	// AUTO_APPROVE mode: AI checks if command is safe before execution
	if (approvalMode === 'AUTO_APPROVE') {
		if (onSafetyCheck) {
			onSafetyCheck(actionDesc, true);
		}

		const safetyResult = await checkShellCommandSafety(action.command, action.reason);

		if (onSafetyCheck) {
			onSafetyCheck(actionDesc, false);
		}
		if (abortSignal?.aborted) {
			return { action, success: false, error: 'Command cancelled' };
		}

		if (safetyResult.verdict === 'UNSAFE') {
			return {
				action,
				success: false,
				rejected: true,
				rejectionReason: `AI safety check: ${safetyResult.reason}`,
			};
		}

		// Safe - execute with spawn for captured output (with auto-respond enabled)
		return executeWithSpawn(action, workspaceRoot, onOutput, abortSignal, true);
	}

	// ALL_APPROVE (YOLO): Execute immediately with spawn (with auto-respond enabled)
	if (approvalMode === 'ALL_APPROVE') {
		return executeWithSpawn(action, workspaceRoot, onOutput, abortSignal, true);
	}

	// SAFE_APPROVE and MANUAL_APPROVE: Use terminal for visibility
	return executeWithTerminal(action, workspaceRoot, abortSignal);
}
