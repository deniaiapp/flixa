/**
 * Smart Diff Applier - Cursor-style intelligent code edit application
 *
 * Handles `// ... existing code ...` markers to merge code edits
 * with existing file content using fuzzy matching.
 */

/** Marker patterns for existing code placeholders */
const EXISTING_CODE_MARKERS = [
	/^\s*\/\/\s*\.\.\.\s*existing\s*code\s*\.\.\..*$/i,
	/^\s*#\s*\.\.\.\s*existing\s*code\s*\.\.\..*$/i,
	/^\s*\/\*\s*\.\.\.\s*existing\s*code\s*\.\.\.\s*\*\/.*$/i,
	/^\s*<!--\s*\.\.\.\s*existing\s*code\s*\.\.\.\s*-->.*$/i,
	/^\s*\.\.\.\s*existing\s*code\s*\.\.\..*$/i,
];

/**
 * Check if a line is an "existing code" marker
 */
function isExistingCodeMarker(line: string): boolean {
	return EXISTING_CODE_MARKERS.some((pattern) => pattern.test(line));
}

/**
 * Check if text contains any markers
 */
function containsMarkers(text: string): boolean {
	const lines = text.split('\n');
	return lines.some((line) => isExistingCodeMarker(line));
}

/**
 * Normalize a line for comparison (trim whitespace)
 */
function normalizeLine(line: string): string {
	return line.trim();
}

/**
 * Calculate similarity between two strings (0-1)
 */
function similarity(a: string, b: string): number {
	const aNorm = normalizeLine(a);
	const bNorm = normalizeLine(b);

	if (aNorm === bNorm) return 1;
	if (aNorm.length === 0 && bNorm.length === 0) return 1;
	if (aNorm.length === 0 || bNorm.length === 0) return 0;

	// Check if one contains the other
	if (aNorm.includes(bNorm) || bNorm.includes(aNorm)) {
		return 0.9;
	}

	// Simple character-based similarity
	const maxLen = Math.max(aNorm.length, bNorm.length);
	let matches = 0;
	const minLen = Math.min(aNorm.length, bNorm.length);

	for (let i = 0; i < minLen; i++) {
		if (aNorm[i] === bNorm[i]) matches++;
	}

	return matches / maxLen;
}

/**
 * Find the index of a line in existing content that best matches the target
 */
function findMatchingLineIndex(
	existingLines: string[],
	targetLine: string,
	startFrom: number = 0
): number {
	const targetNorm = normalizeLine(targetLine);
	if (targetNorm.length === 0) return -1;

	// First try exact match
	for (let i = startFrom; i < existingLines.length; i++) {
		if (normalizeLine(existingLines[i]) === targetNorm) {
			return i;
		}
	}

	// Then try fuzzy match
	let bestMatch = -1;
	let bestSim = 0.7; // Minimum threshold

	for (let i = startFrom; i < existingLines.length; i++) {
		const sim = similarity(existingLines[i], targetLine);
		if (sim > bestSim) {
			bestSim = sim;
			bestMatch = i;
		}
	}

	return bestMatch;
}

/**
 * Apply smart code edit to existing content
 *
 * @param existingContent - The current file content
 * @param codeEdit - The code edit with `// ... existing code ...` markers
 * @returns The merged content
 */
