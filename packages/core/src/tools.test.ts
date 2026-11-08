import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createNodeToolHost } from "./node/index";
import { CORE_TOOLS, getCoreTool, runTool } from "./tools/index";
import type { ToolContext, ToolHost } from "./types";

let root: string;
let outside: string;
let host: ToolHost;

function context(overrides: Partial<ToolContext> = {}): ToolContext {
  return { host, ...overrides };
}

async function call(name: string, input: Record<string, unknown>, ctx = context()) {
  const tool = getCoreTool(name);
  if (!tool) throw new Error(`missing tool ${name}`);
  return tool.execute({ reason: "test", ...input }, ctx);
}

function parse(output: string): Record<string, unknown> {
  return JSON.parse(output) as Record<string, unknown>;
}

beforeEach(() => {
  const base = mkdtempSync(join(tmpdir(), "flixa-core-tools-"));
  root = join(base, "workspace");
  outside = join(base, "outside");
  mkdirSync(join(root, "src", "nested"), { recursive: true });
  mkdirSync(outside);
  writeFileSync(join(root, "src", "a.ts"), "export const alpha = 1;\nexport const beta = 2;\n");
  writeFileSync(join(root, "src", "nested", "b.ts"), "const Alpha = 'x';\n");
  writeFileSync(join(root, "README.md"), "# Title\nalpha in docs\n");
  writeFileSync(join(outside, "secret.txt"), "outside");
  host = createNodeToolHost({ workspaceRoot: root, ripgrepPath: join(root, "no-such-rg") });
});

afterEach(() => {
  rmSync(join(root, ".."), { recursive: true, force: true });
});

describe("core tool set", () => {
  test("offers the CLI-style names", () => {
    expect(CORE_TOOLS.map((tool) => tool.name)).toEqual([
      "Bash",
      "Read",
      "Write",
      "Edit",
      "Grep",
      "Glob",
      "LS",
      "Delete",
    ]);
    for (const tool of CORE_TOOLS) {
      expect(tool.parameters["type"]).toBe("object");
      expect(tool.parameters["required"]).toContain("reason");
    }
  });
});

describe("Read", () => {
  test("reads a file with line bounds", async () => {
    const result = await call("Read", { file_path: "src/a.ts", start_line: 2, end_line: 2 });
    const payload = parse(result.output);
    expect(payload["content"]).toBe("export const beta = 2;");
    expect(payload["total_lines"]).toBe(3);
    expect(result.summary).toBe("Read src/a.ts");
  });

  test("refuses paths outside the workspace, including through links", async () => {
    await expect(call("Read", { file_path: "../outside/secret.txt" })).rejects.toThrow(
      /Path must stay inside/,
    );
    await expect(call("Read", { file_path: join(outside, "secret.txt") })).rejects.toThrow(
      /Path must stay inside/,
    );
    symlinkSync(outside, join(root, "linked"), process.platform === "win32" ? "junction" : "dir");
    await expect(call("Read", { file_path: "linked/secret.txt" })).rejects.toThrow(
      /Path must stay inside/,
    );
  });
});

describe("Write / Edit / Delete", () => {
  test("Write creates parents and reports a file change", async () => {
    const result = await call("Write", { file_path: "new/dir/c.txt", content: "hello" });
    expect(readFileSync(join(root, "new/dir/c.txt"), "utf8")).toBe("hello");
    expect(result.fileChange?.kind).toBe("create");
    expect(result.fileChange?.oldText).toBeNull();
    expect(parse(result.output)["bytes_written"]).toBe(5);
  });

  test("Write refuses .git and null bytes", async () => {
    await expect(
      call("Write", { file_path: ".git/hooks/pre-commit", content: "x" }),
    ).rejects.toThrow(/inside \.git/);
    await expect(call("Write", { file_path: "x.txt", content: "a\0b" })).rejects.toThrow(
      /null bytes/,
    );
  });

  test("Edit replaces exactly one match and keeps $ patterns literal", async () => {
    writeFileSync(join(root, "e.txt"), "OLD");
    await call("Edit", { file_path: "e.txt", old_string: "OLD", new_string: "$& $$ $'" });
    expect(readFileSync(join(root, "e.txt"), "utf8")).toBe("$& $$ $'");

    writeFileSync(join(root, "r.txt"), "x x");
    await expect(
      call("Edit", { file_path: "r.txt", old_string: "x", new_string: "y" }),
    ).rejects.toThrow(/multiple locations/);
    const all = await call("Edit", {
      file_path: "r.txt",
      old_string: "x",
      new_string: "y",
      replace_all: true,
    });
    expect(parse(all.output)["replacements"]).toBe(2);
    expect(all.fileChange?.oldText).toBe("x x");
    expect(all.fileChange?.newText).toBe("y y");
    await expect(
      call("Edit", { file_path: "r.txt", old_string: "missing", new_string: "z" }),
    ).rejects.toThrow(/not found/);
  });

  test("Delete removes a file and refuses missing ones", async () => {
    const result = await call("Delete", { file_path: "README.md" });
    expect(result.fileChange?.kind).toBe("delete");
    expect(result.fileChange?.oldText).toContain("# Title");
    await expect(call("Delete", { file_path: "README.md" })).rejects.toThrow(/File not found/);
  });

  test("file tools honor allowFileEdits and the before-change hook", async () => {
    await expect(
      call("Write", { file_path: "x.txt", content: "x" }, context({ allowFileEdits: false })),
    ).rejects.toThrow(/disabled/);
    const touched: string[] = [];
    await call(
      "Write",
      { file_path: "y.txt", content: "y" },
      context({ onBeforeFileChange: (path) => void touched.push(path.relative) }),
    );
    expect(touched).toEqual(["y.txt"]);
  });
});

