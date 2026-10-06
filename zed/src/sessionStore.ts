import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type * as acp from '@agentclientprotocol/sdk';
import {
  getSessionStorePath,
  type ApprovalMode,
  type ReasoningEffort,
} from './config.js';
import { isReasoningEffort } from './reasoning.js';

export interface PersistedSession {
  cwd: string;
  additionalDirectories: string[];
  input: unknown[];
  model: string;
  reasoningEffort?: ReasoningEffort;
  approvalMode: ApprovalMode;
  modeId: 'agent' | 'chat';
  promptCount: number;
  history: acp.SessionNotification[];
  updatedAt: string;
}

interface SessionStoreFile {
  version: 1;
  sessions: Record<string, PersistedSession>;
}

export class SessionStore {
  private readonly sessions = new Map<string, PersistedSession>();
  private readonly ready: Promise<void>;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string = getSessionStorePath()) {
    this.ready = this.load();
  }

  async get(sessionId: string): Promise<PersistedSession | undefined> {
    await this.ready;
    return this.sessions.get(sessionId);
  }

  async list(): Promise<Array<{ sessionId: string; session: PersistedSession }>> {
    await this.ready;
    return Array.from(this.sessions.entries()).map(([sessionId, session]) => ({
      sessionId,
      session,
    }));
  }

  async save(sessionId: string, session: PersistedSession): Promise<void> {
    await this.ready;
    this.sessions.set(sessionId, session);
    await this.flush();
  }

  private async load(): Promise<void> {
    try {
      const raw = JSON.parse(await readFile(this.filePath, 'utf8')) as unknown;
      if (!isRecord(raw) || raw.version !== 1 || !isRecord(raw.sessions)) {
        return;
      }
      for (const [sessionId, value] of Object.entries(raw.sessions)) {
        const session = parsePersistedSession(value);
        if (session) {
          this.sessions.set(sessionId, session);
        }
      }
    } catch {
      return;
    }
  }

  private async flush(): Promise<void> {
    const snapshot: SessionStoreFile = {
      version: 1,
      sessions: Object.fromEntries(this.sessions),
    };
    const serialized = JSON.stringify(snapshot, null, 2);
    const temporaryPath = `${this.filePath}.tmp`;
    this.writeQueue = this.writeQueue.then(async () => {
      await mkdir(path.dirname(this.filePath), { recursive: true });
      await writeFile(temporaryPath, serialized, { encoding: 'utf8', mode: 0o600 });
      await rename(temporaryPath, this.filePath);
    });
    await this.writeQueue;
  }
}

function parsePersistedSession(value: unknown): PersistedSession | null {
  if (!isRecord(value)) {
    return null;
  }
  if (
    typeof value.cwd !== 'string' ||
    typeof value.model !== 'string' ||
    (value.reasoningEffort !== undefined && !isReasoningEffort(value.reasoningEffort)) ||
    !isApprovalMode(value.approvalMode) ||
    !isModeId(value.modeId) ||
    typeof value.promptCount !== 'number' ||
    !Array.isArray(value.input) ||
    !Array.isArray(value.history)
  ) {
    return null;
  }
  return {
    cwd: value.cwd,
    additionalDirectories: Array.isArray(value.additionalDirectories)
      ? value.additionalDirectories.filter((item): item is string => typeof item === 'string')
      : [],
    input: value.input,
    model: value.model,
    reasoningEffort: value.reasoningEffort,
    approvalMode: value.approvalMode,
    modeId: value.modeId,
    promptCount: Math.max(0, Math.floor(value.promptCount)),
    history: value.history.filter(isSessionNotification),
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : new Date(0).toISOString(),
  };
}

function isSessionNotification(value: unknown): value is acp.SessionNotification {
  return isRecord(value) && typeof value.sessionId === 'string' && isRecord(value.update);
}

function isApprovalMode(value: unknown): value is ApprovalMode {
  return value === 'ALL_APPROVE' || value === 'AUTO_APPROVE' || value === 'SAFE_APPROVE' || value === 'MANUAL_APPROVE';
}

function isModeId(value: unknown): value is 'agent' | 'chat' {
  return value === 'agent' || value === 'chat';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object';
}
