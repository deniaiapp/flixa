import type { AgentTool, FileChange, ToolContext } from "../types";
import {
  countOccurrences,
  getOptionalInteger,
  getRequiredString,
  MAX_READ_CHARS,
  toJson,
  truncate,
  utf8ByteLength,
} from "../util";

const MAX_LIST_ENTRIES = 500;

function fileTitle(verb: string, fallback: string) {
  return (input: Record<string, unknown>): string => {
    const target = input["file_path"] ?? input["path"];
    return `${verb} ${typeof target === "string" && target ? target : fallback}`;
  };
}

function assertEditsAllowed(context: ToolContext, toolName: string): void {
  if (context.allowFileEdits === false) {
    throw new Error(`${toolName} is disabled until accept edits or auto mode is enabled.`);
  }
}

function assertNoNullBytes(value: string, field: string): void {
  if (value.includes("\0")) {
    throw new Error(`${field} contains null bytes.`);
  }
}

async function readExisting(context: ToolContext, path: string): Promise<string | null> {
  const stat = await context.host.stat(path);
  if (!stat) {
    return null;
  }
  if (stat.type !== "file") {
    throw new Error("Path is not a file.");
  }
  return context.host.readFile(path);
}

export const readTool: AgentTool = {
  name: "Read",
  description: "Read a text file from the workspace.",
  parameters: {
    type: "object",
    properties: {
      file_path: {
        type: "string",
        description: "Path to a file relative to the workspace root.",
      },
      start_line: {
        type: "integer",
        description: "1-based start line to read.",
      },
      end_line: {
        type: "integer",
        description: "1-based end line to read.",
      },
      reason: {
        type: "string",
        description: "Why this file needs to be read and why the read is safe.",
      },
    },
    required: ["file_path", "reason"],
    additionalProperties: false,
  },
  category: "read",
  title: fileTitle("Read", "file"),
  async execute(input, context) {
    const path = await context.host.resolvePath(getRequiredString(input, "file_path"));
    const startLine = getOptionalInteger(input, "start_line") ?? 1;
    const endLine = getOptionalInteger(input, "end_line");

    const content = await context.host.readFile(path.absolute);
    const allLines = content.split(/\r?\n/);
    const start = Math.max(1, startLine);
    const end = endLine ? Math.min(allLines.length, endLine) : allLines.length;
    const rendered = allLines.slice(start - 1, end).join("\n");

    return {
      ok: true,
      output: toJson({
        file_path: path.relative,
        start_line: start,
        end_line: end,
        total_lines: allLines.length,
        content: truncate(rendered, MAX_READ_CHARS),
      }),
      summary: `Read ${path.relative}`,
    };
  },
};

export const writeTool: AgentTool = {
  name: "Write",
  description: "Write a full text file in the workspace, creating parent directories if needed.",
  parameters: {
    type: "object",
    properties: {
      file_path: {
        type: "string",
        description: "Path to a file relative to the workspace root.",
      },
      content: {
        type: "string",
        description: "Full file contents to write.",
      },
      reason: {
        type: "string",
        description: "Why this write is necessary and why it is safe.",
      },
    },
    required: ["file_path", "content", "reason"],
    additionalProperties: false,
  },
  category: "edit",
  title: fileTitle("Write", "file"),
  async execute(input, context) {
    assertEditsAllowed(context, "Write");
    const path = await context.host.resolvePath(getRequiredString(input, "file_path"), {
      forWrite: true,
    });
    const content = getRequiredString(input, "content", true);
    assertNoNullBytes(content, "Content");

    const oldText = await readExisting(context, path.absolute);
    await context.onBeforeFileChange?.(path);
    await context.host.writeFile(path.absolute, content);

    const fileChange: FileChange = {
      path,
      oldText,
      newText: content,
      kind: oldText === null ? "create" : "update",
    };
    return {
      ok: true,
      output: toJson({ file_path: path.relative, bytes_written: utf8ByteLength(content) }),
      summary: `Write ${path.relative}`,
      fileChange,
    };
  },
};

