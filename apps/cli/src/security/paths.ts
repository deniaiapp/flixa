import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const FLIXA_HOME_DIR = join(homedir(), ".flixa");
export const FLIXA_SESSIONS_DIR = join(FLIXA_HOME_DIR, "sessions");
export const FLIXA_CONFIG_PATH = join(FLIXA_HOME_DIR, "config.json");
export const FLIXA_CREDENTIALS_PATH = join(FLIXA_HOME_DIR, "credentials");

export function ensurePrivateDir(dirPath: string): void {
  mkdirSync(dirPath, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dirPath, 0o700);
  } catch {
    // Best effort on platforms that do not fully support POSIX permissions.
  }
}

export function ensurePrivateParent(filePath: string): void {
  const lastSlash = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
  const dirPath = lastSlash >= 0 ? filePath.slice(0, lastSlash) : FLIXA_HOME_DIR;
  ensurePrivateDir(dirPath);
}

export function enforcePrivateFile(filePath: string): void {
  if (!existsSync(filePath)) return;
  try {
    chmodSync(filePath, 0o600);
  } catch {
    // Best effort on platforms that do not fully support POSIX permissions.
  }
}
