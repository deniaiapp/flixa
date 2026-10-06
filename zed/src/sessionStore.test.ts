import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SessionStore, type PersistedSession } from './sessionStore.js';

test('persists and reloads session state', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'flixa-session-store-'));
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
          content: { type: 'text', text: 'hello' },
        },
      },
    ],
    updatedAt: new Date().toISOString(),
  };

  try {
    const firstStore = new SessionStore(filePath);
    await firstStore.save('session-1', session);
    const secondStore = new SessionStore(filePath);

    expect(await secondStore.get('session-1')).toEqual(session);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
