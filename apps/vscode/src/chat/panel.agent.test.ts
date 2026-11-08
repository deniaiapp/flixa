import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type * as vscode from 'vscode';

// Agent mode end to end: the panel drives the shared core loop against a mocked
// /v1/agent/responses stream, with the core Node host standing in for the VS Code host.
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'flixa-vscode-agent-'));
const disposable = { dispose() {} };
const quickPicks: string[] = [];

vi.doMock('vscode', () => ({
  window: {
    activeTextEditor: undefined,
    onDidChangeActiveTextEditor: () => disposable,
    onDidChangeTextEditorSelection: () => disposable,
    showErrorMessage: vi.fn(),
    showQuickPick: async (_items: unknown, options: { placeHolder: string }) => {
      quickPicks.push(options.placeHolder);
      return { value: 'approve' };
    },
    createOutputChannel: () => ({ appendLine() {}, show() {}, dispose() {} }),
  },
  workspace: {
    workspaceFolders: [{ uri: { fsPath: workspace } }],
    getConfiguration: () => ({
      get: (key: string, fallback?: unknown) =>
        key === 'agentApprovalMode' ? 'MANUAL_APPROVE' : fallback,
    }),
    onDidSaveTextDocument: () => disposable,
    onDidCreateFiles: () => disposable,
    onDidDeleteFiles: () => disposable,
    onDidChangeConfiguration: () => disposable,
    findFiles: async () => [],
  },
  extensions: { getExtension: () => ({ packageJSON: { version: '9.9.9' } }) },
  Uri: { file: (fsPath: string) => ({ fsPath }) },
}));
vi.doMock('../llm/stub', () => ({
  callLLMForChat: vi.fn(),
  generateSessionTitle: async () => 'Agent test',
  getFlixaProvider: vi.fn(),
  resolveLlmApiError: (error: unknown) => ({
    message: `[API Error] ${error instanceof Error ? error.message : String(error)}`,
  }),
}));
vi.doMock('./context', () => ({
  resolveMentionedFiles: async () => [],
  gatherChatContext: async (message: string) => ({
    userMessage: message,
    activeSelection: '',
    activeFileText: '',
    activeFilePath: '',
    languageId: '',
    diagnostics: [],
    gitDiff: '',
    history: [],
    sessionMessages: [],
    autoContext: { fileList: [], gitStatus: '', packageInfo: '', tsConfig: '' },
    mentionedFiles: [],
  }),
}));
vi.doMock('../agent/host', async () => {
  const { createNodeToolHost } = await import('@deniai/flixa-core/node');
  return {
    createVscodeToolHost: (options: { workspaceRoot: string }) =>
      createNodeToolHost({ workspaceRoot: options.workspaceRoot, background: false }),
  };
});

type Item = Record<string, unknown>;
const requests: Item[] = [];
const replies: Item[][] = [];
const originalFetch = globalThis.fetch;

function streamed(output: Item[], text?: string): Item[] {
  return [
    ...(text ? [{ type: 'response.output_text.delta', delta: text }] : []),
    { type: 'response.completed', response: { output } },
  ];
}

let ChatViewProvider: typeof import('./panel').ChatViewProvider;
beforeAll(async () => {
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    requests.push(JSON.parse(String(init?.body)) as Item);
    const events = replies.shift() ?? [];
    return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  }) as typeof globalThis.fetch;
  ({ ChatViewProvider } = await import('./panel'));
});

afterAll(() => {
  globalThis.fetch = originalFetch;
  fs.rmSync(workspace, { recursive: true, force: true });
});

describe('agent mode on the shared loop', () => {
  it('runs tool calls with approvals and records them in the chat', async () => {
    const state = new Map<string, unknown>([
      [
        'chatSessions',
        [
          {
            id: 's1',
            name: 'Saved',
            createdAt: 1,
            messages: [
              { role: 'user', content: 'Read the readme' },
              {
                role: 'assistant',
                content: '',
                tool_calls: [
                  {
                    id: 'old_1',
                    type: 'function',
                    function: { name: 'read_file', arguments: '{"target_file":"README.md"}' },
                  },
                ],
              },
              {
                role: 'tool',
                content: '',
                toolResults: [
                  { tool_call_id: 'old_1', toolName: 'read_file', content: '# Readme' },
                ],
              },
              { role: 'assistant', content: 'It is a readme.' },
            ],
          },
        ],
      ],
      ['currentSessionId', 's1'],
    ]);
    const provider = new ChatViewProvider(
      { fsPath: workspace } as vscode.Uri,
      {
        subscriptions: [],
        globalState: {
          get: (key: string) => state.get(key),
          update: async (key: string, value: unknown) => void state.set(key, value),
        },
      } as unknown as vscode.ExtensionContext,
      () => {},
    );
    replies.push(
      streamed(
        [
          {
            type: 'function_call',
            call_id: 'call_write',
            name: 'Write',
            arguments: JSON.stringify({ file_path: 'notes.md', content: 'hi\n', reason: 'asked' }),
          },
          {
            type: 'function_call',
            call_id: 'call_ls',
            name: 'LS',
            arguments: JSON.stringify({ reason: 'check' }),
          },
        ],
        'Writing notes.',
      ),
      streamed(
        [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Done.' }] }],
        'Done.',
      ),
    );

    await (
      provider as unknown as { _handleUserMessage: (message: string) => Promise<void> }
    )._handleUserMessage('Write notes');

    expect(fs.readFileSync(path.join(workspace, 'notes.md'), 'utf8')).toBe('hi\n');
    // MANUAL_APPROVE asks for every action; without a webview the quick pick is used.
    expect(quickPicks).toEqual(['Write: notes.md', 'List Dir: .']);

    const replayed = (requests[0]!.input as Item[]).find((item) => item.type === 'function_call');
    expect(replayed).toMatchObject({ name: 'Read', arguments: '{"file_path":"README.md"}' });
    expect((requests[0]!.tools as Item[]).map((tool) => tool.name)).toContain('Edit');

    const sessions = state.get('chatSessions') as Array<{ messages: Item[] }>;
    const messages = sessions[0]!.messages.slice(4);
    expect(messages.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'assistant',
    ]);
    expect((messages[1]!.tool_calls as Item[]).map((call) => (call.function as Item).name)).toEqual(
      ['Write', 'LS'],
    );
    expect((messages[2]!.results as Item[]).map((result) => result.action)).toEqual([
      'Write: notes.md',
      'List Dir: .',
    ]);
    expect((messages[2]!.results as Item[]).every((result) => result.success === true)).toBe(true);
    expect(messages[3]!.content).toBe('Done.');
  });
});
