import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { isReasoningEffort, type ReasoningEffort } from './reasoning.js';

export type { ReasoningEffort } from './reasoning.js';

export const FLIXA_VERSION = process.env.FLIXA_VERSION || '0.8.2';
export const DEFAULT_MODEL = process.env.FLIXA_MODEL || 'openai/gpt-5.5';
export const DEFAULT_REASONING_EFFORT = 'medium';
export const DEFAULT_APPROVAL_MODE = 'AUTO_APPROVE';
export const DEFAULT_COMPACT_TOKEN_THRESHOLD = 200_000;
export const DEFAULT_MAX_AGENT_ITERATIONS = 100;

export type ApprovalMode =
  | 'ALL_APPROVE'
  | 'AUTO_APPROVE'
  | 'SAFE_APPROVE'
  | 'MANUAL_APPROVE';

export interface FlixaConfig {
  apiBaseUrl: string;
  deniAiBaseUrl: string;
  model: string;
  reasoningEffort?: ReasoningEffort;
  approvalMode: ApprovalMode;
  compactTokenThreshold: number;
  maxAgentIterations: number;
}

let loggedOut = false;
let loadedApiKey: string | null | undefined;

function getConfigDirectory(): string {
  if (process.platform === 'win32' && process.env.APPDATA) {
    return path.join(process.env.APPDATA, 'Flixa');
  }

  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Flixa');
  }

  return path.join(
    process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'),
    'flixa',
  );
}

export function getApiKeyPath(): string {
  return path.join(getConfigDirectory(), 'api-key');
}

export function getSessionStorePath(): string {
  return path.join(getConfigDirectory(), 'sessions.json');
}

export async function getApiKey(): Promise<string | undefined> {
  if (loggedOut) {
    return undefined;
  }

  const environmentKey = process.env.FLIXA_API_KEY || process.env.DENI_API_KEY;
  if (environmentKey) {
    return environmentKey;
  }

  if (loadedApiKey !== undefined) {
    return loadedApiKey || undefined;
  }

  try {
    const key = (await readFile(getApiKeyPath(), 'utf8')).trim();
    loadedApiKey = key || null;
  } catch {
    loadedApiKey = null;
  }

  return loadedApiKey || undefined;
}

export async function setApiKey(apiKey: string | undefined): Promise<void> {
  loggedOut = !apiKey;
  loadedApiKey = apiKey || null;

  if (!apiKey) {
    try {
      await unlink(getApiKeyPath());
    } catch {
      return;
    }
    return;
  }

  await mkdir(getConfigDirectory(), { recursive: true });
  await writeFile(getApiKeyPath(), `${apiKey}\n`, { encoding: 'utf8', mode: 0o600 });
}

export function getConfig(): FlixaConfig {
  const requestedReasoning = process.env.FLIXA_REASONING_EFFORT;
  const reasoningEffort: ReasoningEffort = isReasoningEffort(requestedReasoning)
    ? requestedReasoning
    : DEFAULT_REASONING_EFFORT;

  const requestedApproval = process.env.FLIXA_APPROVAL_MODE?.toUpperCase();
  const approvalMode: ApprovalMode =
    requestedApproval === 'ALL_APPROVE' ||
    requestedApproval === 'AUTO_APPROVE' ||
    requestedApproval === 'SAFE_APPROVE' ||
    requestedApproval === 'MANUAL_APPROVE'
      ? requestedApproval
      : DEFAULT_APPROVAL_MODE;

  const compactTokenThreshold = parseNonNegativeInteger(
    process.env.FLIXA_COMPACT_TOKEN_THRESHOLD,
    DEFAULT_COMPACT_TOKEN_THRESHOLD,
  );
  const maxAgentIterations = parsePositiveInteger(
    process.env.FLIXA_MAX_AGENT_ITERATIONS,
    DEFAULT_MAX_AGENT_ITERATIONS,
  );

  return {
    apiBaseUrl: 'https://flixa-api.deniai.app',
    deniAiBaseUrl: 'https://deniai.app',
    model: process.env.FLIXA_MODEL || DEFAULT_MODEL,
    reasoningEffort,
    approvalMode,
    compactTokenThreshold,
    maxAgentIterations,
  };
}

export function openUrl(url: string): void {
  let command: string;
  let args: string[];

  if (process.platform === 'win32') {
    command = 'cmd.exe';
    args = ['/c', 'start', '', url];
  } else if (process.platform === 'darwin') {
    command = 'open';
    args = [url];
  } else {
    command = 'xdg-open';
    args = [url];
  }

  const child = spawn(command, args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
}

function parseNonNegativeInteger(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = parseNonNegativeInteger(value, fallback);
  return parsed > 0 ? parsed : fallback;
}
