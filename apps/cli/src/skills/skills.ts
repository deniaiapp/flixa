import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, parse, resolve } from "node:path";

export interface Skill {
  name: string;
  description: string;
  body: string;
  dir: string;
  scope: "user" | "project";
}

const SKILL_DIR_NAMES = [join(".claude", "skills"), join(".flixa", "skills")] as const;
const SKILL_FILE_NAME = "SKILL.md";
const MAX_SKILL_FILE_BYTES = 64 * 1024;
const MAX_SKILLS = 100;
const MAX_SKILL_FILES = 50;
const MAX_SKILL_FILE_DEPTH = 3;
const MAX_SKILL_WALK_ENTRIES = 500;
const MAX_DESCRIPTION_LENGTH = 250;
const SKILL_NAME_PATTERN = /^[A-Za-z0-9][\w-]*$/;

/**
 * Loads Agent Skills from `.claude/skills` and `.flixa/skills`.
 * User-level skills load first, then project-level skills from the filesystem
 * root down to `workspaceRoot`, so nearer directories (and projects) win when
 * two skills share the same name (compared case-insensitively).
 */
export function loadSkills(workspaceRoot: string): Skill[] {
  const byName = new Map<string, Skill>();
  const seenDirs = new Set<string>();

  const collect = (directory: string, scope: Skill["scope"]): void => {
    const resolved = resolve(directory);
    if (seenDirs.has(resolved) || !isDirectory(resolved)) {
      return;
    }
    seenDirs.add(resolved);

    for (const skill of readSkillsDirectory(resolved, scope)) {
      byName.set(skill.name.toLowerCase(), skill);
    }
  };

  for (const dirName of SKILL_DIR_NAMES) {
    collect(join(homedir(), dirName), "user");
  }

  const ancestors: string[] = [];
  let current = resolve(workspaceRoot);
  while (true) {
    ancestors.push(current);
    const parent = dirname(current);
    if (parent === current || current === parse(current).root) {
      break;
    }
    current = parent;
  }
  for (const directory of ancestors.reverse()) {
    for (const dirName of SKILL_DIR_NAMES) {
      collect(join(directory, dirName), "project");
    }
  }

  return [...byName.values()]
    .sort((left, right) => left.name.localeCompare(right.name))
    .slice(0, MAX_SKILLS);
}

/** Finds a skill by name, compared case-insensitively. */
export function findSkill(skills: readonly Skill[], name: string): Skill | undefined {
  const target = name.trim().toLowerCase();
  return skills.find((skill) => skill.name.toLowerCase() === target);
}

/**
 * Returns the full instructions for a skill plus the supporting files that live
 * in its folder, so the agent knows what it can read on demand.
 */
export function readSkill(
  skills: readonly Skill[],
  name: string,
): { name: string; content: string; files: string[] } {
  const skill = findSkill(skills, name);
  if (!skill) {
    throw new Error(`Unknown skill: ${name}`);
  }

  return { name: skill.name, content: skill.body, files: listSkillFiles(skill.dir) };
}

/**
 * Renders the progressive-disclosure section of the system prompt: only names
 * and one-line descriptions, never the full skill bodies.
 */
export function formatSkillsForPrompt(skills: readonly Skill[]): string | undefined {
  if (skills.length === 0) {
    return undefined;
  }

  const lines = [
    "Available skills (call the Skill tool with a skill name to load its full instructions when the task matches):",
  ];
  for (const skill of skills) {
    lines.push(`- ${skill.name}: ${formatDescription(skill.description)}`);
  }

  return lines.join("\n");
}

function readSkillsDirectory(directory: string, scope: Skill["scope"]): Skill[] {
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }

  const skills: Skill[] = [];
  for (const entry of entries) {
    // Dirent.isDirectory() is false for symlinks, so linked folders are skipped.
    if (!entry.isDirectory()) {
      continue;
    }

    const skill = readSkillFolder(join(directory, entry.name), entry.name, scope);
    if (skill) {
      skills.push(skill);
    }
  }

  return skills;
}

function readSkillFolder(
  directory: string,
  folderName: string,
  scope: Skill["scope"],
): Skill | null {
  try {
    const filePath = join(directory, SKILL_FILE_NAME);
    const stats = statSync(filePath);
    if (!stats.isFile() || stats.size > MAX_SKILL_FILE_BYTES) {
      return null;
    }

    const { meta, body } = parseFrontmatter(readFileSync(filePath, "utf-8"));
    const name = meta["name"] || folderName;
    if (!SKILL_NAME_PATTERN.test(name)) {
      return null;
    }

    const description = meta["description"] || "";
    if (!description) {
      return null;
    }

    const trimmedBody = body.trim();
    if (!trimmedBody) {
      return null;
    }

    return { name, description, body: trimmedBody, dir: directory, scope };
  } catch {
    return null;
  }
}

function listSkillFiles(root: string): string[] {
  const files: string[] = [];
  // Counts every entry seen, so directory-only trees cannot make the walk unbounded.
  let visited = 0;

  const walk = (directory: string, prefix: string, depth: number): void => {
    if (visited >= MAX_SKILL_WALK_ENTRIES) {
      return;
    }

    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (visited >= MAX_SKILL_WALK_ENTRIES) {
        return;
      }
      visited += 1;

      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (depth < MAX_SKILL_FILE_DEPTH) {
          walk(join(directory, entry.name), relative, depth + 1);
        }
        continue;
      }

      // Dirent.isFile() is false for symlinks, so linked files are skipped.
      if (!entry.isFile()) {
        continue;
      }

      // The root SKILL.md is the skill definition itself, not a supporting file.
      if (depth === 0 && entry.name.toLowerCase() === SKILL_FILE_NAME.toLowerCase()) {
        continue;
      }

      files.push(relative);
    }
  };

  walk(root, "", 0);
  return files.sort((left, right) => left.localeCompare(right)).slice(0, MAX_SKILL_FILES);
}

function parseFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
  const text = raw.replace(/^﻿/, "");
  const match = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!match) {
    return { meta: {}, body: text };
  }

  const meta: Record<string, string> = {};
  for (const line of (match[1] ?? "").split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator <= 0) {
      continue;
    }
    const key = line.slice(0, separator).trim().toLowerCase();
    const value = line
      .slice(separator + 1)
      .trim()
      .replace(/^(["'])(.*)\1$/, "$2");
    if (key) {
      meta[key] = value;
    }
  }

  return { meta, body: text.slice(match[0].length) };
}

function formatDescription(description: string): string {
  const single = description.replace(/\s+/g, " ").trim();
  return single.length > MAX_DESCRIPTION_LENGTH
    ? `${single.slice(0, MAX_DESCRIPTION_LENGTH - 1)}…`
    : single;
}

function isDirectory(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isDirectory();
  } catch {
    return false;
  }
}
