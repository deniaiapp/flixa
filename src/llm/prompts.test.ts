import { describe, expect, it } from 'bun:test';
import { AGENT_SYSTEM_PROMPT, CHAT_SYSTEM_PROMPT } from './prompts';

describe('system prompts', () => {
	it('should include Flixa product info in the agent prompt', () => {
		expect(AGENT_SYSTEM_PROMPT).toContain('## About Flixa and Deni AI');
		expect(AGENT_SYSTEM_PROMPT).toContain('https://deniai.app/settings/billing');
		expect(AGENT_SYSTEM_PROMPT).toContain('## Core Behavior');
	});

	it('should include Flixa product info in the chat prompt', () => {
		expect(CHAT_SYSTEM_PROMPT.startsWith('You are Flixa')).toBe(true);
		expect(CHAT_SYSTEM_PROMPT).toContain('## About Flixa and Deni AI');
		expect(CHAT_SYSTEM_PROMPT).toContain('`// TODO: ...`');
		expect(CHAT_SYSTEM_PROMPT).toContain('You MUST respond with valid JSON');
	});
});
