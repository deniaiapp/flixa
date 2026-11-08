import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { ChatMessage } from "../flixa/api.ts";
import { FLIXA_SESSIONS_DIR, enforcePrivateFile, ensurePrivateDir } from "../security/paths.ts";

export interface StoredChatSession {
  id: string;
  cwd: string;
  provider?: string;
  model: string;
  system?: string;
  autoMode?: boolean;
  yoloMode?: boolean;
  planMode?: boolean;
  acceptEdits?: boolean;
  taskDisplayPrompt?: string;
  taskSourceUrl?: string;
  createdAt: string;
  updatedAt: string;
  history: ChatMessage[];
}

const SESSIONS_DIR = FLIXA_SESSIONS_DIR;

export function createSession(
  cwdValue: string,
  model: string,
  system?: string,
  modes?: {
    provider?: string;
    autoMode?: boolean;
    yoloMode?: boolean;
    planMode?: boolean;
    acceptEdits?: boolean;
  },
): StoredChatSession {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    cwd: resolve(cwdValue),
    provider: modes?.provider,
    model,
    system,
    autoMode: modes?.autoMode ?? false,
    yoloMode: modes?.yoloMode ?? false,
    planMode: modes?.planMode ?? false,
    acceptEdits: modes?.acceptEdits ?? false,
    createdAt: now,
    updatedAt: now,
    history: [],
  };
}

export function saveSession(session: StoredChatSession): void {
  ensureSessionsDir();
  const next = {
    ...session,
    cwd: resolve(session.cwd),
    updatedAt: new Date().toISOString(),
  };
  const sessionPath = getSessionPath(next);
  writeFileSync(sessionPath, JSON.stringify(next, null, 2) + "\n", {
    encoding: "utf-8",
    mode: 0o600,
  });
  enforcePrivateFile(sessionPath);
}

export function loadSessionById(sessionId: string): StoredChatSession | null {
  const sessionPath = findSessionPathById(sessionId);
  if (!sessionPath) {
    return null;
  }

  try {
    const raw = readFileSync(sessionPath, "utf-8");
    const parsed = JSON.parse(raw) as StoredChatSession;
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    return {
      ...parsed,
      cwd: resolve(parsed.cwd),
      autoMode: parsed.autoMode ?? false,
      yoloMode: parsed.yoloMode ?? false,
      planMode: parsed.planMode ?? false,
      acceptEdits: parsed.acceptEdits ?? false,
      history: Array.isArray(parsed.history) ? parsed.history : [],
    };
  } catch {
    return null;
  }
}

export function loadLatestSessionForCwd(cwdValue: string): StoredChatSession | null {
  const target = resolve(cwdValue);
  ensureSessionsDir();
  let latest: StoredChatSession | null = null;
  for (const sessionPath of listSessionFilePaths(SESSIONS_DIR)) {
    const session = loadSessionFromPath(sessionPath);
    if (session?.cwd === target && (!latest || session.updatedAt > latest.updatedAt)) {
      latest = session;
    }
  }
  return latest;
}

export function listRecentSessions(limit = 20): StoredChatSession[] {
  ensureSessionsDir();
  const sessions = listSessionFilePaths(SESSIONS_DIR)
    .map((sessionPath) => loadSessionFromPath(sessionPath))
    .filter((session): session is StoredChatSession => session !== null)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  return sessions.slice(0, limit);
}

export function formatRecentSessionLabel(session: StoredChatSession): string {
  return [
    session.id.slice(0, 8),
    session.cwd,
    formatRecentSessionTimestamp(session.updatedAt),
  ].join("  ");
}

function ensureSessionsDir(): void {
  mkdirSync(SESSIONS_DIR, { recursive: true, mode: 0o700 });
  ensurePrivateDir(SESSIONS_DIR);
}

function getSessionPath(session: Pick<StoredChatSession, "id" | "createdAt">): string {
  const { year, month, dayTime } = getSessionPathParts(session.createdAt);
  const sessionDir = join(SESSIONS_DIR, year, month);
  mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
  ensurePrivateDir(sessionDir);
  return join(sessionDir, `${dayTime}-${session.id}.json`);
}

function getSessionPathParts(timestamp: string): {
  year: string;
  month: string;
  dayTime: string;
} {
  const date = new Date(timestamp);
  const year = String(date.getFullYear());
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const time = [date.getHours(), date.getMinutes()]
    .map((value) => String(value).padStart(2, "0"))
    .join("-");

  return { year, month, dayTime: `${day}-${time}` };
}

const SESSION_ID_PREFIX_LENGTH = 8;

function findSessionPathById(sessionId: string): string | null {
  const wanted = sessionId.trim();
  if (!wanted) {
    return null;
  }

  // The directory may not exist yet on a fresh machine.
  ensureSessionsDir();
  const sessionPaths = listSessionFilePaths(SESSIONS_DIR);
  const fileNameOf = (sessionPath: string): string => sessionPath.split(/[/\\]/).pop() ?? "";

  for (const sessionPath of sessionPaths) {
    const fileName = fileNameOf(sessionPath);
    if (fileName === `${wanted}.json` || fileName.endsWith(`-${wanted}.json`)) {
      return sessionPath;
    }
  }

  // The session picker only shows the first 8 characters, so accept a unique prefix of that size.
  if (wanted.length >= SESSION_ID_PREFIX_LENGTH) {
    const lowered = wanted.toLowerCase();
    const matches = sessionPaths.filter((sessionPath) => {
      const idPart = fileNameOf(sessionPath)
        .replace(/\.json$/, "")
        .split("-")
        .slice(-5)
        .join("-");
      return idPart.toLowerCase().startsWith(lowered);
    });
    if (matches.length === 1) {
      return matches[0] ?? null;
    }
  }
  return null;
}

function listSessionFilePaths(dirPath: string): string[] {
  return readdirSync(dirPath).flatMap((entry) => {
    const entryPath = join(dirPath, entry);
    const stats = statSync(entryPath);
    if (stats.isDirectory()) {
      return listSessionFilePaths(entryPath);
    }
    return entry.endsWith(".json") ? [entryPath] : [];
  });
}

function loadSessionFromPath(sessionPath: string): StoredChatSession | null {
  try {
    const raw = readFileSync(sessionPath, "utf-8");
    const parsed = JSON.parse(raw) as StoredChatSession;
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    return {
      ...parsed,
      cwd: resolve(parsed.cwd),
      autoMode: parsed.autoMode ?? false,
      yoloMode: parsed.yoloMode ?? false,
      planMode: parsed.planMode ?? false,
      acceptEdits: parsed.acceptEdits ?? false,
      history: Array.isArray(parsed.history) ? parsed.history : [],
    };
  } catch {
    return null;
  }
}

function formatRecentSessionTimestamp(timestamp: string): string {
  return timestamp.replace("T", " ").slice(0, 16);
}
