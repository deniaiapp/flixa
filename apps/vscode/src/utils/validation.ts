export const MAX_COMMAND_LENGTH = 5000;

export function containsNullBytes(str: string): boolean {
	return str.includes('\0');
}

export function validateCommandLength(command: string): { valid: boolean; error?: string } {
	if (command.length > MAX_COMMAND_LENGTH) {
		return {
			valid: false,
			error: `Command length ${command.length} exceeds maximum ${MAX_COMMAND_LENGTH}`,
		};
	}
	return { valid: true };
}

export function validateNoNullBytes(str: string, fieldName: string): { valid: boolean; error?: string } {
	if (containsNullBytes(str)) {
		return {
			valid: false,
			error: `${fieldName} contains null bytes`,
		};
	}
	return { valid: true };
}
