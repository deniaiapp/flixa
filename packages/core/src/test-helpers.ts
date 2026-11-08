/** Test helpers: a scripted, streaming `/v1/agent/responses` endpoint. Not exported. */

export interface RecordedRequest {
  url: string;
  body: Record<string, unknown>;
  headers: Record<string, string>;
}

export type ScriptedReply =
  | { kind: "sse"; events: Array<Record<string, unknown>> }
  | { kind: "json"; payload: unknown; status?: number }
  | { kind: "hang" };

export function sse(events: Array<Record<string, unknown>>): ScriptedReply {
  return { kind: "sse", events };
}

/** A streamed assistant reply with optional function calls, like the upstream SSE. */
export function streamedTurn(options: {
  text?: string;
  reasoning?: string;
  calls?: Array<{ id: string; name: string; args: Record<string, unknown> }>;
  usage?: Record<string, number>;
}): ScriptedReply {
  const events: Array<Record<string, unknown>> = [];
  const output: Array<Record<string, unknown>> = [];
  if (options.reasoning) {
    events.push({ type: "response.reasoning_summary_text.delta", delta: options.reasoning });
    output.push({
      type: "reasoning",
      id: "rs_1",
      summary: [{ type: "summary_text", text: options.reasoning }],
    });
  }
  if (options.text) {
    const half = Math.ceil(options.text.length / 2);
    events.push({ type: "response.output_text.delta", delta: options.text.slice(0, half) });
    events.push({ type: "response.output_text.delta", delta: options.text.slice(half) });
    output.push({
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: options.text }],
    });
  }
  for (const call of options.calls ?? []) {
    const item = {
      type: "function_call",
      call_id: call.id,
      name: call.name,
      arguments: JSON.stringify(call.args),
    };
    events.push({ type: "response.output_item.done", output_index: output.length, item });
    output.push(item);
  }
  events.push({
    type: "response.completed",
    response: { id: "resp_1", status: "completed", output, usage: options.usage },
  });
  return { kind: "sse", events };
}

/** A fetch that answers each POST with the next scripted reply and records the requests. */
export function createScriptedFetch(replies: ScriptedReply[]): {
  fetch: typeof fetch;
  requests: RecordedRequest[];
} {
  const requests: RecordedRequest[] = [];
  const queue = [...replies];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    requests.push({
      url: String(input),
      body,
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
    });
    const reply = queue.shift();
    if (!reply) {
      throw new Error("No scripted reply left");
    }
    if (reply.kind === "json") {
      return new Response(JSON.stringify(reply.payload), {
        status: reply.status ?? 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (reply.kind === "hang") {
      return await new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        signal?.addEventListener("abort", () => {
          const error = new Error("Aborted");
          error.name = "AbortError";
          reject(error);
        });
      });
    }
    const text = reply.events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
    const encoder = new TextEncoder();
    // Split the body at odd offsets to exercise the SSE parser's buffering.
    const chunks: Uint8Array[] = [];
    for (let index = 0; index < text.length; index += 37) {
      chunks.push(encoder.encode(text.slice(index, index + 37)));
    }
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    });
    return new Response(stream, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  }) as typeof fetch;
  return { fetch: fetchImpl, requests };
}
