import type { PendingApproval } from '../types';

interface ApprovalCardProps {
  approvals: PendingApproval[];
  onRespond: (id: string, decision: 'approve' | 'reject') => void;
}

function getApprovalTitle(action: string): string {
  const lowerAction = action.toLowerCase();
  if (lowerAction.startsWith('shell:') || lowerAction.startsWith('terminal:')) {
    return 'Allow Flixa to run this command?';
  }
  if (lowerAction.startsWith('vscode:')) {
    return 'Allow Flixa to run this VS Code command?';
  }
  if (lowerAction.startsWith('delete:')) {
    return 'Allow Flixa to delete this file?';
  }
  return 'Allow Flixa to make this change?';
}

export function ApprovalCard({ approvals, onRespond }: ApprovalCardProps) {
  const approval = approvals[0];
  if (!approval) {
    return null;
  }

  const target = approval.detail || approval.action.replace(/^[^:]+:\s*/, '');

  return (
    <div className="mx-auto w-full max-w-3xl px-2.5 pt-2.5">
      <div
        role="alertdialog"
        aria-label={getApprovalTitle(approval.action)}
        className="message-animate rounded-2xl border border-warning/40 bg-composer shadow-[0_4px_16px_var(--color-shadow)] overflow-hidden"
      >
        <div className="flex items-center gap-2 px-3.5 pt-3">
          <svg className="w-3.5 h-3.5 text-warning shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
          </svg>
          <span className="text-[12px] font-medium text-foreground flex-1">{getApprovalTitle(approval.action)}</span>
          {approvals.length > 1 && (
            <span className="text-[10px] text-foreground-subtle">1 of {approvals.length}</span>
          )}
        </div>
        <div className="px-3.5 pt-2">
          <pre className="text-[11px] font-mono text-foreground leading-relaxed whitespace-pre-wrap break-all max-h-32 overflow-y-auto rounded-lg bg-code-bg border border-hairline px-2.5 py-2">
            {target}
          </pre>
        </div>
        <div className="flex items-center justify-end gap-1.5 px-2.5 py-2.5">
          <button
            type="button"
            onClick={() => onRespond(approval.id, 'reject')}
            className="h-7 px-3 text-[12px] rounded-lg text-foreground-muted hover:text-foreground hover:bg-surface-hover border border-hairline transition-colors"
          >
            Deny
          </button>
          <button
            type="button"
            onClick={() => onRespond(approval.id, 'approve')}
            className="h-7 px-3 text-[12px] font-medium rounded-lg bg-accent text-accent-foreground hover:bg-accent-hover transition-colors"
          >
            Allow
          </button>
        </div>
      </div>
    </div>
  );
}
