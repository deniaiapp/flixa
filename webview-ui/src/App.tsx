import { useEffect, useCallback, useRef, useState } from 'react';
import { InputArea } from './components/InputArea';
import { MessageList } from './components/MessageList';
import { FilesChanged } from './components/FilesChanged';
import { useMessages, useVSCode } from './hooks';
import type { ImageAttachment } from './types';

export default function App() {
	const {
		messages,
		sessions,
		currentSessionId,
		agentMode,
		approvalMode,
		selectedModel,
		selectedReasoningEffort,
		availableModels,
		modelDefinitions,
		isLoading,
		agentRunning,
		streamingText,
		usageData,
		isLoggedIn,
		changedFiles,
		workspaceFiles,
		activeFilePath,
		activeSelection,
		activeSelectionLabel,
		inlineSuggestion,
		lastSuggestionRequestId,
		clearInlineSuggestion,
		setAgentMode,
		setApprovalMode,
		setSelectedModel,
		setSelectedReasoningEffort,
	} = useMessages();

	const {
		sendMessage,
		toggleAgentMode,
		setApprovalMode: setApprovalModeVSCode,
		setModel: setModelVSCode,
		setReasoningEffort: setReasoningEffortVSCode,
		switchChat,
		newChat,
		deleteChat,
		stopAgent,
		ready,
		showUsageDetail,
		login,
		openBilling,
		requestSuggestion,
	} = useVSCode();

	const messagesEndRef = useRef<HTMLDivElement>(null);
	const [inputText, setInputText] = useState('');
	const [inputImages, setInputImages] = useState<ImageAttachment[]>([]);

	const suggestionRequestIdRef = useRef('');

	const displaySuggestion = lastSuggestionRequestId === suggestionRequestIdRef.current ? inlineSuggestion : '';

	const handleRequestSuggestion = useCallback((text: string) => {
		const requestId = `${Date.now()}-${Math.random()}`;
		suggestionRequestIdRef.current = requestId;
		requestSuggestion(text, requestId);
	}, [requestSuggestion]);

	const handleInputTextChange = (text: string) => {
		setInputText(text);
		clearInlineSuggestion();
	};

	useEffect(() => {
		ready();
	}, [ready]);

	useEffect(() => {
		messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
	});

	const handleSendMessage = (text: string, images: ImageAttachment[]) => {
		if ((!text.trim() && images.length === 0) || isLoading) return;
		sendMessage(text, images);
		setInputText('');
		setInputImages([]);
		clearInlineSuggestion();
	};

	const handleModeChange = (mode: string) => {
		const isAgent = mode === 'agent';
		setAgentMode(isAgent);
		toggleAgentMode(isAgent);
	};

	const handleApprovalChange = (mode: string) => {
		setApprovalMode(mode);
		setApprovalModeVSCode(mode);
	};

	const handleModelChange = (model: string) => {
		setSelectedModel(model);
		setModelVSCode(model);
	};

	const handleReasoningEffortChange = (reasoningEffort: 'low' | 'medium' | 'high') => {
		setSelectedReasoningEffort(reasoningEffort);
		setReasoningEffortVSCode(reasoningEffort);
	};

	const handleSessionChange = (sessionId: string) => {
		switchChat(sessionId);
	};

	const handleNewChat = () => {
		newChat();
	};

	const handleDeleteChat = (sessionId: string) => {
		if (sessions.length > 1) {
			deleteChat(sessionId);
		}
	};

	const handleStop = () => {
		stopAgent();
	};

	const handleUsageClick = () => {
		showUsageDetail();
	};

	const handleLogin = () => {
		login();
	};

	const handleOpenBilling = () => {
		openBilling();
	};

	return (
		<div className="flex flex-col h-full">
			<MessageList
				messages={messages}
				isLoading={isLoading}
				streamingText={streamingText}
				messagesEndRef={messagesEndRef}
			/>
			<FilesChanged files={changedFiles} />
			<InputArea
				agentMode={agentMode}
				sessions={sessions}
				currentSessionId={currentSessionId}
				onSessionChange={handleSessionChange}
				approvalMode={approvalMode}
				selectedModel={selectedModel}
				selectedReasoningEffort={selectedReasoningEffort}
				availableModels={availableModels}
				modelDefinitions={modelDefinitions}
				isLoading={isLoading}
				agentRunning={agentRunning}
				text={inputText}
				images={inputImages}
				onTextChange={handleInputTextChange}
				onImagesChange={setInputImages}
				onSendMessage={handleSendMessage}
				onModeChange={handleModeChange}
				onApprovalChange={handleApprovalChange}
				onModelChange={handleModelChange}
				onReasoningEffortChange={handleReasoningEffortChange}
				workspaceFiles={workspaceFiles}
				activeFilePath={activeFilePath}
				activeSelection={activeSelection}
				activeSelectionLabel={activeSelectionLabel}
				onNewChat={handleNewChat}
				onDeleteChat={handleDeleteChat}
				onStop={handleStop}
				usageData={usageData}
				isLoggedIn={isLoggedIn}
				onUsageClick={handleUsageClick}
				onLogin={handleLogin}
				onOpenBilling={handleOpenBilling}
				inlineSuggestion={displaySuggestion}
				onRequestSuggestion={handleRequestSuggestion}
				onClearSuggestion={clearInlineSuggestion}
			/>
		</div>
	);
}
