import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { ApprovalCard } from './ApprovalCard';
import { Message } from './Message';

afterEach(() => {
	cleanup();
});

describe('ApprovalCard', () => {
	it('should render nothing without approvals', () => {
		const { container } = render(<ApprovalCard approvals={[]} onRespond={() => {}} />);
		expect(container.innerHTML).toBe('');
	});

	it('should show the command and send decisions', () => {
		const onRespond = vi.fn((_id: string, _decision: string) => {});
		render(
			<ApprovalCard
				approvals={[{ id: 'a1', action: 'Shell: npm test', detail: 'npm test -- --watch' }]}
				onRespond={onRespond}
			/>,
		);

		expect(screen.getByText('Allow Flixa to run this command?')).toBeTruthy();
		expect(screen.getByText('npm test -- --watch')).toBeTruthy();
		fireEvent.click(screen.getByText('Allow'));
		fireEvent.click(screen.getByText('Deny'));
		expect(onRespond.mock.calls).toEqual([
			['a1', 'approve'],
			['a1', 'reject'],
		]);
	});
});

describe('Message actions', () => {
	it('should copy assistant content', () => {
		const onCopy = vi.fn((_text: string) => {});
		render(<Message message={{ role: 'assistant', content: 'Copy me' }} onCopy={onCopy} />);

		fireEvent.click(screen.getByLabelText('Copy'));
		expect(onCopy.mock.calls).toEqual([['Copy me']]);
	});

	it('should edit and resend a user message', () => {
		const onEdit = vi.fn((_text: string) => {});
		render(<Message message={{ role: 'user', content: 'Old text' }} onEdit={onEdit} canEdit />);

		fireEvent.click(screen.getByLabelText('Edit and resend'));
		const textarea = screen.getByDisplayValue('Old text');
		fireEvent.change(textarea, { target: { value: 'New text' } });
		fireEvent.click(screen.getByText('Send'));
		expect(onEdit.mock.calls).toEqual([['New text']]);
	});

	it('should render slash command replies as normal text', () => {
		render(
			<Message
				message={{ role: 'system', content: 'Current approval mode: safe\n\nUsage: /approval <mode>' }}
				asReply
			/>,
		);

		const element = screen.getByText(/Current approval mode: safe/);
		expect(element.className).toContain('whitespace-pre-wrap');
		expect(element.className).toContain('text-[12px]');
		expect(element.closest('[role="note"]')).not.toBeNull();
	});

	it('should hide edit when editing is not allowed', () => {
		render(<Message message={{ role: 'user', content: 'Busy' }} onEdit={() => {}} canEdit={false} />);
		expect(screen.queryByLabelText('Edit and resend')).toBeNull();
	});
});
