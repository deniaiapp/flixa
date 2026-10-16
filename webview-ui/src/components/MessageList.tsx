import { useId, type RefObject } from "react";
import type { ChatMessage, ChatSession } from "../types";
import { Message } from "./Message";
import { ExecutingMessage } from "./ExecutingMessage";
import { ResultMessage } from "./ResultMessage";
import { MarkdownContent } from "./MarkdownContent";
import { Spinner } from "./Spinner";

interface MessageListProps {
  messages: ChatMessage[];
  isLoading: boolean;
  streamingText: string;
  messagesEndRef: RefObject<HTMLDivElement | null>;
  sessions?: ChatSession[];
  currentSessionId?: string;
  onSwitchChat?: (sessionId: string) => void;
  onCopy?: (text: string) => void;
  onEditMessage?: (index: number, text: string) => void;
  busy?: boolean;
}

const MAX_RECENT_CHATS = 5;

const FlixaLogo = () => (
  <svg
    className="w-10 h-10 text-accent"
    fill="none"
    stroke="currentColor"
    viewBox="0 0 24 24"
    aria-hidden="true"
  >
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={1.5}
      d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z"
    />
  </svg>
);

export function MessageList({
  messages,
  isLoading,
  streamingText,
  messagesEndRef,
  sessions = [],
  currentSessionId = "",
  onSwitchChat,
  onCopy,
  onEditMessage,
  busy = false,
}: MessageListProps) {
  const idPrefix = useId();

  if (messages.length === 0 && !isLoading) {
    const recentChats = sessions
      .filter((session) => session.id !== currentSessionId)
      .slice(0, MAX_RECENT_CHATS);

    return (
      <div className="flex-1 overflow-y-auto flex flex-col">
        <div className="flex-1 flex flex-col items-center justify-center gap-4 px-6 py-10">
          <FlixaLogo />
          <div className="text-center space-y-1.5">
            <div className="text-xl font-medium tracking-tight text-foreground">What can I help you with?</div>
            <div className="text-xs text-foreground-muted">Ask anything or start a coding task</div>
          </div>
        </div>
        {onSwitchChat && recentChats.length > 0 && (
          <div className="mx-auto w-full max-w-3xl px-4 pb-4">
            <div className="px-2 pb-1 text-[10px] font-medium uppercase tracking-wide text-foreground-subtle">
              Recent
            </div>
            <div className="flex flex-col">
              {recentChats.map((session) => (
                <button
                  key={session.id}
                  type="button"
                  onClick={() => onSwitchChat(session.id)}
                  className="flex items-center gap-2 px-2 py-1.5 rounded-lg text-left text-[12px] text-foreground-muted hover:text-foreground hover:bg-surface-hover transition-colors min-w-0"
                >
                  <svg className="w-3.5 h-3.5 shrink-0 text-foreground-subtle" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 10h8M8 14h5m-9 6l3.5-3H18a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v14z" />
                  </svg>
                  <span className="truncate">{session.name}</span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl px-4 pt-5 pb-3 flex flex-col gap-3">
        {messages.map((msg, idx) => {
          const key = `${idPrefix}-${msg.role}-${idx}`;
          if (msg.role === "assistant" && msg.tool_calls?.length && !msg.content) {
            return null;
          }
          if (msg.role === "executing" && msg.executingAction) {
            return <ExecutingMessage key={key} message={msg} />;
          }
          if ((msg.role === "result" || msg.role === "tool") && msg.results) {
            return <ResultMessage key={key} results={msg.results} />;
          }
          return (
            <Message
              key={key}
              message={msg}
              onCopy={onCopy}
              onEdit={onEditMessage ? (text) => onEditMessage(idx, text) : undefined}
              canEdit={!busy && msg.role === "user" && !msg.content.trim().startsWith("/")}
              asReply={
                msg.role === "system" &&
                messages[idx - 1]?.role === "user" &&
                messages[idx - 1].content.trim().startsWith("/")
              }
            />
          );
        })}
        {isLoading && (
          <div className="message-animate min-w-0 [word-break:break-word]">
            {streamingText ? (
              <div className="text-[13px] text-foreground leading-relaxed">
                <MarkdownContent content={streamingText} />
                <span className="inline-block w-1.5 h-3.5 bg-foreground/60 ml-0.5 animate-pulse align-middle rounded-[1px]" />
              </div>
            ) : (
              <div className="flex items-center gap-2 py-1">
                <Spinner className="text-[13px]" />
                <span className="shimmer-text text-[12px]">Thinking…</span>
              </div>
            )}
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>
    </div>
  );
}
