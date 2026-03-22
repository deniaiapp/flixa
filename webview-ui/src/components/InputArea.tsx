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
  ChatSession,
  UsageData,
  Tier,
  ImageAttachment,
  ModelDefinition,
  ModelTierRequirement,
  ReasoningEffort,
} from "../types";
import { canUseTier } from "../types";

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

interface InputAreaProps {
  sessions: ChatSession[];
  currentSessionId: string;
  onSessionChange: (sessionId: string) => void;
  onNewChat: () => void;
  onDeleteChat: (sessionId: string) => void;
  agentMode: boolean;
  approvalMode: string;
  selectedModel: string;
  selectedReasoningEffort: ReasoningEffort;
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
  onUsageClick: () => void;
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

const HistoryIcon = () => (
  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={2}
      d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
    />
  </svg>
);

const AddIcon = () => (
  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
  </svg>
);

const SettingsIcon = () => (
  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={2}
      d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
    />
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={2}
      d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
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
    label: "Low",
    description: "Lower reasoning effort for faster responses.",
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
];

const PAID_USAGE_LIMIT_LABELS: Record<
  Exclude<Tier, "free">,
  Record<"basic" | "premium", string>
> = {
  plus: {
    basic: "20m",
    premium: "5m",
  },
  pro: {
    basic: "50m",
    premium: "15m",
  },
  max: {
    basic: "120m",
    premium: "40m",
  },
};

function getTierLabel(tier: Tier): string {
  return tier.charAt(0).toUpperCase() + tier.slice(1);
}

function formatUsageLimitLabel(
  tier: Tier,
  category: "basic" | "premium",
  limit: number,
): string {
  if (tier === "free") {
    return `${limit.toLocaleString()} requests`;
  }

  return PAID_USAGE_LIMIT_LABELS[tier][category];
}


const getUsageColorClass = (usageData: UsageData): string => {
  const basic = usageData.usage.find((u) => u.category === "basic");
  const premium = usageData.usage.find((u) => u.category === "premium");

  const basicPct = basic ? (basic.remaining / basic.limit) * 100 : 100;
  const premiumPct = premium ? (premium.remaining / premium.limit) * 100 : 100;
  const worstPct = Math.min(basicPct, premiumPct);

  if (worstPct <= 0) {
    return "bg-error/20 text-error";
  }
  if (worstPct <= 10) {
    return "bg-warning/20 text-warning";
  }
  return "border border-input-border text-foreground-subtle hover:text-foreground";
};

export function InputArea({
  sessions,
  currentSessionId,
  onSessionChange,
  onNewChat,
  onDeleteChat,
  agentMode,
  approvalMode,
  selectedModel,
  selectedReasoningEffort,
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
  onUsageClick,
  onLogin,
  onOpenBilling,
}: InputAreaProps) {
  const [isHistoryOpen, setIsHistoryOpen] = useState(false);
  const historyButtonRef = useRef<HTMLButtonElement>(null);
  const settingsButtonRef = useRef<HTMLButtonElement>(null);
  const [historyPosition, setHistoryPosition] = useState({ top: 0, left: 0 });
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [activeSubmenu, setActiveSubmenu] = useState<string | null>(null);
  const [settingsPosition, setSettingsPosition] = useState({ bottom: 0, left: 0 });
  const [modelSearch, setModelSearch] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [mentionMenuPosition, setMentionMenuPosition] = useState({
    top: 0,
    left: 0,
    width: 0,
    openAbove: false,
  });

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

  const userTier = usageData?.tier ?? null;
  const getModelDefinition = (modelId: string): ModelDefinition | undefined => {
    return modelDefinitions.find((model) => model.id === modelId);
  };
  const getModelLabel = (modelId: string): string => {
    const definition = getModelDefinition(modelId);
    return definition?.label ?? modelId;
  };
  const getModelTierRequirement = (modelId: string): ModelTierRequirement => {
    const definition = getModelDefinition(modelId);
    return definition?.tier ?? "free";
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
      locked: isModelLocked(model, userTier, isLoggedIn),
      lockMessage: getModelLockMessage(model, isLoggedIn),
    };
  });
  const normalizedModelSearch = modelSearch.trim().toLowerCase();
  const filteredModelOptions = modelOptions.filter((option) => {
    if (!normalizedModelSearch) {
      return true;
    }
    return (
      option.label.toLowerCase().includes(normalizedModelSearch) ||
      option.value.toLowerCase().includes(normalizedModelSearch) ||
      option.description.toLowerCase().includes(normalizedModelSearch) ||
      option.tags.some((tag) => tag.toLowerCase().includes(normalizedModelSearch))
    );
  });
  const getModelTooltip = (option: { description: string; tags: string[] }): string => {
    const parts: string[] = [];
    if (option.description) {
      parts.push(option.description);
    }
    if (option.tags.length > 0) {
      parts.push(`Tags: ${option.tags.join(", ")}`);
    }
    return parts.join("\n");
  };

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      const historyMenu = document.getElementById("history-menu");
      const settingsMenu = document.getElementById("settings-menu");
      if (historyButtonRef.current && !historyButtonRef.current.contains(e.target as Node)) {
        if (historyMenu && !historyMenu.contains(e.target as Node)) {
          setIsHistoryOpen(false);
        }
      }
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
    if (isSettingsOpen && settingsButtonRef.current) {
      const buttonRect = settingsButtonRef.current.getBoundingClientRect();
      const settingsMenu = document.getElementById("settings-menu");
      const viewportWidth = window.innerWidth;
      const menuWidth = settingsMenu?.offsetWidth ?? 200;
      let left = buttonRect.left;
      if (left + menuWidth > viewportWidth - 8) {
        left = Math.max(8, viewportWidth - menuWidth - 8);
      }
      setSettingsPosition({
        bottom: window.innerHeight - buttonRect.bottom + 24,
        left,
      });
    }
  }, [isSettingsOpen]);

  useEffect(() => {
    if (isHistoryOpen && historyButtonRef.current) {
      const rect = historyButtonRef.current.getBoundingClientRect();
      setHistoryPosition({
        top: rect.top - 8,
        left: Math.max(8, rect.left),
      });
    }
  }, [isHistoryOpen]);

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
    syncTextareaHeight();
    syncTextareaScroll();
  }, [text]);

  const handleOpenFromHistory = (sessionId: string) => {
    onSessionChange(sessionId);
    setIsHistoryOpen(false);
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
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
    if ((text.trim() || images.length > 0) && !isLoading) {
      onSendMessage(text, images);
      onTextChange("");
      onImagesChange([]);
    }
  };

  const handleTextChange = (e: ChangeEvent<HTMLTextAreaElement>) => {
    onTextChange(e.target.value);
    setMentionIndex(0);
    syncTextareaHeight();
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

  const historyMenu =
    isHistoryOpen &&
    createPortal(
      <div
        id="history-menu"
        className="fixed z-[9999] min-w-[220px] max-h-[300px] overflow-y-auto bg-menu-bg border border-menu-border rounded-lg shadow-[0_12px_24px_var(--color-shadow)]"
        style={{
          top: historyPosition.top,
          left: historyPosition.left,
          transform: "translateY(-100%)",
        }}
      >
        {sessions.length === 0 ? (
          <div className="px-3 py-2 text-xs text-foreground-subtle">No conversations</div>
        ) : (
          sessions.map((session) => (
            <div
              key={session.id}
              className={`flex items-center justify-between group hover:bg-surface-hover border-b border-menu-separator last:border-b-0 ${
                session.id === currentSessionId ? "bg-surface-hover" : ""
              }`}
            >
              <button
                type="button"
                className={`flex-1 px-3 py-2 cursor-pointer transition-colors text-xs text-left ${
                  session.id === currentSessionId ? "text-foreground" : "text-menu-foreground"
                }`}
                onClick={() => handleOpenFromHistory(session.id)}
              >
                <span className="truncate block">{session.name}</span>
              </button>
              <button
                type="button"
                className="flex-shrink-0 p-2 text-foreground-subtle hover:text-error transition-colors opacity-0 group-hover:opacity-100"
                onClick={(e) => {
                  e.stopPropagation();
                  onDeleteChat(session.id);
                }}
                title="Delete"
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
                    d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                  />
                </svg>
              </button>
            </div>
          ))
        )}
      </div>,
      document.body,
    );

  const mentionMenu =
    mentionSuggestions.length > 0 &&
    createPortal(
      <div
        className="fixed z-[9999] border border-input-border rounded-md bg-menu-bg overflow-hidden"
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
            className={`w-full px-2.5 py-2 text-left text-xs transition-colors ${
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
      reasoningEffortOptions.find((option) => option.value === selectedReasoningEffort)?.label ??
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

  const settingsMenu =
    isSettingsOpen &&
    createPortal(
      <div
        id="settings-menu"
        className="fixed z-[9999] min-w-[200px] bg-menu-bg border border-menu-border rounded-lg shadow-[0_12px_24px_var(--color-shadow)]"
        style={{
          bottom: settingsPosition.bottom,
          left: settingsPosition.left,
        }}
      >
        {activeSubmenu === null ? (
          <div className="py-1">
            <button
              type="button"
              className="w-full px-3 py-2 cursor-pointer transition-colors hover:bg-surface-hover text-xs text-left flex items-center justify-between text-menu-foreground"
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
            <button
              type="button"
              className="w-full px-3 py-2 cursor-pointer transition-colors hover:bg-surface-hover text-xs text-left flex items-center justify-between text-menu-foreground border-t border-menu-separator"
              onClick={() => setActiveSubmenu("model")}
            >
              <span>Model: {getCurrentModelLabel()}</span>
              <ChevronIcon />
            </button>
            <button
              type="button"
              className="w-full px-3 py-2 cursor-pointer transition-colors hover:bg-surface-hover text-xs text-left flex items-center justify-between text-menu-foreground border-t border-menu-separator"
              onClick={() => setActiveSubmenu("reasoning")}
            >
              <span>Reasoning: {getCurrentReasoningEffortLabel()}</span>
              <ChevronIcon />
            </button>
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
                    title={getModelTooltip(option)}
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
                    <div className="flex items-center justify-between">
                      <span className="font-medium">{option.label}</span>
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
                          <span>{option.lockMessage}</span>
                        </span>
                      )}
                    </div>
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
            {reasoningEffortOptions.map((option) => (
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
      </div>,
      document.body,
    );

  return (
    <div className="p-2.5">
      <div
        className="bg-input-bg border border-input-border rounded-lg overflow-hidden"
        onDrop={handleDrop}
        onDragOver={handleDragOver}
      >
        {images.length > 0 && (
          <div className="flex flex-wrap gap-2 px-2.5 pt-2">
            {images.map((img) => (
              <div key={img.id} className="relative group">
                <img
                  src={img.data}
                  alt={img.name || "Attached image"}
                  className="h-16 w-16 object-cover rounded-md border border-input-border"
                />
                <button
                  type="button"
                  onClick={() => handleRemoveImage(img.id)}
                  className="absolute -top-1.5 -right-1.5 w-5 h-5 bg-error text-white rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
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
        {(activeFilePath || activeSelection || mentionedFiles.length > 0) && (
          <div className="px-2.5 pt-2">
            <div className="flex gap-1.5 overflow-x-auto whitespace-nowrap pb-1">
              {(activeSelectionLabel || activeFilePath) && (
                <div className="px-1 py-0.5 rounded-md text-[9px] text-foreground border border-input-border inline-flex items-center gap-1.5 shrink-0">
                  <FileIcon />
                  <span>{activeSelectionLabel ? formatSelectionChipLabel(activeSelectionLabel) : getBaseName(activeFilePath)}</span>
                </div>
              )}
              {mentionedFiles.map((file) => (
                <button
                  key={file}
                  type="button"
                  onClick={() => applyMention(file)}
                  className="px-1 py-0.5 rounded-md text-[9px] text-foreground border border-input-border hover:bg-surface-hover inline-flex items-center gap-1.5 shrink-0"
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
              className="absolute inset-0 px-2.5 py-2 text-xs leading-relaxed whitespace-pre-wrap break-words overflow-hidden pointer-events-none select-none"
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
            placeholder="Plan, @file for context, / for commands"
            rows={1}
            disabled={isLoading}
            className={`w-full px-2.5 py-2 bg-transparent resize-none min-h-[36px] max-h-[160px] text-xs leading-relaxed outline-none placeholder:text-input-placeholder disabled:opacity-50 disabled:cursor-not-allowed ${text.length > 0 ? "text-transparent caret-input-foreground" : "text-input-foreground"}`}
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
        <div className="flex items-center justify-between px-1.5 py-1 border-t border-input-border">
          <div className="flex items-center gap-0.5">
            <button
              type="button"
              ref={historyButtonRef}
              onClick={() => setIsHistoryOpen(!isHistoryOpen)}
              className="p-1 text-foreground-subtle hover:text-foreground hover:bg-surface-hover rounded transition-all"
              title="History"
            >
              <HistoryIcon />
            </button>
            <button
              type="button"
              onClick={onNewChat}
              className="p-1 text-foreground-subtle hover:text-foreground hover:bg-surface-hover rounded transition-all"
              title="New Chat"
            >
              <AddIcon />
            </button>
            <button
              type="button"
              onClick={handleImageButtonClick}
              className="p-1 text-foreground-subtle hover:text-foreground hover:bg-surface-hover rounded transition-all"
              title="Attach Image"
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
            </button>
            <button
              type="button"
              ref={settingsButtonRef}
              onClick={() => setIsSettingsOpen(!isSettingsOpen)}
              className="p-1 text-foreground-subtle hover:text-foreground hover:bg-surface-hover rounded transition-all"
              title="Settings"
            >
              <SettingsIcon />
            </button>
            {usageData && (
              <button
                type="button"
                onClick={onUsageClick}
                className={`ml-1 px-1.5 py-0.5 text-[10px] rounded transition-all ${getUsageColorClass(
                  usageData,
                )}`}
                title="View usage details"
              >
                {getTierLabel(usageData.tier)} |{" "}
                {usageData.usage.find((u) => u.category === "basic")?.used ?? 0}/
                {formatUsageLimitLabel(
                  usageData.tier,
                  "basic",
                  usageData.usage.find((u) => u.category === "basic")?.limit ?? 0,
                )}
              </button>
            )}
          </div>
          <div className="flex items-center gap-0.5">
            {agentRunning ? (
              <button
                type="button"
                onClick={onStop}
                className="p-1 text-error hover:text-error hover:bg-error-bg rounded transition-all"
                title="Stop"
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
                    d="M6 18L18 6M6 6l12 12"
                  />
                </svg>
              </button>
            ) : (
              <button
                type="button"
                onClick={handleSend}
                disabled={isLoading || (!text.trim() && images.length === 0)}
                className="p-1 text-foreground-subtle hover:text-foreground hover:bg-surface-hover rounded transition-all disabled:opacity-30 disabled:cursor-not-allowed"
                title="Send"
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
                    d="M14 5l7 7m0 0l-7 7m7-7H3"
                  />
                </svg>
              </button>
            )}
          </div>
        </div>
      </div>
      {historyMenu}
      {mentionMenu}
      {settingsMenu}
    </div>
  );
}
