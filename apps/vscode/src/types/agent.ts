export type { ApprovalMode } from '@deniai/flixa-core';

export interface SafetyCheckResult {
  verdict: 'SAFE' | 'UNSAFE';
  reason: string;
}
