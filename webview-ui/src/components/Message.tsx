import type { ChatMessage } from "../types";
import { MarkdownContent } from "./MarkdownContent";

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

interface MessageProps {
  message: ChatMessage;
}

const UserIcon = () => (
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
      d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"
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

const SystemIcon = () => (
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
      d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
    />
  </svg>
);

const ErrorIcon = () => (
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
      d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
    />
  </svg>
);

const FileIcon = () => (
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
      d="M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8zm0 0v5h5"
    />
  </svg>
);

function isErrorMessage(content: string): boolean {
  const lowerContent = content.toLowerCase();
  return (
    lowerContent.includes("api error") ||
    lowerContent.includes("error:") ||
    lowerContent.startsWith("error") ||
    lowerContent.includes("failed to") ||
    lowerContent.includes("request failed") ||
    lowerContent.includes("connection error") ||
    lowerContent.includes("timeout") ||
    lowerContent.includes("rate limit") ||
    lowerContent.includes("unauthorized") ||
    lowerContent.includes("forbidden")
  );
}

export function Message({ message }: MessageProps) {
  if (message.role === "user") {
    return (
      <div className="message-animate flex gap-2.5 justify-end">
        <div className="flex flex-col items-end gap-1 w-full">
          <div className="flex items-center gap-1.5 text-foreground-muted">
            <span className="text-[10px] font-medium uppercase tracking-wide">You</span>
            <div className="w-5 h-5 rounded-full bg-accent/20 flex items-center justify-center text-accent">
              <UserIcon />
            </div>
          </div>
          {message.images && message.images.length > 0 && (
            <div className="flex flex-wrap gap-2 justify-end mt-1">
              {message.images.map((img) => (
                <img
                  key={img.id}
                  src={img.data}
                  alt={img.name || "Attached image"}
                  className="max-h-48 max-w-full rounded-lg border border-input-border object-contain"
                />
              ))}
            </div>
          )}
          {(message.mentionedFiles && message.mentionedFiles.length > 0) || message.activeSelectionLabel || message.activeFilePath ? (
            <div className="flex flex-wrap gap-1.5 justify-end mt-1">
              {(message.activeSelectionLabel || message.activeFilePath) && (
                <div className="px-2 py-1 rounded-[6px] text-foreground-muted text-[11px] leading-none border border-input-border inline-flex items-center gap-1.5">
                  <FileIcon />
                  <span>
                    {message.activeSelectionLabel
                      ? formatSelectionChipLabel(message.activeSelectionLabel)
                      : message.activeFilePath
                        ? getBaseName(message.activeFilePath)
                        : ""}
                  </span>
                </div>
              )}
              {(message.mentionedFiles ?? []).map((file) => (
                <div
                  key={`${file.reference}-${file.filePath}`}
                  className="px-2 py-1 rounded-[6px] text-foreground-muted text-[11px] leading-none border border-input-border inline-flex items-center gap-1.5"
                >
                  <FileIcon />
                  <span>{getBaseName(file.reference)}</span>
                </div>
              ))}
            </div>
          ) : null}
          {message.content && (
            <div className="px-3.5 py-2.5 bg-accent text-accent-foreground rounded-2xl rounded-tr-sm text-[13px] leading-relaxed whitespace-pre-wrap break-words">
              {message.content}
            </div>
          )}
        </div>
      </div>
    );
  }

  if (message.role === "assistant") {
    const isError = isErrorMessage(message.content);

    if (isError) {
      return (
        <div className="message-animate flex gap-2.5">
          <div className="flex flex-col items-start gap-1 w-full min-w-0">
            <div className="flex items-center gap-1.5 text-error">
              <div className="w-5 h-5 rounded-full bg-error/20 flex items-center justify-center text-error">
                <ErrorIcon />
              </div>
              <span className="text-[10px] font-medium uppercase tracking-wide">Error</span>
            </div>
            <div className="px-3 py-2 rounded-lg bg-error/10 border border-error/20 text-[13px] leading-relaxed text-error min-w-0 [word-break:break-word] mt-2 ml-2">
              {message.content}
            </div>
          </div>
        </div>
      );
    }

    return (
      <div className="message-animate flex gap-2.5">
        <div className="flex flex-col items-start gap-1 w-full min-w-0">
          <div className="flex items-center gap-1.5 text-foreground-muted">
            <div className="w-5 h-5 rounded-full bg-surface-hover flex items-center justify-center text-foreground-subtle">
              <AssistantIcon />
            </div>
            <span className="text-[10px] font-medium uppercase tracking-wide">Flixa</span>
          </div>
          <div className="text-[13px] mt-2 ml-2 leading-relaxed text-foreground min-w-0 [word-break:break-word]">
            <MarkdownContent content={message.content} />
          </div>
        </div>
      </div>
    );
  }

  // System message
  const isError = isErrorMessage(message.content);

  if (isError) {
    return (
      <div className="message-animate flex justify-center py-1">
        <div className="flex items-center gap-1.5 px-3 py-1.5 bg-error/10 border border-error/20 rounded-lg text-error">
          <ErrorIcon />
          <span className="text-[11px]">{message.content}</span>
        </div>
      </div>
    );
  }

  return (
    <div className="message-animate flex justify-center py-1">
      <div className="flex items-center gap-1.5 px-3 py-1.5 bg-surface-hover/50 rounded-full text-foreground-muted">
        <SystemIcon />
        <span className="text-[11px]">{message.content}</span>
      </div>
    </div>
  );
}
