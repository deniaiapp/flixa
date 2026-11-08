import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

export type PermissionDecision = "allow" | "deny" | "ask" | "none";

export interface PermissionRules {
  allow: string[];
  deny: string[];
  ask: string[];
}

export const TRUST_PROJECT_SETTINGS_ENV = "FLIXA_TRUST_PROJECT_SETTINGS";

const BASH_TOOL = "Bash";
const WEB_FETCH_TOOL = "WebFetch";

/** Tool name -> argument holding the path the rule globs are matched against. */
const PATH_ARG_TOOLS: Record<string, string> = {
  Read: "file_path",
  Write: "file_path",
  Edit: "file_path",
  Grep: "path",
  Glob: "path",
};

const RULE_KEYS = ["allow", "deny", "ask"] as const;
const SUB_COMMAND_SPLIT = /\|\||&&|;|\||&|\r?\n|\r/;
// Command substitution can hide a second command, so it disables prefix/exact allow rules.
const SUBSTITUTION_PATTERN = /\$\(|`|<\(|>\(/;
const DOMAIN_PREFIX = /^domain:/i;

/**
 * Loads and concatenates Claude Code style permission rules from user settings and
 * every directory from the filesystem root down to `workspaceRoot`. Missing or
 * invalid files are skipped silently; non-string entries are dropped.
 */
export function loadPermissionRules(workspaceRoot: string): PermissionRules {
  const rules: PermissionRules = { allow: [], deny: [], ask: [] };
  const home = homedir();
  const userFiles = [join(home, ".flixa", "settings.json"), join(home, ".claude", "settings.json")];
  const projectFiles: string[] = [];

  for (const directory of ancestorDirectories(workspaceRoot)) {
    projectFiles.push(
      join(directory, ".claude", "settings.json"),
      join(directory, ".flixa", "settings.json"),
      join(directory, ".claude", "settings.local.json"),
      join(directory, ".flixa", "settings.local.json"),
    );
  }

  // A cloned repository must not be able to pre-approve its own commands, so project
  // files can only tighten (deny/ask) unless the operator opts in to project allow rules.
  const trustProjectAllow = process.env[TRUST_PROJECT_SETTINGS_ENV] === "1";
  const seen = new Set<string>();
  const collect = (files: readonly string[], keys: readonly (typeof RULE_KEYS)[number][]): void => {
    for (const file of files) {
      const key = resolve(file);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      for (const name of keys) {
        rules[name].push(...readRuleList(file, name));
      }
    }
  };

  collect(userFiles, RULE_KEYS);
  collect(projectFiles, trustProjectAllow ? RULE_KEYS : ["deny", "ask"]);

  return rules;
}

/**
 * Resolves the most specific matching rule. Precedence is deny > ask > allow > none,
 * where "none" means no rule matched and the caller keeps its normal behaviour.
 */
export function evaluatePermission(
  rules: PermissionRules,
  toolName: string,
  args: Record<string, unknown>,
  workspaceRoot: string,
): { decision: PermissionDecision; rule?: string } {
  const deny = matchRules(rules.deny, toolName, args, workspaceRoot, "deny");
  if (deny) {
    return { decision: "deny", rule: deny };
  }

  const ask = matchRules(rules.ask, toolName, args, workspaceRoot, "ask");
  if (ask) {
    return { decision: "ask", rule: ask };
  }

  const allow = matchRules(rules.allow, toolName, args, workspaceRoot, "allow");
  if (allow) {
    return { decision: "allow", rule: allow };
  }

  return { decision: "none" };
}

interface ParsedRule {
  raw: string;
  tool: string;
  spec: string;
}

function matchRules(
  rules: readonly string[],
  toolName: string,
  args: Record<string, unknown>,
  workspaceRoot: string,
  kind: "allow" | "deny" | "ask",
): string | null {
  const parsed: ParsedRule[] = [];
  for (const raw of rules) {
    const rule = parseRule(raw);
    if (rule && rule.tool === toolName) {
      parsed.push(rule);
    }
  }
  if (parsed.length === 0) {
    return null;
  }

  if (toolName === BASH_TOOL) {
    return matchBashRules(parsed, args["command"], kind);
  }

  const argKey = PATH_ARG_TOOLS[toolName];
  for (const rule of parsed) {
    if (isCatchAll(rule)) {
      return rule.raw;
    }
    if (toolName === WEB_FETCH_TOOL) {
      if (webFetchMatches(rule.spec, args)) {
        return rule.raw;
      }
      continue;
    }
    // Specs for tools without a path/URL argument can never match.
    if (argKey && pathMatches(rule.spec, args[argKey], workspaceRoot, kind)) {
      return rule.raw;
    }
  }

  return null;
}

function parseRule(raw: string): ParsedRule | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }

  const open = trimmed.indexOf("(");
  if (open === -1 || !trimmed.endsWith(")")) {
    return { raw, tool: trimmed, spec: "" };
  }
  return { raw, tool: trimmed.slice(0, open).trim(), spec: trimmed.slice(open + 1, -1) };
}

function isCatchAll(rule: ParsedRule): boolean {
  return rule.spec === "" || rule.spec.trim() === "*";
}

/**
 * Bash rules are evaluated per sub-command: allow needs every sub-command covered,
 * while a single deny/ask sub-command is enough to match.
 */
function matchBashRules(
  rules: readonly ParsedRule[],
  command: unknown,
  kind: "allow" | "deny" | "ask",
): string | null {
  const bare = rules.find(isCatchAll);
  if (typeof command !== "string" || !command.trim()) {
    return bare ? bare.raw : null;
  }

  const subCommands = command
    .split(SUB_COMMAND_SPLIT)
    .map(collapseSpaces)
    .filter((sub) => sub.length > 0);
  if (subCommands.length === 0) {
    return bare ? bare.raw : null;
  }

  const guarded = SUBSTITUTION_PATTERN.test(command);
  const matches = (rule: ParsedRule, sub: string): boolean => {
    if (isCatchAll(rule)) {
      return true;
    }
    return kind === "allow" && guarded ? false : bashSpecMatches(rule.spec, sub);
  };

  if (kind === "allow") {
    const hits = subCommands.map((sub) => rules.find((rule) => matches(rule, sub)));
    if (hits.some((hit) => hit === undefined)) {
      return null;
    }
    return hits[0]?.raw ?? null;
  }

  const hit = rules.find((rule) => subCommands.some((sub) => matches(rule, sub)));
  return hit ? hit.raw : null;
}

function bashSpecMatches(spec: string, command: string): boolean {
  const wanted = collapseSpaces(spec);
  if (!wanted) {
    return false;
  }
  if (wanted.endsWith(":*")) {
    const prefix = collapseSpaces(wanted.slice(0, -2));
    // The trailing space keeps `npm run test` from matching `npm run testing`.
    return command === prefix || command.startsWith(`${prefix} `);
  }
  return command === wanted;
}

function webFetchMatches(spec: string, args: Record<string, unknown>): boolean {
  const target = spec.trim().replace(DOMAIN_PREFIX, "").trim().toLowerCase();
  if (!target) {
    return false;
  }
  const host = hostnameOf(args["url"] ?? args["domain"]);
  if (!host) {
    return false;
  }
  return host === target || host.endsWith(`.${target}`);
}

function hostnameOf(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }
  const raw = value.trim();
  for (const candidate of [raw, `https://${raw}`]) {
    try {
      return new URL(candidate).hostname.toLowerCase();
    } catch {
      // Try the next form; bare hosts need a scheme.
    }
  }
  return null;
}

