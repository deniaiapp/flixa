import { useState } from 'react';
import type { FileChange } from '../types';
import { vscode } from '../vscode';

interface FilesChangedProps {
  files: FileChange[];
}

const ChevronIcon = ({ expanded }: { expanded: boolean }) => (
  <svg
    className={`w-3 h-3 transition-transform ${expanded ? 'rotate-90' : ''}`}
    fill="none"
    stroke="currentColor"
    viewBox="0 0 24 24"
  >
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
  </svg>
);

const FileIcon = () => (
  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
  </svg>
);

const UndoIcon = () => (
  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h10a5 5 0 015 5v2M3 10l4-4M3 10l4 4" />
  </svg>
);

const CheckIcon = () => (
  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
  </svg>
);

function getStatusInfo(status: FileChange['status']): { label: string; color: string; bg: string } {
  switch (status) {
    case 'modified':
      return { label: 'M', color: 'text-warning', bg: 'bg-warning/15' };
    case 'created':
      return { label: 'A', color: 'text-success', bg: 'bg-success/15' };
    case 'deleted':
      return { label: 'D', color: 'text-error', bg: 'bg-error/15' };
    default:
      return { label: '?', color: 'text-foreground-muted', bg: 'bg-surface-hover' };
  }
}

function getFileName(filePath: string): string {
  const parts = filePath.replace(/\\/g, '/').split('/');
  return parts[parts.length - 1];
}

function getDirectory(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  const lastSlash = normalized.lastIndexOf('/');
  if (lastSlash === -1) {
    return '';
  }
  return normalized.substring(0, lastSlash);
}

function FileItem({ file }: { file: FileChange }) {
  const statusInfo = getStatusInfo(file.status);
  const fileName = getFileName(file.filePath);
  const directory = getDirectory(file.filePath);

  const handleOpen = () => {
    vscode.postMessage({ type: 'openFile', filePath: file.filePath });
  };

  const handleRevert = (e: React.MouseEvent) => {
    e.stopPropagation();
    vscode.postMessage({ type: 'revertFile', filePath: file.filePath });
  };

  const handleKeep = (e: React.MouseEvent) => {
    e.stopPropagation();
    vscode.postMessage({ type: 'keepFile', filePath: file.filePath });
  };

  return (
    <div className="group flex items-center gap-1.5 px-3 py-1 hover:bg-surface-hover/50 transition-colors">
      <button
        type="button"
        onClick={handleOpen}
        className="flex items-center gap-1.5 flex-1 min-w-0 text-left cursor-pointer"
      >
        <div className="text-foreground-subtle shrink-0">
          <FileIcon />
        </div>
        <span className="text-[11px] text-foreground truncate">{fileName}</span>
        {directory && (
          <span className="text-[10px] text-foreground-subtle truncate">{directory}</span>
        )}
      </button>
      <div className="flex items-center gap-1 shrink-0">
        <div className={`w-4 h-4 rounded flex items-center justify-center text-[9px] font-bold ${statusInfo.color} ${statusInfo.bg}`}>
          {statusInfo.label}
        </div>
        <button
          type="button"
          onClick={handleRevert}
          className="w-5 h-5 rounded flex items-center justify-center text-foreground-subtle hover:text-error hover:bg-error/10 opacity-0 group-hover:opacity-100 transition-all cursor-pointer"
          title="Revert"
        >
          <UndoIcon />
        </button>
        <button
          type="button"
          onClick={handleKeep}
          className="w-5 h-5 rounded flex items-center justify-center text-foreground-subtle hover:text-success hover:bg-success/10 opacity-0 group-hover:opacity-100 transition-all cursor-pointer"
          title="Keep"
        >
          <CheckIcon />
        </button>
      </div>
    </div>
  );
}

export function FilesChanged({ files }: FilesChangedProps) {
  const [expanded, setExpanded] = useState(true);

  if (files.length === 0) {
    return null;
  }

  const handleKeepAll = () => {
    vscode.postMessage({ type: 'keepAll' });
  };

  return (
    <div className="mx-auto w-full max-w-3xl px-5">
    <div className="mb-[-10px] rounded-t-xl bg-surface-2/60 border border-b-0 border-hairline overflow-hidden">
      <div className="flex items-center">
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          className="flex items-center gap-2 px-3 py-1.5 text-left hover:bg-surface-hover/30 cursor-pointer flex-1"
        >
          <div className="text-foreground-subtle">
            <ChevronIcon expanded={expanded} />
          </div>
          <span className="text-[11px] font-medium text-foreground">Files Changed</span>
          <span className="text-[10px] text-foreground-subtle">({files.length})</span>
        </button>
        <button
          type="button"
          onClick={handleKeepAll}
          className="text-[11px] text-foreground-muted hover:text-foreground px-2 py-0.5 mr-1.5 rounded-md border border-hairline hover:bg-surface-hover transition-colors cursor-pointer"
        >
          Keep All
        </button>
      </div>

      {expanded && (
        <div className="border-t border-hairline py-0.5 max-h-40 overflow-y-auto">
          {files.map((file) => (
            <FileItem key={file.filePath} file={file} />
          ))}
        </div>
      )}
    </div>
    </div>
  );
}
