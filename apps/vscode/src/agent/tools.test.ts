import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { agentTools, SAFE_TOOLS, SENSITIVE_TOOLS } from './tools';

describe('agentTools', () => {
	describe('codebase_search tool', () => {
		it('should have correct description', () => {
			expect(agentTools.codebase_search.description).toContain('semantic search');
		});

		it('should have inputSchema defined', () => {
			expect(agentTools.codebase_search.inputSchema).toBeDefined();
		});
	});

	describe('read_file tool', () => {
		it('should have correct description', () => {
			expect(agentTools.read_file.description).toContain('Read the contents');
		});

		it('should have inputSchema defined', () => {
			expect(agentTools.read_file.inputSchema).toBeDefined();
		});
	});

	describe('list_dir tool', () => {
		it('should have correct description', () => {
			expect(agentTools.list_dir.description).toContain('List the contents');
		});

		it('should have inputSchema defined', () => {
			expect(agentTools.list_dir.inputSchema).toBeDefined();
		});
	});

	describe('grep_search tool', () => {
		it('should have correct description', () => {
			expect(agentTools.grep_search.description).toContain('regex search');
		});

		it('should have inputSchema defined', () => {
			expect(agentTools.grep_search.inputSchema).toBeDefined();
		});
	});

	describe('file_search tool', () => {
		it('should have correct description', () => {
			expect(agentTools.file_search.description).toContain('fuzzy matching');
		});

		it('should have inputSchema defined', () => {
			expect(agentTools.file_search.inputSchema).toBeDefined();
		});
	});

	describe('edit_file tool', () => {
		it('should have correct description', () => {
			expect(agentTools.edit_file.description).toContain('Edit');
		});

		it('should have inputSchema defined', () => {
			expect(agentTools.edit_file.inputSchema).toBeDefined();
		});
	});

	describe('write_file tool', () => {
		it('should have correct description', () => {
			expect(agentTools.write_file.description).toContain('Create a new file');
		});

		it('should have inputSchema defined', () => {
			expect(agentTools.write_file.inputSchema).toBeDefined();
		});
	});

	describe('delete_file tool', () => {
		it('should have correct description', () => {
			expect(agentTools.delete_file.description).toContain('Delete');
		});

		it('should have inputSchema defined', () => {
			expect(agentTools.delete_file.inputSchema).toBeDefined();
		});
	});

	describe('run_terminal_cmd tool', () => {
		it('should have correct description', () => {
			expect(agentTools.run_terminal_cmd.description).toContain('terminal command');
		});

		it('should have inputSchema defined', () => {
			expect(agentTools.run_terminal_cmd.inputSchema).toBeDefined();
		});
	});

	describe('tool names', () => {
		it('should have all expected tools', () => {
			const toolNames = Object.keys(agentTools);
			expect(toolNames).toContain('codebase_search');
			expect(toolNames).toContain('read_file');
			expect(toolNames).toContain('list_dir');
			expect(toolNames).toContain('grep_search');
			expect(toolNames).toContain('file_search');
			expect(toolNames).toContain('edit_file');
			expect(toolNames).toContain('write_file');
			expect(toolNames).toContain('delete_file');
			expect(toolNames).toContain('run_terminal_cmd');
		});

		it('should have exactly 9 tools', () => {
			expect(Object.keys(agentTools)).toHaveLength(9);
		});
	});

	describe('SAFE_TOOLS', () => {
		it('should contain read/search tools', () => {
			expect(SAFE_TOOLS).toContain('read_file');
			expect(SAFE_TOOLS).toContain('list_dir');
			expect(SAFE_TOOLS).toContain('codebase_search');
			expect(SAFE_TOOLS).toContain('grep_search');
			expect(SAFE_TOOLS).toContain('file_search');
		});

		it('should have exactly 5 safe tools', () => {
			expect(SAFE_TOOLS).toHaveLength(5);
		});
	});

	describe('SENSITIVE_TOOLS', () => {
		it('should contain write/execute tools', () => {
			expect(SENSITIVE_TOOLS).toContain('edit_file');
			expect(SENSITIVE_TOOLS).toContain('write_file');
			expect(SENSITIVE_TOOLS).toContain('delete_file');
			expect(SENSITIVE_TOOLS).toContain('run_terminal_cmd');
		});

		it('should have exactly 4 sensitive tools', () => {
			expect(SENSITIVE_TOOLS).toHaveLength(4);
		});
	});
});