describe("LS / Glob / Grep", () => {
  test("LS lists one directory with trailing slashes for folders", async () => {
    const result = await call("LS", { path: "src" });
    expect(parse(result.output)["entries"]).toEqual(["a.ts", "nested/"]);
  });

  test("Glob lists files with and without a pattern", async () => {
    const all = parse((await call("Glob", {})).output)["files"] as string[];
    expect(all.sort()).toEqual(["README.md", "src/a.ts", "src/nested/b.ts"]);
    const ts = parse((await call("Glob", { pattern: "*.ts" })).output)["files"] as string[];
    expect(ts.sort()).toEqual(["src/a.ts", "src/nested/b.ts"]);
    const scoped = parse((await call("Glob", { pattern: "*.ts", path: "src/nested" })).output)[
      "files"
    ];
    expect(scoped).toEqual(["src/nested/b.ts"]);
  });

  test("Grep finds matches with the JavaScript fallback", async () => {
    const result = await call("Grep", { pattern: "alpha" });
    const payload = parse(result.output);
    expect(payload["exit_code"]).toBe(0);
    expect(String(payload["stdout"]).split("\n").sort()).toEqual([
      "README.md:2:alpha in docs",
      "src/a.ts:1:export const alpha = 1;",
    ]);
    const insensitive = parse(
      (await call("Grep", { pattern: "alpha", glob: "*.ts", case_insensitive: true })).output,
    );
    expect(String(insensitive["stdout"]).split("\n").sort()).toEqual([
      "src/a.ts:1:export const alpha = 1;",
      "src/nested/b.ts:1:const Alpha = 'x';",
    ]);
    const none = parse((await call("Grep", { pattern: "zzz" })).output);
    expect(none["exit_code"]).toBe(1);
  });
});

describe("Bash", () => {
  test("runs a command, streams output, and reports the exit code", async () => {
    const streamed: string[] = [];
    const result = await call(
      "Bash",
      { command: "echo flixa-core" },
      context({ onOutput: (output) => void streamed.push(output) }),
    );
    const payload = parse(result.output);
    expect(payload["exit_code"]).toBe(0);
    expect(String(payload["stdout"])).toContain("flixa-core");
    expect(result.ok).toBe(true);
    expect(streamed.join("")).toContain("flixa-core");
  });

  test("blocks destructive commands and honors allowShell", async () => {
    await expect(call("Bash", { command: "rm -rf build" })).rejects.toThrow(/Command blocked/);
    await expect(
      call("Bash", { command: "echo hi" }, context({ allowShell: false })),
    ).rejects.toThrow(/disabled/);
  });

  test("runTool turns errors into a failed CLI-shaped result", async () => {
    const tool = getCoreTool("Read")!;
    const result = await runTool(tool, { file_path: "missing.txt" }, context(), "missing.txt");
    expect(result.ok).toBe(false);
    expect(parse(result.output)).toMatchObject({ ok: false, tool: "Read" });
    expect(result.summary).toMatch(/^Read missing\.txt failed:/);
  });
});

const bundledRipgrep =
  process.env["FLIXA_TEST_RIPGREP"] ??
  join(
    __dirname,
    "../../../apps/cli/node_modules/@vscode/ripgrep/bin",
    process.platform === "win32" ? "rg.exe" : "rg",
  );

describe.skipIf(!existsSync(bundledRipgrep))("ripgrep-backed search", () => {
  test("Grep and Glob print workspace-relative paths", async () => {
    host = createNodeToolHost({ workspaceRoot: root, ripgrepPath: bundledRipgrep });
    const grep = parse((await call("Grep", { pattern: "alpha", path: "src" })).output);
    expect(grep["stdout"]).toBe("src/a.ts:1:export const alpha = 1;");
    const glob = parse((await call("Glob", { pattern: "*.ts" })).output)["files"] as string[];
    expect(glob.sort()).toEqual(["src/a.ts", "src/nested/b.ts"]);
  });
});
