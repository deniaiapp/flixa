import { useEffect, useRef, useState } from 'react';
import { InputArea } from './components/InputArea';
import { MessageList } from './components/MessageList';
import { FilesChanged } from './components/FilesChanged';
import { useMessages, useVSCode } from './hooks';
import type { ImageAttachment, ReasoningEffort } from './types';
import { getAvailableReasoningEfforts } from './types';

export default function App() {
	const {
		messages,
		agentMode,
		approvalMode,
		selectedModel,
		selectedReasoningEffort,
		autoContextEnabled,
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
		stopAgent,
		ready,
		login,
		openBilling,
	} = useVSCode();

	const messagesEndRef = useRef<HTMLDivElement>(null);
	const [inputText, setInputText] = useState('');
	const [inputImages, setInputImages] = useState<ImageAttachment[]>([]);
	const [excludedActiveFilePath, setExcludedActiveFilePath] = useState<string | null>(null);

	const handleInputTextChange = (text: string) => {
		setInputText(text);
	};

	useEffect(() => {
		ready();
	}, [ready]);

	useEffect(() => {
		messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
	});

	useEffect(() => {
		setExcludedActiveFilePath(null);
	}, [activeFilePath]);

	const handleSendMessage = (text: string, images: ImageAttachment[]) => {
		if ((!text.trim() && images.length === 0) || isLoading) return;
		sendMessage(text, images, excludedActiveFilePath ?? undefined);
		setInputText('');
		setInputImages([]);
		setExcludedActiveFilePath(null);
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
		const modelDefinition = modelDefinitions.find((definition) => definition.id === model);
		const availableEfforts = getAvailableReasoningEfforts(model, modelDefinition?.reasoningEfforts);
		const nextEffort = selectedReasoningEffort && availableEfforts.includes(selectedReasoningEffort)
			? selectedReasoningEffort
			: availableEfforts.includes('medium')
				? 'medium'
				: availableEfforts[0] ?? null;
		if (nextEffort !== selectedReasoningEffort) {
			setSelectedReasoningEffort(nextEffort);
			setReasoningEffortVSCode(nextEffort ?? '');
		}
	};

	const handleReasoningEffortChange = (reasoningEffort: ReasoningEffort) => {
		setSelectedReasoningEffort(reasoningEffort);
		setReasoningEffortVSCode(reasoningEffort);
	};

	const handleStop = () => {
		stopAgent();
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
				approvalMode={approvalMode}
				selectedModel={selectedModel}
				selectedReasoningEffort={selectedReasoningEffort}
				autoContextEnabled={autoContextEnabled}
				excludedActiveFilePath={excludedActiveFilePath}
				onExcludeActiveFile={() => {
					if (activeFilePath) {
						setExcludedActiveFilePath(activeFilePath);
					}
				}}
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
				onStop={handleStop}
				usageData={usageData}
				isLoggedIn={isLoggedIn}
				onLogin={handleLogin}
				onOpenBilling={handleOpenBilling}
			/>
		</div>
	);
}
