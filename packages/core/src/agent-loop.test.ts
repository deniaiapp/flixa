import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FlixaApiError } from "@deniai/flixa-api-client";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { runAgentLoop, type AgentEvent, type AgentLoopOptions } from "./agent-loop";
import { createNodeToolHost } from "./node/index";
import { createScriptedFetch, streamedTurn, type ScriptedReply } from "./test-helpers";
import { CORE_TOOLS } from "./tools/index";
import type { ToolHost } from "./types";

let root: string;
let host: ToolHost;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "flixa-core-loop-"));
  writeFileSync(join(root, "notes.txt"), "draft\n");
  host = createNodeToolHost({ workspaceRoot: root, ripgrepPath: join(root, "no-rg") });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function setup(replies: ScriptedReply[], overrides: Partial<AgentLoopOptions> = {}) {
  const scripted = createScriptedFetch(replies);
  const events: AgentEvent[] = [];
  const options: AgentLoopOptions = {
    client: {
      apiKey: "test-key",
      baseUrl: "http://127.0.0.1:9/v1/agent",
      headers: { "x-flixa-client": "test" },
      fetch: scripted.fetch,
    },
    model: "openai/gpt-6-luna",
    instructions: "You are a test agent.",
    input: [{ role: "user", content: "Update the notes." }],
    tools: CORE_TOOLS,
    host,
    approval: "SAFE_APPROVE",
    onEvent: (event) => void events.push(event),
    ...overrides,
  };
  return { options, events, requests: scripted.requests };
}

