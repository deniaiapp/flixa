export const REASONING_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];
export type ModelReasoningEfforts = readonly ReasoningEffort[] | false;

const REASONING_EFFORT_LABELS: Record<ReasoningEffort, string> = {
  low: 'Light',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra High',
  max: 'Max',
};

export function getAvailableReasoningEfforts(
  _modelId: string,
  modelEfforts?: readonly string[] | false,
): ReasoningEffort[] {
  if (modelEfforts === false) {
    return [];
  }
  if (Array.isArray(modelEfforts)) {
    return REASONING_EFFORTS.filter((effort) => modelEfforts.includes(effort));
  }
  return ['low', 'medium', 'high'];
}

export function getReasoningEffortLabel(effort: ReasoningEffort): string {
  return REASONING_EFFORT_LABELS[effort];
}

export function normalizeReasoningEfforts(value: unknown): ModelReasoningEfforts | undefined {
  if (value === false) {
    return false;
  }
  if (!Array.isArray(value)) {
    return undefined;
  }
  return REASONING_EFFORTS.filter((effort) => value.includes(effort));
}

export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return typeof value === 'string' && (REASONING_EFFORTS as readonly string[]).includes(value);
}
