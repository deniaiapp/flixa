import { useEffect, useRef, useState } from "react";
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
  onCopy?: (text: string) => void;
  onEdit?: (text: string) => void;
  canEdit?: boolean;
  asReply?: boolean;
}

const CopyIcon = () => (
  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
  </svg>
);

const CheckIcon = () => (
  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
  </svg>
);

const PencilIcon = () => (
  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536M9 13l6.232-6.232a2.5 2.5 0 113.536 3.536L12.536 16.5H9V13z" />
  </svg>
);

const actionButtonClassName =
  "w-6 h-6 flex items-center justify-center rounded-md text-foreground-subtle hover:text-foreground hover:bg-surface-hover transition-colors";

function CopyButton({ text, onCopy }: { text: string; onCopy: (text: string) => void }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) {
      return;
    }
    const id = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(id);
  }, [copied]);

  return (
    <button
      type="button"
      onClick={() => {
        onCopy(text);
        setCopied(true);
      }}
      className={actionButtonClassName}
      title={copied ? "Copied" : "Copy"}
      aria-label={copied ? "Copied" : "Copy"}
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
    </button>
  );
}

function EditBox({
  initialText,
  onCancel,
  onSubmit,
}: {
  initialText: string;
  onCancel: () => void;
  onSubmit: (text: string) => void;
}) {
  const [draft, setDraft] = useState(initialText);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) {
      return;
    }
    textarea.focus();
    textarea.selectionStart = textarea.value.length;
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 240)}px`;
  }, []);

  const submit = () => {
    if (draft.trim()) {
      onSubmit(draft);
    }
  };

  return (
    <div className="w-full max-w-[85%] rounded-2xl border border-input-border bg-composer focus-within:border-foreground/30 transition-colors">
      <textarea
        ref={textareaRef}
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value);
          e.target.style.height = "auto";
          e.target.style.height = `${Math.min(e.target.scrollHeight, 240)}px`;
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          } else if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            submit();
          }
        }}
        rows={1}
        className="block w-full px-3.5 pt-2.5 pb-1 bg-transparent resize-none text-[13px] leading-relaxed text-input-foreground outline-none"
      />
      <div className="flex items-center justify-end gap-1.5 px-2 pb-2">
        <button
          type="button"
          onClick={onCancel}
          className="h-6 px-2.5 text-[11px] rounded-md text-foreground-muted hover:text-foreground hover:bg-surface-hover transition-colors"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={submit}
          disabled={!draft.trim()}
          className="h-6 px-2.5 text-[11px] font-medium rounded-md bg-accent text-accent-foreground hover:bg-accent-hover transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          Send
        </button>
      </div>
    </div>
  );
}

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


const chipClassName =
  "px-2 py-1 rounded-md text-foreground-muted text-[11px] leading-none bg-bubble inline-flex items-center gap-1.5";

export function Message({ message, onCopy, onEdit, canEdit = false, asReply = false }: MessageProps) {
  const [isEditing, setIsEditing] = useState(false);

  useEffect(() => {
    if (!canEdit) {
      setIsEditing(false);
    }
  }, [canEdit]);

  if (message.role === "user") {
    return (
      <div className="message-animate group flex justify-end pt-2">
        <div className="flex flex-col items-end gap-1.5 w-full">
          {message.images && message.images.length > 0 && (
            <div className="flex flex-wrap gap-2 justify-end">
              {message.images.map((img) => (
                <img
                  key={img.id}
                  src={img.data}
                  alt={img.name || "Attached image"}
                  className="max-h-48 max-w-full rounded-xl border border-hairline object-contain"
                />
              ))}
            </div>
          )}
          {(message.mentionedFiles && message.mentionedFiles.length > 0) || message.activeSelectionLabel || message.activeFilePath ? (
            <div className="flex flex-wrap gap-1.5 justify-end">
              {(message.activeSelectionLabel || message.activeFilePath) && (
                <div className={chipClassName}>
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
                <div key={`${file.reference}-${file.filePath}`} className={chipClassName}>
                  <FileIcon />
                  <span>{getBaseName(file.reference)}</span>
                </div>
              ))}
            </div>
          ) : null}
          {isEditing && onEdit ? (
            <EditBox
              initialText={message.content}
              onCancel={() => setIsEditing(false)}
              onSubmit={(text) => {
                setIsEditing(false);
                onEdit(text);
              }}
            />
          ) : (
            message.content && (
              <div className="max-w-[85%] px-3.5 py-2 bg-bubble text-foreground rounded-2xl text-[13px] leading-relaxed whitespace-pre-wrap break-words">
                {message.content}
              </div>
            )
          )}
          {!isEditing && message.content && (onCopy || (onEdit && canEdit)) && (
            <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
              {onEdit && canEdit && (
                <button
                  type="button"
                  onClick={() => setIsEditing(true)}
                  className={actionButtonClassName}
                  title="Edit and resend"
                  aria-label="Edit and resend"
                >
                  <PencilIcon />
                </button>
              )}
              {onCopy && <CopyButton text={message.content} onCopy={onCopy} />}
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
        <div className="message-animate w-full min-w-0">
          <div className="flex items-start gap-2 px-3 py-2 rounded-xl bg-error/10 border border-error/25 text-[12px] leading-relaxed text-error min-w-0 [word-break:break-word]">
            <span className="mt-[3px] shrink-0">
              <ErrorIcon />
            </span>
            <span>{message.content}</span>
          </div>
        </div>
      );
    }

    return (
      <div className="message-animate group w-full min-w-0 py-0.5">
        <div className="text-[13px] leading-relaxed text-foreground min-w-0 [word-break:break-word]">
          <MarkdownContent content={message.content} />
        </div>
        {onCopy && message.content && (
          <div className="flex items-center gap-0.5 mt-1 -ml-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
            <CopyButton text={message.content} onCopy={onCopy} />
          </div>
        )}
      </div>
    );
  }

  const isError = isErrorMessage(message.content);

  if (isError) {
    return (
      <div className="message-animate flex justify-center py-1">
        <div className="flex items-center gap-1.5 px-3 py-1.5 bg-error/10 border border-error/25 rounded-lg text-error">
          <ErrorIcon />
          <span className="text-[11px]">{message.content}</span>
        </div>
      </div>
    );
  }

  if (asReply) {
    return (
      <div
        role="note"
        className="message-animate group relative w-full min-w-0 flex items-start gap-2.5 px-3 py-2.5 rounded-xl border border-info/30 bg-info/10"
      >
        <span className="mt-[3px] shrink-0 text-info">
          <SystemIcon />
        </span>
        <div className="flex-1 text-[12px] leading-relaxed text-foreground min-w-0 whitespace-pre-wrap [word-break:break-word]">
          {message.content}
        </div>
        {onCopy && message.content && (
          <div className="absolute top-1.5 right-1.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
            <CopyButton text={message.content} onCopy={onCopy} />
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="message-animate flex items-center gap-3 py-1 text-foreground-subtle">
      <div className="h-px flex-1 bg-hairline" />
      <div className="flex items-center gap-1.5 min-w-0 max-w-[85%]">
        <span className="shrink-0">
          <SystemIcon />
        </span>
        <span className="text-[11px]">{message.content}</span>
      </div>
      <div className="h-px flex-1 bg-hairline" />
    </div>
  );
}