describe("runAgentLoop", () => {
  test("tool call → approval → result → final text", async () => {
    const approvals: string[] = [];
    const { options, events, requests } = setup(
      [
        streamedTurn({
          text: "Checking first.",
          calls: [
            { id: "c1", name: "Bash", args: { command: "echo loop-ok", reason: "check" } },
            {
              id: "c2",
              name: "Edit",
              args: {
                file_path: "notes.txt",
                old_string: "draft",
                new_string: "final",
                reason: "edit",
              },
            },
          ],
          usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
        }),
        streamedTurn({ text: "All done.", reasoning: "Wrap up." }),
      ],
      {
        requestApproval: async (request) => {
          approvals.push(request.call.name);
          return true;
        },
      },
    );

    const result = await runAgentLoop(options);

    expect(result.stopReason).toBe("completed");
    expect(result.finalText).toBe("All done.");
    expect(result.reasoningText).toBe("Wrap up.");
    expect(result.steps).toBe(2);
    expect(approvals).toEqual(["Bash"]);
    expect(readFileSync(join(root, "notes.txt"), "utf8")).toBe("final\n");

    expect(requests).toHaveLength(2);
    const first = requests[0]!;
    expect(first.url).toBe("http://127.0.0.1:9/v1/agent/responses");
    expect(first.headers["authorization"]).toBe("Bearer test-key");
    expect(first.headers["x-flixa-client"]).toBe("test");
    expect(first.body["stream"]).toBe(true);
    expect((first.body["tools"] as Array<{ name: string }>).map((tool) => tool.name)).toContain(
      "Bash",
    );
    const secondInput = requests[1]!.body["input"] as Array<Record<string, unknown>>;
    const outputs = secondInput.filter((item) => item["type"] === "function_call_output");
    expect(outputs.map((item) => item["call_id"])).toEqual(["c1", "c2"]);
    expect(JSON.parse(String(outputs[0]!["output"]))).toMatchObject({ ok: true, exit_code: 0 });
    expect(result.items.at(-1)).toMatchObject({ type: "message", role: "assistant" });

    const types = events.map((event) => event.type);
    expect(types.filter((type) => type === "text_delta").length).toBeGreaterThan(1);
    expect(types).toContain("approval_requested");
    expect(types).toContain("usage");
    expect(types.indexOf("approval_requested")).toBeLessThan(
      types.indexOf("tool_execution_started"),
    );
    expect(types.at(-1)).toBe("done");
    const finished = events.filter((event) => event.type === "tool_call_finished");
    expect(finished).toHaveLength(2);
    const editFinished = finished[1] as Extract<AgentEvent, { type: "tool_call_finished" }>;
    expect(editFinished.result.fileChange?.newText).toBe("final\n");
  });

  test("a rejected approval and an unknown tool become denied outputs", async () => {
    const { options, requests } = setup(
      [
        streamedTurn({
          calls: [
            { id: "c1", name: "Bash", args: { command: "echo nope", reason: "x" } },
            { id: "c2", name: "run_terminal_cmd", args: { command: "ls" } },
          ],
        }),
        streamedTurn({ text: "Okay." }),
      ],
      { requestApproval: async () => false },
    );

    const result = await runAgentLoop(options);
    expect(result.finalText).toBe("Okay.");
    const outputs = (requests[1]!.body["input"] as Array<Record<string, unknown>>).filter(
      (item) => item["type"] === "function_call_output",
    );
    expect(JSON.parse(String(outputs[0]!["output"]))).toMatchObject({
      denied: true,
      reason: "User rejected action",
    });
    expect(JSON.parse(String(outputs[1]!["output"]))).toMatchObject({
      denied: true,
      reason: "Tool run_terminal_cmd is not available in this context.",
    });
  });

  test("AUTO_APPROVE sends shell commands to the reviewer", async () => {
    const reviewed: string[] = [];
    const { options, requests } = setup(
      [
        streamedTurn({
          calls: [{ id: "c1", name: "Bash", args: { command: "echo hi", reason: "x" } }],
        }),
        streamedTurn({ text: "Blocked." }),
      ],
      {
        approval: "AUTO_APPROVE",
        reviewToolCall: async (request) => {
          reviewed.push(String(request.call.input["command"]));
          return { safe: false, reason: "looks odd" };
        },
      },
    );
    await runAgentLoop(options);
    expect(reviewed).toEqual(["echo hi"]);
    const output = (requests[1]!.body["input"] as Array<Record<string, unknown>>).find(
      (item) => item["type"] === "function_call_output",
    );
    expect(JSON.parse(String(output!["output"]))["reason"]).toBe("AI safety check: looks odd");
  });

  test("beforeToolCall and afterToolCall hooks gate and annotate calls", async () => {
    const { options, requests } = setup(
      [
        streamedTurn({
          calls: [
            { id: "c1", name: "Read", args: { file_path: "notes.txt", reason: "x" } },
            { id: "c2", name: "LS", args: { reason: "x" } },
          ],
        }),
        streamedTurn({ text: "Done." }),
      ],
      {
        approval: "ALL_APPROVE",
        beforeToolCall: async (call) => (call.name === "LS" ? "Denied by rule LS" : null),
        afterToolCall: async () => "\n[hook] checked",
      },
    );
    await runAgentLoop(options);
    const outputs = (requests[1]!.body["input"] as Array<Record<string, unknown>>).filter(
      (item) => item["type"] === "function_call_output",
    );
    expect(String(outputs[0]!["output"])).toMatch(/\[hook\] checked$/);
    expect(JSON.parse(String(outputs[1]!["output"]))["reason"]).toBe("Denied by rule LS");
  });

  test("cancellation while streaming stops the turn", async () => {
    const controller = new AbortController();
    const { options } = setup([{ kind: "hang" }], { signal: controller.signal });
    const running = runAgentLoop(options);
    setTimeout(() => controller.abort(), 20);
    const result = await running;
    expect(result.stopReason).toBe("cancelled");
    expect(result.items).toEqual([{ role: "user", content: "Update the notes." }]);
  });

  test("cancellation during approval closes every pending call", async () => {
    const controller = new AbortController();
    const { options } = setup(
      [
        streamedTurn({
          calls: [
            { id: "c1", name: "Bash", args: { command: "echo a", reason: "x" } },
            { id: "c2", name: "Read", args: { file_path: "notes.txt", reason: "x" } },
          ],
        }),
      ],
      {
        signal: controller.signal,
        requestApproval: async () => {
          controller.abort();
          return true;
        },
      },
    );
    const result = await runAgentLoop(options);
    expect(result.stopReason).toBe("cancelled");
    const outputs = result.items.filter((item) => item["type"] === "function_call_output");
    expect(outputs.map((item) => item["call_id"])).toEqual(["c1", "c2"]);
  });

  test("compacts locally when the input reaches the threshold", async () => {
    const bigHistory = [
      { role: "user", content: `First request ${"x".repeat(4000)}` },
      { role: "assistant", content: `First answer ${"y".repeat(4000)}` },
      { role: "user", content: "Now continue." },
    ];
    const { options, events, requests } = setup(
      [
        {
          kind: "json",
          payload: {
            output: [
              {
                type: "message",
                role: "assistant",
                content: [{ type: "output_text", text: "SUMMARY: earlier work" }],
              },
            ],
          },
        },
        streamedTurn({ text: "Continuing." }),
      ],
      { input: bigHistory, compaction: { thresholdTokens: 1000 } },
    );

    const result = await runAgentLoop(options);
    expect(result.finalText).toBe("Continuing.");
    expect(requests[0]!.body["stream"]).toBe(false);
    expect(String(requests[0]!.body["instructions"])).toMatch(/compress a coding-assistant/);
    const streamedInput = requests[1]!.body["input"] as Array<Record<string, unknown>>;
    expect(String(streamedInput[0]!["content"])).toMatch(/SUMMARY: earlier work/);
    expect(streamedInput.at(-1)).toEqual({ role: "user", content: "Now continue." });
    const compacted = events.find((event) => event.type === "compacted");
    expect(compacted).toBeDefined();
  });

  test("stops at the step limit", async () => {
    const call = { id: "c1", name: "LS", args: { reason: "x" } };
    const { options } = setup(
      [streamedTurn({ calls: [call] }), streamedTurn({ calls: [{ ...call, id: "c2" }] })],
      { approval: "ALL_APPROVE", maxSteps: 2 },
    );
    const result = await runAgentLoop(options);
    expect(result.stopReason).toBe("max_steps");
    expect(result.steps).toBe(2);
  });

  test("API errors surface as FlixaApiError", async () => {
    const { options, events } = setup([
      {
        kind: "json",
        status: 400,
        payload: { error: { message: "bad model", code: "unsupported_model" } },
      },
    ]);
    await expect(runAgentLoop(options)).rejects.toBeInstanceOf(FlixaApiError);
    expect(events.at(-1)?.type).toBe("error");
  });

  test("stream error events surface as FlixaApiError", async () => {
    const { options } = setup([
      {
        kind: "sse",
        events: [{ type: "error", error: { message: "quota", code: "USAGE_LIMIT_EXCEEDED" } }],
      },
    ]);
    await expect(runAgentLoop(options)).rejects.toMatchObject({ code: "USAGE_LIMIT_EXCEEDED" });
  });
});