export function applySmartEdit(
	existingContent: string,
	codeEdit: string
): string {
	// Check if edit contains markers
	if (!containsMarkers(codeEdit)) {
		// No markers, treat as full replacement
		return codeEdit;
	}

	// Handle empty existing content - just remove markers
	if (!existingContent || existingContent.trim().length === 0) {
		const lines = codeEdit.split('\n');
		return lines.filter((line) => !isExistingCodeMarker(line)).join('\n');
	}

	const existingLines = existingContent.split('\n');
	const editLines = codeEdit.split('\n');
	const result: string[] = [];

	let existingIdx = 0;

	for (let editIdx = 0; editIdx < editLines.length; editIdx++) {
		const editLine = editLines[editIdx];

		if (isExistingCodeMarker(editLine)) {
			// Find the next non-marker line in the edit
			let nextEditIdx = editIdx + 1;
			while (
				nextEditIdx < editLines.length &&
				isExistingCodeMarker(editLines[nextEditIdx])
			) {
				nextEditIdx++;
			}

			if (nextEditIdx >= editLines.length) {
				// Marker at end - copy remaining existing content
				while (existingIdx < existingLines.length) {
					result.push(existingLines[existingIdx]);
					existingIdx++;
				}
			} else {
				// Find where the next edit content appears in existing
				const nextEditLine = editLines[nextEditIdx];
				const matchIdx = findMatchingLineIndex(
					existingLines,
					nextEditLine,
					existingIdx
				);

				if (matchIdx >= 0) {
					// Copy existing content up to the match point
					while (existingIdx < matchIdx) {
						result.push(existingLines[existingIdx]);
						existingIdx++;
					}
				} else {
					// No match found - copy all remaining existing content
					while (existingIdx < existingLines.length) {
						result.push(existingLines[existingIdx]);
						existingIdx++;
					}
				}
			}
		} else {
			// Regular content line from edit - add it
			result.push(editLine);

			// Try to advance existing index past matching content
			const matchIdx = findMatchingLineIndex(
				existingLines,
				editLine,
				existingIdx
			);
			if (matchIdx >= 0) {
				existingIdx = matchIdx + 1;
			}
		}
	}

	return result.join('\n');
}

/**
 * Apply smart edit with better context awareness (V2)
 */
export function applySmartEditV2(
	existingContent: string,
	codeEdit: string
): string {
	if (!containsMarkers(codeEdit)) {
		return codeEdit;
	}

	// Handle empty existing content
	if (!existingContent || existingContent.trim().length === 0) {
		const lines = codeEdit.split('\n');
		return lines.filter((line) => !isExistingCodeMarker(line)).join('\n');
	}

	const existingLines = existingContent.split('\n');
	const editLines = codeEdit.split('\n');
	const result: string[] = [];

	let existingIdx = 0;
	let editIdx = 0;

	while (editIdx < editLines.length) {
		const editLine = editLines[editIdx];

		if (isExistingCodeMarker(editLine)) {
			// Skip consecutive markers
			let nextEditIdx = editIdx + 1;
			while (
				nextEditIdx < editLines.length &&
				isExistingCodeMarker(editLines[nextEditIdx])
			) {
				nextEditIdx++;
			}

			if (nextEditIdx >= editLines.length) {
				// Marker(s) at end - copy remaining existing content
				while (existingIdx < existingLines.length) {
					result.push(existingLines[existingIdx]);
					existingIdx++;
				}
				editIdx = nextEditIdx;
			} else {
				// Find where the next edit line appears in existing
				const nextEditLine = editLines[nextEditIdx];
				const matchIdx = findMatchingLineIndex(
					existingLines,
					nextEditLine,
					existingIdx
				);

				if (matchIdx >= 0) {
					// Copy existing content up to the match
					while (existingIdx < matchIdx) {
						result.push(existingLines[existingIdx]);
						existingIdx++;
					}
				} else {
					// No match - copy all remaining existing content
					while (existingIdx < existingLines.length) {
						result.push(existingLines[existingIdx]);
						existingIdx++;
					}
				}
				editIdx = nextEditIdx;
			}
		} else {
			// Regular line - add it
			result.push(editLine);

			// Advance existing past this line if it matches
			const matchIdx = findMatchingLineIndex(
				existingLines,
				editLine,
				existingIdx
			);
			if (matchIdx >= 0) {
				existingIdx = matchIdx + 1;
			}

			editIdx++;
		}
	}

	return result.join('\n');
}

export default applySmartEditV2;