export const editTool: AgentTool = {
  name: "Edit",
  description:
    "Replace text inside a file. Useful for targeted edits without rewriting the whole file.",
  parameters: {
    type: "object",
    properties: {
      file_path: {
        type: "string",
        description: "Path to a file relative to the workspace root.",
      },
      old_string: {
        type: "string",
        description: "Text to replace.",
      },
      new_string: {
        type: "string",
        description: "Replacement text.",
      },
      replace_all: {
        type: "boolean",
        description: "Replace all occurrences instead of exactly one.",
      },
      reason: {
        type: "string",
        description: "Why this edit is necessary and why it is safe.",
      },
    },
    required: ["file_path", "old_string", "new_string", "reason"],
    additionalProperties: false,
  },
  category: "edit",
  title: fileTitle("Edit", "file"),
  async execute(input, context) {
    assertEditsAllowed(context, "Edit");
    const path = await context.host.resolvePath(getRequiredString(input, "file_path"), {
      forWrite: true,
    });
    const oldString = getRequiredString(input, "old_string");
    const newString = getRequiredString(input, "new_string", true);
    assertNoNullBytes(newString, "new_string");
    const replaceAll = Boolean(input["replace_all"]);

    const original = await context.host.readFile(path.absolute);
    const occurrences = countOccurrences(original, oldString);
    if (occurrences === 0) {
      throw new Error("Edit failed: old_string was not found.");
    }
    if (!replaceAll && occurrences > 1) {
      throw new Error("Edit failed: old_string matched multiple locations. Use replace_all=true.");
    }

    const updated = replaceAll
      ? original.split(oldString).join(newString)
      : original.replace(oldString, () => newString);
    await context.onBeforeFileChange?.(path);
    await context.host.writeFile(path.absolute, updated);

    return {
      ok: true,
      output: toJson({ file_path: path.relative, replacements: replaceAll ? occurrences : 1 }),
      summary: `Edit ${path.relative}`,
      fileChange: { path, oldText: original, newText: updated, kind: "update" },
    };
  },
};

export const deleteTool: AgentTool = {
  name: "Delete",
  description:
    "Delete a file in the workspace. Fails when the file does not exist. Use only when the user asked for the file to be removed.",
  parameters: {
    type: "object",
    properties: {
      file_path: {
        type: "string",
        description: "Path to a file relative to the workspace root.",
      },
      reason: {
        type: "string",
        description: "Why this file must be deleted and why it is safe.",
      },
    },
    required: ["file_path", "reason"],
    additionalProperties: false,
  },
  category: "delete",
  title: fileTitle("Delete", "file"),
  async execute(input, context) {
    assertEditsAllowed(context, "Delete");
    const path = await context.host.resolvePath(getRequiredString(input, "file_path"), {
      forWrite: true,
    });
    const oldText = await readExisting(context, path.absolute);
    if (oldText === null) {
      throw new Error(`File not found: ${path.relative}`);
    }
    await context.onBeforeFileChange?.(path);
    await context.host.deleteFile(path.absolute);

    return {
      ok: true,
      output: toJson({ file_path: path.relative, deleted: true }),
      summary: `Delete ${path.relative}`,
      fileChange: { path, oldText, newText: "", kind: "delete" },
    };
  },
};

export const lsTool: AgentTool = {
  name: "LS",
  description:
    "List the entries of one directory in the workspace. Directories end with a slash. Use Glob to find files recursively.",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Directory path relative to the workspace root. Defaults to the root.",
      },
      reason: {
        type: "string",
        description: "Why this listing is needed and why it is safe.",
      },
    },
    required: ["reason"],
    additionalProperties: false,
  },
  category: "read",
  title: fileTitle("List", "workspace"),
  async execute(input, context) {
    const requested = typeof input["path"] === "string" && input["path"] ? input["path"] : ".";
    const path = await context.host.resolvePath(requested);
    const entries = await context.host.listDirectory(path.absolute);
    const names = entries
      .map((entry) => (entry.type === "directory" ? `${entry.name}/` : entry.name))
      .sort((left, right) => left.localeCompare(right));

    return {
      ok: true,
      output: toJson({
        path: path.relative,
        entries: names.slice(0, MAX_LIST_ENTRIES),
        ...(names.length > MAX_LIST_ENTRIES ? { truncated: true, total: names.length } : {}),
      }),
      summary: `LS ${path.relative} (${names.length} entries)`,
    };
  },
};
