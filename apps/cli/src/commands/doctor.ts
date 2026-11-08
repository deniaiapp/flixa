import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import chalk from "chalk";
import type { Command } from "commander";
import { DEFAULT_FLIXA_BASE_URL } from "../flixa/api.ts";
import { loadInstructionFiles } from "../instructions/files.ts";
import { resolveProviderContext } from "../providers/runtime.ts";
import { FLIXA_SESSIONS_DIR } from "../security/paths.ts";
import { CLI_VERSION } from "../version.ts";

export type DoctorStatus = "ok" | "warn" | "fail";

export interface DoctorCheck {
  name: string;
  status: DoctorStatus;
  detail: string;
}

export interface DoctorOptions {
  cwd?: string;
  offline?: boolean;
}

const require = createRequire(import.meta.url);

const PROCESS_TIMEOUT_MS = 5_000;
const NETWORK_TIMEOUT_MS = 5_000;

type CheckRunner = () => DoctorCheck | Promise<DoctorCheck>;

export async function runDoctor(options: DoctorOptions = {}): Promise<DoctorCheck[]> {
  const cwd = resolve(options.cwd ?? process.cwd());

  return [
    await runCheck("Flixa CLI", () => checkFlixaCli()),
    await runCheck("Runtime", () => checkRuntime()),
    await runCheck("Git", () => checkGit()),
    await runCheck("ripgrep", () => checkRipgrep()),
    await runCheck("Shell", () => checkShell()),
    await runCheck("Credentials", () => checkCredentials()),
    await runCheck("Sessions directory", () => checkSessionsDirectory()),
    await runCheck("Instruction files", () => checkInstructionFiles(cwd)),
    await runCheck("Network", () => checkNetwork(options.offline === true)),
  ];
}

export function formatDoctorReport(checks: readonly DoctorCheck[]): string {
  const lines = checks.map((check) => {
    const label = check.status === "fail" ? "FAIL" : check.status;
    return `[${label}] ${check.name}: ${check.detail}`;
  });

  const ok = checks.filter((check) => check.status === "ok").length;
  const warn = checks.filter((check) => check.status === "warn").length;
  const fail = checks.filter((check) => check.status === "fail").length;
  lines.push(`${ok} ok, ${warn} warning${warn === 1 ? "" : "s"}, ${fail} failed`);

  return lines.join("\n");
}

export function registerDoctorCommand(program: Command): void {
  program
    .command("doctor")
    .description("Diagnose your Flixa CLI environment and configuration")
    .option("--offline", "Skip the network connectivity check")
    .action(async (options: { offline?: boolean }) => {
      const checks = await runDoctor({ offline: options.offline === true });

      for (const check of checks) {
        console.log(`${colorizeStatus(check.status)} ${check.name}: ${check.detail}`);
      }

      const failed = checks.some((check) => check.status === "fail");
      console.log(chalk.dim(summaryLine(checks)));
      if (failed) {
        process.exitCode = 1;
      }
    });
}

async function runCheck(name: string, runner: CheckRunner): Promise<DoctorCheck> {
  try {
    return await runner();
  } catch (error) {
    return {
      name,
      status: "fail",
      detail: `Check failed: ${describeError(error)}`,
    };
  }
}

function checkFlixaCli(): DoctorCheck {
  return {
    name: "Flixa CLI",
    status: "ok",
    detail: CLI_VERSION,
  };
}

function checkRuntime(): DoctorCheck {
  const nodeVersion = process.version;
  const major = Number.parseInt(nodeVersion.replace(/^v/, "").split(".")[0] ?? "", 10);
  if (Number.isFinite(major) && major < 20) {
    return {
      name: "Runtime",
      status: "warn",
      detail: `Node ${nodeVersion} (Node 20 or newer is recommended)`,
    };
  }

  return { name: "Runtime", status: "ok", detail: `Node ${nodeVersion}` };
}

function checkGit(): DoctorCheck {
  try {
    const output = runCommand("git", ["--version"]);
    return { name: "Git", status: "ok", detail: output || "git available" };
  } catch {
    return {
      name: "Git",
      status: "warn",
      detail: "git not found on PATH",
    };
  }
}

function checkRipgrep(): DoctorCheck {
  const bundled = resolveBundledRipgrep();
  let bundledIssue: string;

  if (bundled) {
    try {
      const output = runCommand(bundled, ["--version"]);
      return {
        name: "ripgrep",
        status: "ok",
        detail: `${firstLine(output) || "available"} (bundled)`,
      };
    } catch (error) {
      bundledIssue = `bundled binary not runnable (${describeError(error)})`;
    }
  } else {
    bundledIssue = "bundled binary missing";
  }

  try {
    const output = runCommand("rg", ["--version"]);
    return {
      name: "ripgrep",
      status: "ok",
      detail: `${firstLine(output) || "available"} (PATH)`,
    };
  } catch {
    return {
      name: "ripgrep",
      status: "warn",
      detail: `ripgrep unavailable: ${bundledIssue}; no \`rg\` on PATH`,
    };
  }
}

