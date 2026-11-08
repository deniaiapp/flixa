import { randomUUID } from "node:crypto";
import { cwd } from "node:process";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, render, useApp, useInput } from "ink";
import Spinner from "ink-spinner";
import TextInput from "ink-text-input";
import {
  runAgentTurn,
  type ToolApprovalRequest,
  type ToolSafetyReviewResult,
} from "../agent-tools/runner.ts";
import {
  createResponse,
  extractOutputText,
  fetchAvailableModels,
  fetchDeniUsage,
  type ChatMessage,
  type FlixaModelDefinition,
} from "../flixa/api.ts";
import {
  listConfiguredProviderIds,
  listProviderModelOptions,
  resolveApiKeyForProvider,
  resolveProviderContext,
  runSharedAgentTurn,
  type ProviderModelOption,
} from "../providers/runtime.ts";
import { formatUsageReport } from "../flixa/usage.ts";
import type { StoredChatSession } from "../sessions/store.ts";
import {
  createSession,
  formatRecentSessionLabel,
  listRecentSessions,
  loadLatestSessionForCwd,
  loadSessionById,
  saveSession,
} from "../sessions/store.ts";
import {
  setDefaultProvider,
  setPersistedModel,
  setPersistedModeDefaults,
} from "../config/store.ts";
import { listProviderDefinitions } from "../providers/registry.ts";
import { buildInstructionSystemPrompt } from "../instructions/files.ts";
import {
  expandCustomCommand,
  findCustomCommand,
  loadCustomCommands,
  type CustomCommand,
} from "../slash/custom-commands.ts";
import { getCheckpointStore, resetTodos } from "../agent-tools/tools.ts";
import { loadToolGuards, prepareUserPrompt, runStopHooks } from "../agent-tools/guards.ts";
import { getActiveMention, listMentionCandidates } from "../mentions/files.ts";
import { parseMemoryShortcut } from "../memory/memory.ts";
import { runDoctor, formatDoctorReport } from "../commands/doctor.ts";
import {
  formatAgentsList,
  formatHooksReport,
  formatPermissionsReport,
  formatSkillsList,
  runExportCommand,
  runMemoryCommand,
  runRewindCommand,
} from "./slash-handlers.ts";
import {
  compactHistory,
  createSummaryGenerator,
  formatCompactResult,
  shouldAutoCompact,
} from "../compact/compact.ts";
import { renderMarkdownToLines } from "./markdown.ts";
import { CLI_VERSION } from "../version.ts";
import {
  buildShareCard,
  copyToClipboard,
  formatGitSnapshot,
  readGitSnapshot,
  writeShareCard,
} from "../runs/share-card.ts";

type InteractiveChatOptions = {
  provider?: string;
  model: string;
  system?: string;
  rawSystem?: string;
  stream: boolean;
  baseUrl?: string;
  maxOutputTokens?: number;
  autoMode: boolean;
  yoloMode: boolean;
  planMode: boolean;
  acceptEdits: boolean;
  modeOverride: "default" | "accept-edits" | "plan" | "auto" | "yolo" | null;
};

type InteractiveChatAppProps = {
  apiKey: string;
  options: InteractiveChatOptions;
  session: StoredChatSession;
};

/** A selectable model tagged with the provider that serves it. */
type SelectableModel = (FlixaModelDefinition | ProviderModelOption) & {
  provider: string;
  providerName: string;
};

type UiMessage = {
  id: string;
  role: "user" | "assistant" | "system" | "header" | "thinking" | "card";
  content: string;
  pending?: boolean;
};

type SlashCommand = {
  name: string;
  description: string;
  aliases?: readonly string[];
};

type SlashCommandSuggestion = SlashCommand & {
  matchedAlias?: string;
};

type FooterModeKey = "default" | "accept-edits" | "plan" | "auto" | "yolo";
type ApprovalChoice = "approve" | "deny";

const COLORS = {
  brand: "yellow",
  assistant: "yellowBright",
  user: "cyanBright",
  system: "white",
  border: "yellow",
  dim: "gray",
  success: "greenBright",
  warning: "magentaBright",
  error: "red",
} as const;

const DEFAULT_TERMINAL_ROWS = 24;
const LOGO_LINES = ["█▄▄   ▄▄█", "█▀█████▀█", "▀███▄███▀"];
const INIT_PROMPT = `Set up a minimal AGENTS.md for this repo. AGENTS.md is loaded into coding-agent sessions, so it must be concise — only include what an agent would get wrong without it.

Please analyze the codebase and either create or improve AGENTS.md.

Goals:
- If AGENTS.md does not exist, write one at the project root.
- If AGENTS.md already exists, review it and propose or apply focused improvements instead of replacing good repo-specific guidance.
- Keep it concise and specific to this repository.

What to include when applicable:
1. Commands agents will commonly need: build, lint, test, dev, and any single-test or targeted verification commands that are non-obvious.
2. High-level architecture and structure that requires reading multiple files to understand.
3. Important workflow notes, setup quirks, environment details, conventions, and gotchas that would help an agent avoid mistakes.
4. Important project-specific guidance from existing instruction files such as README.md, CLAUDE.md, AGENTS.md, .cursor/rules, .cursorrules, .github/copilot-instructions.md, .windsurfrules, .clinerules, or .mcp.json.

What to avoid:
- Generic software advice.
- Obvious file listings or conventions the agent can infer from the codebase.
- Made-up sections or filler.
- Repeating the same guidance in multiple sections.

Prefix the file with exactly:
# AGENTS.md

This file provides guidance to coding agents when working with this repository.
`;

const SLASH_COMMANDS: readonly SlashCommand[] = [
  { name: "/help", description: "show available commands" },
  {
    name: "/clear",
    description: "start a fresh conversation",
    aliases: ["/new"],
  },
  { name: "/continue", description: "load latest session for this directory" },
  { name: "/resume", description: "resume a session by id or recent" },
  { name: "/init", description: "create or improve AGENTS.md for this repo" },
  { name: "/compact", description: "summarize the conversation to free up context" },
  { name: "/rewind", description: "undo the agent's file edits (/rewind [turns|list])" },
  { name: "/export", description: "save this conversation as Markdown" },
  { name: "/memory", description: "show or add project/user memory notes (# note)" },
  { name: "/doctor", description: "check your setup (git, ripgrep, credentials, network)" },
  { name: "/agents", description: "list available sub-agents" },
  { name: "/skills", description: "list available skills" },
  { name: "/permissions", description: "show allow/ask/deny permission rules" },
  { name: "/hooks", description: "show configured lifecycle hooks" },
  { name: "/ship", description: "run a guarded build mission", aliases: ["/run"] },
  {
    name: "/share",
    description: "create a redacted share card from this session",
    aliases: ["/recap"],
  },
  { name: "/diff", description: "show the current git diff summary" },
  { name: "/model", description: "switch model or open selector" },
  { name: "/usage", description: "show plan and quota usage" },
  { name: "/exit", description: "exit flixa cli", aliases: ["/quit"] },
];

export async function runInteractiveChatApp(
  apiKey: string,
  options: InteractiveChatOptions,
  session: StoredChatSession,
): Promise<void> {
  const app = render(<InteractiveChatApp apiKey={apiKey} options={options} session={session} />, {
    exitOnCtrlC: false,
  });
  await app.waitUntilExit();
}

