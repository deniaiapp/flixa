import { describe, it, expect } from 'vitest';
import {
	MAX_COMMAND_LENGTH,
	containsNullBytes,
	validateCommandLength,
	validateNoNullBytes,
} from './validation';

describe('containsNullBytes', () => {
	it('should return false for regular string', () => {
		expect(containsNullBytes('hello world')).toBe(false);
	});

	it('should return false for empty string', () => {
		expect(containsNullBytes('')).toBe(false);
	});

	it('should return true for string with null byte', () => {
		expect(containsNullBytes('hello\0world')).toBe(true);
	});

	it('should return true for string starting with null byte', () => {
		expect(containsNullBytes('\0hello')).toBe(true);
	});

	it('should return true for string ending with null byte', () => {
		expect(containsNullBytes('hello\0')).toBe(true);
	});

	it('should return true for string with multiple null bytes', () => {
		expect(containsNullBytes('a\0b\0c')).toBe(true);
	});

	it('should return false for string with other special characters', () => {
		expect(containsNullBytes('hello\n\t\rworld')).toBe(false);
	});
});

describe('validateCommandLength', () => {
	it('should return valid for short command', () => {
		const result = validateCommandLength('npm test');
		expect(result.valid).toBe(true);
		expect(result.error).toBeUndefined();
	});

	it('should return valid for empty command', () => {
		const result = validateCommandLength('');
		expect(result.valid).toBe(true);
	});

	it('should return valid for command at exactly max length', () => {
		const command = 'x'.repeat(MAX_COMMAND_LENGTH);
		const result = validateCommandLength(command);
		expect(result.valid).toBe(true);
	});

	it('should return invalid for command exceeding max length', () => {
		const command = 'x'.repeat(MAX_COMMAND_LENGTH + 1);
		const result = validateCommandLength(command);
		expect(result.valid).toBe(false);
		expect(result.error).toContain('exceeds maximum');
		expect(result.error).toContain(String(MAX_COMMAND_LENGTH + 1));
		expect(result.error).toContain(String(MAX_COMMAND_LENGTH));
	});

	it('should report correct length in error message', () => {
		const command = 'x'.repeat(6000);
		const result = validateCommandLength(command);
		expect(result.error).toContain('6000');
	});
});

describe('validateNoNullBytes', () => {
	it('should return valid for regular string', () => {
		const result = validateNoNullBytes('hello world', 'testField');
		expect(result.valid).toBe(true);
		expect(result.error).toBeUndefined();
	});

	it('should return valid for empty string', () => {
		const result = validateNoNullBytes('', 'testField');
		expect(result.valid).toBe(true);
	});

	it('should return invalid for string with null byte', () => {
		const result = validateNoNullBytes('hello\0world', 'testField');
		expect(result.valid).toBe(false);
		expect(result.error).toBe('testField contains null bytes');
	});

	it('should include field name in error message', () => {
		const result = validateNoNullBytes('test\0', 'filePath');
		expect(result.error).toBe('filePath contains null bytes');
	});

	it('should include different field name in error message', () => {
		const result = validateNoNullBytes('test\0', 'content');
		expect(result.error).toBe('content contains null bytes');
	});
});

describe('MAX_COMMAND_LENGTH', () => {
	it('should be 5000', () => {
		expect(MAX_COMMAND_LENGTH).toBe(5000);
	});
});
