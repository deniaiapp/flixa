import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

// A turn keeps one snapshot per touched file, so the history is capped to keep
// memory bounded. Each snapshot is at most MAX_SNAPSHOT_BYTES in size.
const MAX_TURNS = 20;
const MAX_SNAPSHOT_BYTES = 1_048_576;
const UNKNOWN_TURN_LABEL = "(unknown)";

export interface TurnSummary {
  index: number;
  label: string;
  files: string[];
}

interface RewindResult {
  restored: string[];
  deleted: string[];
  skipped: string[];
  turnsRewound: number;
}

type FileSnapshot =
  | { kind: "missing" }
  | { kind: "content"; bytes: Buffer }
  | { kind: "unavailable" };

interface Turn {
  label: string;
  snapshots: Map<string, FileSnapshot>;
}

/**
 * In-memory snapshots of agent file edits, grouped by conversation turn.
 *
 * The caller opens a turn with beginTurn(), calls recordBeforeWrite() before
 * every Write/Edit tool run, and can later rewind() to put the recorded files
 * back the way they were. Snapshots use raw Buffers so binary and CRLF content
 * round-trips byte for byte.
 */
export class CheckpointStore {
  private readonly workspaceRoot: string;
  private readonly turns: Turn[] = [];
  private current: Turn | null = null;

  constructor(workspaceRoot: string) {
    this.workspaceRoot = resolve(workspaceRoot);
  }

  beginTurn(label: string): void {
    this.finalizeCurrentTurn();
    this.current = {
      label: label || UNKNOWN_TURN_LABEL,
      snapshots: new Map<string, FileSnapshot>(),
    };
  }

  recordBeforeWrite(absolutePath: string): void {
    const relativePath = this.toWorkspaceRelative(absolutePath);
    if (relativePath === null || isGitInternal(relativePath)) {
      return;
    }

    const turn = this.ensureTurn();
    if (turn.snapshots.has(relativePath)) {
      return;
    }

    turn.snapshots.set(relativePath, this.snapshotFile(relativePath));
  }

  /** Only turns that touched at least one file, oldest first. */
  listTurns(): TurnSummary[] {
    return this.allTurns().map((turn, index) => ({
      index,
      label: turn.label,
      files: [...turn.snapshots.keys()],
    }));
  }

  rewind(steps = 1): RewindResult {
    const restored: string[] = [];
    const deleted: string[] = [];
    const skipped: string[] = [];

    const available = this.allTurns();
    if (available.length === 0) {
      return { restored, deleted, skipped, turnsRewound: 0 };
    }

    const requested = Number.isFinite(steps) ? Math.floor(steps) : 1;
    const count = Math.min(Math.max(1, requested), available.length);
    const target = available.slice(available.length - count);

    // Walk newest first and let older turns overwrite the decision, so the
    // oldest snapshot recorded for a file is the one that wins.
    const decisions = new Map<string, FileSnapshot>();
    for (const turn of [...target].reverse()) {
      for (const [relativePath, snapshot] of turn.snapshots) {
        decisions.set(relativePath, snapshot);
      }
    }

    for (const [relativePath, snapshot] of decisions) {
      this.applySnapshot(relativePath, snapshot, restored, deleted, skipped);
    }

    const hadCurrent = this.current !== null && this.current.snapshots.size > 0;
    const storedToRemove = hadCurrent ? count - 1 : count;
    if (storedToRemove > 0) {
      this.turns.splice(this.turns.length - storedToRemove, storedToRemove);
    }
    if (hadCurrent) {
      this.current = null;
    }

    return { restored, deleted, skipped, turnsRewound: count };
  }

  clear(): void {
    this.turns.length = 0;
    this.current = null;
  }

  private ensureTurn(): Turn {
    if (!this.current) {
      this.current = {
        label: UNKNOWN_TURN_LABEL,
        snapshots: new Map<string, FileSnapshot>(),
      };
    }

    return this.current;
  }

  private finalizeCurrentTurn(): void {
    const turn = this.current;
    this.current = null;
    if (!turn || turn.snapshots.size === 0) {
      return;
    }

    this.turns.push(turn);
    while (this.turns.length > MAX_TURNS) {
      this.turns.shift();
    }
  }

  private allTurns(): Turn[] {
    const turns = [...this.turns];
    if (this.current && this.current.snapshots.size > 0) {
      turns.push(this.current);
    }

    return turns;
  }

  private snapshotFile(relativePath: string): FileSnapshot {
    const absolutePath = resolve(this.workspaceRoot, relativePath);
    try {
      const stats = lstatSync(absolutePath);
      if (!stats.isFile() || stats.size > MAX_SNAPSHOT_BYTES) {
        return { kind: "unavailable" };
      }

      const bytes = readFileSync(absolutePath);
      if (bytes.length > MAX_SNAPSHOT_BYTES) {
        return { kind: "unavailable" };
      }

      return { kind: "content", bytes };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { kind: "missing" };
      }
      return { kind: "unavailable" };
    }
  }

  private applySnapshot(
    relativePath: string,
    snapshot: FileSnapshot,
    restored: string[],
    deleted: string[],
    skipped: string[],
  ): void {
    const absolutePath = resolve(this.workspaceRoot, relativePath);

    // The lexical check in toWorkspaceRelative cannot see links, so confirm the real
    // location is still inside the workspace before touching anything.
    if (snapshot.kind === "unavailable" || !this.isRealPathInsideWorkspace(absolutePath)) {
      skipped.push(relativePath);
      return;
    }

    try {
      if (snapshot.kind === "missing") {
        if (existsSync(absolutePath)) {
          unlinkSync(absolutePath);
        }
        deleted.push(relativePath);
        return;
      }

      mkdirSync(dirname(absolutePath), { recursive: true });
      writeFileSync(absolutePath, snapshot.bytes);
      restored.push(relativePath);
    } catch {
      skipped.push(relativePath);
    }
  }

  private isRealPathInsideWorkspace(absolutePath: string): boolean {
    try {
      const realRoot = realpathSync(this.workspaceRoot);
      let probe = absolutePath;
      // Walk up to the nearest existing entry; a missing file inherits its parent's location.
      while (!existsSyncOrLink(probe)) {
        const parent = dirname(probe);
        if (parent === probe) {
          return false;
        }
        probe = parent;
      }

      const relativeToRoot = relative(realRoot, realpathSync(probe));
      return (
        !isAbsolute(relativeToRoot) &&
        relativeToRoot !== ".." &&
        !relativeToRoot.startsWith(`..${sep}`)
      );
    } catch {
      return false;
    }
  }

  private toWorkspaceRelative(absolutePath: string): string | null {
    if (typeof absolutePath !== "string" || absolutePath.length === 0) {
      return null;
    }

    const absolute = resolve(this.workspaceRoot, absolutePath);
    const relativePath = relative(this.workspaceRoot, absolute);
    if (
      !relativePath ||
      isAbsolute(relativePath) ||
      relativePath === ".." ||
      relativePath.startsWith(`..${sep}`)
    ) {
      return null;
    }

    return toForwardSlashes(relativePath);
  }
}

// Hooks and config under .git run code on later git commands, so checkpointing
// them would let a rewind silently restore executable git internals.
function isGitInternal(relativePath: string): boolean {
  return relativePath.split("/").some((segment) => segment.toLowerCase() === ".git");
}

// existsSync follows links, so a dangling link would look missing; lstat sees it.
function existsSyncOrLink(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function toForwardSlashes(pathValue: string): string {
  return pathValue.split(sep).join("/");
}
