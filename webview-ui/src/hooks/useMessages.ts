import { useEffect, useState } from 'react';
import { DEFAULT_MODEL, DEFAULT_REASONING_EFFORT } from '../constants';
import type {
	ChatMessage,
	ChatSession,
	FileChange,
	ModelDefinition,
	ReasoningEffort,
	UsageData,
} from '../types';

export interface UseMessagesReturn {
	messages: ChatMessage[];
	sessions: ChatSession[];
	currentSessionId: string;
	agentMode: boolean;
	approvalMode: string;
	selectedModel: string;
	selectedReasoningEffort: ReasoningEffort;
	availableModels: string[];
	modelDefinitions: ModelDefinition[];
	isLoading: boolean;
	agentRunning: boolean;
	streamingText: string;
	usageData: UsageData | null;
	isLoggedIn: boolean;
	changedFiles: FileChange[];
	workspaceFiles: string[];
	activeFilePath: string;
	activeSelection: string;
	activeSelectionLabel: string;
	setAgentMode: (mode: boolean) => void;
	setApprovalMode: (mode: string) => void;
	setSelectedModel: (model: string) => void;
	setSelectedReasoningEffort: (reasoningEffort: ReasoningEffort) => void;
}

export function useMessages(): UseMessagesReturn {
	const [messages, setMessages] = useState<ChatMessage[]>([]);
	const [sessions, setSessions] = useState<ChatSession[]>([]);
	const [currentSessionId, setCurrentSessionId] = useState('');
	const [agentMode, setAgentMode] = useState(true);
	const [approvalMode, setApprovalMode] = useState('AUTO_APPROVE');
	const [selectedModel, setSelectedModel] = useState(DEFAULT_MODEL);
	const [selectedReasoningEffort, setSelectedReasoningEffort] =
		useState<ReasoningEffort>(DEFAULT_REASONING_EFFORT as ReasoningEffort);
	const [availableModels, setAvailableModels] = useState<string[]>([DEFAULT_MODEL]);
	const [modelDefinitions, setModelDefinitions] = useState<ModelDefinition[]>([
		{ id: DEFAULT_MODEL, label: 'GPT-5.2 Codex', description: '', tags: [], tier: 'free' },
	]);
	const [isLoading, setIsLoading] = useState(false);
	const [agentRunning, setAgentRunning] = useState(false);
	const [streamingText, setStreamingText] = useState('');
	const [usageData, setUsageData] = useState<UsageData | null>(null);
	const [isLoggedIn, setIsLoggedIn] = useState(false);
	const [changedFiles, setChangedFiles] = useState<FileChange[]>([]);
	const [workspaceFiles, setWorkspaceFiles] = useState<string[]>([]);
	const [activeFilePath, setActiveFilePath] = useState('');
	const [activeSelection, setActiveSelection] = useState('');
	const [activeSelectionLabel, setActiveSelectionLabel] = useState('');

	useEffect(() => {
		const handleMessage = (event: MessageEvent) => {
			const data = event.data;
			switch (data.type) {
				case 'updateMessages':
					setMessages(data.messages);
					break;
				case 'updateState':
					setAgentMode(data.agentMode);
					setApprovalMode(data.approvalMode);
					if (data.selectedModel) {
						setSelectedModel(data.selectedModel);
					}
					if (data.selectedReasoningEffort) {
						setSelectedReasoningEffort(data.selectedReasoningEffort);
					}
					if (data.availableModels) {
						setAvailableModels(data.availableModels);
					}
					if (data.modelDefinitions) {
						setModelDefinitions(data.modelDefinitions);
					}
					if (data.isLoggedIn !== undefined) {
						setIsLoggedIn(data.isLoggedIn);
					}
					if (data.workspaceFiles) {
						setWorkspaceFiles(data.workspaceFiles);
					}
					break;
				case 'setLoading':
					setIsLoading(data.loading);
					setAgentRunning(data.agentRunning);
					break;
				case 'updateSessions':
					setSessions(data.sessions);
					setCurrentSessionId(data.currentSessionId);
					break;
				case 'streamingUpdate':
					setStreamingText(data.text || '');
					break;
				case 'updateUsage':
					setUsageData(data.usage);
					if (data.isLoggedIn !== undefined) {
						setIsLoggedIn(data.isLoggedIn);
					}
					break;
				case 'updateChangedFiles':
					setChangedFiles(data.files || []);
					break;
				case 'updateEditorContext':
					setActiveFilePath(data.activeFilePath || '');
					setActiveSelection(data.activeSelection || '');
					setActiveSelectionLabel(data.activeSelectionLabel || '');
					break;
			}
		};

		window.addEventListener('message', handleMessage);
		return () => window.removeEventListener('message', handleMessage);
	}, []);

	return {
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
		setAgentMode,
		setApprovalMode,
		setSelectedModel,
		setSelectedReasoningEffort,
	};
}
