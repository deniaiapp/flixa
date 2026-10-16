import type { ImageAttachment } from '../types';

export interface QueuedMessage {
  id: string;
  text: string;
  images: ImageAttachment[];
  excludedActiveFilePath?: string;
}

interface QueuedMessagesProps {
  queue: QueuedMessage[];
  onRemove: (id: string) => void;
}

export function QueuedMessages({ queue, onRemove }: QueuedMessagesProps) {
  if (queue.length === 0) {
    return null;
  }

  return (
    <div className="mx-auto w-full max-w-3xl px-2.5 pt-2.5 flex flex-col gap-1">
      <div className="px-1 text-[10px] font-medium uppercase tracking-wide text-foreground-subtle">
        Queued · sends when Flixa finishes
      </div>
      {queue.map((item) => (
        <div
          key={item.id}
          className="group flex items-center gap-2 rounded-xl bg-bubble px-3 py-1.5 min-w-0"
        >
          <svg className="w-3 h-3 text-foreground-subtle shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <span className="text-[12px] text-foreground truncate flex-1">{item.text}</span>
          <button
            type="button"
            onClick={() => onRemove(item.id)}
            className="w-5 h-5 shrink-0 flex items-center justify-center rounded text-foreground-subtle hover:text-foreground hover:bg-surface-hover transition-colors"
            title="Remove from queue"
            aria-label="Remove from queue"
          >
            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      ))}
    </div>
  );
}
