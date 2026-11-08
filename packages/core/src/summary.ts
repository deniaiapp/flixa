import { getOptionalString, parseToolArguments, shorten } from "./util";

/** One-line description of a tool call for status lines and approval cards. */
export function summarizeToolCall(toolName: string, argumentsText: string): string {
  const parsed = parseToolArguments(argumentsText);
  if (toolName === "TodoWrite") {
    return "update task list";
  }

  if (toolName === "Task") {
    return shorten(getOptionalString(parsed, "description") ?? "sub-agent task", 100);
  }

  if (toolName === "Skill") {
    return getOptionalString(parsed, "name") ?? toolName;
  }

  const backgroundId =
    getOptionalString(parsed, "bash_id") ?? getOptionalString(parsed, "shell_id");
  if (backgroundId) {
    return backgroundId;
  }

  const filePath = getOptionalString(parsed, "file_path");
  if (filePath) {
    return filePath;
  }

  const url = getOptionalString(parsed, "url");
  if (toolName === "WebFetch" && url) {
    return shorten(url, 100);
  }

  const path = getOptionalString(parsed, "path");
  const pattern = getOptionalString(parsed, "pattern");
  const command = getOptionalString(parsed, "command");

  if (command) {
    return shorten(command, 100);
  }

  if (toolName === "Grep" && pattern) {
    return path ? `${pattern} in ${path}` : pattern;
  }

  if (toolName === "Glob" && path) {
    return path;
  }

  if (pattern) {
    return pattern;
  }

  if (path) {
    return path;
  }

  const compact = argumentsText.replace(/\s+/g, " ").trim();
  return compact ? shorten(compact, 100) : toolName;
}

/** Collapse whitespace and cap the length of a value shown in an approval card. */
export function previewForDisplay(value: string | undefined, maxLength = 120): string {
  if (!value) {
    return "(empty)";
  }
  return shorten(value.replace(/\s+/g, " ").trim(), maxLength);
}