function checkShell(): DoctorCheck {
  if (process.platform === "win32") {
    for (const candidate of ["pwsh", "powershell"]) {
      const result = spawnSync(
        candidate,
        ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.Major"],
        {
          stdio: ["ignore", "pipe", "ignore"],
          encoding: "utf-8",
          timeout: PROCESS_TIMEOUT_MS,
        },
      );
      if (result.status === 0) {
        const version = firstLine(String(result.stdout ?? ""));
        return {
          name: "Shell",
          status: "ok",
          detail: version ? `${candidate} (PowerShell ${version})` : candidate,
        };
      }
    }

    return {
      name: "Shell",
      status: "fail",
      detail: "No PowerShell found (expected `pwsh` or `powershell` on PATH)",
    };
  }

  const shell = process.env.SHELL?.trim() || "bash";
  const result = spawnSync(shell, ["-lc", "exit 0"], {
    stdio: ["ignore", "ignore", "ignore"],
    encoding: "utf-8",
    timeout: PROCESS_TIMEOUT_MS,
  });
  if (result.status === 0) {
    return { name: "Shell", status: "ok", detail: shell };
  }

  return {
    name: "Shell",
    status: "fail",
    detail: `Shell not usable: ${shell}`,
  };
}

function checkCredentials(): DoctorCheck {
  const context = resolveProviderContext();
  if (context.apiKey) {
    return {
      name: "Credentials",
      status: "ok",
      detail: `${context.displayName} API key found (${context.provider})`,
    };
  }

  return {
    name: "Credentials",
    status: "warn",
    detail: `No API key for ${context.displayName}. Run \`flixa login\``,
  };
}

function checkSessionsDirectory(): DoctorCheck {
  try {
    mkdirSync(FLIXA_SESSIONS_DIR, { recursive: true, mode: 0o700 });
  } catch {
    // The probe write below reports the actionable failure.
  }

  const probePath = join(
    FLIXA_SESSIONS_DIR,
    `.doctor-probe-${process.pid}-${Date.now().toString(36)}`,
  );

  try {
    writeFileSync(probePath, "flixa doctor probe\n", { encoding: "utf-8" });
    rmSync(probePath, { force: true });
    return {
      name: "Sessions directory",
      status: "ok",
      detail: FLIXA_SESSIONS_DIR,
    };
  } catch (error) {
    try {
      rmSync(probePath, { force: true });
    } catch {
      // Best effort cleanup.
    }
    return {
      name: "Sessions directory",
      status: "fail",
      detail: `Not writable (${FLIXA_SESSIONS_DIR}): ${describeError(error)}`,
    };
  }
}

function checkInstructionFiles(cwd: string): DoctorCheck {
  // Sessions also read instruction files from parent directories, so the check must as well.
  const found = loadInstructionFiles(cwd).map((file) => {
    const relativePath = relative(cwd, file.path);
    return relativePath && !relativePath.startsWith("..") && !isAbsolute(relativePath)
      ? relativePath
      : file.path;
  });
  return {
    name: "Instruction files",
    status: "ok",
    detail: found.length > 0 ? found.join(", ") : "none found",
  };
}

async function checkNetwork(offline: boolean): Promise<DoctorCheck> {
  if (offline) {
    return { name: "Network", status: "ok", detail: "skipped (--offline)" };
  }

  let origin: string;
  try {
    origin = new URL(DEFAULT_FLIXA_BASE_URL).origin;
  } catch (error) {
    return {
      name: "Network",
      status: "warn",
      detail: `Invalid base URL: ${describeError(error)}`,
    };
  }

  let lastError: unknown;
  for (const method of ["HEAD", "GET"] as const) {
    try {
      const response = await fetch(origin, {
        method,
        signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS),
        headers: { Accept: "*/*" },
      });
      return {
        name: "Network",
        status: "ok",
        detail: `${origin} reachable (HTTP ${response.status})`,
      };
    } catch (error) {
      lastError = error;
    }
  }

  return {
    name: "Network",
    status: "warn",
    detail: `Unreachable (${origin}): ${describeError(lastError)}`,
  };
}

function resolveBundledRipgrep(): string | null {
  try {
    const packageJsonPath = require.resolve("@vscode/ripgrep/package.json");
    const executable = join(
      dirname(packageJsonPath),
      "bin",
      process.platform === "win32" ? "rg.exe" : "rg",
    );
    return existsSync(executable) ? executable : null;
  } catch {
    return null;
  }
}

function runCommand(executable: string, args: string[]): string {
  return execFileSync(executable, args, {
    encoding: "utf-8",
    timeout: PROCESS_TIMEOUT_MS,
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

function firstLine(value: string): string {
  return value.split(/\r?\n/, 1)[0]?.trim() ?? "";
}

function colorizeStatus(status: DoctorStatus): string {
  const marker = status === "fail" ? "[FAIL]" : `[${status}]`;
  switch (status) {
    case "ok":
      return chalk.green(marker);
    case "warn":
      return chalk.yellow(marker);
    case "fail":
      return chalk.red(marker);
  }
}

function summaryLine(checks: readonly DoctorCheck[]): string {
  const ok = checks.filter((check) => check.status === "ok").length;
  const warn = checks.filter((check) => check.status === "warn").length;
  const fail = checks.filter((check) => check.status === "fail").length;
  return `${ok} ok, ${warn} warning${warn === 1 ? "" : "s"}, ${fail} failed`;
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message || error.name;
  }
  return String(error);
}