describe('tool schemas validation', () => {
	const codebaseSearchSchema = z.object({
		query: z.string(),
		target_directories: z.array(z.string()).optional(),
	});

	const readFileSchema = z.object({
		target_file: z.string(),
		start_line: z.number().optional(),
		end_line: z.number().optional(),
	});

	const listDirSchema = z.object({
		path: z.string(),
	});

	const grepSearchSchema = z.object({
		query: z.string(),
		case_sensitive: z.boolean().optional(),
		include_pattern: z.string().optional(),
		exclude_pattern: z.string().optional(),
	});

	const fileSearchSchema = z.object({
		query: z.string(),
	});

	const editFileSchema = z.object({
		target_file: z.string(),
		instructions: z.string(),
		code_edit: z.string(),
	});

	const writeFileSchema = z.object({
		target_file: z.string(),
		content: z.string(),
	});

	const deleteFileSchema = z.object({
		target_file: z.string(),
	});

	const runTerminalCmdSchema = z.object({
		command: z.string(),
		is_background: z.boolean().optional(),
	});

	describe('codebase_search schema', () => {
		it('should validate valid input', () => {
			const result = codebaseSearchSchema.safeParse({ query: 'error handling' });
			expect(result.success).toBe(true);
		});

		it('should validate with target_directories', () => {
			const result = codebaseSearchSchema.safeParse({
				query: 'test',
				target_directories: ['src/', 'lib/'],
			});
			expect(result.success).toBe(true);
		});

		it('should reject missing query', () => {
			const result = codebaseSearchSchema.safeParse({});
			expect(result.success).toBe(false);
		});
	});

	describe('read_file schema', () => {
		it('should validate with file only', () => {
			const result = readFileSchema.safeParse({ target_file: 'test.ts' });
			expect(result.success).toBe(true);
		});

		it('should validate with line ranges', () => {
			const result = readFileSchema.safeParse({
				target_file: 'test.ts',
				start_line: 1,
				end_line: 50,
			});
			expect(result.success).toBe(true);
		});

		it('should reject missing target_file', () => {
			const result = readFileSchema.safeParse({ start_line: 1 });
			expect(result.success).toBe(false);
		});
	});

	describe('list_dir schema', () => {
		it('should validate valid input', () => {
			const result = listDirSchema.safeParse({ path: 'src/' });
			expect(result.success).toBe(true);
		});

		it('should reject missing path', () => {
			const result = listDirSchema.safeParse({});
			expect(result.success).toBe(false);
		});
	});

	describe('grep_search schema', () => {
		it('should validate with query only', () => {
			const result = grepSearchSchema.safeParse({ query: 'function.*test' });
			expect(result.success).toBe(true);
		});

		it('should validate with all options', () => {
			const result = grepSearchSchema.safeParse({
				query: 'test',
				case_sensitive: true,
				include_pattern: '*.ts',
				exclude_pattern: '*.test.ts',
			});
			expect(result.success).toBe(true);
		});

		it('should reject missing query', () => {
			const result = grepSearchSchema.safeParse({ case_sensitive: true });
			expect(result.success).toBe(false);
		});
	});

	describe('file_search schema', () => {
		it('should validate valid input', () => {
			const result = fileSearchSchema.safeParse({ query: 'component' });
			expect(result.success).toBe(true);
		});

		it('should reject missing query', () => {
			const result = fileSearchSchema.safeParse({});
			expect(result.success).toBe(false);
		});
	});

	describe('edit_file schema', () => {
		it('should validate valid input', () => {
			const result = editFileSchema.safeParse({
				target_file: 'test.ts',
				instructions: 'Update the constant',
				code_edit: 'const x = 2',
			});
			expect(result.success).toBe(true);
		});

		it('should reject missing target_file', () => {
			const result = editFileSchema.safeParse({ instructions: 'old', code_edit: 'new' });
			expect(result.success).toBe(false);
		});

		it('should reject missing instructions', () => {
			const result = editFileSchema.safeParse({ target_file: 'test.ts', code_edit: 'new' });
			expect(result.success).toBe(false);
		});

		it('should reject missing code_edit', () => {
			const result = editFileSchema.safeParse({ target_file: 'test.ts', instructions: 'old' });
			expect(result.success).toBe(false);
		});
	});

	describe('write_file schema', () => {
		it('should validate valid input', () => {
			const result = writeFileSchema.safeParse({
				target_file: 'test.ts',
				content: 'export const x = 1;',
			});
			expect(result.success).toBe(true);
		});

		it('should reject missing target_file', () => {
			const result = writeFileSchema.safeParse({ content: 'test' });
			expect(result.success).toBe(false);
		});

		it('should reject missing content', () => {
			const result = writeFileSchema.safeParse({ target_file: 'test.ts' });
			expect(result.success).toBe(false);
		});

		it('should allow empty content', () => {
			const result = writeFileSchema.safeParse({ target_file: 'test.ts', content: '' });
			expect(result.success).toBe(true);
		});
	});

	describe('delete_file schema', () => {
		it('should validate valid input', () => {
			const result = deleteFileSchema.safeParse({ target_file: 'test.ts' });
			expect(result.success).toBe(true);
		});

		it('should reject missing target_file', () => {
			const result = deleteFileSchema.safeParse({});
			expect(result.success).toBe(false);
		});
	});

	describe('run_terminal_cmd schema', () => {
		it('should validate with command only', () => {
			const result = runTerminalCmdSchema.safeParse({ command: 'npm test' });
			expect(result.success).toBe(true);
		});

		it('should validate with is_background', () => {
			const result = runTerminalCmdSchema.safeParse({
				command: 'npm start',
				is_background: true,
			});
			expect(result.success).toBe(true);
		});

		it('should reject missing command', () => {
			const result = runTerminalCmdSchema.safeParse({ is_background: true });
			expect(result.success).toBe(false);
		});

		it('should reject non-string command', () => {
			const result = runTerminalCmdSchema.safeParse({ command: 123 });
			expect(result.success).toBe(false);
		});
	});
});
