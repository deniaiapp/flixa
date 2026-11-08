import { afterEach, beforeEach, expect, test } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type * as acp from '@agentclientprotocol/sdk/unstable';
import { FlixaAgent, toAcpToolCall } from './agent.js';
import { SessionStore, type PersistedSession } from './sessionStore.js';

type Item = Record<string, unknown>;

let directory: string;
let originalFetch: typeof globalThis.fetch;
const previousKey = process.env.FLIXA_API_KEY;

beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), 'flixa-zed-e2e-'));
  originalFetch = globalThis.fetch;
  process.env.FLIXA_API_KEY = 'zed-test-key';
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  if (previousKey === undefined) {
    delete process.env.FLIXA_API_KEY;
  } else {
    process.env.FLIXA_API_KEY = previousKey;
  }
  await rm(directory, { recursive: true, force: true });
});

function sseResponse(output: Item[], text?: string): Response {
  const events: Item[] = [];
  if (text) {
    events.push({ type: 'response.output_text.delta', delta: text });
  }
  events.push({
    type: 'response.completed',
    response: { output, usage: { input_tokens: 12, output_tokens: 3, total_tokens: 15 } },
  });
  const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('');
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function message(text: string): Item {
  return {
    type: 'message',
    role: 'assistant',
    status: 'completed',
    content: [{ type: 'output_text', text }],
  };
}

/** Mock fetch: `/models` lists one model; each `/responses` call gets the next reply. */
function mockFetch(replies: Array<(body: Item) => Response>): Item[] {
  const requests: Item[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/models')) {
      return new Response(JSON.stringify(['openai/gpt-6-luna']), { status: 200 });
    }
    const body = JSON.parse(String(init?.body)) as Item;
    requests.push(body);
    const reply = replies.shift();
    if (!reply) {
      throw new Error(`Unexpected request to ${url}`);
    }
    return reply(body);
  }) as typeof globalThis.fetch;
  return requests;
}

function createClient(decision: 'allow' | 'reject') {
  const updates: acp.SessionUpdate[] = [];
  const permissions: Item[] = [];
  const client = {
    notify: async (_method: string, params: acp.SessionNotification) => {
      updates.push(params.update);
    },
    request: async (_method: string, params: Item) => {
      permissions.push(params);
      return { outcome: { outcome: 'selected', optionId: decision } };
    },
  } as unknown as acp.AgentContext;
  return { client, updates, permissions };
}

test('runs one tool-using prompt through the ACP agent', async () => {
  const requests = mockFetch([
    () =>
      sseResponse(
        [
          {
            type: 'function_call',
            call_id: 'call_write',
            name: 'Write',
            arguments: JSON.stringify({
              file_path: 'notes.md',
              content: '# Notes\n',
              reason: 'Requested file',
            }),
          },
          {
            type: 'function_call',
            call_id: 'call_bash',
            name: 'Bash',
            arguments: JSON.stringify({ command: 'echo zed-ok', reason: 'Verify' }),
          },
        ],
        'Writing the notes.',
      ),
    () => sseResponse([message('Done.')], 'Done.'),
  ]);
  const agent = new FlixaAgent(new SessionStore(path.join(directory, 'sessions.json')));
  const { client, updates, permissions } = createClient('allow');

  const { sessionId } = await agent.newSession({ cwd: directory, mcpServers: [] });
  await agent.setSessionConfigOption({ sessionId, configId: 'approval_mode', value: 'safe' });
  const response = await agent.prompt(
    { sessionId, prompt: [{ type: 'text', text: 'Write notes and check the shell.' }] },
    client,
  );

  expect(response.stopReason).toBe('end_turn');
  expect(response.usage?.totalTokens).toBe(15);
  expect(await readFile(path.join(directory, 'notes.md'), 'utf8')).toBe('# Notes\n');

  // SAFE_APPROVE: the write runs, the shell command asks for permission.
  expect(permissions).toHaveLength(1);
  expect((permissions[0]!.toolCall as Item).name).toBe('Bash');
  expect((permissions[0]!.toolCall as Item).kind).toBe('execute');

  const toolCalls = updates.filter((update) => update.sessionUpdate === 'tool_call');
  expect(toolCalls.map((update) => (update as Item).name)).toEqual(['Write', 'Bash']);
  expect((toolCalls[0] as Item).kind).toBe('edit');
  const finished = updates.filter(
    (update) =>
      update.sessionUpdate === 'tool_call_update' && (update as Item).status === 'completed',
  ) as Item[];
  expect(finished.map((update) => update.toolCallId)).toEqual(['call_write', 'call_bash']);
  const diff = (finished[0]!.content as Item[])[0]!;
  expect(diff).toMatchObject({ type: 'diff', oldText: null, newText: '# Notes\n' });
  const messages = updates
    .filter((update) => update.sessionUpdate === 'agent_message_chunk')
    .map((update) => ((update as Item).content as Item).text);
  expect(messages).toEqual(['Writing the notes.', 'Done.']);

  expect((requests[0]!.tools as Item[]).map((tool) => tool.name)).toEqual([
    'Bash',
    'Read',
    'Write',
    'Edit',
    'Grep',
    'Glob',
    'LS',
    'Delete',
  ]);
  const followUp = (requests[1]!.input as Item[]).filter(
    (item) => item.type === 'function_call_output',
  );
  expect(JSON.parse(String(followUp[1]!.output))).toMatchObject({ exit_code: 0 });
});

