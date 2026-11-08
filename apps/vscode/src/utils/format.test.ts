import { describe, it, expect } from 'vitest';
import { describeToolCall, formatSessionResults, generateNonce } from './format';
import type { SerializedActionResult } from '../types';

describe('describeToolCall', () => {
  it('labels shell commands as terminal actions and truncates them', () => {
    expect(describeToolCall('Bash', { command: 'npm test' })).toBe('Terminal: npm test');
    expect(describeToolCall('Bash', { command: 'x'.repeat(80) })).toBe(
      `Terminal: ${'x'.repeat(50)}`,
    );
  });

  it('labels file tools with their path', () => {
    expect(describeToolCall('Read', { file_path: 'src/a.ts' })).toBe('Read: src/a.ts');
    expect(describeToolCall('Write', { file_path: 'b.ts' })).toBe('Write: b.ts');
    expect(describeToolCall('Edit', { file_path: 'c.ts' })).toBe('Edit: c.ts');
    expect(describeToolCall('Delete', { file_path: 'd.ts' })).toBe('Delete: d.ts');
    expect(describeToolCall('LS', {})).toBe('List Dir: .');
  });

  it('labels searches with their pattern', () => {
    expect(describeToolCall('Grep', { pattern: 'TODO' })).toBe('Grep: TODO');
    expect(describeToolCall('Glob', { pattern: '*.ts' })).toBe('Glob: *.ts');
    expect(describeToolCall('Glob', {})).toBe('Glob: **/*');
  });

  it('falls back to the tool name', () => {
    expect(describeToolCall('Unknown', {})).toBe('Unknown');
  });
});

describe('formatSessionResults', () => {
  it('should format successful results', () => {
    const results: SerializedActionResult[] = [{ action: 'Shell: npm test', success: true }];
    const formatted = formatSessionResults(results);

    expect(formatted).toContain('[Action Results]');
    expect(formatted).toContain('[SUCCESS] Shell: npm test');
    expect(formatted).toContain('Continue with the next steps or finish if done.');
  });

  it('should format successful results with output', () => {
    const results: SerializedActionResult[] = [
      { action: 'Shell: npm test', success: true, output: 'All tests passed' },
    ];
    const formatted = formatSessionResults(results);

    expect(formatted).toContain('[SUCCESS] Shell: npm test');
    expect(formatted).toContain('Output: All tests passed');
  });

  it('should format failed results', () => {
    const results: SerializedActionResult[] = [
      { action: 'Shell: npm test', success: false, error: 'Tests failed' },
    ];
    const formatted = formatSessionResults(results);

    expect(formatted).toContain('[FAILED] Shell: npm test: Tests failed');
  });

  it('should format failed results with output', () => {
    const results: SerializedActionResult[] = [
      {
        action: 'Shell: npm test',
        success: false,
        error: 'Exit code 1',
        output: 'Error details',
      },
    ];
    const formatted = formatSessionResults(results);

    expect(formatted).toContain('[FAILED] Shell: npm test: Exit code 1');
    expect(formatted).toContain('Output: Error details');
  });

  it('should format rejected results', () => {
    const results: SerializedActionResult[] = [
      {
        action: 'Shell: rm -rf /',
        success: false,
        rejected: true,
        rejectionReason: 'Dangerous command',
      },
    ];
    const formatted = formatSessionResults(results);

    expect(formatted).toContain('[REJECTED] Shell: rm -rf /: Dangerous command');
  });

  it('should include long output', () => {
    const longOutput = 'x'.repeat(5000);
    const results: SerializedActionResult[] = [
      { action: 'Shell: npm test', success: true, output: longOutput },
    ];
    const formatted = formatSessionResults(results);

    expect(formatted).toContain('Output:');
    expect(formatted).toContain(longOutput);
  });

  it('should include empty output marker for output actions', () => {
    const results: SerializedActionResult[] = [
      { action: 'Shell: npm test', success: true, output: '' },
    ];
    const formatted = formatSessionResults(results);

    expect(formatted).toContain('Output: <no files or terminal output>');
  });

  it('should include empty output marker for whitespace-only output actions', () => {
    const results: SerializedActionResult[] = [
      { action: 'Shell: npm test', success: true, output: '   \n  ' },
    ];
    const formatted = formatSessionResults(results);

    expect(formatted).toContain('Output: <no files or terminal output>');
  });

  it('should normalize "(no output)" marker for output actions', () => {
    const results: SerializedActionResult[] = [
      { action: 'Shell: npm test', success: true, output: '(no output)' },
    ];
    const formatted = formatSessionResults(results);

    expect(formatted).toContain('Output: <no files or terminal output>');
  });

  it('should format multiple results', () => {
    const results: SerializedActionResult[] = [
      { action: 'Shell: npm test', success: true },
      { action: 'Write: test.ts', success: true },
      { action: 'Shell: npm build', success: false, error: 'Build failed' },
    ];
    const formatted = formatSessionResults(results);

    expect(formatted).toContain('[SUCCESS] Shell: npm test');
    expect(formatted).toContain('[SUCCESS] Write: test.ts');
    expect(formatted).toContain('[FAILED] Shell: npm build: Build failed');
  });
});

describe('generateNonce', () => {
  it('should generate 32 character string', () => {
    const nonce = generateNonce();
    expect(nonce).toHaveLength(32);
  });

  it('should only contain alphanumeric characters', () => {
    const nonce = generateNonce();
    expect(nonce).toMatch(/^[A-Za-z0-9]+$/);
  });

  it('should generate unique values', () => {
    const nonces = new Set<string>();
    for (let i = 0; i < 100; i++) {
      nonces.add(generateNonce());
    }
    expect(nonces.size).toBe(100);
  });
});
