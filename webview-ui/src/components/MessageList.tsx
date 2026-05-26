import { useId, type RefObject } from "react";
import type { ChatMessage } from "../types";
import { Message } from "./Message";
import { ExecutingMessage } from "./ExecutingMessage";
import { ResultMessage } from "./ResultMessage";
import { MarkdownContent } from "./MarkdownContent";

interface MessageListProps {
  messages: ChatMessage[];
  isLoading: boolean;
  streamingText: string;
  messagesEndRef: RefObject<HTMLDivElement | null>;
}

const FlixaLogo = () => (
  <svg
    className="w-12 h-12 text-foreground-subtle/30"
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

const AssistantIcon = () => (
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
      d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z"
    />
  </svg>
);

export function MessageList({
  messages,
  isLoading,
  streamingText,
  messagesEndRef,
}: MessageListProps) {
  const idPrefix = useId();

  if (messages.length === 0 && !isLoading) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-foreground-subtle gap-4 p-8">
        <FlixaLogo />
        <div className="text-center space-y-1">
          <div className="text-sm font-medium text-foreground-muted">What can I help you with?</div>
          <div className="text-xs text-foreground-subtle">Ask anything or start a coding task</div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-4">
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
        return <Message key={key} message={msg} />;
      })}
      {isLoading && (
        <div className="message-animate flex gap-2.5">
          <div className="flex flex-col items-start gap-1 max-w-[90%] min-w-0">
            <div className="flex items-center gap-1.5 text-foreground-muted">
              <div className="w-5 h-5 rounded-full bg-surface-hover flex items-center justify-center text-foreground-subtle">
                <AssistantIcon />
              </div>
              <span className="text-[10px] font-medium uppercase tracking-wide">Flixa</span>
            </div>
            <div className="min-w-0 mt-2 ml-2 [word-break:break-word]">
              {streamingText ? (
                <div className="text-[13px] text-foreground leading-relaxed">
                  <MarkdownContent content={streamingText} />
                  <span className="inline-block w-0.5 h-4 bg-accent ml-0.5 animate-pulse align-middle" />
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  <span className="text-xs text-foreground-muted">Thinking</span>
                  <div className="flex gap-1">
                    <span className="loading-dot w-1 h-1 bg-foreground-muted rounded-full" />
                    <span className="loading-dot w-1 h-1 bg-foreground-muted rounded-full" />
                    <span className="loading-dot w-1 h-1 bg-foreground-muted rounded-full" />
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
      <div ref={messagesEndRef} />
    </div>
  );
}
