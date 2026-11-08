import { spawnSync } from "node:child_process";

export interface ElevationInfo {
  /** Human-readable description, e.g. "root" or "an Administrator". */
  label: string;
  viaSudo: boolean;
}

/** Detect a root / sudo (POSIX) or elevated Administrator (Windows) session. */
export function detectElevation(): ElevationInfo | null {
  if (process.platform === "win32") {
    // `fltmc` succeeds only from an elevated token and ships with Windows.
    const result = spawnSync("fltmc", [], { stdio: "ignore", windowsHide: true, timeout: 3_000 });
    return !result.error && result.status === 0
      ? { label: "an elevated Administrator", viaSudo: false }
      : null;
  }

  if (typeof process.getuid !== "function" || process.getuid() !== 0) {
    return null;
  }

  const viaSudo = Boolean(process.env.SUDO_USER || process.env.SUDO_UID);
  return { label: viaSudo ? "root (via sudo)" : "root", viaSudo };
}

/** Print a warning to stderr when the CLI runs with elevated privileges. */
export function warnIfElevated(): void {
  if (process.env.FLIXA_SUPPRESS_ELEVATION_WARNING === "1") {
    return;
  }

  const elevation = detectElevation();
  if (!elevation) {
    return;
  }

  const yellow = process.stderr.isTTY ? (text: string): string => `\x1b[33m${text}\x1b[0m` : String;
  process.stderr.write(
    yellow(
      `⚠ Flixa is running as ${elevation.label}. ` +
        "The agent can run shell commands and edit files with full system privileges, " +
        "and credentials are stored for the elevated account. " +
        "Run it as a regular user unless you really need this " +
        "(set FLIXA_SUPPRESS_ELEVATION_WARNING=1 to hide this warning).\n",
    ),
  );
}
