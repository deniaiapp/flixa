import { generateText } from "ai";
import * as vscode from "vscode";
import { log } from "../logger";
import { getFlixaProvider } from "../llm/stub";
import type { SafetyCheckResult } from "../types";

function getModel(): string {
	const config = vscode.workspace.getConfiguration("flixa");
	return config.get<string>("model") || "openai/gpt-6-luna";
}

export async function checkShellCommandSafety(
	command: string,
	aiReason?: string,
): Promise<SafetyCheckResult> {
	const flixa = getFlixaProvider();
	const model = getModel();

	const aiReasonSection = aiReason 
		? `\n## AI's stated reason for this command:\n${aiReason}\n\nConsider this context when making your decision. If the AI has provided a valid development-related reason, lean towards SAFE.\n`
		: '';

	const prompt = `You are a security validation AI for a developer's local workspace.

Your job is to determine if a shell command is SAFE to execute. Be LENIENT for typical development workflows.

## SAFE commands (always allow):
- Package managers: npm, yarn, pnpm, bun, pip, cargo, go, etc.
- Build tools: make, cmake, tsc, webpack, vite, esbuild, etc.
- Linters & formatters: eslint, prettier, biome, black, ruff, etc.
- Test runners: jest, vitest, pytest, cargo test, go test, etc.
- Version control: git (non-destructive operations)
- Language runtimes: node, python, ruby, go run, cargo run, etc.
- File operations within the project: mkdir, cp, mv, rm (non-system paths)
- Development servers: npm run dev, yarn start, etc.

## UNSAFE commands (reject):
- System-level modifications: rm -rf /, chmod 777 /, modifying /etc, /usr, /bin
- Network attacks: curl piped to bash from untrusted sources, reverse shells
- Credential theft: accessing ~/.ssh, ~/.aws, ~/.gnupg without clear dev purpose
- Destructive git: git push --force to main/master, git reset --hard on shared branches
- Privilege escalation: sudo for non-dev tasks
- Crypto mining, malware download, data exfiltration

## Guidelines:
- If the command is a standard development task, mark it SAFE
- Only mark UNSAFE if there's clear malicious intent or system damage risk
- When in doubt for dev-related commands, lean towards SAFE
${aiReasonSection}
Reply in JSON only:
{
  "verdict": "SAFE" | "UNSAFE",
  "reason": string
}

Command:
${command}`;

	log('[Flixa] safety check prompt to AI:', prompt);

	try {
		const { text } = await generateText({
			model: flixa(model),
			prompt,
		});

		log('[Flixa] safety check AI response:', text);

		let responseText = text.trim();
		if (responseText.startsWith("```json")) {
			responseText = responseText
				.replace(/^```json\n?/, "")
				.replace(/\n?```$/, "");
		} else if (responseText.startsWith("```")) {
			responseText = responseText.replace(/^```\n?/, "").replace(/\n?```$/, "");
		}

		try {
			const parsed = JSON.parse(responseText);
			if (
				parsed &&
				typeof parsed === "object" &&
				(parsed.verdict === "SAFE" || parsed.verdict === "UNSAFE") &&
				typeof parsed.reason === "string"
			) {
				return {
					verdict: parsed.verdict,
					reason: parsed.reason,
				};
			}
		} catch {
			// JSON parse failed
		}

		return {
			verdict: "UNSAFE",
			reason: "Failed to parse safety check response",
		};
	} catch (error) {
		return {
			verdict: "UNSAFE",
			reason: `Safety check error: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}
