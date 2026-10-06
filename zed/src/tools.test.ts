import { describe, expect, test } from 'bun:test';
import { applyUnifiedDiff, isObviouslyUnsafeCommand } from './tools.js';

describe('applyUnifiedDiff', () => {
  test('applies a standard replacement hunk', () => {
    const original = 'const first = 1;\nconst second = 2;\n';
    const diff = [
      '--- a/example.ts',
      '+++ b/example.ts',
      '@@ -1,2 +1,2 @@',
      '-const first = 1;',
      '+const first = 3;',
      ' const second = 2;',
      '',
    ].join('\n');

    expect(applyUnifiedDiff(original, diff)).toBe('const first = 3;\nconst second = 2;\n');
  });

  test('applies an insertion hunk', () => {
    const original = 'second\n';
    const diff = [
      '--- a/example.txt',
      '+++ b/example.txt',
      '@@ -1,0 +1,1 @@',
      '+first',
      '',
    ].join('\n');

    expect(applyUnifiedDiff(original, diff)).toBe('first\nsecond\n');
  });

  test('rejects a hunk with mismatched context', () => {
    const diff = ['--- a/example.ts', '+++ b/example.ts', '@@ -1,1 +1,1 @@', '-missing', '+replacement', ''].join('\n');

    expect(applyUnifiedDiff('actual\n', diff)).toBeNull();
  });
});

test('identifies obviously unsafe commands', () => {
  expect(isObviouslyUnsafeCommand('rm -rf /')).toBe(true);
  expect(isObviouslyUnsafeCommand('bun test')).toBe(false);
});
