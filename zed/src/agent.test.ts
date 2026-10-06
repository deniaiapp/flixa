import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type * as acp from '@agentclientprotocol/sdk';
import { parseResponsesAgentOutput } from './agent.js';
import { FlixaAgent } from './agent.js';
import { SessionStore, type PersistedSession } from './sessionStore.js';

test('parses response text and function calls', () => {
  const parsed = parseResponsesAgentOutput([
    {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'Reading the file.' }],
    },
    {
      type: 'function_call',
      call_id: 'call-1',
      name: 'read_file',
      arguments: '{"target_file":"README.md"}',
    },
  ]);

  expect(parsed.text).toBe('Reading the file.');
  expect(parsed.toolCalls).toEqual([
    {
      id: 'call-1',
      name: 'read_file',
      input: { target_file: 'README.md' },
    },
  ]);
});

test('advertises session loading and resuming', async () => {
  const response = await new FlixaAgent().initialize({ protocolVersion: 1 });

  expect(response.agentCapabilities?.loadSession).toBe(true);
  expect(response.agentCapabilities?.sessionCapabilities?.list).toEqual({});
  expect(response.agentCapabilities?.sessionCapabilities?.resume).toEqual({});
});

test('loads and resumes a persisted session', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'flixa-agent-session-'));
  const filePath = path.join(directory, 'sessions.json');
  const session: PersistedSession = {
    cwd: directory,
    additionalDirectories: [],
    input: [{ role: 'user', content: 'hello' }],
    model: 'openai/gpt-5.5',
    reasoningEffort: 'medium',
    approvalMode: 'AUTO_APPROVE',
    modeId: 'agent',
    promptCount: 1,
    history: [
      {
        sessionId: 'session-1',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'Restored' },
        },
      },
    ],
    updatedAt: new Date().toISOString(),
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify(['openai/gpt-5.5']), { status: 200 })) as unknown as typeof globalThis.fetch;
  const updates: acp.SessionNotification[] = [];
  const client = {
    notify: async (_method: string, params: acp.SessionNotification) => {
      updates.push(params);
    },
  } as unknown as acp.AgentContext;

  try {
    const store = new SessionStore(filePath);
    await store.save('session-1', session);
    const agent = new FlixaAgent(store);
    const loaded = await agent.loadSession(
      { sessionId: 'session-1', cwd: directory, mcpServers: [], additionalDirectories: [] },
      client,
    );
    const resumed = await agent.resumeSession({
      sessionId: 'session-1',
      cwd: directory,
      mcpServers: [],
      additionalDirectories: [],
    });

    expect(loaded.modes?.currentModeId).toBe('agent');
    expect(resumed.modes?.currentModeId).toBe('agent');
    expect(updates).toHaveLength(1);
    expect(updates[0]?.update.sessionUpdate).toBe('agent_message_chunk');
  } finally {
    globalThis.fetch = originalFetch;
    await rm(directory, { recursive: true, force: true });
  }
});
