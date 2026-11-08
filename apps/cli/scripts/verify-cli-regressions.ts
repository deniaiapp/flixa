import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { executeToolCall } from "../src/agent-tools/tools.ts";

// Keep credentials and session fixtures separate from the user's real profile.
if (!process.env.FLIXA_REGRESSION_HOME) {
  const home = mkdtempSync(join(tmpdir(), "flixa-regressions-"));
  const result = spawnSync(
    process.execPath,
    [...process.execArgv, fileURLToPath(import.meta.url)],
    {
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        FLIXA_REGRESSION_HOME: home,
        FLIXA_API_KEY: "regression-dummy",
        ANTHROPIC_API_KEY: "regression-dummy",
      },
      stdio: "inherit",
    },
  );
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}

const home = process.env.FLIXA_REGRESSION_HOME;
assert.equal(resolve(homedir()), resolve(home));
const root = join(home, "workspace");
const outside = join(home, "outside");
mkdirSync(root);
mkdirSync(outside);
writeFileSync(join(outside, "sample.txt"), "outside fixture");
symlinkSync(outside, join(root, "linked"), process.platform === "win32" ? "junction" : "dir");
const context = { workspaceRoot: root, allowShell: false, allowFileEdits: true };
const call = (name: string, args: Record<string, unknown>) =>
  executeToolCall(
    {
      name,
      argumentsText: JSON.stringify({ ...args, reason: "Regression fixture" }),
      callId: name,
    },
    context,
  );

for (const file_path of [
  "linked/sample.txt",
  "../outside/sample.txt",
  join(outside, "sample.txt"),
]) {
  await assert.rejects(call("Read", { file_path }), /Path must stay inside/);
}
await assert.rejects(
  call("Write", { file_path: "linked/new/deep.txt", content: "bad" }),
  /Path must stay inside/,
);
await assert.rejects(
  call("Edit", { file_path: "linked/sample.txt", old_string: "outside", new_string: "bad" }),
  /Path must stay inside/,
);
assert.equal(readFileSync(join(outside, "sample.txt"), "utf8"), "outside fixture");

await call("Write", { file_path: "nested/empty.txt", content: "" });
assert.equal(readFileSync(join(root, "nested/empty.txt"), "utf8"), "");
await call("Write", { file_path: "..valid.txt", content: "OLD" });
await call("Edit", { file_path: "..valid.txt", old_string: "OLD", new_string: "$& $$ $' $`" });
assert.equal(readFileSync(join(root, "..valid.txt"), "utf8"), "$& $$ $' $`");
await call("Edit", { file_path: "..valid.txt", old_string: "$& $$ $' $`", new_string: "" });
assert.equal(readFileSync(join(root, "..valid.txt"), "utf8"), "");
await call("Write", { file_path: "repeat.txt", content: "x x" });
await call("Edit", {
  file_path: "repeat.txt",
  old_string: "x",
  new_string: "$&",
  replace_all: true,
});
assert.equal(readFileSync(join(root, "repeat.txt"), "utf8"), "$& $&");
await assert.rejects(call("Write", { file_path: "missing.txt" }), /Missing required string/);

const { registerChatCommand } = await import("../src/commands/chat.ts");
const { resolveProviderContext } = await import("../src/providers/runtime.ts");
const { saveConfig } = await import("../src/config/store.ts");
saveConfig({
  defaultProvider: "flixa",
  providers: {
    flixa: { defaultModel: "flixa-fixture" },
    anthropic: { defaultModel: "anthropic-fixture" },
  },
});
for (const args of [
  ["chat", "--provider", "anthropic", "hello"],
  ["--provider", "anthropic", "chat", "hello"],
  ["chat", "--provider", "anthropic", "--model", "explicit-model", "hello"],
]) {
  const program = new Command();
  registerChatCommand(program);
  let checked = false;
  program.commands
    .find((command) => command.name() === "chat")!
    .action((_parts, options, command) => {
      const context = resolveProviderContext({ ...command.parent.opts(), ...options });
      assert.equal(context.provider, "anthropic");
      assert.equal(
        context.model,
        args.includes("--model") ? "explicit-model" : "anthropic-fixture",
      );
      checked = true;
    });
  await program.parseAsync(["node", "flixa", ...args]);
  assert.ok(checked);
}

const { createSession, loadLatestSessionForCwd, saveSession } =
  await import("../src/sessions/store.ts");
assert.equal(loadLatestSessionForCwd(root), null);
const sessionDir = join(home, ".flixa", "sessions");
const oldSession = createSession(root, "fixture");
writeFileSync(
  join(sessionDir, "old.json"),
  JSON.stringify({ ...oldSession, updatedAt: "2000-01-01T00:00:00.000Z" }),
);
for (let i = 0; i < 105; i++) {
  writeFileSync(
    join(sessionDir, `other-${i}.json`),
    JSON.stringify({ ...createSession(outside, "fixture"), updatedAt: "2020-01-01T00:00:00.000Z" }),
  );
}
assert.equal(loadLatestSessionForCwd(root)?.id, oldSession.id);
const newSession = createSession(root, "fixture");
saveSession(newSession);
assert.equal(loadLatestSessionForCwd(root)?.id, newSession.id);
console.log("CLI regression checks passed (paths, edits, model selection, session continuation).");
