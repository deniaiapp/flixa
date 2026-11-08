import { tool } from 'ai';
import { z } from 'zod';

/**
 * Agent tools following Cursor's tool specification.
 * These tools do NOT have execute functions - we handle tool calls manually
 * to apply approval modes and security checks.
 *
 * Tool categories:
 * - Read: read_file, list_dir (no approval needed)
 * - Search: codebase_search, grep_search, file_search (no approval needed)
 * - Write: edit_file, write_file, delete_file (may need approval)
 * - Execute: run_terminal_cmd (may need approval)
 */
export const agentTools = {
	/**
	 * Semantic search - finds code by meaning, not just exact matches
	 */
	codebase_search: tool({
		description:
			'Find snippets of code from the codebase most relevant to the search query. This is a semantic search tool, so the query should ask for something semantically matching what is needed. If it makes sense to only search in particular directories, please specify them in the target_directories field. Unless there is a clear reason to use your own search query, please just reuse the user\'s exact query with their wording.',
		inputSchema: z.object({
			query: z.string().describe('The search query to find relevant code.'),
			target_directories: z
				.array(z.string())
				.optional()
				.describe('Glob patterns for directories to search over'),
		}),
	}),

	/**
	 * Read file contents with line range support
	 */
	read_file: tool({
		description:
			'Read the contents of a file. You can read a specific range of lines or the entire file. When reading a range, results include line numbers. Reading entire files is allowed but should be used sparingly for large files.',
		inputSchema: z.object({
			target_file: z
				.string()
				.describe(
					'The path of the file to read. Can be relative to workspace or absolute.'
				),
			start_line: z
				.number()
				.int()
				.optional()
				.describe('The one-indexed line number to start reading from (inclusive).'),
			end_line: z
				.number()
				.int()
				.optional()
				.describe('The one-indexed line number to end reading at (inclusive).'),
		}),
	}),

	/**
	 * List directory contents
	 */
	list_dir: tool({
		description:
			'List the contents of a directory. Quick tool for discovery before using more targeted tools like semantic search or file reading. Useful for understanding file structure.',
		inputSchema: z.object({
			path: z
				.string()
				.describe('Path to list contents of, relative to the workspace root.'),
		}),
	}),

	/**
	 * Regex search using ripgrep
	 */
	grep_search: tool({
		description:
			'Fast exact regex search over text files using ripgrep. Results are capped at 50 matches. Use include/exclude patterns to filter by file type. Always escape special regex characters.',
		inputSchema: z.object({
			query: z.string().describe('The regex pattern to search for'),
			case_sensitive: z
				.boolean()
				.optional()
				.describe('Whether the search should be case sensitive'),
			include_pattern: z
				.string()
				.optional()
				.describe("Glob pattern for files to include (e.g. '*.ts')"),
			exclude_pattern: z
				.string()
				.optional()
				.describe('Glob pattern for files to exclude'),
		}),
	}),

	/**
	 * Fuzzy file name search
	 */
	file_search: tool({
		description:
			"Fast file search based on fuzzy matching against file path. Use if you know part of the file path but don't know where it's located exactly. Response capped to 10 results.",
		inputSchema: z.object({
			query: z.string().describe('Fuzzy filename to search for'),
		}),
	}),

	/**
	 * Edit file with unified diff format
	 */
	edit_file: tool({
		description:
			'Edit an existing file using unified diff format. Provide the changes as a unified diff (like git diff output). The diff should include context lines for accurate matching. Use this for precise, surgical edits to existing files.',
		inputSchema: z.object({
			target_file: z
				.string()
				.describe(
					'The target file to modify. Can be relative to workspace or absolute.'
				),
			instructions: z
				.string()
				.describe(
					'A single sentence describing what you are doing. Use first person.'
				),
			diff: z
				.string()
				.describe(
					'The unified diff to apply. Must include @@ line numbers and context lines for accurate matching.'
				),
		}),
	}),

	/**
	 * Create or overwrite file
	 */
	write_file: tool({
		description:
			'Create a new file or completely overwrite an existing file with new content. Use this when you need to create a new file or replace all content. Prefer edit_file for targeted changes.',
		inputSchema: z.object({
			target_file: z
				.string()
				.describe('Path to the file, relative to workspace root'),
			content: z.string().describe('The complete content to write to the file'),
		}),
	}),

	/**
	 * Delete file
	 */
	delete_file: tool({
		description:
			"Delete a file at the specified path. The operation will fail gracefully if the file doesn't exist or cannot be deleted.",
		inputSchema: z.object({
			target_file: z
				.string()
				.describe('The path of the file to delete, relative to the workspace root.'),
		}),
	}),

	/**
	 * Run terminal command
	 */
	run_terminal_cmd: tool({
		description:
			'Run a terminal command. The user will see the command and must approve it before execution. For long-running commands, set is_background to true. Do not use interactive commands or commands requiring user input. For commands that use a pager, append ` | cat`. Do not include newlines in the command.',
		inputSchema: z.object({
			command: z.string().describe('The terminal command to execute'),
			is_background: z
				.boolean()
				.optional()
				.describe('Whether to run the command in the background'),
		}),
	}),
};

export type AgentToolName = keyof typeof agentTools;

/**
 * List of tool names that never require approval (read/search operations)
 */
export const SAFE_TOOLS: AgentToolName[] = [
	'read_file',
	'list_dir',
	'codebase_search',
	'grep_search',
	'file_search',
];

/**
 * List of tool names that may require approval (write/execute operations)
 */
export const SENSITIVE_TOOLS: AgentToolName[] = [
	'edit_file',
	'write_file',
	'delete_file',
	'run_terminal_cmd',
];
