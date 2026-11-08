import { describe, it, expect } from 'vitest';
import { validateDiff, parseDiff, applyDiffToContent } from './validator';

describe('validateDiff', () => {
	const validDiff = `--- a/test.ts
+++ b/test.ts
@@ -1,3 +1,3 @@
 const x = 1;
-const y = 2;
+const y = 3;
 const z = 3;`;

	it('should validate a valid diff for chat flow', () => {
		const result = validateDiff(validDiff, 'chat', 'test.ts');
		expect(result.valid).toBe(true);
		expect(result.error).toBeUndefined();
	});

	it('should reject empty diff', () => {
		const result = validateDiff('', 'chat', 'test.ts');
		expect(result.valid).toBe(false);
		expect(result.error).toBe('Empty diff received');
	});

	it('should reject whitespace-only diff', () => {
		const result = validateDiff('   \n  ', 'chat', 'test.ts');
		expect(result.valid).toBe(false);
		expect(result.error).toBe('Empty diff received');
	});

	it('should reject unparseable diff', () => {
		const result = validateDiff('not a valid diff', 'chat', 'test.ts');
		expect(result.valid).toBe(false);
		expect(result.error).toBe('Failed to parse unified diff');
	});

	it('should reject diff touching multiple files', () => {
		const multiFileDiff = `--- a/file1.ts
+++ b/file1.ts
@@ -1 +1 @@
-old
+new
--- a/file2.ts
+++ b/file2.ts
@@ -1 +1 @@
-old
+new`;
		const result = validateDiff(multiFileDiff, 'chat', 'file1.ts');
		expect(result.valid).toBe(false);
		expect(result.error).toContain('Diff must touch exactly one file');
	});

	it('should reject diff for wrong file in chat flow', () => {
		const result = validateDiff(validDiff, 'chat', 'other.ts');
		expect(result.valid).toBe(false);
		expect(result.error).toContain('does not match active file');
	});

	it('should accept diff matching active file by name', () => {
		const result = validateDiff(validDiff, 'chat', '/path/to/test.ts');
		expect(result.valid).toBe(true);
	});

	it('should validate scope range in codelens flow', () => {
		const result = validateDiff(validDiff, 'codelens', 'test.ts', {
			startLine: 0,
			endLine: 3,
		});
		expect(result.valid).toBe(true);
	});

	it('should reject diff outside scope range in codelens flow', () => {
		const diffAtLine10 = `--- a/test.ts
+++ b/test.ts
@@ -10,3 +10,3 @@
 const x = 1;
-const y = 2;
+const y = 3;
 const z = 3;`;
		const result = validateDiff(diffAtLine10, 'codelens', 'test.ts', {
			startLine: 0,
			endLine: 5,
		});
		expect(result.valid).toBe(false);
		expect(result.error).toContain('outside the scope range');
	});

	it('should reject diff exceeding 400 changed lines', () => {
		let largeDiff = `--- a/test.ts
+++ b/test.ts
@@ -1,401 +1,401 @@
`;
		for (let i = 0; i < 401; i++) {
			largeDiff += `-line ${i}\n`;
		}
		const result = validateDiff(largeDiff, 'chat', 'test.ts');
		expect(result.valid).toBe(false);
		expect(result.error).toContain('exceeds limit of 400');
	});

	it('should reject binary patches', () => {
		const binaryDiff = `--- a/test.png
+++ b/test.png
Binary files a/test.png and b/test.png differ`;
		const result = validateDiff(binaryDiff, 'chat', 'test.png');
		expect(result.valid).toBe(false);
		expect(result.error).toBe('Binary patches are not supported');
	});

	it('should reject GIT binary patch', () => {
		const binaryDiff = `--- a/test.png
+++ b/test.png
GIT binary patch
literal 1234`;
		const result = validateDiff(binaryDiff, 'chat', 'test.png');
		expect(result.valid).toBe(false);
		expect(result.error).toBe('Binary patches are not supported');
	});
});

