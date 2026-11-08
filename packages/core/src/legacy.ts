import { isRecord } from "./util";

/**
 * Tool names used by the VS Code extension and the Zed agent before the tools were unified
 * (Cursor style), mapped to the current CLI-style names. Saved sessions still contain the
 * old names; replay them through these helpers so the model sees one consistent tool set.
 */
export const LEGACY_TOOL_NAME_MAP: Readonly<Record<string, string>> = {
  run_terminal_cmd: "Bash",
  read_file: "Read",
  write_file: "Write",
  edit_file: "Edit",
  search_replace: "Edit",
  delete_file: "Delete",
  list_dir: "LS",
  grep_search: "Grep",
  codebase_search: "Grep",
  file_search: "Glob",
};

export function isLegacyToolName(name: string): boolean {
  return Object.hasOwn(LEGACY_TOOL_NAME_MAP, name);
}

export function mapLegacyToolName(name: string): string {
  return LEGACY_TOOL_NAME_MAP[name] ?? name;
}

const KEY_RENAMES: Readonly<Record<string, string>> = {
  target_file: "file_path",
  relative_workspace_path: "path",
  start_line_one_indexed: "start_line",
  end_line_one_indexed_inclusive: "end_line",
  is_background: "run_in_background",
  explanation: "reason",
  include_pattern: "glob",
};

/** Map an old tool call (name and input) to the current tool name and argument names. */
export function mapLegacyToolCall(
  name: string,
  input: Record<string, unknown>,
): { name: string; input: Record<string, unknown> } {
  if (!isLegacyToolName(name)) {
    return { name, input };
  }

  const mapped: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    mapped[KEY_RENAMES[key] ?? key] = value;
  }

  if (name === "grep_search" || name === "codebase_search") {
    if (typeof mapped["query"] === "string") {
      mapped["pattern"] = mapped["query"];
      delete mapped["query"];
    }
    if (name === "grep_search") {
      mapped["case_insensitive"] = mapped["case_sensitive"] !== true;
      delete mapped["case_sensitive"];
    }
  }
  if (name === "file_search" && typeof mapped["query"] === "string") {
    mapped["pattern"] = `**/*${mapped["query"]}*`;
    delete mapped["query"];
  }

  return { name: mapLegacyToolName(name), input: mapped };
}

/** Same as mapLegacyToolCall for a JSON `arguments` string. Invalid JSON is kept as-is. */
export function mapLegacyToolArguments(
  name: string,
  argumentsText: string,
): { name: string; argumentsText: string } {
  if (!isLegacyToolName(name)) {
    return { name, argumentsText };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(argumentsText);
  } catch {
    return { name: mapLegacyToolName(name), argumentsText };
  }
  if (!isRecord(parsed)) {
    return { name: mapLegacyToolName(name), argumentsText };
  }
  const mapped = mapLegacyToolCall(name, parsed);
  return { name: mapped.name, argumentsText: JSON.stringify(mapped.input) };
}

/**
 * Rewrite `function_call` items saved with old tool names in a Responses input list.
 * Returns the original array when nothing changed.
 */
export function migrateLegacyResponseItems<T>(items: readonly T[]): T[] {
  let changed = false;
  const migrated = items.map((item) => {
    if (
      !isRecord(item) ||
      item["type"] !== "function_call" ||
      typeof item["name"] !== "string" ||
      !isLegacyToolName(item["name"])
    ) {
      return item;
    }
    changed = true;
    const argumentsText = typeof item["arguments"] === "string" ? item["arguments"] : "{}";
    const mapped = mapLegacyToolArguments(item["name"], argumentsText);
    return { ...item, name: mapped.name, arguments: mapped.argumentsText } as T;
  });
  return changed ? migrated : (items as T[]);
}
