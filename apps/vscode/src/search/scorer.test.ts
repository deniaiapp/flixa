import { describe, expect, it } from 'vitest';
import {
	tokenize,
	calculateTermFrequency,
	calculateIDF,
	calculateTFIDF,
	calculateCodeBoost,
	findMatchingLines,
	searchDocuments,
	buildDocumentStats,
	type DocumentStats,
} from './scorer';

describe('scorer', () => {
	describe('tokenize', () => {
		it('should split on whitespace and punctuation', () => {
			expect(tokenize('hello world')).toEqual(['hello', 'world']);
			expect(tokenize('foo.bar.baz')).toEqual(['foo', 'bar', 'baz']);
		});

		it('should handle camelCase', () => {
			expect(tokenize('getUserById')).toEqual(['get', 'user', 'by', 'id']);
			expect(tokenize('XMLHttpRequest')).toEqual(['xmlhttp', 'request']);
		});

		it('should handle snake_case', () => {
			expect(tokenize('user_name')).toEqual(['user', 'name']);
			expect(tokenize('MAX_BUFFER_SIZE')).toEqual(['max', 'buffer', 'size']);
		});

		it('should filter out single character tokens', () => {
			expect(tokenize('a b c foo')).toEqual(['foo']);
		});

		it('should lowercase all tokens', () => {
			expect(tokenize('Hello WORLD')).toEqual(['hello', 'world']);
		});
	});

	describe('calculateTermFrequency', () => {
		it('should count term occurrences', () => {
			const freq = calculateTermFrequency('foo bar foo baz foo');
			expect(freq.get('foo')).toBe(3);
			expect(freq.get('bar')).toBe(1);
			expect(freq.get('baz')).toBe(1);
		});

		it('should handle code with camelCase', () => {
			const freq = calculateTermFrequency('getUserById getUsers');
			expect(freq.get('get')).toBe(2);
			expect(freq.get('user')).toBe(1);
			expect(freq.get('users')).toBe(1);
		});
	});

	describe('calculateIDF', () => {
		it('should calculate IDF for terms', () => {
			const docs: DocumentStats[] = [
				buildDocumentStats('a.ts', 'foo bar'),
				buildDocumentStats('b.ts', 'foo baz'),
				buildDocumentStats('c.ts', 'qux quux'),
			];

			const idf = calculateIDF(docs, ['foo', 'bar', 'qux']);

			// foo appears in 2 docs, bar in 1, qux in 1
			expect(idf.get('foo')).toBeLessThan(idf.get('bar')!);
			expect(idf.get('bar')).toEqual(idf.get('qux'));
		});

		it('should handle term not in any document', () => {
			const docs: DocumentStats[] = [buildDocumentStats('a.ts', 'foo bar')];

			const idf = calculateIDF(docs, ['nonexistent']);

			// Should still return a value (smoothed IDF)
			expect(idf.get('nonexistent')).toBeGreaterThan(0);
		});
	});

	describe('calculateTFIDF', () => {
		it('should score documents based on term frequency and IDF', () => {
			const docs: DocumentStats[] = [
				buildDocumentStats('a.ts', 'foo foo foo bar'),
				buildDocumentStats('b.ts', 'foo bar bar bar'),
			];

			const idf = calculateIDF(docs, ['foo', 'bar']);

			const scoreA = calculateTFIDF(docs[0], ['foo'], idf);
			const scoreB = calculateTFIDF(docs[1], ['foo'], idf);

			// doc A has more 'foo' occurrences, should score higher
			expect(scoreA).toBeGreaterThan(scoreB);
		});

		it('should return 0 for document without query terms', () => {
			const docs: DocumentStats[] = [buildDocumentStats('a.ts', 'hello world')];

			const idf = calculateIDF(docs, ['nonexistent']);
			const score = calculateTFIDF(docs[0], ['nonexistent'], idf);

			expect(score).toBe(0);
		});
	});

	describe('calculateCodeBoost', () => {
		it('should boost exact phrase matches', () => {
			const boost1 = calculateCodeBoost('function getUserById() {}', 'getUserById', 'user.ts');
			const boost2 = calculateCodeBoost('function foo() {}', 'getUserById', 'user.ts');

			expect(boost1).toBeGreaterThan(boost2);
		});

		it('should boost when file name matches query', () => {
			const boost1 = calculateCodeBoost('some content', 'user', 'userService.ts');
			const boost2 = calculateCodeBoost('some content', 'user', 'helper.ts');

			expect(boost1).toBeGreaterThan(boost2);
		});

		it('should boost function definitions matching query', () => {
			const boost1 = calculateCodeBoost('function getUser() { return user; }', 'user', 'a.ts');
			const boost2 = calculateCodeBoost('const x = user;', 'user', 'a.ts');

			expect(boost1).toBeGreaterThan(boost2);
		});
	});

	describe('findMatchingLines', () => {
		it('should find lines containing query terms', () => {
			const content = `line one
function getUser() {
  return user;
}
unrelated line`;

			const matches = findMatchingLines(content, ['user']);

			expect(matches.length).toBeGreaterThan(0);
			expect(matches.some((m) => m.content.includes('getUser'))).toBe(true);
		});

		it('should limit results to maxLines', () => {
			const content = Array.from({ length: 100 }, (_, i) => `user line ${i}`).join('\n');

			const matches = findMatchingLines(content, ['user'], 3);

			expect(matches.length).toBe(3);
		});

		it('should score definition lines higher', () => {
			const content = `const user = "test";
user is mentioned here
just using user`;

			const matches = findMatchingLines(content, ['user']);

			// First match should be the const definition (boosted)
			expect(matches[0].content).toContain('const');
		});

		it('should truncate long lines', () => {
			const longLine = 'user ' + 'x'.repeat(200);
			const content = longLine;

			const matches = findMatchingLines(content, ['user']);

			expect(matches[0].content.length).toBeLessThanOrEqual(150);
		});
	});

	describe('searchDocuments', () => {
		it('should rank documents by relevance', () => {
			const docs: DocumentStats[] = [
				buildDocumentStats('utils.ts', 'helper function'),
				buildDocumentStats('userService.ts', 'function getUser() { return user; } function updateUser() {}'),
				buildDocumentStats('config.ts', 'user setting'),
			];

			const results = searchDocuments(docs, 'user function');

			expect(results.length).toBeGreaterThan(0);
			// userService.ts should rank highest (has both user and function, multiple times)
			expect(results[0].filePath).toBe('userService.ts');
		});

		it('should return empty array for empty query', () => {
			const docs: DocumentStats[] = [buildDocumentStats('a.ts', 'some content')];

			const results = searchDocuments(docs, '');

			expect(results).toEqual([]);
		});

		it('should limit results to maxResults', () => {
			const docs: DocumentStats[] = Array.from({ length: 50 }, (_, i) =>
				buildDocumentStats(`file${i}.ts`, `user content ${i}`)
			);

			const results = searchDocuments(docs, 'user', 10);

			expect(results.length).toBe(10);
		});

		it('should include matching lines in results', () => {
			const docs: DocumentStats[] = [
				buildDocumentStats('a.ts', 'function findUser() {\n  const user = db.get();\n  return user;\n}'),
			];

			const results = searchDocuments(docs, 'user');

			expect(results[0].matchingLines.length).toBeGreaterThan(0);
			expect(results[0].matchingLines[0].lineNumber).toBeGreaterThan(0);
		});
	});

	describe('buildDocumentStats', () => {
		it('should build stats with term frequency', () => {
			const stats = buildDocumentStats('test.ts', 'foo bar foo');

			expect(stats.filePath).toBe('test.ts');
			expect(stats.content).toBe('foo bar foo');
			expect(stats.termFrequency.get('foo')).toBe(2);
			expect(stats.termFrequency.get('bar')).toBe(1);
			expect(stats.totalTerms).toBe(3);
		});
	});
});