describe('parseDiff', () => {
	it('should parse a valid unified diff', () => {
		const diff = `--- a/test.ts
+++ b/test.ts
@@ -1,3 +1,4 @@
 const x = 1;
+const y = 2;
 const z = 3;
 export {};`;

		const parsed = parseDiff(diff);

		expect(parsed).not.toBeNull();
		expect(parsed!.oldFile).toBe('test.ts');
		expect(parsed!.newFile).toBe('test.ts');
		expect(parsed!.hunks).toHaveLength(1);
		expect(parsed!.hunks[0].oldStart).toBe(1);
		expect(parsed!.hunks[0].oldCount).toBe(3);
		expect(parsed!.hunks[0].newStart).toBe(1);
		expect(parsed!.hunks[0].newCount).toBe(4);
	});

	it('should parse multiple hunks', () => {
		const diff = `--- a/test.ts
+++ b/test.ts
@@ -1,2 +1,2 @@
 const x = 1;
-const y = 2;
+const y = 3;
@@ -10,2 +10,2 @@
 const a = 1;
-const b = 2;
+const b = 3;`;

		const parsed = parseDiff(diff);

		expect(parsed).not.toBeNull();
		expect(parsed!.hunks).toHaveLength(2);
		expect(parsed!.hunks[0].oldStart).toBe(1);
		expect(parsed!.hunks[1].oldStart).toBe(10);
	});

	it('should handle hunk header without count (defaults to 1)', () => {
		const diff = `--- a/test.ts
+++ b/test.ts
@@ -1 +1 @@
-old
+new`;

		const parsed = parseDiff(diff);

		expect(parsed).not.toBeNull();
		expect(parsed!.hunks[0].oldCount).toBe(1);
		expect(parsed!.hunks[0].newCount).toBe(1);
	});

	it('should strip a/ and b/ prefixes from file paths', () => {
		const diff = `--- a/src/test.ts
+++ b/src/test.ts
@@ -1 +1 @@
-old
+new`;

		const parsed = parseDiff(diff);

		expect(parsed!.oldFile).toBe('src/test.ts');
		expect(parsed!.newFile).toBe('src/test.ts');
	});

	it('should return null for invalid diff', () => {
		const diff = 'this is not a valid diff';
		const parsed = parseDiff(diff);
		expect(parsed).toBeNull();
	});

	it('should handle empty lines in hunk', () => {
		const diff = `--- a/test.ts
+++ b/test.ts
@@ -1,3 +1,3 @@
 const x = 1;

-const y = 2;
+const y = 3;`;

		const parsed = parseDiff(diff);

		expect(parsed).not.toBeNull();
		expect(parsed!.hunks[0].lines).toContain('');
	});
});

describe('applyDiffToContent', () => {
	it('should apply a simple replacement diff', () => {
		const original = `const x = 1;
const y = 2;
const z = 3;`;

		const diff = `--- a/test.ts
+++ b/test.ts
@@ -1,3 +1,3 @@
 const x = 1;
-const y = 2;
+const y = 999;
 const z = 3;`;

		const result = applyDiffToContent(original, diff);

		expect(result).toBe(`const x = 1;
const y = 999;
const z = 3;`);
	});

	it('should apply a diff that adds lines', () => {
		const original = `const x = 1;
const z = 3;`;

		const diff = `--- a/test.ts
+++ b/test.ts
@@ -1,2 +1,3 @@
 const x = 1;
+const y = 2;
 const z = 3;`;

		const result = applyDiffToContent(original, diff);

		expect(result).toBe(`const x = 1;
const y = 2;
const z = 3;`);
	});

	it('should apply a diff that removes lines', () => {
		const original = `const x = 1;
const y = 2;
const z = 3;`;

		const diff = `--- a/test.ts
+++ b/test.ts
@@ -1,3 +1,2 @@
 const x = 1;
-const y = 2;
 const z = 3;`;

		const result = applyDiffToContent(original, diff);

		expect(result).toBe(`const x = 1;
const z = 3;`);
	});

	it('should apply multiple hunks', () => {
		const original = `line 1
line 2
line 3
line 4
line 5
line 6
line 7
line 8
line 9
line 10`;

		const diff = `--- a/test.ts
+++ b/test.ts
@@ -1,2 +1,2 @@
-line 1
+LINE 1
 line 2
@@ -9,2 +9,2 @@
 line 9
-line 10
+LINE 10`;

		const result = applyDiffToContent(original, diff);

		expect(result).toContain('LINE 1');
		expect(result).toContain('LINE 10');
	});

	it('should return null for invalid diff', () => {
		const original = 'some content';
		const diff = 'not a valid diff';

		const result = applyDiffToContent(original, diff);

		expect(result).toBeNull();
	});

	it('should handle empty original content', () => {
		const original = '';
		const diff = `--- a/test.ts
+++ b/test.ts
@@ -0,0 +1 @@
+new line`;

		const result = applyDiffToContent(original, diff);

		expect(result).not.toBeNull();
	});
});