function InteractiveChatApp({
  apiKey: initialApiKey,
  options: initialOptions,
  session,
}: InteractiveChatAppProps): React.JSX.Element {
  const { exit } = useApp();
  // /model can switch providers mid-session; `options` and `apiKey` below follow the active one.
  const [currentProvider, setCurrentProvider] = useState(initialOptions.provider);
  const options = useMemo<InteractiveChatOptions>(
    () =>
      currentProvider === initialOptions.provider
        ? initialOptions
        : { ...initialOptions, provider: currentProvider, baseUrl: undefined },
    [currentProvider, initialOptions],
  );
  const apiKey = useMemo(() => {
    if (currentProvider === initialOptions.provider) {
      return initialApiKey;
    }
    try {
      return resolveProviderContext({ provider: currentProvider }).apiKey ?? "";
    } catch {
      return "";
    }
  }, [currentProvider, initialApiKey, initialOptions.provider]);
  const [input, setInput] = useState("");
  const [activeSession, setActiveSession] = useState<StoredChatSession>(session);
  const [messages, setMessages] = useState<UiMessage[]>(() =>
    buildInitialMessages(
      session.history,
      session.model || options.model,
      session.cwd,
      session.model || options.model,
    ),
  );
  const [conversation, setConversation] = useState<ChatMessage[]>(session.history);
  const [status, setStatus] = useState("Ready");
  const [loading, setLoading] = useState(false);
  const [currentModel, setCurrentModel] = useState(session.model || options.model);
  const [currentModelLabel, setCurrentModelLabel] = useState(session.model || options.model);
  const [planLabel, setPlanLabel] = useState<string | null>(null);
  const headerModelText = formatHeaderModelLine(currentModelLabel, planLabel);
  const initialModes = useMemo(() => getInitialModes(options, session), [options, session]);
  const [autoMode, setAutoMode] = useState(initialModes.autoMode);
  const [yoloMode, setYoloMode] = useState(initialModes.yoloMode);
  const [planMode, setPlanMode] = useState(initialModes.planMode);
  const [acceptEdits, setAcceptEdits] = useState(initialModes.acceptEdits);
  const [selectedCommandSuggestionIndex, setSelectedCommandSuggestionIndex] = useState(0);
  const [resumeSelectorSessions, setResumeSelectorSessions] = useState<StoredChatSession[]>([]);
  const [selectedResumeSessionIndex, setSelectedResumeSessionIndex] = useState(0);
  const [modelSelectorModels, setModelSelectorModels] = useState<SelectableModel[]>([]);
  const [selectedModelIndex, setSelectedModelIndex] = useState(0);
  const [terminalRows, setTerminalRows] = useState(process.stdout.rows ?? DEFAULT_TERMINAL_ROWS);
  const [thinkingStatus, setThinkingStatus] = useState<"thinking" | number | null>(null);
  const [pendingApproval, setPendingApproval] = useState<ToolApprovalRequest | null>(null);
  const [approvalChoice, setApprovalChoice] = useState<ApprovalChoice>("approve");
  const abortRef = useRef<AbortController | null>(null);
  const thinkingStartRef = useRef<number | null>(null);
  const approvalResolveRef = useRef<((approved: boolean) => void) | null>(null);
  const approvalRejectRef = useRef<((error: Error) => void) | null>(null);
  const approvalCleanupRef = useRef<(() => void) | null>(null);
  const cwdValue = activeSession.cwd || cwd();
  const customCommands = useMemo(
    () =>
      loadCustomCommands(
        cwdValue,
        SLASH_COMMANDS.flatMap((command) => [command.name, ...(command.aliases ?? [])]),
      ),
    [cwdValue],
  );
  const allSlashCommands = useMemo<readonly SlashCommand[]>(
    () => [
      ...SLASH_COMMANDS,
      ...customCommands.map((command) => ({
        name: command.name,
        description: formatCustomCommandDescription(command),
      })),
    ],
    [customCommands],
  );
  const commandSuggestions = useMemo(
    () => getCommandSuggestions(input, allSlashCommands),
    [allSlashCommands, input],
  );
  const activeMention = useMemo(() => getActiveMention(input), [input]);
  const mentionCandidates = useMemo(
    () => (activeMention === null ? [] : listMentionCandidates(activeMention, cwdValue)),
    [activeMention, cwdValue],
  );
  const isResumeSelectorOpen = resumeSelectorSessions.length > 0;
  const isModelSelectorOpen = modelSelectorModels.length > 0;
  const isAutocompleteOpen =
    commandSuggestions.length > 0 && !isResumeSelectorOpen && !isModelSelectorOpen;
  const activeFooterMode = useMemo(
    () => getActiveFooterMode(autoMode, yoloMode, planMode, acceptEdits),
    [acceptEdits, autoMode, yoloMode, planMode],
  );
  const activeFooterModeLabel = activeFooterMode ? getFooterModeLabel(activeFooterMode) : null;
  const selectedCommandSuggestion =
    commandSuggestions[selectedCommandSuggestionIndex] ?? commandSuggestions[0] ?? null;
  const selectedResumeSession =
    resumeSelectorSessions[selectedResumeSessionIndex] ?? resumeSelectorSessions[0] ?? null;
  const selectedModel = modelSelectorModels[selectedModelIndex] ?? modelSelectorModels[0] ?? null;

  useEffect(() => {
    setSelectedCommandSuggestionIndex((prev) => (prev < commandSuggestions.length ? prev : 0));
  }, [commandSuggestions.length]);

  useEffect(() => {
    setSelectedModelIndex((prev) => (prev < modelSelectorModels.length ? prev : 0));
  }, [modelSelectorModels.length]);

  const appendSystemMessage = useCallback((content: string) => {
    setMessages((prev) => [...prev, { id: randomUUID(), role: "system", content }]);
  }, []);

  const settleApprovalRequest = useCallback(
    (result: { approved?: boolean; error?: Error; nextStatus?: string }) => {
      approvalCleanupRef.current?.();
      approvalCleanupRef.current = null;

      const resolveApproval = approvalResolveRef.current;
      const rejectApproval = approvalRejectRef.current;
      approvalResolveRef.current = null;
      approvalRejectRef.current = null;

      setPendingApproval(null);
      setApprovalChoice("approve");

      if (result.nextStatus) {
        setStatus(result.nextStatus);
      }

      if (result.error) {
        rejectApproval?.(result.error);
        return;
      }

      resolveApproval?.(result.approved === true);
    },
    [],
  );

  const clearConversation = useCallback(
    (reason?: string) => {
      abortRef.current?.abort();
      abortRef.current = null;
      setMessages([
        buildHeaderMessage(headerModelText, cwdValue),
        ...(reason ? [{ id: randomUUID(), role: "system" as const, content: reason }] : []),
      ]);
      setConversation([]);
      setStatus("Conversation cleared");
    },
    [headerModelText, cwdValue],
  );

  const startFreshConversation = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setResumeSelectorSessions([]);
    setSelectedResumeSessionIndex(0);
    setModelSelectorModels([]);
    setSelectedModelIndex(0);

    const nextSession = createSession(cwdValue, currentModel, options.system, {
      provider: options.provider,
      autoMode,
      yoloMode,
      planMode,
      acceptEdits,
    });
    saveSession(nextSession);
    resetTodos();
    setActiveSession(nextSession);
    setMessages(buildInitialMessages([], currentModel, nextSession.cwd, headerModelText));
    setConversation([]);
    setInput("");
    setStatus("Ready");
  }, [
    acceptEdits,
    autoMode,
    yoloMode,
    currentModel,
    headerModelText,
    cwdValue,
    options.system,
    planMode,
  ]);

  const persistSessionModes = useCallback(
    (
      nextSession: StoredChatSession,
      nextModes: {
        autoMode: boolean;
        yoloMode: boolean;
        planMode: boolean;
        acceptEdits: boolean;
      },
    ): StoredChatSession => {
      const updatedSession = {
        ...nextSession,
        autoMode: nextModes.autoMode,
        yoloMode: nextModes.yoloMode,
        planMode: nextModes.planMode,
        acceptEdits: nextModes.acceptEdits,
      };
      setActiveSession(updatedSession);
      saveSession(updatedSession);
      return updatedSession;
    },
    [],
  );

  const reviewToolSafety = useCallback(
    async (request: ToolApprovalRequest): Promise<ToolSafetyReviewResult> => {
      const providerContext = resolveProviderContext({
        provider: options.provider,
        model: currentModel,
        baseUrl: options.baseUrl,
      });
      const reviewPrompt = [
        `Tool: ${request.toolName}`,
        `Title: ${request.title}`,
        `Reason: ${request.reason}`,
        `Summary: ${request.summary}`,
        `Details:\n${request.details.join("\n")}`,
      ].join("\n");

      try {
        if (providerContext.provider === "flixa") {
          const response = await createResponse({
            apiKey,
            model: currentModel,
            system:
              "You are a safety reviewer for CLI tool calls. Respond with a short verdict only. Approve only if the request is narrowly scoped, justified by the provided reason, and appears safe for the local workspace. Reject if the reason is missing, vague, risky, destructive, or unrelated to the requested action. Format: SAFE: <brief reason> or UNSAFE: <brief reason>.",
            input: [{ role: "user", content: reviewPrompt }],
            baseUrl: options.baseUrl,
            maxOutputTokens: 120,
            toolChoice: "none",
          });
          const verdict = extractOutputText(response).trim() || "UNSAFE: Empty review response.";
          const normalizedVerdict = verdict.toUpperCase();
          return {
            safe: normalizedVerdict.startsWith("SAFE:"),
            verdict,
          };
        }

        const result = await runSharedAgentTurn({
          provider: providerContext.provider,
          model: providerContext.model,
          baseUrl: providerContext.baseUrl,
          history: [],
          prompt: reviewPrompt,
          system:
            "You are a safety reviewer for CLI tool calls. Respond with a short verdict only. Approve only if the request is narrowly scoped, justified by the provided reason, and appears safe for the local workspace. Reject if the reason is missing, vague, risky, destructive, or unrelated to the requested action. Format: SAFE: <brief reason> or UNSAFE: <brief reason>.",
          maxOutputTokens: 120,
          planMode: true,
          // The reviewer only judges text; it must not run tools or start sub-agents.
          allowedTools: [],
        });
        const verdict = result.text.trim() || "UNSAFE: Empty review response.";
        const normalizedVerdict = verdict.toUpperCase();
        return {
          safe: normalizedVerdict.startsWith("SAFE:"),
          verdict,
        };
      } catch (error) {
        return {
          safe: false,
          verdict:
            error instanceof Error
              ? `UNSAFE: Safety review failed: ${error.message}`
              : `UNSAFE: Safety review failed: ${String(error)}`,
        };
      }
    },
    [apiKey, currentModel, options.baseUrl, options.provider],
  );

  const requestToolApproval = useCallback(
    async (request: ToolApprovalRequest): Promise<boolean> => {
      const signal = abortRef.current?.signal;
      setPendingApproval(request);
      setApprovalChoice("approve");
      setStatus(`Approval required: ${request.toolName}`);

      return await new Promise<boolean>((resolve, reject) => {
        approvalResolveRef.current = resolve;
        approvalRejectRef.current = reject;

        const handleAbort = (): void => {
          settleApprovalRequest({
            error: createAbortError(),
            nextStatus: "Request canceled",
          });
        };

        signal?.addEventListener("abort", handleAbort, { once: true });
        approvalCleanupRef.current = () => {
          signal?.removeEventListener("abort", handleAbort);
        };
      });
    },
    [settleApprovalRequest],
  );

  const sendPrompt = useCallback(
    async (prompt: string, displayText?: string) => {
      const trimmedPrompt = prompt.trim();
      if (!trimmedPrompt || loading) {
        return;
      }

      const userMessage: UiMessage = {
        id: randomUUID(),
        role: "user",
        content: displayText?.trim() || trimmedPrompt,
      };

      setInput("");
      setLoading(true);
      setStatus("Working…");
      setMessages((prev) => [...prev, userMessage]);

      const abortController = new AbortController();
      abortRef.current = abortController;

      try {
        const providerContext = resolveProviderContext({
          provider: options.provider,
          model: currentModel,
          baseUrl: options.baseUrl,
        });
        const turnSystemPrompt = buildInstructionSystemPrompt(
          activeSession.cwd || cwd(),
          options.rawSystem,
          trimmedPrompt,
        );

        const guards = loadToolGuards(cwd(), activeSession.id);
        const prepared = await prepareUserPrompt(trimmedPrompt, guards, abortController.signal);
        for (const notice of prepared.notices) {
          appendSystemMessage(notice);
        }
        if (prepared.blockedReason) {
          appendSystemMessage(prepared.blockedReason);
          setStatus("Prompt blocked by hook");
          return;
        }
        const modelPrompt = prepared.prompt;
        getCheckpointStore(cwdValue).beginTurn(trimmedPrompt.slice(0, 60));

        let historyForTurn = conversation;
        if (shouldAutoCompact(conversation)) {
          setStatus("Compacting conversation…");
          try {
            const compacted = await compactHistory({
              history: conversation,
              generate: createSummaryGenerator({
                context: providerContext,
                apiKey,
                model: providerContext.model,
                baseUrl: options.baseUrl,
                signal: abortController.signal,
              }),
            });
            historyForTurn = compacted.history;
            appendSystemMessage(`Auto-compact: ${formatCompactResult(compacted)}`);
          } catch (error) {
            if (abortController.signal.aborted) {
              throw error;
            }
            const message = error instanceof Error ? error.message : String(error);
            appendSystemMessage(`Auto-compact skipped: ${message}`);
          }
          setStatus("Working…");
        }

        if (providerContext.provider === "flixa") {
          const result = await runAgentTurn({
            apiKey,
            model: currentModel,
            history: historyForTurn,
            prompt: modelPrompt,
            guards,
            system: turnSystemPrompt,
            baseUrl: options.baseUrl,
            maxOutputTokens: options.maxOutputTokens,
            autoMode,
            yoloMode,
            planMode,
            acceptEdits,
            signal: abortController.signal,
            reviewToolSafety: yoloMode ? undefined : reviewToolSafety,
            requestToolApproval: yoloMode ? async () => true : requestToolApproval,
            onEvent: (event) => {
              if (event.type === "tool_start") {
                setStatus(`Running ${event.toolName}…`);
                return;
              }

              if (event.type === "tool_result") {
                appendSystemMessage(event.summary);
              }
            },
          });

          const displayText = result.finalText.trim();
          setMessages((prev) => {
            const nextMessages = [...prev];
            if (result.thinkingText?.trim()) {
              nextMessages.push({
                id: randomUUID(),
                role: "thinking",
                content: result.thinkingText.trim(),
              });
            }
            if (displayText) {
              nextMessages.push({
                id: randomUUID(),
                role: "assistant",
                content: displayText,
              });
            }
            return nextMessages;
          });
          setConversation(result.history);
          const nextSession = {
            ...activeSession,
            provider: providerContext.provider,
            history: result.history,
            model: currentModel,
            system: turnSystemPrompt,
            autoMode,
            yoloMode,
            planMode,
            acceptEdits,
          };
          setActiveSession(nextSession);
          setPersistedModel(currentModel, providerContext.provider);
          saveSession(nextSession);
          setStatus(displayText ? "Ready" : "No assistant text returned");
        } else {
          const result = await runSharedAgentTurn({
            provider: providerContext.provider,
            model: providerContext.model,
            baseUrl: providerContext.baseUrl,
            history: historyForTurn,
            sessionId: activeSession.id,
            prompt: modelPrompt,
            guards,
            system: turnSystemPrompt,
            maxOutputTokens: options.maxOutputTokens,
            signal: abortController.signal,
            autoMode,
            planMode,
            yoloMode,
            acceptEdits,
            reviewToolSafety: yoloMode ? undefined : reviewToolSafety,
            requestToolApproval: yoloMode ? async () => true : requestToolApproval,
            onEvent: (event) => {
              if (event.type === "tool_start") {
                setStatus(`Running ${event.toolName}…`);
              } else if (event.type === "tool_result") {
                appendSystemMessage(event.summary);
              }
            },
          });

          const displayText = result.text.trim();
          if (displayText) {
            setMessages((prev) => [
              ...prev,
              {
                id: randomUUID(),
                role: "assistant",
                content: displayText,
              },
            ]);
          }
          setConversation(result.history);
          const nextSession = {
            ...activeSession,
            provider: result.context.provider,
            history: result.history,
            model: result.context.model,
            system: turnSystemPrompt,
            autoMode,
            yoloMode,
            planMode,
            acceptEdits,
          };
          setActiveSession(nextSession);
          setCurrentModel(result.context.model);
          setCurrentModelLabel(result.context.model);
          setPersistedModel(result.context.model, result.context.provider);
          saveSession(nextSession);
          setStatus(displayText ? "Ready" : "No assistant text returned");
        }

        for (const notice of await runStopHooks(guards, abortController.signal)) {
          appendSystemMessage(notice);
        }
      } catch (error) {
        if (abortController.signal.aborted) {
          // /clear and /new detach this controller before aborting; stay out of the new conversation.
          if (abortRef.current === abortController) {
            appendSystemMessage("Request canceled.");
            setStatus("Request canceled");
          }
        } else {
          const message = error instanceof Error ? error.message : String(error);
          appendSystemMessage(`Request failed: ${message}`);
          setStatus("Last request failed");
        }
      } finally {
        if (abortRef.current === abortController) {
          abortRef.current = null;
        }
        setLoading(false);
      }
    },
    [
      apiKey,
      appendSystemMessage,
      conversation,
      currentModel,
      loading,
      options.baseUrl,
      options.maxOutputTokens,
      options.provider,
      options.rawSystem,
      options.stream,
      autoMode,
      yoloMode,
      planMode,
      acceptEdits,
      activeSession,
      cwdValue,
      reviewToolSafety,
      requestToolApproval,
      settleApprovalRequest,
    ],
  );

  const compactConversation = useCallback(
    async (instructions?: string) => {
      if (loading) {
        appendSystemMessage("Wait for the current request to finish first.");
        return;
      }

      setInput("");
      if (conversation.length < 2) {
        appendSystemMessage("Nothing to compact yet.");
        return;
      }

      const abortController = new AbortController();
      abortRef.current = abortController;
      setLoading(true);
      setStatus("Compacting conversation…");

      try {
        const providerContext = resolveProviderContext({
          provider: options.provider,
          model: currentModel,
          baseUrl: options.baseUrl,
        });
        const result = await compactHistory({
          history: conversation,
          instructions,
          generate: createSummaryGenerator({
            context: providerContext,
            apiKey,
            model: providerContext.model,
            baseUrl: options.baseUrl,
            signal: abortController.signal,
          }),
        });

        setConversation(result.history);
        const nextSession = { ...activeSession, history: result.history };
        setActiveSession(nextSession);
        saveSession(nextSession);
        appendSystemMessage(formatCompactResult(result));
        setStatus("Conversation compacted");
      } catch (error) {
        if (abortController.signal.aborted) {
          if (abortRef.current === abortController) {
            appendSystemMessage("Compaction canceled.");
            setStatus("Compaction canceled");
          }
        } else {
          const message = error instanceof Error ? error.message : String(error);
          appendSystemMessage(`Compaction failed: ${message}`);
          setStatus("Compaction failed");
        }
      } finally {
        if (abortRef.current === abortController) {
          abortRef.current = null;
        }
        setLoading(false);
      }
    },
    [
      activeSession,
      apiKey,
      appendSystemMessage,
      conversation,
      currentModel,
      loading,
      options.baseUrl,
      options.provider,
    ],
  );

  const resumeIntoSession = useCallback(
    (nextSession: StoredChatSession, sourceLabel: string) => {
      // Switching mid-turn would let the old turn overwrite the resumed history when it ends.
      if (loading) {
        appendSystemMessage("Wait for the current request to finish first.");
        return;
      }
      const nextProvider =
        nextSession.provider && hasUsableKey(nextSession.provider)
          ? nextSession.provider
          : options.provider;
      if (nextProvider !== options.provider) {
        setCurrentProvider(nextProvider);
      }
      const nextModel = nextSession.model || options.model;
      setActiveSession(nextSession);
      setCurrentModel(nextModel);
      setCurrentModelLabel(nextModel);
      setPersistedModel(nextModel, resolveProviderContext({ provider: nextProvider }).provider);
      setConversation(nextSession.history);
      setAutoMode(nextSession.autoMode ?? options.autoMode);
      setYoloMode(nextSession.yoloMode ?? options.yoloMode);
      setPlanMode(nextSession.planMode ?? options.planMode);
      setAcceptEdits(nextSession.acceptEdits ?? options.acceptEdits);
      setMessages((prev) => [
        ...prev,
        {
          id: randomUUID(),
          role: "system",
          content: `Switched to ${sourceLabel}: ${nextSession.id.slice(0, 8)}`,
        },
        ...buildInitialMessages(nextSession.history, nextModel, nextSession.cwd, headerModelText),
      ]);
      setStatus(`Resumed ${nextSession.id.slice(0, 8)}`);
    },
    [
      appendSystemMessage,
      headerModelText,
      loading,
      options.acceptEdits,
      options.autoMode,
      options.yoloMode,
      options.model,
      options.planMode,
    ],
  );

  const closeResumeSelector = useCallback((nextStatus = "Ready") => {
    setResumeSelectorSessions([]);
    setSelectedResumeSessionIndex(0);
    setStatus(nextStatus);
  }, []);

  const openResumeSelector = useCallback(() => {
    if (loading) {
      appendSystemMessage("Wait for the current request to finish first.");
      return;
    }
    const recent = listRecentSessions(20);
    if (recent.length === 0) {
      appendSystemMessage("No saved session found.");
      setStatus("No saved sessions");
      setInput("");
      return;
    }

    setResumeSelectorSessions(recent);
    setSelectedResumeSessionIndex(0);
    setInput("");
    setStatus("Select a conversation to resume");
  }, [appendSystemMessage, loading]);

  const closeModelSelector = useCallback((nextStatus = "Ready") => {
    setModelSelectorModels([]);
    setSelectedModelIndex(0);
    setStatus(nextStatus);
  }, []);

  const applyModelSelection = useCallback(
    (nextModel: string, label?: string, nextProvider?: string) => {
      const activeProvider = resolveProviderContext({ provider: options.provider }).provider;
      const provider = resolveProviderContext({
        provider: nextProvider ?? options.provider,
      }).provider;
      if (provider !== activeProvider) {
        setCurrentProvider(provider);
        setDefaultProvider(provider);
      }
      setCurrentModel(nextModel);
      setCurrentModelLabel(label ?? nextModel);
      setPersistedModel(nextModel, provider);
      const nextSession = {
        ...activeSession,
        provider,
        model: nextModel,
        autoMode,
        yoloMode,
        planMode,
        acceptEdits,
      };
      setActiveSession(nextSession);
      saveSession(nextSession);
      appendSystemMessage(
        label && label !== nextModel
          ? `Model switched to ${label} (${nextModel})`
          : `Model switched to ${nextModel}`,
      );
      setStatus(`Model: ${label ?? nextModel}`);
    },
    [
      acceptEdits,
      activeSession,
      appendSystemMessage,
      autoMode,
      options.provider,
      yoloMode,
      planMode,
    ],
  );

  useEffect(() => {
    let canceled = false;

    const syncCurrentModelLabel = async (): Promise<void> => {
      try {
        const providerContext = resolveProviderContext({
          provider: options.provider,
          model: currentModel,
          baseUrl: options.baseUrl,
        });

        if (providerContext.provider === "flixa") {
          const models = await fetchAvailableModels({
            apiKey,
            baseUrl: options.baseUrl,
          });
          if (canceled) {
            return;
          }

          const matchedModel =
            models.find((model) => model.id === currentModel) ??
            models.find(
              (model) => stripModelProvider(model.id) === stripModelProvider(currentModel),
            );

          setCurrentModelLabel(matchedModel ? matchedModel.label : currentModel);
          return;
        }

        const models = await listProviderModelOptions({
          provider: providerContext.provider,
          model: currentModel,
          baseUrl: providerContext.baseUrl,
        });
        if (canceled) {
          return;
        }

        const matchedModel = models.find((model) => model.id === currentModel);
        setCurrentModelLabel(matchedModel?.label ?? currentModel);
      } catch {
        if (!canceled) {
          setCurrentModelLabel(currentModel);
        }
      }
    };

    void syncCurrentModelLabel();

    return () => {
      canceled = true;
    };
  }, [apiKey, currentModel, options.baseUrl, options.provider]);

  useEffect(() => {
    let canceled = false;

    const syncPlanLabel = async (): Promise<void> => {
      try {
        const providerContext = resolveProviderContext({
          provider: options.provider,
          model: currentModel,
          baseUrl: options.baseUrl,
        });
        if (providerContext.provider !== "flixa") {
          setPlanLabel(providerContext.displayName);
          return;
        }

        const usage = await fetchDeniUsage({ apiKey, baseUrl: options.baseUrl });
        if (!canceled) {
          setPlanLabel(formatFlixaPlanLabel(usage.tier, usage.isTeam));
        }
      } catch {
        if (!canceled) {
          setPlanLabel("Flixa");
        }
      }
    };

    void syncPlanLabel();

    return () => {
      canceled = true;
    };
  }, [apiKey, currentModel, options.baseUrl, options.provider]);

  // The header is created before the model label and plan resolve, so refresh its model line in place.
  useEffect(() => {
    setMessages((prev) => {
      const index = prev.findLastIndex((message) => message.role === "header");
      const header = prev[index];
      if (!header) {
        return prev;
      }
      const lines = header.content.split("\n");
      if (lines[1] === undefined || lines[1].endsWith(headerModelText)) {
        return prev;
      }
      lines[1] = `${LOGO_LINES[1]}  ${headerModelText}`;
      return prev.map((message, i) =>
        i === index ? { ...message, content: lines.join("\n") } : message,
      );
    });
  }, [headerModelText]);

  const collectSelectableModels = useCallback(async () => {
    const current = resolveProviderContext({
      provider: options.provider,
      model: currentModel,
      baseUrl: options.baseUrl,
    });

    // The active provider first, then every other provider that has credentials configured.
    const configured = new Set(listConfiguredProviderIds());
    const providers = listProviderDefinitions()
      .filter((definition) => definition.runtime !== "external")
      .filter((definition) => definition.id === current.provider || configured.has(definition.id))
      .sort(
        (left, right) =>
          Number(right.id === current.provider) - Number(left.id === current.provider),
      );

    const results = await Promise.allSettled(
      providers.map((definition): Promise<SelectableModel[]> => {
        const isCurrent = definition.id === current.provider;
        const context = isCurrent ? current : resolveProviderContext({ provider: definition.id });
        const cacheKey = `${definition.id}|${context.baseUrl ?? ""}|${context.apiKey ?? ""}`;
        const cached = modelListCache.get(cacheKey);
        if (cached && Date.now() - cached.at < MODEL_LIST_CACHE_TTL_MS) {
          return cached.models;
        }

        const models = withTimeout<Array<FlixaModelDefinition | ProviderModelOption>>(
          definition.id === "flixa"
            ? fetchAvailableModels({
                apiKey: isCurrent ? apiKey : (context.apiKey ?? ""),
                baseUrl: isCurrent ? options.baseUrl : context.baseUrl,
              })
            : listProviderModelOptions({
                provider: definition.id,
                model: isCurrent ? currentModel : undefined,
                baseUrl: context.baseUrl,
              }),
          MODEL_LIST_TIMEOUT_MS,
          `${definition.displayName} timed out`,
        ).then((fetched) =>
          fetched.map((model) => ({
            ...model,
            provider: definition.id,
            providerName: definition.displayName,
          })),
        );
        // Cache the in-flight promise so a warm-up and a manual open share one request.
        modelListCache.set(cacheKey, { at: Date.now(), models });
        models.catch(() => modelListCache.delete(cacheKey));
        return models;
      }),
    );

    return {
      current,
      models: results.flatMap((result) => (result.status === "fulfilled" ? result.value : [])),
      failed: results.flatMap((result, index) =>
        result.status === "rejected" ? [providers[index]?.displayName ?? "?"] : [],
      ),
    };
  }, [apiKey, currentModel, options.baseUrl, options.provider]);

  // Warm the cache shortly after startup so the first /model opens without waiting on the network.
  useEffect(() => {
    const timer = setTimeout(() => {
      collectSelectableModels().catch(() => undefined);
    }, 1500);
    return () => clearTimeout(timer);
  }, [collectSelectableModels]);

  const openModelSelector = useCallback(async () => {
    if (loading) {
      appendSystemMessage("Wait for the current request to finish first.");
      return;
    }

    setInput("");
    setStatus("Loading models…");

    try {
      const { current, models, failed } = await collectSelectableModels();
      if (failed.length > 0) {
        appendSystemMessage(`Could not load models from: ${failed.join(", ")}`);
      }

      if (models.length === 0) {
        appendSystemMessage("No models available for this account.");
        setStatus("No models available");
        return;
      }

      setModelSelectorModels(models);
      setSelectedModelIndex(findModelSelectionIndex(models, currentModel, current.provider));
      setStatus("Select a model");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      appendSystemMessage(`Failed to load models: ${message}`);
      setStatus("Model selector failed");
    }
  }, [appendSystemMessage, collectSelectableModels, currentModel, loading]);

  const showUsage = useCallback(async () => {
    if (loading) {
      appendSystemMessage("Wait for the current request to finish first.");
      return;
    }

    setInput("");
    setStatus("Loading usage…");

    try {
      const providerContext = resolveProviderContext({
        provider: options.provider,
        model: currentModel,
        baseUrl: options.baseUrl,
      });
      if (providerContext.provider !== "flixa") {
        appendSystemMessage(
          `Usage reporting is not yet implemented for ${providerContext.displayName}.`,
        );
        setStatus("Usage unavailable");
        return;
      }

      const usage = await fetchDeniUsage({
        apiKey,
        baseUrl: options.baseUrl,
      });
      appendSystemMessage(formatUsageReport(usage));
      setStatus(`Usage: ${usage.tier}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      appendSystemMessage(`Failed to load usage: ${message}`);
      setStatus("Usage request failed");
    }
  }, [apiKey, appendSystemMessage, currentModel, loading, options.baseUrl, options.provider]);

  const applyFooterMode = useCallback(
    (modeKey: FooterModeKey | null) => {
      const nextModes = getModeFlags(modeKey);
      setAutoMode(nextModes.autoMode);
      setYoloMode(nextModes.yoloMode);
      setPlanMode(nextModes.planMode);
      setAcceptEdits(nextModes.acceptEdits);
      persistSessionModes(activeSession, nextModes);
      setPersistedModeDefaults(nextModes);
    },
    [activeSession, persistSessionModes],
  );

  const shareCurrentSession = useCallback(
    (outputPath?: string) => {
      const lastUserPrompt = [...activeSession.history]
        .reverse()
        .find((message) => message.role === "user")?.content;
      const lastAssistantText = [...activeSession.history]
        .reverse()
        .find((message) => message.role === "assistant")?.content;
      const card = buildShareCard({
        workspaceRoot: cwdValue,
        prompt: lastUserPrompt || "Flixa coding session",
        provider: activeSession.provider || options.provider || "flixa",
        model: activeSession.model || currentModel,
        finalText: lastAssistantText || "No assistant result yet.",
        startedAt: activeSession.createdAt,
        endedAt: activeSession.updatedAt,
        sessionId: activeSession.id,
        planMode,
      });
      const clipboard = copyToClipboard(card);

      if (outputPath) {
        try {
          const resolvedPath = writeShareCard(card, outputPath, cwdValue);
          appendSystemMessage(`Share card saved to ${resolvedPath}`);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          appendSystemMessage(`Could not save the share card: ${message}`);
          setInput("");
          setStatus("Share card not saved");
          return;
        }
      } else {
        setMessages((prev) => [...prev, { id: randomUUID(), role: "card", content: card }]);
      }
      if (clipboard.copied) {
        appendSystemMessage(`Share card copied to clipboard (${clipboard.method}).`);
      } else {
        appendSystemMessage(`Clipboard unavailable: ${clipboard.reason}`);
      }
      setInput("");
      setStatus(
        outputPath
          ? clipboard.copied
            ? "Share card saved and copied"
            : "Share card saved"
          : clipboard.copied
            ? "Share card copied"
            : "Share card ready",
      );
    },
    [activeSession, appendSystemMessage, currentModel, cwdValue, options.provider, planMode],
  );

  const showGitDiff = useCallback(() => {
    appendSystemMessage(formatGitSnapshot(readGitSnapshot(cwdValue)));
    setInput("");
    setStatus("Git status refreshed");
  }, [appendSystemMessage, cwdValue]);

  const handleCommand = useCallback(
    async (value: string) => {
      let trimmed = value.trim();
      if (!trimmed) {
        return;
      }

      const memoryNote = parseMemoryShortcut(trimmed);
      if (memoryNote !== null) {
        appendSystemMessage(runMemoryCommand(`project ${memoryNote}`, cwdValue));
        setInput("");
        return;
      }

      if (!trimmed.startsWith("/")) {
        await sendPrompt(trimmed);
        return;
      }

      if (!trimmed.includes(" ") && commandSuggestions.length > 0) {
        // An exact command wins; otherwise run the suggestion the user moved the cursor to.
        const exactSuggestion = commandSuggestions.find(
          (suggestion) => suggestion.name === trimmed,
        );
        const chosenSuggestion = exactSuggestion ?? selectedCommandSuggestion;
        if (chosenSuggestion) {
          trimmed = chosenSuggestion.name;
        }
      }

      if (trimmed === "/exit" || trimmed === "/quit") {
        abortRef.current?.abort();
        exit();
        return;
      }

      if (trimmed === "/clear" || trimmed === "/new") {
        startFreshConversation();
        return;
      }

      if (trimmed === "/help") {
        appendSystemMessage(buildHelpMessage(customCommands));
        setInput("");
        return;
      }

      if (trimmed === "/continue") {
        const latest = loadLatestSessionForCwd(cwd());
        if (!latest) {
          appendSystemMessage("No saved session found for this directory.");
        } else {
          resumeIntoSession(latest, "latest session");
        }
        setInput("");
        return;
      }

      if (trimmed === "/resume") {
        openResumeSelector();
        return;
      }

      if (trimmed === "/usage") {
        await showUsage();
        return;
      }

      if (trimmed === "/init") {
        await sendPrompt(INIT_PROMPT);
        return;
      }

      if (trimmed === "/diff") {
        showGitDiff();
        return;
      }

      if (trimmed === "/compact" || trimmed.startsWith("/compact ")) {
        await compactConversation(trimmed.slice("/compact".length).trim() || undefined);
        return;
      }

      const [commandWord = "", ...commandRest] = trimmed.split(/\s+/);
      const commandArgs = commandRest.join(" ");
      const infoMessage = ((): string | null => {
        switch (commandWord) {
          case "/rewind":
            return runRewindCommand(commandArgs, cwdValue);
          case "/export":
            return runExportCommand(commandArgs, cwdValue, activeSession, conversation);
          case "/memory":
            return runMemoryCommand(commandArgs, cwdValue);
          case "/agents":
            return formatAgentsList(cwdValue);
          case "/skills":
            return formatSkillsList(cwdValue);
          case "/permissions":
            return formatPermissionsReport(cwdValue);
          case "/hooks":
            return formatHooksReport(cwdValue);
          default:
            return null;
        }
      })();
      if (infoMessage !== null) {
        appendSystemMessage(infoMessage);
        setInput("");
        return;
      }

      if (commandWord === "/doctor") {
        setInput("");
        setStatus("Running diagnostics…");
        try {
          appendSystemMessage(formatDoctorReport(await runDoctor({ cwd: cwdValue })));
          setStatus("Ready");
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          appendSystemMessage(`Doctor failed: ${message}`);
          setStatus("Doctor failed");
        }
        return;
      }

      if (trimmed === "/share" || trimmed === "/recap") {
        shareCurrentSession();
        return;
      }

      if (trimmed.startsWith("/share ") || trimmed.startsWith("/recap ")) {
        const outputPath = trimmed.slice(trimmed.indexOf(" ") + 1).trim();
        if (!outputPath) {
          appendSystemMessage("Usage: /share [output-path]");
        } else {
          shareCurrentSession(outputPath);
        }
        return;
      }

      if (trimmed === "/ship" || trimmed === "/run") {
        appendSystemMessage("Usage: /ship <task>");
        setInput("");
        return;
      }

      if (trimmed.startsWith("/ship ") || trimmed.startsWith("/run ")) {
        const task = trimmed.slice(trimmed.indexOf(" ") + 1).trim();
        if (!task) {
          appendSystemMessage("Usage: /ship <task>");
        } else {
          await sendPrompt(buildShipPrompt(task));
        }
        return;
      }

      if (trimmed === "/model") {
        await openModelSelector();
        return;
      }

      if (trimmed.startsWith("/resume ")) {
        const sessionId = trimmed.slice(8).trim();
        if (!sessionId) {
          appendSystemMessage("Usage: /resume <session-id>");
        } else {
          const loaded = loadSessionById(sessionId);
          if (!loaded) {
            appendSystemMessage(`Session not found: ${sessionId}`);
          } else {
            resumeIntoSession(loaded, "resumed session");
          }
        }
        setInput("");
        return;
      }

      if (trimmed.startsWith("/model ")) {
        const nextModel = trimmed.slice(7).trim();
        if (!nextModel) {
          appendSystemMessage("Usage: /model <model-id>");
        } else {
          applyModelSelection(nextModel);
        }
        setInput("");
        return;
      }

      const customMatch = findCustomCommand(customCommands, trimmed);
      if (customMatch) {
        await sendPrompt(expandCustomCommand(customMatch.command, customMatch.args), trimmed);
        return;
      }

      appendSystemMessage(`Unknown command: ${trimmed}`);
      setInput("");
    },
    [
      activeSession,
      appendSystemMessage,
      clearConversation,
      commandSuggestions,
      compactConversation,
      conversation,
      customCommands,
      cwdValue,
      currentModel,
      exit,
      openModelSelector,
      openResumeSelector,
      options.model,
      options.system,
      resumeIntoSession,
      selectedCommandSuggestion,
      showUsage,
      showGitDiff,
      shareCurrentSession,
      startFreshConversation,
      sendPrompt,
      applyModelSelection,
    ],
  );

  useInput(
    (keyInput, key) => {
      if (pendingApproval) {
        if (key.leftArrow || key.upArrow || key.tab) {
          setApprovalChoice((prev) => (prev === "approve" ? "deny" : "approve"));
          return;
        }

        if (key.rightArrow || key.downArrow) {
          setApprovalChoice((prev) => (prev === "approve" ? "deny" : "approve"));
          return;
        }

        if (key.return) {
          settleApprovalRequest({
            approved: approvalChoice === "approve",
            nextStatus:
              approvalChoice === "approve"
                ? `Approved ${pendingApproval.toolName}`
                : `Denied ${pendingApproval.toolName}`,
          });
          return;
        }

        if (key.escape) {
          settleApprovalRequest({
            approved: false,
            nextStatus: `Denied ${pendingApproval.toolName}`,
          });
          return;
        }
      }

      if (isModelSelectorOpen) {
        if (key.escape) {
          closeModelSelector("Model selection canceled");
          return;
        }

        if (key.upArrow) {
          setSelectedModelIndex((prev) => (prev <= 0 ? modelSelectorModels.length - 1 : prev - 1));
          return;
        }

        if (key.downArrow) {
          setSelectedModelIndex((prev) => (prev >= modelSelectorModels.length - 1 ? 0 : prev + 1));
          return;
        }

        if (key.return && selectedModel) {
          closeModelSelector();
          applyModelSelection(selectedModel.id, selectedModel.label, selectedModel.provider);
          return;
        }
      }

      if (isResumeSelectorOpen) {
        if (key.escape) {
          closeResumeSelector("Resume canceled");
          return;
        }

        if (key.upArrow) {
          setSelectedResumeSessionIndex((prev) =>
            prev <= 0 ? resumeSelectorSessions.length - 1 : prev - 1,
          );
          return;
        }

        if (key.downArrow) {
          setSelectedResumeSessionIndex((prev) =>
            prev >= resumeSelectorSessions.length - 1 ? 0 : prev + 1,
          );
          return;
        }

        if (key.return && selectedResumeSession) {
          closeResumeSelector();
          resumeIntoSession(selectedResumeSession, "resumed session");
          return;
        }
      }

      if (key.ctrl && keyInput === "c") {
        if (loading && abortRef.current) {
          abortRef.current.abort();
          return;
        }

        exit();
        return;
      }

      if (key.ctrl && keyInput === "l") {
        clearConversation();
        return;
      }

      if (
        key.shift &&
        key.tab &&
        !isAutocompleteOpen &&
        !isResumeSelectorOpen &&
        !isModelSelectorOpen
      ) {
        applyFooterMode(getNextFooterMode(activeFooterMode));
        return;
      }

      if (key.escape) {
        setInput("");
        return;
      }

      if (commandSuggestions.length > 0 && key.upArrow) {
        setSelectedCommandSuggestionIndex((prev) =>
          prev <= 0 ? commandSuggestions.length - 1 : prev - 1,
        );
        return;
      }

      if (commandSuggestions.length > 0 && key.downArrow) {
        setSelectedCommandSuggestionIndex((prev) =>
          prev >= commandSuggestions.length - 1 ? 0 : prev + 1,
        );
        return;
      }

      if (key.tab) {
        const completion = selectedCommandSuggestion;
        if (completion) {
          setInput(formatCommandInput(completion.name));
          return;
        }

        const firstCandidate = mentionCandidates[0];
        if (firstCandidate !== undefined && activeMention !== null) {
          const token = /\s/.test(firstCandidate) ? `@"${firstCandidate}"` : `@${firstCandidate}`;
          setInput(`${input.slice(0, input.length - activeMention.length - 1)}${token}`);
        }
      }
    },
    { isActive: true },
  );

  useEffect(() => () => abortRef.current?.abort(), []);

  useEffect(() => {
    const onResize = (): void => setTerminalRows(process.stdout.rows ?? DEFAULT_TERMINAL_ROWS);
    process.stdout.on("resize", onResize);
    return () => {
      process.stdout.off("resize", onResize);
    };
  }, []);

  useEffect(() => {
    let showDurationTimer: ReturnType<typeof setTimeout> | null = null;
    let clearStatusTimer: ReturnType<typeof setTimeout> | null = null;

    if (loading) {
      if (thinkingStartRef.current === null) {
        thinkingStartRef.current = Date.now();
        setThinkingStatus("thinking");
      }
    } else if (thinkingStartRef.current !== null) {
      const duration = Date.now() - thinkingStartRef.current;
      const remainingThinkingTime = Math.max(0, 2000 - duration);
      thinkingStartRef.current = null;

      const showDuration = (): void => {
        setThinkingStatus(duration);
        clearStatusTimer = setTimeout(() => setThinkingStatus(null), 2000);
      };

      if (remainingThinkingTime > 0) {
        showDurationTimer = setTimeout(showDuration, remainingThinkingTime);
      } else {
        showDuration();
      }
    }

    return () => {
      if (showDurationTimer) {
        clearTimeout(showDurationTimer);
      }
      if (clearStatusTimer) {
        clearTimeout(clearStatusTimer);
      }
    };
  }, [loading]);

  return (
    <Box flexDirection="column" paddingX={1} paddingY={1}>
      {/* A selector plus the whole history can be taller than the terminal, which cuts off the top. */}
      {isResumeSelectorOpen || isModelSelectorOpen ? null : (
        <Box flexDirection="column">
          {messages.map((message) => (
            <MessageRow key={message.id} message={message} />
          ))}
        </Box>
      )}

      <Box marginTop={0} flexDirection="column">
        {thinkingStatus !== null ? <ThinkingIndicator thinkingStatus={thinkingStatus} /> : null}
        <Box flexDirection="column">
          <Box
            borderStyle="round"
            borderColor="white"
            borderLeft={false}
            borderRight={false}
            width="100%"
            paddingLeft={1}
            paddingRight={1}
          >
            <Text color={COLORS.user}>› </Text>
            <TextInput
              value={input}
              onChange={setInput}
              onSubmit={handleCommand}
              focus={!isResumeSelectorOpen && !isModelSelectorOpen && pendingApproval === null}
              placeholder="Ask Flixa for code, diffs, or analysis…"
            />
          </Box>
        </Box>
        {pendingApproval ? (
          <PermissionApprovalDialog request={pendingApproval} choice={approvalChoice} />
        ) : null}
        {isResumeSelectorOpen ? (
          <ResumeSelector
            sessions={resumeSelectorSessions}
            selectedIndex={selectedResumeSessionIndex}
            maxRows={terminalRows}
          />
        ) : isModelSelectorOpen ? (
          <ModelSelector
            models={modelSelectorModels}
            selectedIndex={selectedModelIndex}
            maxRows={terminalRows}
          />
        ) : null}
        {!pendingApproval && !isAutocompleteOpen && mentionCandidates.length > 0 ? (
          <Text color={COLORS.dim}>@ Tab: {mentionCandidates.join("  ")}</Text>
        ) : null}
        {!pendingApproval && isAutocompleteOpen ? (
          <CommandAutocomplete
            suggestions={commandSuggestions}
            selectedIndex={selectedCommandSuggestionIndex}
          />
        ) : !pendingApproval ? (
          <Footer
            loading={loading}
            status={status}
            selectedMode={activeFooterMode}
            selectedModeLabel={activeFooterModeLabel}
          />
        ) : null}
      </Box>
    </Box>
  );
}

function MessageRow({ message }: { message: UiMessage }): React.JSX.Element {
  if (message.role === "header") {
    const lines = message.content.split(/\r?\n/);
    return (
      <Box flexDirection="column" marginBottom={1}>
        {lines.map((line, index) => (
          <Text
            key={index}
            color={index === 1 ? COLORS.assistant : index === 2 ? COLORS.dim : undefined}
          >
            {line}
          </Text>
        ))}
      </Box>
    );
  }

  if (message.role === "user") {
    return (
      <Box flexDirection="column" marginBottom={1}>
        {message.content.split(/\r?\n/).map((line, index) => (
          <Text key={index} color={COLORS.user}>
            {index === 0 ? `> ${line}` : `  ${line}`}
          </Text>
        ))}
      </Box>
    );
  }

  if (message.role === "system") {
    return (
      <Box flexDirection="column" marginBottom={1}>
        {message.content.split(/\r?\n/).map((line, index) => (
          <React.Fragment key={index}>{renderSystemLine(line, index)}</React.Fragment>
        ))}
      </Box>
    );
  }

  if (message.role === "thinking") {
    const renderedLines = renderMarkdownToLines(message.content);
    return (
      <Box flexDirection="column" marginBottom={1}>
        <Text color={COLORS.dim}>thinking</Text>
        {renderedLines.map((line, index) => (
          <Text key={index} color={COLORS.dim} wrap="wrap">
            {line}
          </Text>
        ))}
      </Box>
    );
  }

  if (message.role === "card") {
    const renderedLines = renderMarkdownToLines(message.content);
    return (
      <Box
        borderStyle="round"
        borderColor={COLORS.brand}
        flexDirection="column"
        paddingX={1}
        marginBottom={1}
      >
        {renderedLines.map((line, index) => (
          <Text key={index} wrap="wrap">
            {line || " "}
          </Text>
        ))}
      </Box>
    );
  }

  const renderedLines = renderMarkdownToLines(
    message.content || (message.pending ? "Thinking…" : ""),
  );

  return (
    <Box flexDirection="column" marginBottom={1}>
      {message.pending && !message.content ? (
        <Text color={COLORS.assistant}>
          <Spinner type="dots" /> thinking
        </Text>
      ) : null}
      {renderedLines.map((line, index) => (
        <React.Fragment key={index}>
          <Text wrap="wrap">{line}</Text>
          {index < renderedLines.length - 1 && line.trim() === "" ? <Text dimColor> </Text> : null}
        </React.Fragment>
      ))}
      {message.pending && message.content ? (
        <Text color={COLORS.assistant}>
          <Spinner type="dots" />
        </Text>
      ) : null}
    </Box>
  );
}

function Footer({
  loading,
  status,
  selectedMode,
  selectedModeLabel,
}: {
  loading: boolean;
  status: string;
  selectedMode: FooterModeKey;
  selectedModeLabel: string | null;
}): React.JSX.Element {
  return (
    <Box marginTop={0} justifyContent="space-between">
      <Box>
        {selectedModeLabel ? (
          <Box>
            <Text color={getFooterModeColor(selectedMode)}>{`>> ${selectedModeLabel}`}</Text>
            <Text color={COLORS.dim}> · shift + tab to switch</Text>
          </Box>
        ) : (
          <Text color={COLORS.dim}>/help for shortcuts, commands and more...</Text>
        )}
      </Box>
      <Text color={COLORS.dim}>{loading ? "Esc clears input · Ctrl+C cancels" : status}</Text>
    </Box>
  );
}

function ThinkingIndicator({
  thinkingStatus,
}: {
  thinkingStatus: "thinking" | number;
}): React.JSX.Element {
  const text =
    thinkingStatus === "thinking"
      ? "thinking..."
      : `thought for ${Math.max(1, Math.round(thinkingStatus / 1000))}s`;

  return (
    <Box marginBottom={1} paddingX={2}>
      {thinkingStatus === "thinking" ? (
        <Text color={COLORS.assistant}>
          <Spinner type="dots" /> {text}
        </Text>
      ) : (
        <Text color={COLORS.dim}>{text}</Text>
      )}
    </Box>
  );
}

function PermissionApprovalDialog({
  request,
  choice,
}: {
  request: ToolApprovalRequest;
  choice: ApprovalChoice;
}): React.JSX.Element {
  const isApproveSelected = choice === "approve";

  return (
    <Box
      borderStyle="round"
      borderColor={COLORS.warning}
      flexDirection="column"
      paddingX={1}
      marginTop={1}
    >
      <Box justifyContent="space-between">
        <Text color={COLORS.warning}>{request.title}</Text>
        <Text color={COLORS.dim}>←→ select · Enter confirm · Esc deny</Text>
      </Box>
      <Text>{request.reason}</Text>
      <Text color={COLORS.assistant}>{`${request.toolName}: ${request.summary}`}</Text>
      {request.details.map((detail) => (
        <Text key={detail} color={COLORS.dim} wrap="wrap">
          {`· ${detail}`}
        </Text>
      ))}
      <Box marginTop={1}>
        <Text color={isApproveSelected ? COLORS.success : COLORS.dim}>
          {isApproveSelected ? "> Approve" : "  Approve"}
        </Text>
        <Text color={COLORS.dim}> </Text>
        <Text color={!isApproveSelected ? COLORS.warning : COLORS.dim}>
          {!isApproveSelected ? "> Deny" : "  Deny"}
        </Text>
      </Box>
    </Box>
  );
}

// Rows used around a selector: root padding (2), thinking indicator (up to 2), input box (3),
// footer (1), selector border (2) and title (1). Ink switches to a clear-everything render
// mode once a frame reaches the terminal height and leaves stray lines when it shrinks again,
// so the frame must stay at least one row shorter than the terminal; the extra row is slack.
const SELECTOR_RESERVED_ROWS = 12;
// The model selector frame is root padding (2), border (2), title (1), input box (3), footer (1)
// and the same one row of slack.
const MODEL_SELECTOR_RESERVED_ROWS = 10;
const MODEL_LABEL_MAX_WIDTH = 32;

/** Returns the first index of a window of `count` items that keeps `selectedIndex` visible. */
function getWindowStart(selectedIndex: number, total: number, count: number): number {
  return Math.max(0, Math.min(selectedIndex - Math.floor(count / 2), total - count));
}

function ResumeSelector({
  sessions,
  selectedIndex,
  maxRows,
}: {
  sessions: readonly StoredChatSession[];
  selectedIndex: number;
  maxRows: number;
}): React.JSX.Element {
  const visibleCount = Math.max(1, Math.min(6, maxRows - SELECTOR_RESERVED_ROWS));
  const visibleStartIndex = getWindowStart(selectedIndex, sessions.length, visibleCount);
  const visibleSessions = sessions.slice(visibleStartIndex, visibleStartIndex + visibleCount);

  return (
    <Box borderStyle="round" borderColor={COLORS.border} flexDirection="column" paddingX={1}>
      <Box justifyContent="space-between">
        <Text color={COLORS.assistant} wrap="truncate">
          Resume Conversation ({selectedIndex + 1}/{sessions.length})
        </Text>
        <Text color={COLORS.dim} wrap="truncate">
          ↑↓ select · Enter resume · Esc cancel
        </Text>
      </Box>
      {visibleSessions.map((session, index) => {
        const absoluteIndex = visibleStartIndex + index;
        const isSelected = absoluteIndex === selectedIndex;
        return (
          <Text key={session.id} color={isSelected ? COLORS.assistant : COLORS.dim} wrap="truncate">
            {isSelected ? "> " : "  "}
            {formatRecentSessionLabel(session)}
          </Text>
        );
      })}
    </Box>
  );
}

function ModelSelector({
  models,
  selectedIndex,
  maxRows,
}: {
  models: readonly SelectableModel[];
  selectedIndex: number;
  maxRows: number;
}): React.JSX.Element {
  // One row per model, so the list takes whatever height the terminal leaves.
  const visibleCount = Math.max(1, maxRows - MODEL_SELECTOR_RESERVED_ROWS);
  const visibleStartIndex = getWindowStart(selectedIndex, models.length, visibleCount);
  const visibleModels = models.slice(visibleStartIndex, visibleStartIndex + visibleCount);
  const labelWidth = Math.min(
    MODEL_LABEL_MAX_WIDTH,
    Math.max(...visibleModels.map((model) => model.label.length)),
  );
  const providerWidth = Math.max(...visibleModels.map((model) => model.providerName.length));

  return (
    <Box borderStyle="round" borderColor={COLORS.border} flexDirection="column" paddingX={1}>
      <Box justifyContent="space-between">
        <Text color={COLORS.assistant} wrap="truncate">
          Select Model ({selectedIndex + 1}/{models.length})
        </Text>
        <Text color={COLORS.dim} wrap="truncate">
          ↑↓ select · Enter apply · Esc cancel
        </Text>
      </Box>
      {visibleModels.map((model, index) => {
        const absoluteIndex = visibleStartIndex + index;
        const isSelected = absoluteIndex === selectedIndex;

        return (
          <Text key={model.id} wrap="truncate">
            <Text color={isSelected ? COLORS.assistant : COLORS.dim}>
              {isSelected ? "> " : "  "}
              {truncateEnd(model.label, labelWidth).padEnd(labelWidth)}
            </Text>
            <Text color={COLORS.dim}>{`  ${model.providerName.padEnd(providerWidth)}`}</Text>
            {model.description ? (
              <Text
                color={isSelected ? COLORS.system : COLORS.dim}
              >{`  ${model.description}`}</Text>
            ) : null}
          </Text>
        );
      })}
    </Box>
  );
}

function CommandAutocomplete({
  suggestions,
  selectedIndex,
}: {
  suggestions: readonly SlashCommandSuggestion[];
  selectedIndex: number;
}): React.JSX.Element {
  const selectedSuggestion = suggestions[selectedIndex] ?? suggestions[0] ?? null;
  const visibleStartIndex = Math.max(0, Math.min(selectedIndex - 1, suggestions.length - 4));
  const visibleSuggestions = suggestions.slice(visibleStartIndex, visibleStartIndex + 4);

  return (
    <Box paddingX={2} flexDirection="column">
      {visibleSuggestions.map((suggestion) => {
        const isSelected = suggestion.name === selectedSuggestion?.name;
        const suggestionLabel = suggestion.matchedAlias
          ? `${suggestion.name} (${suggestion.matchedAlias})`
          : suggestion.name;
        return (
          <Text
            key={suggestion.name}
            color={isSelected ? COLORS.assistant : COLORS.dim}
            wrap="truncate"
          >
            {`${isSelected ? "> " : "  "}${suggestionLabel}  ${suggestion.description}`}
          </Text>
        );
      })}
    </Box>
  );
}

function buildInitialMessages(
  history: ChatMessage[],
  model: string,
  cwdValue: string,
  modelLabel: string = model,
): UiMessage[] {
  return [
    buildHeaderMessage(modelLabel, cwdValue),
    ...history.map((message) => ({
      id: randomUUID(),
      role: message.role,
      content: message.content,
    })),
  ];
}

function buildHeaderMessage(modelLabel: string, cwdValue: string): UiMessage {
  return {
    id: `header-${randomUUID()}`,
    role: "header",
    content: [
      `${LOGO_LINES[0]}  Flixa CLI v${CLI_VERSION}`,
      `${LOGO_LINES[1]}  ${modelLabel}`,
      `${LOGO_LINES[2]}  ${truncateMiddle(cwdValue, 64)}`,
    ].join("\n"),
  };
}

function formatHeaderModelLine(modelLabel: string, planLabel: string | null): string {
  return planLabel ? `${modelLabel} · ${planLabel}` : modelLabel;
}

function formatFlixaPlanLabel(tier: string, isTeam: boolean): string {
  const tierName = tier ? `${tier.charAt(0).toUpperCase()}${tier.slice(1)}` : "";
  return ["Flixa", tierName, isTeam ? "Team" : ""].filter(Boolean).join(" ");
}

function truncateMiddle(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  const left = Math.max(4, Math.floor((maxLength - 1) / 2));
  const right = Math.max(4, maxLength - left - 1);
  return `${value.slice(0, left)}…${value.slice(-right)}`;
}

function truncateEnd(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  if (maxLength <= 1) {
    return value.slice(0, maxLength);
  }

  return `${value.slice(0, maxLength - 1)}…`;
}

function formatCustomCommandDescription(command: CustomCommand): string {
  const hint = command.argumentHint ? ` ${command.argumentHint}` : "";
  return `${command.description}${hint} (${command.scope})`;
}

function getCommandSuggestions(
  input: string,
  commands: readonly SlashCommand[] = SLASH_COMMANDS,
): readonly SlashCommandSuggestion[] {
  if (!isCommandInput(input) || hasCommandArgs(input)) {
    return [];
  }

  const query = input.slice(1).trim().toLowerCase();
  if (query === "") {
    return [...commands].sort((left, right) => left.name.localeCompare(right.name));
  }

  return commands
    .map((command) => rankCommandSuggestion(command, query))
    .filter((suggestion): suggestion is RankedSlashCommand => suggestion !== null)
    .sort(compareRankedSlashCommands)
    .map(({ command, matchedAlias }) => ({ ...command, matchedAlias }));
}

type RankedSlashCommand = {
  command: SlashCommand;
  matchedAlias?: string;
  bucket: number;
  score: number;
};

function isCommandInput(input: string): boolean {
  return input.startsWith("/");
}

function hasCommandArgs(input: string): boolean {
  if (!isCommandInput(input)) {
    return false;
  }

  if (!input.includes(" ")) {
    return false;
  }

  return !input.endsWith(" ");
}

function formatCommandInput(commandName: string): string {
  return `${commandName} `;
}

function rankCommandSuggestion(command: SlashCommand, query: string): RankedSlashCommand | null {
  const normalizedName = normalizeCommandToken(command.name);
  const normalizedAliases = (command.aliases ?? []).map((alias) => ({
    raw: alias,
    normalized: normalizeCommandToken(alias),
  }));
  const nameParts = normalizedName.split(/[:_-]/g).filter(Boolean);
  const descriptionWords = tokenizeSearchText(command.description);

  if (normalizedName === query) {
    return { command, bucket: 0, score: 0 };
  }

  const exactAlias = normalizedAliases.find((alias) => alias.normalized === query);
  if (exactAlias) {
    return { command, matchedAlias: exactAlias.raw, bucket: 1, score: 0 };
  }

  if (normalizedName.startsWith(query)) {
    return {
      command,
      bucket: 2,
      score: normalizedName.length - query.length,
    };
  }

  const prefixAlias = normalizedAliases.find((alias) => alias.normalized.startsWith(query));
  if (prefixAlias) {
    return {
      command,
      matchedAlias: prefixAlias.raw,
      bucket: 3,
      score: prefixAlias.normalized.length - query.length,
    };
  }

  const namePartMatch = nameParts
    .filter((part) => part.startsWith(query))
    .sort((left, right) => left.length - right.length)[0];
  if (namePartMatch) {
    return {
      command,
      bucket: 4,
      score: namePartMatch.length - query.length,
    };
  }

  const descriptionPrefix = descriptionWords
    .filter((word) => word.startsWith(query))
    .sort((left, right) => left.length - right.length)[0];
  if (descriptionPrefix) {
    return {
      command,
      bucket: 5,
      score: descriptionPrefix.length - query.length,
    };
  }

  const nameContainsIndex = normalizedName.indexOf(query);
  if (nameContainsIndex >= 0) {
    return {
      command,
      bucket: 6,
      score: nameContainsIndex,
    };
  }

  const aliasContains = normalizedAliases
    .map((alias) => ({
      raw: alias.raw,
      index: alias.normalized.indexOf(query),
    }))
    .filter((alias) => alias.index >= 0)
    .sort((left, right) => left.index - right.index)[0];
  if (aliasContains) {
    return {
      command,
      matchedAlias: aliasContains.raw,
      bucket: 7,
      score: aliasContains.index,
    };
  }

  const descriptionContains = descriptionWords
    .map((word) => word.indexOf(query))
    .filter((index) => index >= 0)
    .sort((left, right) => left - right)[0];
  if (descriptionContains !== undefined) {
    return {
      command,
      bucket: 8,
      score: descriptionContains,
    };
  }

  return null;
}

function compareRankedSlashCommands(left: RankedSlashCommand, right: RankedSlashCommand): number {
  if (left.bucket !== right.bucket) {
    return left.bucket - right.bucket;
  }

  if (left.score !== right.score) {
    return left.score - right.score;
  }

  return left.command.name.localeCompare(right.command.name);
}

function normalizeCommandToken(value: string): string {
  return value.replace(/^\//, "").toLowerCase();
}

function tokenizeSearchText(value: string): string[] {
  return value
    .split(/[\s:_/-]+/g)
    .map((part) => part.toLowerCase().replace(/[^a-z0-9]/g, ""))
    .filter(Boolean);
}

function renderSystemLine(line: string, index: number): React.JSX.Element {
  const toolSummaryMatch = line.match(
    /^(Bash|Read|Write|Edit|Grep|Glob|GitStatus|GitDiff)\b(?:\s+(.*))?$/,
  );
  if (toolSummaryMatch) {
    const toolName = toolSummaryMatch[1] ?? "";
    const summary = toolSummaryMatch[2] ?? "";
    return (
      <Text color={COLORS.system}>
        {index === 0 ? "· " : "  "}
        <Text color={COLORS.assistant}>{toolName}</Text>
        {summary ? (
          <>
            {" "}
            <Text dimColor>{summary}</Text>
          </>
        ) : null}
      </Text>
    );
  }

  return <Text color={COLORS.system}>{index === 0 ? `· ${line}` : `  ${line}`}</Text>;
}

function getActiveFooterMode(
  autoMode: boolean,
  yoloMode: boolean,
  planMode: boolean,
  acceptEdits: boolean,
): FooterModeKey {
  if (yoloMode) {
    return "yolo";
  }

  if (autoMode) {
    return "auto";
  }

  if (planMode) {
    return "plan";
  }

  if (acceptEdits) {
    return "accept-edits";
  }

  return "default";
}

function getFooterModeLabel(mode: FooterModeKey): string | null {
  switch (mode) {
    case "default":
      return null;
    case "accept-edits":
      return "accept edits on";
    case "plan":
      return "plan mode on";
    case "auto":
      return "auto mode on";
    case "yolo":
      return "yolo mode on";
  }
}

function getFooterModeColor(mode: FooterModeKey): (typeof COLORS)[keyof typeof COLORS] {
  switch (mode) {
    case "yolo":
      return COLORS.error;
    case "auto":
      return COLORS.brand;
    case "plan":
      return COLORS.user;
    case "accept-edits":
      return COLORS.warning;
    case "default":
      return COLORS.dim;
  }
}

function getModeFlags(mode: FooterModeKey | null): {
  autoMode: boolean;
  yoloMode: boolean;
  planMode: boolean;
  acceptEdits: boolean;
} {
  return {
    autoMode: mode === "auto",
    yoloMode: mode === "yolo",
    planMode: mode === "plan",
    acceptEdits: mode === "accept-edits",
  };
}

function getInitialModes(
  options: Pick<
    InteractiveChatOptions,
    "autoMode" | "yoloMode" | "planMode" | "acceptEdits" | "modeOverride"
  >,
  session: Pick<StoredChatSession, "autoMode" | "yoloMode" | "planMode" | "acceptEdits">,
): {
  autoMode: boolean;
  yoloMode: boolean;
  planMode: boolean;
  acceptEdits: boolean;
} {
  if (options.modeOverride) {
    return {
      autoMode: options.autoMode,
      yoloMode: options.yoloMode,
      planMode: options.planMode,
      acceptEdits: options.acceptEdits,
    };
  }

  return {
    autoMode: session.autoMode ?? options.autoMode,
    yoloMode: session.yoloMode ?? options.yoloMode,
    planMode: session.planMode ?? options.planMode,
    acceptEdits: session.acceptEdits ?? options.acceptEdits,
  };
}

function getNextFooterMode(currentMode: FooterModeKey | null): FooterModeKey {
  switch (currentMode) {
    case "default":
      return "accept-edits";
    case "accept-edits":
      return "plan";
    case "plan":
      return "auto";
    case "auto":
      return "yolo";
    case "yolo":
      return "default";
    default:
      return "default";
  }
}

function findModelSelectionIndex(
  models: readonly SelectableModel[],
  currentModel: string,
  currentProvider: string,
): number {
  const sameProvider = (model: SelectableModel): boolean => model.provider === currentProvider;
  const exactIndex = models.findIndex((model) => sameProvider(model) && model.id === currentModel);
  if (exactIndex >= 0) {
    return exactIndex;
  }

  const currentModelSuffix = stripModelProvider(currentModel);
  const suffixIndex = models.findIndex(
    (model) => sameProvider(model) && stripModelProvider(model.id) === currentModelSuffix,
  );
  return suffixIndex >= 0 ? suffixIndex : 0;
}

// Model lists change rarely, so reopening the selector reuses them for a few minutes.
const MODEL_LIST_CACHE_TTL_MS = 5 * 60_000;
// One slow or unreachable provider must not hold the whole selector back.
const MODEL_LIST_TIMEOUT_MS = 6_000;
const modelListCache = new Map<string, { at: number; models: Promise<SelectableModel[]> }>();

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** True when the provider has an API key (environment or stored) without throwing on bad config. */
function hasUsableKey(provider: string): boolean {
  try {
    return Boolean(resolveApiKeyForProvider(provider));
  } catch {
    return false;
  }
}

function stripModelProvider(modelId: string): string {
  const slashIndex = modelId.indexOf("/");
  return slashIndex === -1 ? modelId : modelId.slice(slashIndex + 1);
}

function createAbortError(): Error {
  const error = new Error("Aborted");
  error.name = "AbortError";
  return error;
}

function buildHelpMessage(customCommands: readonly CustomCommand[] = []): string {
  const customSection =
    customCommands.length > 0
      ? [
          "",
          "Custom commands (.claude/commands, .flixa/commands)",
          ...customCommands.map(
            (command) => `  ${command.name.padEnd(21)} ${formatCustomCommandDescription(command)}`,
          ),
        ]
      : [];

  return [
    "Flixa understands your codebase, makes edits with your permission, and executes commands from your terminal.",
    "",
    "Shortcuts",
    "  / for commands",
    "  Tab completes the selected command",
    "  ↑↓ navigates command suggestions or resume sessions",
    "  Shift+Tab cycles modes: default -> accept edits -> plan -> auto -> yolo",
    "  Esc clears input or denies the current approval dialog",
    "  Ctrl+C cancels an active request or exits when idle",
    "  Ctrl+L clears the current conversation",
    "",
    "Commands",
    "  /help                 show this help",
    "  /clear, /new          start a fresh conversation",
    "  /continue             load the latest session for this directory",
    "  /resume [sessionId]   resume a saved session",
    "  /init                 create or improve AGENTS.md for this repo",
    "  /compact [focus]      summarize the conversation to free up context",
    "  /ship <task>          run an inspect -> edit -> verify mission",
    "  /diff                 show the current git diff summary",
    "  /share [path]         create a redacted share card",
    "  /model [id]           open model selector or switch model",
    "  /usage                show plan and quota usage",
    "  /exit, /quit          exit Flixa CLI",
    ...customSection,
  ].join("\n");
}

function buildShipPrompt(task: string): string {
  return [
    "Ship this task end-to-end in the current repository.",
    "Inspect the relevant code first, make the smallest focused implementation, and run the most relevant verification before you finish.",
    "Use GitStatus/GitDiff before the final response when available.",
    "Final response format: SHIPPED or NOT SHIPPED, summary, files changed, verification, and any follow-up.",
    "",
    `Task: ${task}`,
  ].join("\n");
}
