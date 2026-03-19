import type * as vscode from 'vscode';
import type { ReferencedContextFile, SerializedActionResult, SessionMessage } from '../types';

export interface ChatMessage {
	role: 'user' | 'assistant' | 'system' | 'result' | 'executing';
	content: string;
	results?: SerializedActionResult[];
	executingAction?: string;
	executingOutput?: string;
	activeSelection?: string;
	activeFilePath?: string;
	activeSelectionLabel?: string;
	mentionedFiles?: ReferencedContextFile[];
}

export interface ChatSession {
	id: string;
	name: string;
	messages: ChatMessage[];
	createdAt: number;
}

export class SessionManager {
	private _sessions: ChatSession[] = [];
	private _currentSessionId: string = '';
	private _context: vscode.ExtensionContext;

	constructor(context: vscode.ExtensionContext) {
		this._context = context;
		this._loadSessions();
	}

	private _loadSessions(): void {
		const saved = this._context.globalState.get<ChatSession[]>('chatSessions');
		if (saved && saved.length > 0) {
			this._sessions = saved;
			this._currentSessionId =
				this._context.globalState.get<string>('currentSessionId') ||
				saved[0].id;
		} else {
			this.createNewSession();
		}
	}

	private _saveSessions(): void {
		this._context.globalState.update('chatSessions', this._sessions);
		this._context.globalState.update(
			'currentSessionId',
			this._currentSessionId
		);
	}

	get sessions(): ChatSession[] {
		return this._sessions;
	}

	get currentSessionId(): string {
		return this._currentSessionId;
	}

	set currentSessionId(id: string) {
		this._currentSessionId = id;
		this._saveSessions();
	}

	getCurrentSession(): ChatSession | undefined {
		return this._sessions.find((s) => s.id === this._currentSessionId);
	}

	getMessages(): ChatMessage[] {
		const session = this.getCurrentSession();
		return session ? session.messages : [];
	}

	setMessages(messages: ChatMessage[]): void {
		const session = this.getCurrentSession();
		if (session) {
			session.messages = messages;
		}
	}

	pushMessage(msg: ChatMessage): void {
		const session = this.getCurrentSession();
		if (session) {
			session.messages.push(msg);
		}
	}

	filterMessages(predicate: (m: ChatMessage) => boolean): void {
		const session = this.getCurrentSession();
		if (session) {
			session.messages = session.messages.filter(predicate);
		}
	}

	createNewSession(): string {
		const id = Date.now().toString();
		const session: ChatSession = {
			id,
			name: `Chat ${this._sessions.length + 1}`,
			messages: [],
			createdAt: Date.now(),
		};
		this._sessions.unshift(session);
		this._currentSessionId = id;
		this._saveSessions();
		return id;
	}

	deleteSession(sessionId: string): void {
		this._sessions = this._sessions.filter((s) => s.id !== sessionId);
		if (this._currentSessionId === sessionId) {
			if (this._sessions.length === 0) {
				this.createNewSession();
			} else {
				this._currentSessionId = this._sessions[0].id;
			}
		}
		this._saveSessions();
	}

	clearHistory(): void {
		this.setMessages([]);
		this._saveSessions();
	}

	save(): void {
		this._saveSessions();
	}

	updateSessionName(sessionId: string, name: string): void {
		const session = this._sessions.find((s) => s.id === sessionId);
		if (session) {
			session.name = name;
			this._saveSessions();
		}
	}

	getSessionMessages(): SessionMessage[] {
		return this.getMessages()
			.filter(
				(m) =>
					m.role === 'user' || m.role === 'assistant' || m.role === 'result'
			)
			.map((m) => ({
				role: m.role as 'user' | 'assistant' | 'result',
				content: m.content,
				results: m.results,
				activeSelection: m.activeSelection,
				activeFilePath: m.activeFilePath,
				activeSelectionLabel: m.activeSelectionLabel,
				mentionedFiles: m.mentionedFiles,
			}));
	}
}
