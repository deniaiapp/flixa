import {
  type ChangeEvent,
  type KeyboardEvent,
  type ClipboardEvent,
  type DragEvent,
  useEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import type { ReactNode } from "react";
import type {
  UsageData,
  Tier,
  ImageAttachment,
  ModelDefinition,
  ModelTierRequirement,
  ReasoningEffort,
} from "../types";
import {
  canUseTier,
  getAvailableReasoningEfforts,
} from "../types";

function getBaseName(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/");
  const parts = normalized.split("/");
  return parts[parts.length - 1] || filePath;
}

function formatSelectionChipLabel(label: string): string {
  const separatorIndex = label.indexOf(":");
  if (separatorIndex === -1) {
    return getBaseName(label);
  }
  const filePath = label.slice(0, separatorIndex);
  const suffix = label.slice(separatorIndex);
  return `${getBaseName(filePath)}${suffix}`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function renderHighlightedText(text: string, workspaceFiles: string[]): ReactNode[] {
  const validFiles = new Set(workspaceFiles);
  const parts: ReactNode[] = [];
  const pattern = /@([A-Za-z0-9_./-]+)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    const fullMatch = match[0];
    const reference = match[1];
    const start = match.index;
    const end = start + fullMatch.length;

    if (start > lastIndex) {
      parts.push(
        <span key={`text-${lastIndex}`}>{text.slice(lastIndex, start)}</span>,
      );
    }

    const isValid = validFiles.has(reference);
    parts.push(
      <span
        key={`mention-${start}`}
        className={isValid ? "text-accent" : undefined}
      >
        {fullMatch}
      </span>,
    );

    lastIndex = end;
  }

  if (lastIndex < text.length) {
    parts.push(<span key={`text-${lastIndex}`}>{text.slice(lastIndex)}</span>);
  }

  if (parts.length === 0) {
    parts.push(<span key="empty">{text}</span>);
  }

  return parts;
}

const FileIcon = () => (
  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={2}
      d="M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8zm0 0v5h5"
    />
  </svg>
);

const CloseIcon = () => (
  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
  </svg>
);

interface InputAreaProps {
  agentMode: boolean;
  approvalMode: string;
  selectedModel: string;
  selectedReasoningEffort: ReasoningEffort | null;
  autoContextEnabled: boolean;
  excludedActiveFilePath: string | null;
  onExcludeActiveFile: () => void;
  availableModels: string[];
  modelDefinitions: ModelDefinition[];
  isLoading: boolean;
  agentRunning: boolean;
  text: string;
  images: ImageAttachment[];
  onTextChange: (text: string) => void;
  onImagesChange: (
    images: ImageAttachment[] | ((prev: ImageAttachment[]) => ImageAttachment[]),
  ) => void;
  onSendMessage: (text: string, images: ImageAttachment[]) => void;
  onModeChange: (mode: string) => void;
  onApprovalChange: (mode: string) => void;
  onModelChange: (model: string) => void;
  onReasoningEffortChange: (reasoningEffort: ReasoningEffort) => void;
  workspaceFiles: string[];
  activeFilePath: string;
  activeSelection: string;
  activeSelectionLabel: string;
  onStop: () => void;
  usageData: UsageData | null;
  isLoggedIn: boolean;
  onLogin: () => void;
  onOpenBilling: () => void;
}

const ChatIcon = () => (
  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={2}
      d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"
    />
  </svg>
);

const AgentIcon = () => (
  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={2}
      d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"
    />
  </svg>
);

const AllApproveIcon = () => (
  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={2}
      d="M13 10V3L4 14h7v7l9-11h-7z"
    />
  </svg>
);

const AutoApproveIcon = () => (
  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={2}
      d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"
    />
  </svg>
);

const SafeApproveIcon = () => (
  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={2}
      d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"
    />
  </svg>
);

const ManualApproveIcon = () => (
  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={2}
      d="M7 11.5V14m0-2.5v-6a1.5 1.5 0 113 0m-3 6a1.5 1.5 0 00-3 0v2a7.5 7.5 0 0015 0v-5a1.5 1.5 0 00-3 0m-6-3V11m0-5.5v-1a1.5 1.5 0 013 0v1m0 0V11m0-5.5a1.5 1.5 0 013 0v3m0 0V11"
    />
  </svg>
);


const modeOptions = [
  {
    value: "chat",
    label: "Chat",
    description:
      "Simple chat mode for asking questions and discussing code without executing actions.",
    icon: <ChatIcon />,
  },
  {
    value: "agent",
    label: "Agent",
    description:
      "Autonomous agent mode that can execute shell commands, edit files, and perform complex tasks.",
    icon: <AgentIcon />,
  },
];

const approvalOptions = [
  {
    value: "ALL_APPROVE",
    label: "All Approve",
    description: "Execute all actions immediately without any confirmation. Use with caution.",
    icon: <AllApproveIcon />,
  },
  {
    value: "AUTO_APPROVE",
    label: "Auto",
    description: "AI safety check for shell commands, auto-execute file operations.",
    icon: <AutoApproveIcon />,
  },
  {
    value: "SAFE_APPROVE",
    label: "Safe Approve",
    description: "User confirmation for shell commands, auto-execute safe file operations.",
    icon: <SafeApproveIcon />,
  },
  {
    value: "MANUAL_APPROVE",
    label: "Manual Approve",
    description: "User confirmation required for all actions. Most secure option.",
    icon: <ManualApproveIcon />,
  },
];

const reasoningEffortOptions: Array<{
  value: ReasoningEffort;
  label: string;
  description: string;
}> = [
  {
    value: "low",
    label: "Light",
    description: "Light reasoning effort for faster responses.",
  },
  {
    value: "medium",
    label: "Medium",
    description: "Balanced reasoning effort.",
  },
  {
    value: "high",
    label: "High",
    description: "Higher reasoning effort for harder tasks.",
  },
  {
    value: "xhigh",
    label: "Extra High",
    description: "Extra high reasoning effort for complex tasks.",
  },
  {
    value: "max",
    label: "Max",
    description: "Maximum reasoning effort for the hardest tasks.",
  },
];

export function InputArea({
  agentMode,
  approvalMode,
  selectedModel,
  selectedReasoningEffort,
  autoContextEnabled,
  excludedActiveFilePath,
  onExcludeActiveFile,
  availableModels,
  modelDefinitions,
  isLoading,
  agentRunning,
  text,
  images,
  onTextChange,
  onImagesChange,
  onSendMessage,
  onModeChange,
  onApprovalChange,
  onModelChange,
  onReasoningEffortChange,
  workspaceFiles,
  activeFilePath,
  activeSelection,
  activeSelectionLabel,
  onStop,
  usageData,
  isLoggedIn,
  onLogin,
  onOpenBilling,
}: InputAreaProps) {
  const settingsButtonRef = useRef<HTMLDivElement>(null);
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [activeSubmenu, setActiveSubmenu] = useState<string | null>(null);
  const [settingsPosition, setSettingsPosition] = useState({ bottom: 0, left: 0 });
  const [modelSearch, setModelSearch] = useState("");
  const [modelTooltip, setModelTooltip] = useState<{
    label: string;
    description: string;
    tags: string[];
    bottom: number;
    left: number;
    width: number;
  } | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [mentionMenuPosition, setMentionMenuPosition] = useState({
    top: 0,
    left: 0,
    width: 0,
    openAbove: false,
  });
  const [commandIndex, setCommandIndex] = useState(0);
  const [commandMenuPosition, setCommandMenuPosition] = useState({
    top: 0,
    left: 0,
    width: 0,
    openAbove: false,
  });
  const [, setIsCursorAtEnd] = useState(true);

  const syncTextareaHeight = () => {
    if (!textareaRef.current) {
      return;
    }

    textareaRef.current.style.height = "auto";
    const nextHeight = Math.min(textareaRef.current.scrollHeight, 200);
    textareaRef.current.style.height = `${nextHeight}px`;
    textareaRef.current.style.overflowY =
      textareaRef.current.scrollHeight > 200 ? "auto" : "hidden";
  };

  const syncTextareaScroll = () => {
    const textarea = textareaRef.current;
    const mirror = document.getElementById("input-text-mirror");
    if (!textarea || !mirror) {
      return;
    }

    mirror.scrollTop = textarea.scrollTop;
    mirror.scrollLeft = textarea.scrollLeft;
  };

  const mentionMatch = text.match(/(?:^|\s)@([A-Za-z0-9_./-]*)$/);
  const mentionQuery = mentionMatch?.[1] ?? "";
  const mentionSuggestions =
    mentionMatch
      ? workspaceFiles
          .filter((file) => file.toLowerCase().includes(mentionQuery.toLowerCase()))
          .slice(0, 8)
      : [];
  const mentionedFiles = Array.from(
    new Set((text.match(/@([A-Za-z0-9_./-]+)/g) ?? []).map((match) => match.slice(1))),
  );

  const slashCommands = [
    { name: "help", description: "Show available slash commands" },
    { name: "new", description: "Start a new chat" },
    { name: "clear", description: "Clear messages in the current chat" },
    { name: "compact", description: "Compact the context window for this chat" },
    { name: "stop", description: "Stop the running agent" },
    { name: "agent", description: "Switch to agent mode" },
    { name: "chat", description: "Switch to chat mode" },
    { name: "model", description: "Show or set the model (/model [id])" },
    {
      name: "approval",
      description: "Show or set approval mode (/approval auto|safe|manual|all)",
    },
  ];
  const commandMatch = text.match(/^\/([a-zA-Z0-9_-]*)$/);
  const commandQuery = commandMatch?.[1] ?? "";
  const commandSuggestions = commandMatch
    ? slashCommands.filter((command) =>
        command.name.toLowerCase().startsWith(commandQuery.toLowerCase()),
      )
    : [];

  const userTier = usageData?.tier ?? null;
  const normalizedActiveFilePath = activeFilePath.replace(/\\/g, "/").toLowerCase();
  const normalizedExcludedActiveFilePath = excludedActiveFilePath
    ?.replace(/\\/g, "/")
    .toLowerCase();
  const includeActiveFileContext =
    autoContextEnabled &&
    !!(activeFilePath || activeSelection) &&
    normalizedActiveFilePath !== normalizedExcludedActiveFilePath;
  const getModelDefinition = (modelId: string): ModelDefinition | undefined => {
    return modelDefinitions.find((model) => model.id === modelId);
  };
  const availableReasoningEffortOptions = reasoningEffortOptions.filter((option) =>
    getAvailableReasoningEfforts(
      selectedModel,
      getModelDefinition(selectedModel)?.reasoningEfforts,
    ).includes(option.value),
  );
  const getModelLabel = (modelId: string): string => {
    const definition = getModelDefinition(modelId);
    return definition?.label ?? modelId;
  };
  const getModelTierRequirement = (modelId: string): ModelTierRequirement => {
    const definition = getModelDefinition(modelId);
    return definition?.tier ?? "free";
  };
  const getModelTokenUsageMultiplier = (modelId: string): number => {
    const definition = getModelDefinition(modelId);
    return definition?.tokenUsageMultiplier ?? 1;
  };
  // Tier 2 and above count each token more than once; older servers send only the multiplier.
  const renderTokenUsageMultiplierBadge = (multiplier: number, usageTier?: number) => {
    if (multiplier <= 1 && (usageTier ?? 1) <= 1) {
      return null;
    }
    return (
      <span
        className="shrink-0 rounded border border-foreground/30 bg-foreground/10 px-1 py-0.5 text-[9px] leading-none text-foreground whitespace-nowrap"
        title={`Each token counts ${multiplier}x toward your usage`}
      >
        {usageTier ? `Tier ${usageTier} · ${multiplier}x` : `${multiplier}x token usage`}
      </span>
    );
  };
  const isModelLocked = (model: string, tier: Tier | null, loggedIn: boolean): boolean => {
    if (!loggedIn) {
      return true;
    }
    if (!tier) {
      return true;
    }
    const required = getModelTierRequirement(model);
    return !canUseTier(tier, required);
  };
  const getModelLockMessage = (model: string, loggedIn: boolean): string => {
    if (!loggedIn) {
      return "Login required";
    }
    const required = getModelTierRequirement(model);
    if (required === "max") {
      return "Max plan required";
    }

    if (required === "pro") {
      return "Pro plan required";
    }
    if (required === "plus") {
      return "Plus plan or higher required";
    }
    return "";
  };

  const modelOptions = availableModels.map((model) => {
    const def = getModelDefinition(model);
    return {
      value: model,
      label: getModelLabel(model),
      description: def?.description ?? "",
      tags: def?.tags ?? [],
      tokenUsageMultiplier: getModelTokenUsageMultiplier(model),
      usageTier: def?.usageTier,
      locked: isModelLocked(model, userTier, isLoggedIn),
      lockMessage: getModelLockMessage(model, isLoggedIn),
    };
  });
  const normalizedModelSearch = modelSearch.trim().toLowerCase();
  const filteredModelOptions = modelOptions
    .filter((option) => {
      if (!normalizedModelSearch) {
        return true;
      }
      return (
        option.label.toLowerCase().includes(normalizedModelSearch) ||
        option.value.toLowerCase().includes(normalizedModelSearch) ||
        option.description.toLowerCase().includes(normalizedModelSearch) ||
        option.tags.some((tag) => tag.toLowerCase().includes(normalizedModelSearch))
      );
    })
    .sort((a, b) => Number(a.locked) - Number(b.locked));

	useEffect(() => {
		if (!isSettingsOpen || activeSubmenu !== "model") {
			setModelTooltip(null);
		}
	}, [isSettingsOpen, activeSubmenu]);

	useEffect(() => {
		const handleClickOutside = (e: MouseEvent) => {
			const settingsMenu = document.getElementById("settings-menu");
			if (settingsButtonRef.current && !settingsButtonRef.current.contains(e.target as Node)) {
        if (settingsMenu && !settingsMenu.contains(e.target as Node)) {
          setIsSettingsOpen(false);
          setActiveSubmenu(null);
        }
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  useEffect(() => {
    const anchor = menuAnchor ?? settingsButtonRef.current;
    if (isSettingsOpen && anchor) {
      const buttonRect = anchor.getBoundingClientRect();
      const settingsMenu = document.getElementById("settings-menu");
      const viewportWidth = window.innerWidth;
      const menuWidth = settingsMenu?.offsetWidth ?? 200;
      let left = buttonRect.left;
      if (left + menuWidth > viewportWidth - 8) {
        left = Math.max(8, viewportWidth - menuWidth - 8);
      }
      setSettingsPosition({
        bottom: window.innerHeight - buttonRect.top + 6,
        left,
      });
    }
  }, [isSettingsOpen, menuAnchor, activeSubmenu]);

  useEffect(() => {
    const updateMentionMenuPosition = () => {
      if (!textareaRef.current || mentionSuggestions.length === 0) {
        return;
      }

      const rect = textareaRef.current.getBoundingClientRect();
      const menuHeight = Math.min(mentionSuggestions.length, 8) * 36 + 4;
      const spaceBelow = window.innerHeight - rect.bottom;
      const openAbove = spaceBelow < menuHeight + 8 && rect.top > spaceBelow;

      setMentionMenuPosition({
        top: openAbove ? rect.top - 4 : rect.bottom + 4,
        left: rect.left,
        width: rect.width,
        openAbove,
      });
    };

    updateMentionMenuPosition();

    if (mentionSuggestions.length === 0) {
      return;
    }

    window.addEventListener("resize", updateMentionMenuPosition);
    window.addEventListener("scroll", updateMentionMenuPosition, true);
    return () => {
      window.removeEventListener("resize", updateMentionMenuPosition);
      window.removeEventListener("scroll", updateMentionMenuPosition, true);
    };
  }, [mentionSuggestions.length, text, activeSelectionLabel, activeFilePath]);

  useEffect(() => {
    const updateCommandMenuPosition = () => {
      if (!textareaRef.current || commandSuggestions.length === 0) {
        return;
      }

      const rect = textareaRef.current.getBoundingClientRect();
      const menuHeight = Math.min(commandSuggestions.length, 8) * 44 + 4;
      const spaceBelow = window.innerHeight - rect.bottom;
      const openAbove = spaceBelow < menuHeight + 8 && rect.top > spaceBelow;

      setCommandMenuPosition({
        top: openAbove ? rect.top - 4 : rect.bottom + 4,
        left: rect.left,
        width: rect.width,
        openAbove,
      });
    };

    updateCommandMenuPosition();

    if (commandSuggestions.length === 0) {
      return;
    }

    window.addEventListener("resize", updateCommandMenuPosition);
    window.addEventListener("scroll", updateCommandMenuPosition, true);
    return () => {
      window.removeEventListener("resize", updateCommandMenuPosition);
      window.removeEventListener("scroll", updateCommandMenuPosition, true);
    };
  }, [commandSuggestions.length, text]);

  useEffect(() => {
    syncTextareaHeight();
    syncTextareaScroll();
  }, [text]);

  const applyCommand = (commandName: string) => {
    const nextText = `/${commandName}`;
    onTextChange(nextText);
    setCommandIndex(0);
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      if (textareaRef.current) {
        const length = nextText.length;
        textareaRef.current.selectionStart = length;
        textareaRef.current.selectionEnd = length;
        syncTextareaScroll();
      }
    });
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (commandSuggestions.length > 0 && commandMatch) {
      const selectedCommand =
        commandSuggestions[commandIndex] ?? commandSuggestions[0];
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setCommandIndex((prev) => (prev + 1) % commandSuggestions.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setCommandIndex(
          (prev) => (prev - 1 + commandSuggestions.length) % commandSuggestions.length,
        );
        return;
      }
      if (e.key === "Tab") {
        e.preventDefault();
        applyCommand(selectedCommand.name);
        return;
      }
      if (e.key === "Enter" && text.trim() !== `/${selectedCommand.name}`) {
        e.preventDefault();
        applyCommand(selectedCommand.name);
        return;
      }
    }
    if (mentionSuggestions.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setMentionIndex((prev) => (prev + 1) % mentionSuggestions.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setMentionIndex((prev) => (prev - 1 + mentionSuggestions.length) % mentionSuggestions.length);
        return;
      }
      if (e.key === "Tab" || e.key === "Enter") {
        if (mentionMatch) {
          e.preventDefault();
          applyMention(mentionSuggestions[mentionIndex] ?? mentionSuggestions[0]);
          return;
        }
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleSend = () => {
    if (text.trim() || images.length > 0) {
      onSendMessage(text, images);
      onTextChange("");
      onImagesChange([]);
    }
  };

  const handleTextChange = (e: ChangeEvent<HTMLTextAreaElement>) => {
    onTextChange(e.target.value);
    setMentionIndex(0);
    setCommandIndex(0);
    setIsCursorAtEnd(e.target.selectionStart === e.target.value.length);
    syncTextareaHeight();
  };

  const handleCursorChange = () => {
    if (textareaRef.current) {
      setIsCursorAtEnd(textareaRef.current.selectionStart === text.length);
    }
  };

  const applyMention = (filePath: string) => {
    const nextText = text.replace(/(?:^|\s)@([A-Za-z0-9_./-]*)$/, (match) => {
      const prefix = match.startsWith(" ") ? " " : "";
      return `${prefix}@${filePath} `;
    });
    onTextChange(nextText);
    setMentionIndex(0);
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      if (textareaRef.current) {
        const length = nextText.length;
        textareaRef.current.selectionStart = length;
        textareaRef.current.selectionEnd = length;
        syncTextareaScroll();
      }
    });
  };

  const fileInputRef = useRef<HTMLInputElement>(null);

  const processFiles = (files: FileList | File[]) => {
    const imageFiles = Array.from(files).filter((file) => file.type.startsWith("image/"));
    if (imageFiles.length === 0) return;

    const newImages: ImageAttachment[] = [];
    let loadedCount = 0;

    for (const file of imageFiles) {
      const reader = new FileReader();
      reader.onload = (e) => {
        const dataUrl = e.target?.result as string;
        newImages.push({
          id: crypto.randomUUID(),
          data: dataUrl,
          mimeType: file.type,
          name: file.name,
        });
        loadedCount++;
        if (loadedCount === imageFiles.length) {
          onImagesChange((prev) => [...prev, ...newImages]);
        }
      };
      reader.readAsDataURL(file);
    }
  };

  const handlePaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData?.items;
    if (!items) return;

    const imageItems = Array.from(items).filter((item) => item.type.startsWith("image/"));
    if (imageItems.length === 0) return;

    e.preventDefault();
    const files: File[] = [];
    for (const item of imageItems) {
      const file = item.getAsFile();
      if (file) files.push(file);
    }
    processFiles(files);
  };

  const handleDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    const files = e.dataTransfer?.files;
    if (files) processFiles(files);
  };

  const handleDragOver = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
  };

  const handleRemoveImage = (id: string) => {
    onImagesChange((prev) => prev.filter((img) => img.id !== id));
  };

  const handleImageButtonClick = () => {
    fileInputRef.current?.click();
  };

  const handleFileInputChange = (e: ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files) processFiles(files);
    e.target.value = "";
  };

  const mentionMenu =
    mentionSuggestions.length > 0 &&
    createPortal(
      <div
        className="fixed z-[9999] border border-menu-border rounded-xl bg-menu-bg overflow-hidden py-1 shadow-[0_12px_32px_var(--color-shadow)]"
        style={{
          top: mentionMenuPosition.top,
          left: mentionMenuPosition.left,
          width: mentionMenuPosition.width,
          transform: mentionMenuPosition.openAbove ? "translateY(-100%)" : undefined,
        }}
      >
        {mentionSuggestions.map((file, index) => (
          <button
            key={file}
            type="button"
            onClick={() => applyMention(file)}
            className={`w-full px-3 py-1.5 text-left text-xs font-mono truncate transition-colors ${
              index === mentionIndex
                ? "bg-surface-hover text-foreground"
                : "text-menu-foreground hover:bg-surface-hover"
            }`}
          >
            @{file}
          </button>
        ))}
      </div>,
      document.body,
    );

  const commandMenu =
    commandSuggestions.length > 0 &&
    createPortal(
      <div
        className="fixed z-[9999] border border-menu-border rounded-xl bg-menu-bg overflow-hidden py-1 shadow-[0_12px_32px_var(--color-shadow)]"
        style={{
          top: commandMenuPosition.top,
          left: commandMenuPosition.left,
          width: commandMenuPosition.width,
          transform: commandMenuPosition.openAbove ? "translateY(-100%)" : undefined,
        }}
      >
        {commandSuggestions.map((command, index) => (
          <button
            key={command.name}
            type="button"
            onClick={() => applyCommand(command.name)}
            className={`w-full px-3 py-1.5 text-left text-xs transition-colors ${
              index === commandIndex
                ? "bg-surface-hover text-foreground"
                : "text-menu-foreground hover:bg-surface-hover"
            }`}
          >
            <div className="flex items-baseline gap-2 min-w-0">
              <span className="font-medium font-mono shrink-0">/{command.name}</span>
              <span className="text-[11px] text-foreground-subtle truncate">
                {command.description}
              </span>
            </div>
          </button>
        ))}
      </div>,
      document.body,
    );

  const getCurrentModeLabel = () => {
    const mode = modeOptions.find((m) => m.value === (agentMode ? "agent" : "chat"));
    return mode?.label || "Chat";
  };

  const getCurrentApprovalLabel = () => {
    const approval = approvalOptions.find((a) => a.value === approvalMode);
    return approval?.label || "Auto";
  };

  const getCurrentModelLabel = () => {
    return getModelLabel(selectedModel);
  };

  const getCurrentReasoningEffortLabel = () => {
    return (
      availableReasoningEffortOptions.find((option) => option.value === selectedReasoningEffort)?.label ??
      "Medium"
    );
  };

  const getCurrentModeIcon = () => {
    return agentMode ? <AgentIcon /> : <ChatIcon />;
  };

  const getCurrentApprovalIcon = () => {
    switch (approvalMode) {
      case "ALL_APPROVE":
        return <AllApproveIcon />;
      case "AUTO_APPROVE":
        return <AutoApproveIcon />;
      case "SAFE_APPROVE":
        return <SafeApproveIcon />;
      case "MANUAL_APPROVE":
        return <ManualApproveIcon />;
      default:
        return <AutoApproveIcon />;
    }
  };

  const ChevronIcon = () => (
    <svg
      className="w-3.5 h-3.5"
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
    </svg>
  );

  const SelectorChevronIcon = () => (
    <svg
      className="w-3 h-3 opacity-70"
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 9l6 6 6-6" />
    </svg>
  );

  const settingsMenu =
    isSettingsOpen &&
    createPortal(
      <div
        id="settings-menu"
        className="fixed z-[9999] min-w-[220px] max-w-[calc(100vw-16px)] bg-menu-bg border border-menu-border rounded-xl overflow-hidden shadow-[0_12px_32px_var(--color-shadow)]"
        style={{
          bottom: settingsPosition.bottom,
          left: settingsPosition.left,
        }}
      >
        {activeSubmenu === null ? (
          <div className="py-1">
            <button
              type="button"
              className="w-full px-3 py-2 cursor-pointer transition-colors hover:bg-surface-hover text-xs text-left flex items-center gap-2 text-menu-foreground"
              onClick={() => {
                setIsSettingsOpen(false);
                handleImageButtonClick();
              }}
            >
              <svg
                className="w-4 h-4"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
                aria-hidden="true"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"
                />
              </svg>
              <span>Attach image</span>
            </button>
            <button
              type="button"
              className="w-full px-3 py-2 cursor-pointer transition-colors hover:bg-surface-hover text-xs text-left flex items-center justify-between text-menu-foreground border-t border-menu-separator"
              onClick={() => setActiveSubmenu("mode")}
            >
              <div className="flex items-center gap-2">
                {getCurrentModeIcon()}
                <span>Mode: {getCurrentModeLabel()}</span>
              </div>
              <ChevronIcon />
            </button>
            {agentMode && (
              <button
                type="button"
                className="w-full px-3 py-2 cursor-pointer transition-colors hover:bg-surface-hover text-xs text-left flex items-center justify-between text-menu-foreground border-t border-menu-separator"
                onClick={() => setActiveSubmenu("approval")}
              >
                <div className="flex items-center gap-2">
                  {getCurrentApprovalIcon()}
                  <span>Approval: {getCurrentApprovalLabel()}</span>
                </div>
                <ChevronIcon />
              </button>
            )}
          </div>
        ) : activeSubmenu === "mode" ? (
          <div className="py-1">
            <button
              type="button"
              className="w-full px-3 py-2 cursor-pointer transition-colors hover:bg-surface-hover text-xs text-left text-foreground-subtle flex items-center gap-2"
              onClick={() => setActiveSubmenu(null)}
            >
              <svg
                className="w-3.5 h-3.5"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
                aria-hidden="true"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M15 19l-7-7 7-7"
                />
              </svg>
              <span>Back</span>
            </button>
            <div className="border-t border-menu-separator" />
            {modeOptions.map((option) => (
              <button
                key={option.value}
                type="button"
                className={`w-full px-3 py-2 cursor-pointer transition-colors hover:bg-surface-hover text-xs text-left flex items-center gap-2 ${
                  (agentMode ? "agent" : "chat") === option.value
                    ? "bg-surface-hover text-foreground"
                    : "text-menu-foreground"
                }`}
                onClick={() => {
                  onModeChange(option.value);
                  setActiveSubmenu(null);
                  setIsSettingsOpen(false);
                }}
              >
                <span className="flex-shrink-0">{option.icon}</span>
                <div className="flex-1">
                  <div className="font-medium">{option.label}</div>
                  <div className="text-[10px] text-foreground-subtle leading-tight mt-0.5">
                    {option.description}
                  </div>
                </div>
              </button>
            ))}
          </div>
        ) : activeSubmenu === "approval" ? (
          <div className="py-1">
            <button
              type="button"
              className="w-full px-3 py-2 cursor-pointer transition-colors hover:bg-surface-hover text-xs text-left text-foreground-subtle flex items-center gap-2"
              onClick={() => setActiveSubmenu(null)}
            >
              <svg
                className="w-3.5 h-3.5"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
                aria-hidden="true"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M15 19l-7-7 7-7"
                />
              </svg>
              <span>Back</span>
            </button>
            <div className="border-t border-menu-separator" />
            {approvalOptions.map((option) => (
              <button
                key={option.value}
                type="button"
                className={`w-full px-3 py-2 cursor-pointer transition-colors hover:bg-surface-hover text-xs text-left flex items-center gap-2 ${
                  approvalMode === option.value
                    ? "bg-surface-hover text-foreground"
                    : "text-menu-foreground"
                }`}
                onClick={() => {
                  onApprovalChange(option.value);
                  setActiveSubmenu(null);
                  setIsSettingsOpen(false);
                }}
              >
                <span className="flex-shrink-0">{option.icon}</span>
                <div className="flex-1">
                  <div className="font-medium">{option.label}</div>
                  <div className="text-[10px] text-foreground-subtle leading-tight mt-0.5">
                    {option.description}
                  </div>
                </div>
              </button>
            ))}
          </div>
        ) : activeSubmenu === "model" ? (
          <div className="py-1">
            <button
              type="button"
              className="w-full px-3 py-2 cursor-pointer transition-colors hover:bg-surface-hover text-xs text-left text-foreground-subtle flex items-center gap-2"
              onClick={() => {
                setActiveSubmenu(null);
                setIsSettingsOpen(false);
              }}
            >
              <svg
                className="w-3.5 h-3.5"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
                aria-hidden="true"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M15 19l-7-7 7-7"
                />
              </svg>
              <span>Back</span>
            </button>
            <div className="border-t border-menu-separator" />
            <div className="px-3 py-2">
              <input
                type="text"
                value={modelSearch}
                onChange={(e) => setModelSearch(e.target.value)}
                placeholder="Search models"
                className="w-full px-2 py-1 text-xs rounded border border-menu-border bg-input-bg text-input-foreground placeholder:text-input-placeholder outline-none"
              />
            </div>
            <div className="max-h-[280px] overflow-y-auto">
              {filteredModelOptions.length === 0 ? (
                <div className="px-3 py-2 text-xs text-foreground-subtle">No models found</div>
              ) : (
                filteredModelOptions.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    onMouseEnter={(e) => {
                      if (!option.description && option.tags.length === 0) {
                        setModelTooltip(null);
                        return;
                      }
                      const rect = e.currentTarget.getBoundingClientRect();
                      const width = Math.min(260, window.innerWidth - 16);
                      setModelTooltip({
                        label: option.label,
                        description: option.description,
                        tags: option.tags,
                        bottom: window.innerHeight - rect.top + 6,
                        left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
                        width,
                      });
                    }}
                    onMouseLeave={() => setModelTooltip(null)}
                    className={`w-full px-3 py-2 cursor-pointer transition-colors hover:bg-surface-hover text-xs text-left ${
                      selectedModel === option.value
                        ? "bg-surface-hover text-foreground"
                        : "text-menu-foreground"
                    } ${option.locked ? "opacity-60" : ""}`}
                    onClick={() => {
                      if (option.locked) {
                        if (!isLoggedIn) {
                          onLogin();
                        } else {
                          onOpenBilling();
                        }
                        setActiveSubmenu(null);
                        setIsSettingsOpen(false);
                        return;
                      }
                      onModelChange(option.value);
                      setActiveSubmenu(null);
                      setIsSettingsOpen(false);
                    }}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="flex min-w-0 items-center gap-2">
                        <span className="truncate font-medium">{option.label}</span>
                        {renderTokenUsageMultiplierBadge(
                          option.tokenUsageMultiplier,
                          option.usageTier,
                        )}
                      </span>
                      {option.locked && (
                        <span className="flex items-center gap-1 text-[10px] text-foreground-subtle">
                          <svg
                            className="w-3 h-3"
                            fill="none"
                            stroke="currentColor"
                            viewBox="0 0 24 24"
                            aria-hidden="true"
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              strokeWidth={2}
                              d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"
                            />
                          </svg>
                        </span>
                      )}
                    </div>
                    {option.locked && (
                      <div className="mt-0.5 text-[10px] text-foreground-subtle">{option.lockMessage}</div>
                    )}
                  </button>
                ))
              )}
            </div>
          </div>
        ) : activeSubmenu === "reasoning" ? (
          <div className="py-1">
            <button
              type="button"
              className="w-full px-3 py-2 cursor-pointer transition-colors hover:bg-surface-hover text-xs text-left text-foreground-subtle flex items-center gap-2"
              onClick={() => {
                setActiveSubmenu(null);
                setIsSettingsOpen(false);
              }}
            >
              <svg
                className="w-3.5 h-3.5"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
                aria-hidden="true"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M15 19l-7-7 7-7"
                />
              </svg>
              <span>Back</span>
            </button>
            <div className="border-t border-menu-separator" />
            {availableReasoningEffortOptions.map((option) => (
              <button
                key={option.value}
                type="button"
                className={`w-full px-3 py-2 cursor-pointer transition-colors hover:bg-surface-hover text-xs text-left ${
                  selectedReasoningEffort === option.value
                    ? "bg-surface-hover text-foreground"
                    : "text-menu-foreground"
                }`}
                onClick={() => {
                  onReasoningEffortChange(option.value);
                  setActiveSubmenu(null);
                  setIsSettingsOpen(false);
                }}
              >
                <div className="font-medium">{option.label}</div>
                <div className="text-[10px] text-foreground-subtle leading-tight mt-0.5">
                  {option.description}
                </div>
              </button>
            ))}
          </div>
        ) : null}
        {activeSubmenu === "model" && modelTooltip && (
          <div
            role="tooltip"
            className="fixed z-[10000] pointer-events-none rounded-lg border border-menu-border bg-menu-bg px-3 py-2 text-xs text-menu-foreground shadow-[0_8px_24px_var(--color-shadow)] backdrop-blur-sm"
            style={{
              bottom: modelTooltip.bottom,
              left: modelTooltip.left,
              width: modelTooltip.width,
            }}
          >
            <div className="font-semibold text-foreground">{modelTooltip.label}</div>
            {modelTooltip.description && (
              <div className="mt-1 text-[11px] leading-snug text-foreground-muted">
                {modelTooltip.description}
              </div>
            )}
            {modelTooltip.tags.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1">
                {modelTooltip.tags.map((tag) => (
                  <span
                    key={tag}
                    className="rounded-full border border-foreground/20 bg-foreground/10 px-1.5 py-0.5 text-[9px] leading-none text-foreground"
                  >
                    {tag}
                  </span>
                ))}
              </div>
            )}
          </div>
        )}
      </div>,
      document.body,
    );

  const openMenu = (anchor: HTMLElement, submenu: string | null) => {
    setMenuAnchor(anchor);
    setActiveSubmenu(submenu);
    setIsSettingsOpen(true);
  };

  const toolbarButtonClassName =
    "inline-flex items-center gap-1 h-7 px-2 text-[11px] text-foreground-muted hover:text-foreground hover:bg-surface-hover rounded-lg transition-colors";

  return (
    <div className="mx-auto w-full max-w-3xl px-2.5 pb-2.5 pt-2.5">
      <div
        className="relative z-10 bg-composer border border-input-border rounded-2xl overflow-hidden shadow-[0_4px_16px_var(--color-shadow)] focus-within:border-foreground/30 transition-colors"
        onDrop={handleDrop}
        onDragOver={handleDragOver}
      >
        {images.length > 0 && (
          <div className="flex flex-wrap gap-2 px-3 pt-3">
            {images.map((img) => (
              <div key={img.id} className="relative group">
                <img
                  src={img.data}
                  alt={img.name || "Attached image"}
                  className="h-16 w-16 object-cover rounded-lg border border-hairline"
                />
                <button
                  type="button"
                  onClick={() => handleRemoveImage(img.id)}
                  className="absolute -top-1.5 -right-1.5 w-5 h-5 bg-menu-bg text-foreground border border-menu-border rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                  title="Remove image"
                >
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M6 18L18 6M6 6l12 12"
                    />
                  </svg>
                </button>
              </div>
            ))}
          </div>
        )}
        {(includeActiveFileContext || mentionedFiles.length > 0) && (
          <div className="px-3 pt-2.5">
            <div className="flex gap-1.5 overflow-x-auto whitespace-nowrap">
              {includeActiveFileContext && (activeSelectionLabel || activeFilePath) && (
                <div className="px-1.5 py-0.5 rounded-md text-[11px] text-foreground-muted bg-bubble inline-flex items-center gap-1.5 shrink-0">
                  <FileIcon />
                  <span>{activeSelectionLabel ? formatSelectionChipLabel(activeSelectionLabel) : getBaseName(activeFilePath)}</span>
                  <button
                    type="button"
                    onClick={onExcludeActiveFile}
                    className="text-foreground-subtle hover:text-foreground rounded-sm transition-colors"
                    title="Exclude active file from context"
                    aria-label="Exclude active file from context"
                  >
                    <CloseIcon />
                  </button>
                </div>
              )}
              {mentionedFiles.map((file) => (
                <button
                  key={file}
                  type="button"
                  onClick={() => applyMention(file)}
                  className="px-1.5 py-0.5 rounded-md text-[11px] text-foreground-muted bg-bubble hover:text-foreground inline-flex items-center gap-1.5 shrink-0"
                >
                  <FileIcon />
                  <span>{getBaseName(file)}</span>
                </button>
              ))}
            </div>
          </div>
        )}
        <div className="relative">
          {text.length > 0 && (
            <div
              id="input-text-mirror"
              aria-hidden="true"
              className="absolute inset-0 px-3.5 pt-3 pb-1.5 text-[13px] leading-relaxed whitespace-pre-wrap break-words overflow-hidden pointer-events-none select-none"
            >
              <span className="invisible">{escapeHtml("")}</span>
              <span className="text-input-foreground">{renderHighlightedText(text, workspaceFiles)}</span>
            </div>
          )}
          <textarea
            ref={textareaRef}
            value={text}
            onChange={handleTextChange}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            onScroll={syncTextareaScroll}
            onClick={handleCursorChange}
            onSelect={handleCursorChange}
            placeholder={isLoading || agentRunning ? "Queue a message for when Flixa finishes" : "Plan, @file for context, / for commands"}
            rows={1}
            className={`block w-full px-3.5 pt-3 pb-1.5 bg-transparent resize-none min-h-[48px] max-h-[200px] text-[13px] leading-relaxed outline-none placeholder:text-input-placeholder disabled:opacity-50 disabled:cursor-not-allowed ${text.length > 0 ? "text-transparent caret-input-foreground" : "text-input-foreground"}`}
          />
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          onChange={handleFileInputChange}
          className="hidden"
        />
        <div className="flex items-center justify-between gap-2 px-2 pb-2 pt-0.5">
          <div ref={settingsButtonRef} className="flex items-center gap-0.5 min-w-0">
            <button
              type="button"
              onClick={(e) => openMenu(e.currentTarget, null)}
              className="w-7 h-7 shrink-0 flex items-center justify-center text-foreground-muted hover:text-foreground hover:bg-surface-hover rounded-lg transition-colors"
              title={agentMode ? `Attach image, Mode: ${getCurrentModeLabel()}, Approval: ${getCurrentApprovalLabel()}` : `Attach image, Mode: ${getCurrentModeLabel()}`}
              aria-label="More options"
            >
              <svg
                className="w-4 h-4"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
                aria-hidden="true"
              >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 5v14M5 12h14" />
              </svg>
            </button>
            <button
              type="button"
              onClick={(e) => {
                setModelSearch("");
                openMenu(e.currentTarget, "model");
              }}
              className={`${toolbarButtonClassName} min-w-0 max-w-[160px]`}
              title={`Model: ${getCurrentModelLabel()}`}
            >
              <span className="truncate">{getCurrentModelLabel()}</span>
              <SelectorChevronIcon />
            </button>
            {availableReasoningEffortOptions.length > 0 && (
              <button
                type="button"
                onClick={(e) => openMenu(e.currentTarget, "reasoning")}
                className={`${toolbarButtonClassName} min-w-0 max-w-[105px]`}
                title={`Effort: ${getCurrentReasoningEffortLabel()}`}
              >
                <span className="truncate">{getCurrentReasoningEffortLabel()}</span>
                <SelectorChevronIcon />
              </button>
            )}
          </div>
          <div className="flex items-center shrink-0">
            {agentRunning ? (
              <button
                type="button"
                onClick={onStop}
                className="w-7 h-7 flex items-center justify-center rounded-full bg-foreground text-[var(--vscode-editor-background)] hover:opacity-80 transition-opacity"
                title="Stop"
              >
                <svg className="w-2.5 h-2.5" viewBox="0 0 10 10" fill="currentColor" aria-hidden="true">
                  <rect width="10" height="10" rx="1.5" />
                </svg>
              </button>
            ) : (
              <button
                type="button"
                onClick={handleSend}
                disabled={!text.trim() && images.length === 0}
                className="w-7 h-7 flex items-center justify-center rounded-full bg-accent text-accent-foreground hover:bg-accent-hover transition-colors disabled:bg-foreground/15 disabled:text-foreground-subtle disabled:cursor-not-allowed"
                title="Send"
              >
                <svg
                  className="w-4 h-4"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                  aria-hidden="true"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.25} d="M12 19V5m0 0l-6 6m6-6l6 6" />
                </svg>
              </button>
            )}
          </div>
        </div>
      </div>
      {mentionMenu}
      {commandMenu}
      {settingsMenu}
    </div>
  );
}