function pathMatches(
  spec: string,
  value: unknown,
  workspaceRoot: string,
  kind: "allow" | "deny" | "ask",
): boolean {
  if (typeof value !== "string" || !value.trim()) {
    return false;
  }

  const relativePath = toWorkspaceRelative(value, workspaceRoot);
  if (relativePath !== null) {
    return globMatches(spec, relativePath);
  }

  // Paths outside the workspace are never allowed, but deny/ask may still target them.
  if (kind === "allow") {
    return false;
  }
  return globMatches(spec, toForwardSlashes(resolve(workspaceRoot, value)));
}

/** Returns the workspace-relative forward-slash path, or null when it escapes the workspace. */
function toWorkspaceRelative(value: string, workspaceRoot: string): string | null {
  const cleaned = toForwardSlashes(value.trim()).replace(/^\.\//, "");
  const root = resolve(workspaceRoot);
  const absolute = isAbsolute(cleaned) ? resolve(cleaned) : resolve(root, cleaned);
  const rel = toForwardSlashes(relative(root, absolute));
  if (!rel || rel === "." || rel === ".." || rel.startsWith("../") || isAbsolute(rel)) {
    return null;
  }
  return rel;
}

function globMatches(spec: string, candidate: string): boolean {
  const pattern = toForwardSlashes(spec.trim()).replace(/^\.\//, "");
  if (!pattern) {
    return false;
  }
  return globToRegExp(pattern).test(candidate);
}

const globCache = new Map<string, RegExp>();

/** Supports `**` (any depth, including none), `*` (within one segment) and `?`. */
function globToRegExp(pattern: string): RegExp {
  const cached = globCache.get(pattern);
  if (cached) {
    return cached;
  }

  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]!;
    if (char === "*") {
      if (pattern[index + 1] === "*") {
        while (pattern[index + 1] === "*") {
          index += 1;
        }
        if (pattern[index + 1] === "/") {
          index += 1;
          source += "(?:.*/)?";
        } else {
          source += ".*";
        }
      } else {
        source += "[^/]*";
      }
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  }

  // Windows and macOS file systems are case-insensitive by default, so a deny rule must be too.
  const caseInsensitive = process.platform === "win32" || process.platform === "darwin";
  const regex = new RegExp(`^${source}$`, caseInsensitive ? "i" : "");
  globCache.set(pattern, regex);
  return regex;
}

function ancestorDirectories(workspaceRoot: string): string[] {
  const chain: string[] = [];
  let current = resolve(workspaceRoot);
  while (true) {
    chain.push(current);
    const parent = dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  return chain.reverse();
}

function readRuleList(filePath: string, name: (typeof RULE_KEYS)[number]): string[] {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf-8");
  } catch {
    return [];
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) {
      return [];
    }
    const permissions = parsed["permissions"];
    if (!isRecord(permissions)) {
      return [];
    }
    const values = permissions[name];
    if (!Array.isArray(values)) {
      return [];
    }
    return values.filter((value): value is string => typeof value === "string");
  } catch {
    return [];
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function collapseSpaces(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function toForwardSlashes(value: string): string {
  return value.replace(/\\/g, "/");
}
