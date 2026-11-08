/**
 * Codebase search scoring module using TF-IDF and relevance ranking.
 * Provides semantic-like search without requiring embeddings.
 */

export interface SearchResult {
	filePath: string;
	score: number;
	matchingLines: MatchingLine[];
}

export interface MatchingLine {
	lineNumber: number;
	content: string;
	score: number;
}

export interface DocumentStats {
	filePath: string;
	content: string;
	termFrequency: Map<string, number>;
	totalTerms: number;
}

/**
 * Tokenize text into terms for search.
 * Handles camelCase, snake_case, and common code patterns.
 */
export function tokenize(text: string): string[] {
	// Split camelCase and PascalCase
	const withSpaces = text.replace(/([a-z])([A-Z])/g, '$1 $2');

	// Split on non-alphanumeric, underscores become spaces
	const tokens = withSpaces
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter((t) => t.length > 1);

	return tokens;
}

/**
 * Calculate term frequency for a document.
 */
export function calculateTermFrequency(content: string): Map<string, number> {
	const terms = tokenize(content);
	const frequency = new Map<string, number>();

	for (const term of terms) {
		frequency.set(term, (frequency.get(term) || 0) + 1);
	}

	return frequency;
}

/**
 * Calculate inverse document frequency for terms across all documents.
 */
export function calculateIDF(documents: DocumentStats[], terms: string[]): Map<string, number> {
	const idf = new Map<string, number>();
	const totalDocs = documents.length;

	for (const term of terms) {
		let docsWithTerm = 0;
		for (const doc of documents) {
			if (doc.termFrequency.has(term)) {
				docsWithTerm++;
			}
		}
		// IDF formula: log(N / (1 + df)) + 1 (smoothed)
		const idfValue = Math.log(totalDocs / (1 + docsWithTerm)) + 1;
		idf.set(term, idfValue);
	}

	return idf;
}

/**
 * Calculate TF-IDF score for a document given query terms.
 */
export function calculateTFIDF(
	doc: DocumentStats,
	queryTerms: string[],
	idf: Map<string, number>
): number {
	let score = 0;

	for (const term of queryTerms) {
		const tf = doc.termFrequency.get(term) || 0;
		if (tf > 0) {
			// Normalized TF: log(1 + tf)
			const normalizedTF = Math.log(1 + tf);
			const termIDF = idf.get(term) || 1;
			score += normalizedTF * termIDF;
		}
	}

	return score;
}

/**
 * Boost score based on code-specific patterns.
 */
export function calculateCodeBoost(
	content: string,
	query: string,
	filePath: string
): number {
	let boost = 0;
	const queryLower = query.toLowerCase();
	const contentLower = content.toLowerCase();
	const fileNameLower = filePath.toLowerCase();

	// Exact phrase match (highest boost)
	if (contentLower.includes(queryLower)) {
		boost += 5;
	}

	// File name contains query terms
	const queryTerms = tokenize(query);
	for (const term of queryTerms) {
		if (fileNameLower.includes(term)) {
			boost += 2;
		}
	}

	// Function/class definition patterns
	const definitionPatterns = [
		/function\s+\w+/gi,
		/class\s+\w+/gi,
		/const\s+\w+\s*=/gi,
		/export\s+(default\s+)?/gi,
		/interface\s+\w+/gi,
		/type\s+\w+\s*=/gi,
	];

	for (const pattern of definitionPatterns) {
		const matches = content.match(pattern) || [];
		for (const match of matches) {
			const matchLower = match.toLowerCase();
			for (const term of queryTerms) {
				if (matchLower.includes(term)) {
					boost += 3;
				}
			}
		}
	}

	return boost;
}

/**
 * Find the most relevant lines in a file for the given query.
 */
export function findMatchingLines(
	content: string,
	queryTerms: string[],
	maxLines: number = 5
): MatchingLine[] {
	const lines = content.split('\n');
	const scoredLines: MatchingLine[] = [];

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const lineLower = line.toLowerCase();
		const lineTerms = tokenize(line);
		let lineScore = 0;

		// Score based on term matches
		for (const term of queryTerms) {
			if (lineLower.includes(term)) {
				lineScore += 2;
			}
			// Exact word match gets higher score
			if (lineTerms.includes(term)) {
				lineScore += 1;
			}
		}

		// Boost for definition lines
		if (/^(export\s+)?(function|class|const|let|var|interface|type)\s+/i.test(line.trim())) {
			lineScore *= 1.5;
		}

		if (lineScore > 0) {
			scoredLines.push({
				lineNumber: i + 1,
				content: line.trim().substring(0, 150),
				score: lineScore,
			});
		}
	}

	// Sort by score descending, take top N
	return scoredLines.sort((a, b) => b.score - a.score).slice(0, maxLines);
}

/**
 * Main search function that ranks documents by relevance.
 */
export function searchDocuments(
	documents: DocumentStats[],
	query: string,
	maxResults: number = 20
): SearchResult[] {
	const queryTerms = tokenize(query);

	if (queryTerms.length === 0) {
		return [];
	}

	// Calculate IDF for query terms
	const idf = calculateIDF(documents, queryTerms);

	// Score each document
	const results: SearchResult[] = [];

	for (const doc of documents) {
		const tfidfScore = calculateTFIDF(doc, queryTerms, idf);

		if (tfidfScore > 0) {
			const codeBoost = calculateCodeBoost(doc.content, query, doc.filePath);
			const totalScore = tfidfScore + codeBoost;

			const matchingLines = findMatchingLines(doc.content, queryTerms);

			if (matchingLines.length > 0) {
				results.push({
					filePath: doc.filePath,
					score: totalScore,
					matchingLines,
				});
			}
		}
	}

	// Sort by score descending
	return results.sort((a, b) => b.score - a.score).slice(0, maxResults);
}

/**
 * Build document stats from file content.
 */
export function buildDocumentStats(filePath: string, content: string): DocumentStats {
	const termFrequency = calculateTermFrequency(content);
	const totalTerms = Array.from(termFrequency.values()).reduce((a, b) => a + b, 0);

	return {
		filePath,
		content,
		termFrequency,
		totalTerms,
	};
}
