import { describe, expect, test } from "vitest";
import {
  LEGACY_TOOL_NAME_MAP,
  mapLegacyToolArguments,
  mapLegacyToolCall,
  migrateLegacyResponseItems,
} from "./legacy";
import { getCoreTool } from "./tools/index";

describe("legacy tool names", () => {
  test("every old name maps to a core tool", () => {
    for (const [oldName, newName] of Object.entries(LEGACY_TOOL_NAME_MAP)) {
      expect(getCoreTool(newName), `${oldName} -> ${newName}`).toBeDefined();
    }
  });

  test("maps names and argument keys", () => {
    expect(mapLegacyToolCall("read_file", { target_file: "a.ts", start_line: 2 })).toEqual({
      name: "Read",
      input: { file_path: "a.ts", start_line: 2 },
    });
    expect(mapLegacyToolCall("run_terminal_cmd", { command: "ls", is_background: true })).toEqual({
      name: "Bash",
      input: { command: "ls", run_in_background: true },
    });
    expect(mapLegacyToolCall("list_dir", { relative_workspace_path: "src" })).toEqual({
      name: "LS",
      input: { path: "src" },
    });
    expect(mapLegacyToolCall("grep_search", { query: "foo", include_pattern: "*.ts" })).toEqual({
      name: "Grep",
      input: { pattern: "foo", glob: "*.ts", case_insensitive: true },
    });
    expect(mapLegacyToolCall("file_search", { query: "panel" })).toEqual({
      name: "Glob",
      input: { pattern: "**/*panel*" },
    });
    expect(mapLegacyToolCall("Bash", { command: "ls" })).toEqual({
      name: "Bash",
      input: { command: "ls" },
    });
  });

  test("maps argument strings and keeps invalid JSON", () => {
    expect(mapLegacyToolArguments("delete_file", '{"target_file":"x"}')).toEqual({
      name: "Delete",
      argumentsText: '{"file_path":"x"}',
    });
    expect(mapLegacyToolArguments("write_file", "{oops")).toEqual({
      name: "Write",
      argumentsText: "{oops",
    });
  });

  test("migrates saved Responses items and leaves current ones untouched", () => {
    const saved = [
      { role: "user", content: "hi" },
      { type: "function_call", call_id: "c1", name: "edit_file", arguments: '{"target_file":"a"}' },
      { type: "function_call_output", call_id: "c1", output: "File edited" },
    ];
    const migrated = migrateLegacyResponseItems(saved);
    expect(migrated[1]).toEqual({
      type: "function_call",
      call_id: "c1",
      name: "Edit",
      arguments: '{"file_path":"a"}',
    });
    expect(migrated[0]).toBe(saved[0]);
    const current = [{ type: "function_call", call_id: "c2", name: "Read", arguments: "{}" }];
    expect(migrateLegacyResponseItems(current)).toBe(current);
  });
});
