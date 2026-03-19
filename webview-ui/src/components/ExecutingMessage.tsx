import type { ReactNode } from 'react';
import type { ChatMessage } from '../types';

interface ExecutingMessageProps {
  message: ChatMessage;
}

const TerminalIcon = () => (
  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
  </svg>
);

const ReadIcon = () => (
  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
  </svg>
);

const EditIcon = () => (
  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
  </svg>
);

const SearchIcon = () => (
  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
  </svg>
);

const FolderIcon = () => (
  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
  </svg>
);

const WriteIcon = () => (
  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
  </svg>
);

function getToolInfo(action: string): { name: string; target: string; icon: ReactNode } {
  const lowerAction = action.toLowerCase();

  if (lowerAction.startsWith('read:') || lowerAction.startsWith('read ')) {
    return { name: 'Read', target: action.replace(/^read:?\s*/i, ''), icon: <ReadIcon /> };
  }
  if (lowerAction.startsWith('edit:') || lowerAction.startsWith('edit ')) {
    return { name: 'Edit', target: action.replace(/^edit:?\s*/i, ''), icon: <EditIcon /> };
  }
  if (lowerAction.startsWith('write:') || lowerAction.startsWith('write ')) {
    return { name: 'Write', target: action.replace(/^write:?\s*/i, ''), icon: <WriteIcon /> };
  }
  if (lowerAction.startsWith('grep:') || lowerAction.startsWith('grep ') || lowerAction.startsWith('codebase search:')) {
    return { name: 'Grep', target: action.replace(/^(grep|codebase search):?\s*/i, ''), icon: <SearchIcon /> };
  }
  if (lowerAction.startsWith('glob:') || lowerAction.startsWith('glob ') || lowerAction.startsWith('file search:')) {
    return { name: 'Glob', target: action.replace(/^(glob|file search):?\s*/i, ''), icon: <SearchIcon /> };
  }
  if (lowerAction.startsWith('list dir:') || lowerAction.startsWith('listdir:')) {
    return { name: 'List', target: action.replace(/^list\s*dir:?\s*/i, ''), icon: <FolderIcon /> };
  }
  if (lowerAction.startsWith('terminal:') || lowerAction.startsWith('shell:') || lowerAction.startsWith('bash:')) {
    return { name: 'Terminal', target: action.replace(/^(terminal|shell|bash):?\s*/i, ''), icon: <TerminalIcon /> };
  }

  const colonIdx = action.indexOf(':');
  if (colonIdx > 0 && colonIdx < 20) {
    return { name: action.substring(0, colonIdx), target: action.substring(colonIdx + 1).trim(), icon: <TerminalIcon /> };
  }

  return { name: 'Action', target: action, icon: <TerminalIcon /> };
}

export function ExecutingMessage({ message }: ExecutingMessageProps) {
  const lines = message.executingOutput?.split('\n').slice(-10).join('\n') || '';
  const toolInfo = getToolInfo(message.executingAction || '');

  return (
    <div className="message-animate">
      <div className="rounded-lg bg-surface-2/50 border border-border-subtle/30 overflow-hidden">
        <div className="flex items-center gap-2 px-2.5 py-1.5">
          <div className="w-4 h-4 rounded flex items-center justify-center bg-info/10">
            <div className="w-1.5 h-1.5 rounded-full bg-info animate-pulse" />
          </div>
          <div className="text-foreground-muted">
            {toolInfo.icon}
          </div>
          <span className="text-[11px] font-medium text-foreground-muted">{toolInfo.name}</span>
          <span className="text-[11px] text-foreground-subtle truncate flex-1">{toolInfo.target}</span>
        </div>
        {lines && (
          <div className="px-2.5 py-2 border-t border-border-subtle/20 bg-surface-1/30">
            <pre className="text-[11px] text-foreground-muted font-mono leading-relaxed max-h-40 overflow-y-auto whitespace-pre-wrap">
              {lines}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}
