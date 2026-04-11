import { useCallback } from 'react';
import { vscode } from '../vscode';
import type { ImageAttachment } from '../types';

export interface UseVSCodeReturn {
	sendMessage: (text: string, images?: ImageAttachment[]) => void;
	toggleAgentMode: (enabled: boolean) => void;
	setApprovalMode: (mode: string) => void;
	setModel: (model: string) => void;
	setReasoningEffort: (reasoningEffort: string) => void;
	switchChat: (sessionId: string) => void;
	newChat: () => void;
	deleteChat: (sessionId: string) => void;
	stopAgent: () => void;
	ready: () => void;
	showUsageDetail: () => void;
	login: () => void;
	openBilling: () => void;
	requestSuggestion: (text: string, requestId: string) => void;
}

export function useVSCode(): UseVSCodeReturn {
	const sendMessage = useCallback((text: string, images?: ImageAttachment[]) => {
		vscode.postMessage({ type: 'sendMessage', message: text, images });
	}, []);

	const toggleAgentMode = useCallback((enabled: boolean) => {
		vscode.postMessage({ type: 'toggleAgentMode', enabled });
	}, []);

	const setApprovalMode = useCallback((mode: string) => {
		vscode.postMessage({ type: 'setApprovalMode', mode });
	}, []);

	const setModel = useCallback((model: string) => {
		vscode.postMessage({ type: 'setModel', model });
	}, []);

	const setReasoningEffort = useCallback((reasoningEffort: string) => {
		vscode.postMessage({ type: 'setReasoningEffort', reasoningEffort });
	}, []);

	const switchChat = useCallback((sessionId: string) => {
		vscode.postMessage({ type: 'switchChat', sessionId });
	}, []);

	const newChat = useCallback(() => {
		vscode.postMessage({ type: 'newChat' });
	}, []);

	const deleteChat = useCallback((sessionId: string) => {
		vscode.postMessage({ type: 'deleteChat', sessionId });
	}, []);

	const stopAgent = useCallback(() => {
		vscode.postMessage({ type: 'stopAgent' });
	}, []);

	const ready = useCallback(() => {
		vscode.postMessage({ type: 'ready' });
	}, []);

	const showUsageDetail = useCallback(() => {
		vscode.postMessage({ type: 'showUsageDetail' });
	}, []);

	const login = useCallback(() => {
		vscode.postMessage({ type: 'login' });
	}, []);

	const openBilling = useCallback(() => {
		vscode.postMessage({ type: 'openBilling' });
	}, []);

	const requestSuggestion = useCallback((text: string, requestId: string) => {
		vscode.postMessage({ type: 'requestSuggestion', text, requestId });
	}, []);

	return {
		sendMessage,
		toggleAgentMode,
		setApprovalMode,
		setModel,
		setReasoningEffort,
		switchChat,
		newChat,
		deleteChat,
		stopAgent,
		ready,
		showUsageDetail,
		login,
		openBilling,
		requestSuggestion,
	};
}
