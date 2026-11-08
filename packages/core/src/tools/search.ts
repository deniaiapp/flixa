import type { AgentTool } from "../types";
import { getOptionalString, getRequiredString, toJson, truncate } from "../util";

const MAX_GLOB_RESULTS = 500;

export const grepTool: AgentTool = {
  name: "Grep",
  description: "Search for a regex pattern in files under the workspace using ripgrep.",
  parameters: {
    type: "object",
    properties: {
      pattern: {
        type: "string",
        description: "Regex pattern to search for.",
      },
      path: {
        type: "string",
        description: "Optional directory or file path relative to the workspace root.",
      },
      glob: {
        type: "string",
        description: "Optional glob filter such as *.ts or src/**/*.tsx.",
      },
      case_insensitive: {
        type: "boolean",
        description: "Match case-insensitively. Defaults to false.",
      },
      reason: {
        type: "string",
        description: "Why this search is needed and why it is safe.",
      },
    },
    required: ["pattern", "reason"],
    additionalProperties: false,
  },
  category: "search",
  title: (input) =>
    `Search ${typeof input["pattern"] === "string" ? input["pattern"].slice(0, 60) : "workspace"}`,
  async execute(input, context) {
    const pattern = getRequiredString(input, "pattern");
    const pathValue = getOptionalString(input, "path");
    const searchRoot = pathValue
      ? (await context.host.resolvePath(pathValue)).absolute
      : context.host.workspaceRoot;
    const result = await context.host.grep({
      pattern,
      path: searchRoot,
      glob: getOptionalString(input, "glob"),
      caseInsensitive: input["case_insensitive"] === true,
      signal: context.signal,
    });

    return {
      ok: result.exitCode === 0 || result.exitCode === 1,
      output: toJson({
        exit_code: result.exitCode,
        stdout: truncate(result.stdout),
        stderr: truncate(result.stderr),
      }),
      summary: `Grep searched for ${JSON.stringify(pattern)}`,
    };
  },
};

export const globTool: AgentTool = {
  name: "Glob",
  description: "List files in the workspace, optionally filtered by a glob pattern.",
  parameters: {
    type: "object",
    properties: {
      pattern: {
        type: "string",
        description: "Optional glob pattern such as *.ts or src/**/*.tsx.",
      },
      path: {
        type: "string",
        description: "Optional directory path relative to the workspace root.",
      },
      reason: {
        type: "string",
        description: "Why this file listing is needed and why it is safe.",
      },
    },
    required: ["reason"],
    additionalProperties: false,
  },
  category: "search",
  title: (input) =>
    `Find ${typeof input["pattern"] === "string" && input["pattern"] ? input["pattern"] : "files"}`,
  async execute(input, context) {
    const pathValue = getOptionalString(input, "path");
    const root = pathValue
      ? (await context.host.resolvePath(pathValue)).absolute
      : context.host.workspaceRoot;
    const files = await context.host.glob({
      pattern: getOptionalString(input, "pattern"),
      path: root,
      limit: MAX_GLOB_RESULTS,
      signal: context.signal,
    });
    const listed = files.slice(0, MAX_GLOB_RESULTS);

    return {
      ok: true,
      output: toJson({ files: listed }),
      summary: `Glob listed ${listed.length} files`,
    };
  },
};
