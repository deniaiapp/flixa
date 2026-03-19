import { describe, it, expect } from 'bun:test';
import { render, screen } from '@testing-library/react';
import { Message } from './Message';
import type { ChatMessage } from '../types';

describe('Message', () => {
	it('should render user message with correct styling', () => {
		const message: ChatMessage = {
			role: 'user',
			content: 'Hello, assistant!',
		};

		render(<Message message={message} />);

		const messageElement = screen.getByText('Hello, assistant!');
		expect(messageElement).toBeTruthy();
		expect(messageElement.className).toContain('bg-accent');
		expect(messageElement.className).toContain('rounded-2xl');
	});

	it('should render assistant message with correct styling', () => {
		const message: ChatMessage = {
			role: 'assistant',
			content: 'Hello, user!',
		};

		render(<Message message={message} />);

		const messageElement = screen.getByText('Hello, user!');
		expect(messageElement).toBeTruthy();
		expect(messageElement.className).toContain('bg-surface-2');
		expect(messageElement.className).toContain('rounded-2xl');
	});

	it('should render system message with correct styling', () => {
		const message: ChatMessage = {
			role: 'system',
			content: 'System notification',
		};

		render(<Message message={message} />);

		const messageElement = screen.getByText('System notification');
		expect(messageElement).toBeTruthy();
		expect(messageElement.className).toContain('text-[11px]');
	});

	it('should preserve whitespace in message content', () => {
		const message: ChatMessage = {
			role: 'user',
			content: 'Line 1\nLine 2',
		};

		render(<Message message={message} />);

		const messageElement = screen.getByText(/Line 1/);
		expect(messageElement.className).toContain('whitespace-pre-wrap');
	});

	it('should have animation class on wrapper', () => {
		const message: ChatMessage = {
			role: 'user',
			content: 'Test message',
		};

		render(<Message message={message} />);

		const messageElement = screen.getByText('Test message');
		const wrapper = messageElement.closest('.message-animate');
		expect(wrapper).not.toBeNull();
	});

	it('should have max width constraint on wrapper', () => {
		const message: ChatMessage = {
			role: 'user',
			content: 'Test message',
		};

		render(<Message message={message} />);

		const messageElement = screen.getByText('Test message');
		const wrapper = messageElement.closest('.max-w-\\[85\\%\\]');
		expect(wrapper).not.toBeNull();
	});

	it('should render result message as system style', () => {
		const message: ChatMessage = {
			role: 'result',
			content: 'Action completed',
		};

		render(<Message message={message} />);

		const messageElement = screen.getByText('Action completed');
		expect(messageElement).toBeTruthy();
		expect(messageElement.className).toContain('text-[11px]');
	});

	it('should render executing message as system style', () => {
		const message: ChatMessage = {
			role: 'executing',
			content: 'Running task...',
		};

		render(<Message message={message} />);

		const messageElement = screen.getByText('Running task...');
		expect(messageElement).toBeTruthy();
		expect(messageElement.className).toContain('text-[11px]');
	});

	it('should show user label for user messages', () => {
		const message: ChatMessage = {
			role: 'user',
			content: 'Test message',
		};

		render(<Message message={message} />);

		expect(screen.getByText('You')).toBeTruthy();
	});

	it('should show Flixa label for assistant messages', () => {
		const message: ChatMessage = {
			role: 'assistant',
			content: 'Test response',
		};

		render(<Message message={message} />);

		expect(screen.getByText('Flixa')).toBeTruthy();
	});
});
