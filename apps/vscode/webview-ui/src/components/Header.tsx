import { useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import type { ChatSession } from '../types';

interface HeaderProps {
  sessions: ChatSession[];
  currentSessionId: string;
  onSessionChange: (sessionId: string) => void;
  onNewChat: () => void;
  onDeleteChat: (sessionId: string) => void;
}

const AddIcon = () => (
  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
  </svg>
);

const HistoryIcon = () => (
  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
  </svg>
);

const MoreIcon = () => (
  <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
    <circle cx="5" cy="12" r="2" />
    <circle cx="12" cy="12" r="2" />
    <circle cx="19" cy="12" r="2" />
  </svg>
);

export function Header({
  sessions,
  currentSessionId,
  onSessionChange,
  onNewChat,
  onDeleteChat,
}: HeaderProps) {
  const [isHistoryOpen, setIsHistoryOpen] = useState(false);
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const historyButtonRef = useRef<HTMLButtonElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const [historyPosition, setHistoryPosition] = useState({ top: 0, left: 0 });
  const [menuPosition, setMenuPosition] = useState({ top: 0, left: 0 });

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      const historyMenu = document.getElementById('history-menu');
      const moreMenu = document.getElementById('more-menu');
      if (historyButtonRef.current && !historyButtonRef.current.contains(e.target as Node)) {
        if (historyMenu && !historyMenu.contains(e.target as Node)) {
          setIsHistoryOpen(false);
        }
      }
      if (menuButtonRef.current && !menuButtonRef.current.contains(e.target as Node)) {
        if (moreMenu && !moreMenu.contains(e.target as Node)) {
          setIsMenuOpen(false);
        }
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  useEffect(() => {
    if (isHistoryOpen && historyButtonRef.current) {
      const rect = historyButtonRef.current.getBoundingClientRect();
      setHistoryPosition({
        top: rect.bottom + 4,
        left: Math.max(8, rect.left - 100),
      });
    }
  }, [isHistoryOpen]);

  useEffect(() => {
    if (isMenuOpen && menuButtonRef.current) {
      const rect = menuButtonRef.current.getBoundingClientRect();
      setMenuPosition({
        top: rect.bottom + 4,
        left: rect.right - 150,
      });
    }
  }, [isMenuOpen]);

  const handleOpenFromHistory = (sessionId: string) => {
    onSessionChange(sessionId);
    setIsHistoryOpen(false);
  };

  const truncateName = (name: string, maxLength: number = 12) => {
    if (name.length <= maxLength) return name;
    return name.slice(0, maxLength - 2) + '..';
  };

  const historyMenu = isHistoryOpen && createPortal(
    <div
      id="history-menu"
      className="fixed z-[9999] min-w-[180px] max-h-[300px] overflow-y-auto bg-menu-bg border border-menu-border rounded-lg shadow-[0_12px_24px_var(--color-shadow)]"
      style={{
        top: historyPosition.top,
        left: historyPosition.left,
      }}
    >
      {sessions.length === 0 ? (
        <div className="px-3 py-2 text-xs text-foreground-subtle">No conversations</div>
      ) : (
        sessions.map((session) => (
          <button
            type="button"
            key={session.id}
            className={`w-full px-3 py-2 cursor-pointer transition-colors hover:bg-menu-selected-bg text-xs border-b border-menu-separator last:border-b-0 text-left ${
              session.id === currentSessionId ? 'text-foreground' : 'text-menu-foreground'
            }`}
            onClick={() => handleOpenFromHistory(session.id)}
          >
            <span className="truncate">{session.name}</span>
          </button>
        ))
      )}
    </div>,
    document.body
  );

  const moreMenu = isMenuOpen && createPortal(
    <div
      id="more-menu"
      className="fixed z-[9999] min-w-[150px] bg-menu-bg border border-menu-border rounded-lg shadow-[0_12px_24px_var(--color-shadow)]"
      style={{
        top: menuPosition.top,
        left: menuPosition.left,
      }}
    >
      <button
        type="button"
        className="w-full px-3 py-2 cursor-pointer transition-colors hover:bg-menu-selected-bg text-xs text-menu-foreground text-left"
        onClick={() => {
          onNewChat();
          setIsMenuOpen(false);
        }}
      >
        New conversation
      </button>
      <button
        type="button"
        className="w-full px-3 py-2 cursor-pointer transition-colors hover:bg-menu-selected-bg text-xs text-error border-t border-menu-separator text-left"
        onClick={() => {
          onDeleteChat(currentSessionId);
          setIsMenuOpen(false);
        }}
      >
        Delete conversation
      </button>
    </div>,
    document.body
  );

  return (
    <div className="px-2 pt-2">
      <div className="bg-input-bg border border-input-border rounded-lg overflow-hidden">
        <div className="flex items-center">
          <button
            type="button"
            ref={historyButtonRef}
            onClick={() => setIsHistoryOpen(!isHistoryOpen)}
            className="flex-shrink-0 p-1.5 text-foreground-subtle hover:text-foreground hover:bg-surface-hover transition-all border-r border-input-border"
            title="History"
          >
            <HistoryIcon />
          </button>
          <div className="flex-1 flex items-center px-2.5 py-1.5 text-xs text-foreground-subtle truncate">
            {currentSessionId
              ? truncateName(sessions.find(session => session.id === currentSessionId)?.name ?? 'Conversation')
              : 'Conversation'}
          </div>
          <button
            type="button"
            onClick={onNewChat}
            className="flex-shrink-0 p-1.5 text-foreground-subtle hover:text-foreground hover:bg-surface-hover transition-all border-l border-input-border"
            title="New Chat"
          >
            <AddIcon />
          </button>
          <button
            type="button"
            ref={menuButtonRef}
            onClick={() => setIsMenuOpen(!isMenuOpen)}
            className="flex-shrink-0 p-1.5 text-foreground-subtle hover:text-foreground hover:bg-surface-hover transition-all border-l border-input-border"
            title="More"
          >
            <MoreIcon />
          </button>
        </div>
      </div>
      {historyMenu}
      {moreMenu}
    </div>
  );
}
