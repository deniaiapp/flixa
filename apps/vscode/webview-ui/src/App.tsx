import { useEffect, useRef, useState } from 'react';
import { InputArea } from './components/InputArea';
import { MessageList } from './components/MessageList';
import { FilesChanged } from './components/FilesChanged';
import { ApprovalCard } from './components/ApprovalCard';
import { QueuedMessages, type QueuedMessage } from './components/QueuedMessages';
import { useMessages, useVSCode } from './hooks';
import type { ImageAttachment, ReasoningEffort } from './types';
import { getAvailableReasoningEfforts } from './types';

export default function App() {
	const {
		messages,
		sessions,
		currentSessionId,
		approvals,
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
		switchChat,
		respondApproval,
		copyToClipboard,
		editMessage,
		ready,
		login,
		openBilling,
	} = useVSCode();

	const messagesEndRef = useRef<HTMLDivElement>(null);
	const [inputText, setInputText] = useState('');
	const [inputImages, setInputImages] = useState<ImageAttachment[]>([]);
	const [excludedActiveFilePath, setExcludedActiveFilePath] = useState<string | null>(null);
	const [queue, setQueue] = useState<QueuedMessage[]>([]);
	const dequeueGateRef = useRef(false);
	const busy = isLoading || agentRunning;

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

	useEffect(() => {
		setQueue([]);
	}, [currentSessionId]);

	useEffect(() => {
		if (busy) {
			dequeueGateRef.current = false;
			return;
		}
		if (dequeueGateRef.current || queue.length === 0) {
			return;
		}
		const [next, ...rest] = queue;
		dequeueGateRef.current = true;
		setQueue(rest);
		sendMessage(next.text, next.images, next.excludedActiveFilePath, true);
		const id = setTimeout(() => {
			dequeueGateRef.current = false;
		}, 1500);
		return () => clearTimeout(id);
	}, [busy, queue, sendMessage]);

	const handleSendMessage = (text: string, images: ImageAttachment[]) => {
		if (!text.trim() && images.length === 0) return;
		const isImmediateCommand = /^\/(stop|new|clear)\b/.test(text.trim());
		if ((busy || queue.length > 0) && !isImmediateCommand) {
			setQueue((prev) => [
				...prev,
				{
					id: crypto.randomUUID(),
					text,
					images,
					excludedActiveFilePath: excludedActiveFilePath ?? undefined,
				},
			]);
		} else {
			sendMessage(text, images, excludedActiveFilePath ?? undefined);
		}
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
				sessions={sessions}
				currentSessionId={currentSessionId}
				onSwitchChat={switchChat}
				onCopy={copyToClipboard}
				onEditMessage={editMessage}
				busy={busy}
			/>
			<QueuedMessages
				queue={queue}
				onRemove={(id) => setQueue((prev) => prev.filter((item) => item.id !== id))}
			/>
			<ApprovalCard approvals={approvals} onRespond={respondApproval} />
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