test('a rejected permission reaches the model as a denied tool result', async () => {
  const requests = mockFetch([
    () =>
      sseResponse([
        {
          type: 'function_call',
          call_id: 'call_rm',
          name: 'Delete',
          arguments: JSON.stringify({ file_path: 'keep.txt', reason: 'cleanup' }),
        },
      ]),
    () => sseResponse([message('Understood.')], 'Understood.'),
  ]);
  await writeFile(path.join(directory, 'keep.txt'), 'keep');
  const agent = new FlixaAgent(new SessionStore(path.join(directory, 'sessions.json')));
  const { client, updates } = createClient('reject');
  const { sessionId } = await agent.newSession({ cwd: directory, mcpServers: [] });
  await agent.setSessionConfigOption({ sessionId, configId: 'approval_mode', value: 'manual' });

  await agent.prompt({ sessionId, prompt: [{ type: 'text', text: 'Clean up.' }] }, client);

  expect(await readFile(path.join(directory, 'keep.txt'), 'utf8')).toBe('keep');
  const output = (requests[1]!.input as Item[]).find(
    (item) => item.type === 'function_call_output',
  );
  expect(JSON.parse(String(output!.output))).toMatchObject({
    denied: true,
    reason: 'User rejected action',
  });
  expect(
    updates.some(
      (update) =>
        update.sessionUpdate === 'tool_call_update' && (update as Item).status === 'failed',
    ),
  ).toBe(true);
});

test('replays sessions saved with the old tool names under the new names', async () => {
  const session: PersistedSession = {
    cwd: directory,
    additionalDirectories: [],
    input: [
      { role: 'user', content: 'Read the readme' },
      {
        type: 'function_call',
        call_id: 'old_1',
        name: 'read_file',
        arguments: JSON.stringify({ target_file: 'README.md' }),
      },
      { type: 'function_call_output', call_id: 'old_1', output: '1\t# Readme' },
      message('It is a readme.'),
    ],
    model: 'openai/gpt-6-luna',
    reasoningEffort: 'medium',
    approvalMode: 'AUTO_APPROVE',
    modeId: 'agent',
    promptCount: 1,
    history: [],
    updatedAt: new Date().toISOString(),
  };
  const store = new SessionStore(path.join(directory, 'sessions.json'));
  await store.save('legacy', session);
  const requests = mockFetch([() => sseResponse([message('Still a readme.')], 'Still a readme.')]);
  const agent = new FlixaAgent(store);
  const { client } = createClient('allow');

  await agent.resumeSession({ sessionId: 'legacy', cwd: directory, mcpServers: [] });
  await agent.prompt({ sessionId: 'legacy', prompt: [{ type: 'text', text: 'And now?' }] }, client);

  const replayed = (requests[0]!.input as Item[]).find((item) => item.type === 'function_call');
  expect(replayed).toMatchObject({
    name: 'Read',
    arguments: JSON.stringify({ file_path: 'README.md' }),
  });
});

test('maps core tool calls to ACP tool-call fields', () => {
  const fields = toAcpToolCall(
    {
      callId: 'c1',
      name: 'Edit',
      argumentsText: '{}',
      input: { file_path: 'src/a.ts' },
      category: 'edit',
      summary: 'src/a.ts',
      title: 'Edit src/a.ts',
    },
    { cwd: directory },
  );
  expect(fields).toMatchObject({
    toolCallId: 'c1',
    title: 'Edit src/a.ts',
    kind: 'edit',
    locations: [{ path: path.resolve(directory, 'src/a.ts') }],
  });
});
