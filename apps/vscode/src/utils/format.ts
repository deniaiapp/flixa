import type { SerializedActionResult } from '../types';

/** Card label for a tool call, e.g. `Read: src/a.ts` or `Terminal: npm test`. */
export function describeToolCall(name: string, input: Record<string, unknown>): string {
  const text = (key: string) => (typeof input[key] === 'string' ? (input[key] as string) : '');
  switch (name) {
    case 'Bash':
      return `Terminal: ${text('command').substring(0, 50)}`;
    case 'Read':
      return `Read: ${text('file_path')}`;
    case 'Write':
      return `Write: ${text('file_path')}`;
    case 'Edit':
      return `Edit: ${text('file_path')}`;
    case 'Delete':
      return `Delete: ${text('file_path')}`;
    case 'LS':
      return `List Dir: ${text('path') || '.'}`;
    case 'Grep':
      return `Grep: ${text('pattern').substring(0, 50)}`;
    case 'Glob':
      return `Glob: ${text('pattern') || '**/*'}`;
    default:
      return name;
  }
}

export function formatSessionResults(results: SerializedActionResult[]): string {
  const lines: string[] = ['[Action Results]'];
  const outputActions = /^(List Dir|Read|Terminal|Grep|Glob|File Search|Codebase Search|Shell):/i;

  for (const r of results) {
    if (r.rejected) {
      lines.push(`[REJECTED] ${r.action}: ${r.rejectionReason}`);
    } else if (r.success) {
      lines.push(`[SUCCESS] ${r.action}`);
      const hasOutput = r.output && r.output.trim() && r.output !== '(no output)';
      if (hasOutput) {
        lines.push(`  Output: ${r.output}`);
      } else if (outputActions.test(r.action)) {
        lines.push(`  Output: <no files or terminal output>`);
      }
    } else {
      lines.push(`[FAILED] ${r.action}: ${r.error}`);
      if (r.output && r.output.trim() && r.output !== '(no output)') {
        lines.push(`  Output: ${r.output}`);
      }
    }
  }
  lines.push('\nContinue with the next steps or finish if done.');
  return lines.join('\n');
}

export function generateNonce(): string {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
