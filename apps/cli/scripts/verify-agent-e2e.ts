// End-to-end check: run `flixa chat --print` against a local mock of /v1/agent/responses and
// verify one full tool-using turn (Write + Bash, then a final answer).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

type Item = Record<string, unknown>;

const cliEntry = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const home = mkdtempSync(join(tmpdir(), "flixa-e2e-home-"));
const workspace = join(home, "workspace");
mkdirSync(workspace);

const streamedRequests: Item[] = [];

function sendSse(response: ServerResponse, events: Item[]): void {
  response.writeHead(200, { "content-type": "text/event-stream" });
  for (const event of events) {
    response.write(`event: ${String(event["type"])}\ndata: ${JSON.stringify(event)}\n\n`);
  }
  response.end("data: [DONE]\n\n");
}

function turn(output: Item[], text?: string): Item[] {
  const events: Item[] = [];
  if (text) {
    events.push({ type: "response.output_text.delta", delta: text });
  }
  output.forEach((item, index) => {
    events.push({ type: "response.output_item.done", output_index: index, item });
  });
  events.push({
    type: "response.completed",
    response: {
      id: `resp_${streamedRequests.length}`,
      status: "completed",
      output,
      usage: { input_tokens: 42, output_tokens: 7, total_tokens: 49 },
    },
  });
  return events;
}

async function readBody(request: IncomingMessage): Promise<Item> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Item;
}

const server = createServer((request, response) => {
  void (async () => {
    if (request.method !== "POST" || request.url !== "/v1/agent/responses") {
      response.writeHead(404).end();
      return;
    }
    assert.equal(request.headers["authorization"], "Bearer e2e-key");
    const body = await readBody(request);
    if (body["stream"] !== true) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ output: [] }));
      return;
    }
    streamedRequests.push(body);
    const input = body["input"] as Item[];
    const outputs = input.filter((item) => item["type"] === "function_call_output");
    if (outputs.length === 0) {
      sendSse(
        response,
        turn(
          [
            {
              type: "function_call",
              call_id: "call_write",
              name: "Write",
              arguments: JSON.stringify({
                file_path: "hello.txt",
                content: "hello from the mock model\n",
                reason: "The user asked for this file.",
              }),
            },
            {
              type: "function_call",
              call_id: "call_bash",
              name: "Bash",
              arguments: JSON.stringify({
                command: "echo e2e-bash-ok",
                reason: "Show that commands run.",
              }),
            },
          ],
          "Creating the file.",
        ),
      );
      return;
    }
    sendSse(
      response,
      turn(
        [
          {
            type: "message",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: "Created hello.txt and ran the command." }],
          },
        ],
        "Created hello.txt and ran the command.",
      ),
    );
  })().catch((error: unknown) => {
    response.writeHead(500).end(String(error));
  });
});

await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as AddressInfo).port;

try {
  const child = spawn(
    process.execPath,
    [
      ...process.execArgv,
      cliEntry,
      "chat",
      "--provider",
      "flixa",
      "--model",
      "openai/gpt-6-luna",
      "--base-url",
      `http://127.0.0.1:${port}/v1/agent`,
      "--yolo",
      "--print",
      "Create hello.txt and run a command.",
    ],
    {
      cwd: workspace,
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        FLIXA_API_KEY: "e2e-key",
        FLIXA_BASE_URL: `http://127.0.0.1:${port}/v1/agent`,
        FLIXA_SUPPRESS_ELEVATION_WARNING: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  const exitCode = await new Promise<number | null>((resolve) => child.on("close", resolve));

  assert.equal(exitCode, 0, `CLI exited with ${exitCode}\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  assert.match(stdout, /Created hello\.txt and ran the command\./);
  assert.equal(readFileSync(join(workspace, "hello.txt"), "utf8"), "hello from the mock model\n");
  assert.equal(streamedRequests.length, 2);

  const first = streamedRequests[0]!;
  const toolNames = (first["tools"] as Array<{ name: string }>).map((tool) => tool.name);
  for (const name of ["Bash", "Read", "Write", "Edit", "Grep", "Glob", "LS"]) {
    assert.ok(toolNames.includes(name), `tool ${name} offered`);
  }
  const second = streamedRequests[1]!["input"] as Item[];
  const outputs = new Map(
    second
      .filter((item) => item["type"] === "function_call_output")
      .map((item) => [item["call_id"], JSON.parse(String(item["output"])) as Item]),
  );
  assert.equal(outputs.get("call_write")?.["file_path"], "hello.txt");
  assert.equal(outputs.get("call_bash")?.["exit_code"], 0);
  assert.match(String(outputs.get("call_bash")?.["stdout"]), /e2e-bash-ok/);
  assert.match(stderr, /Write hello\.txt|hello\.txt/);

  console.log(
    "CLI agent e2e passed (mock Responses server: Write + Bash tool calls, then final text).",
  );
} finally {
  server.close();
  rmSync(home, { recursive: true, force: true });
}
