export interface PendingDiff {
	filePath: string;
	originalContent: string;
	newContent: string;
	flow: 'codelens' | 'chat';
}
