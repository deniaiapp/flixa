import * as vscode from 'vscode';
import { FlixaCodeLensProvider } from './codelens/provider';
import { ChatViewProvider } from './chat/panel';
import { callLLMForImplement } from './llm/stub';
import { showDiffPreview } from './diff/preview';
import { applyPendingDiff } from './diff/apply';
import { PendingDiff, ImplementRequest, ApprovalMode } from './types';
import { setOutputChannel } from './logger';
import { UsageService, UsageStatusBarItem, showQuotaExceededDialog, showUsageDetailPanel } from './usage';
import { setApiKey } from './llm/provider';

let pendingDiff: PendingDiff | null = null;
let chatViewProvider: ChatViewProvider | null = null;
let usageService: UsageService | null = null;
let usageStatusBarItem: UsageStatusBarItem | null = null;

function storePendingDiff(diff: PendingDiff): void {
  pendingDiff = diff;
}

function clearPendingDiff(): void {
  pendingDiff = null;
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const outputChannel = vscode.window.createOutputChannel('Flixa');
  setOutputChannel(outputChannel);
  context.subscriptions.push(outputChannel);

  console.log('[Flixa] Extension activated!');

  usageService = new UsageService(context);

  const apiKey = await usageService.getApiKey();
  setApiKey(apiKey);

  usageService.onUsageChanged(async () => {
    const newApiKey = await usageService!.getApiKey();
    setApiKey(newApiKey);
  });

  usageStatusBarItem = new UsageStatusBarItem(usageService);
  context.subscriptions.push({
    dispose: () => usageStatusBarItem?.dispose(),
  });

  const isLoggedIn = await usageService.isLoggedIn();
  if (isLoggedIn) {
    usageService.fetchUsage();
  }

  context.subscriptions.push(
    vscode.window.onDidChangeWindowState(async (state) => {
      if (state.focused && usageService && await usageService.isLoggedIn()) {
        await usageService.fetchUsage(true);
      }
    })
  );

  const codeLensProvider = new FlixaCodeLensProvider();
  const codeLensDisposable = vscode.languages.registerCodeLensProvider(
    [
      { scheme: 'file', pattern: '**/*' },
      { scheme: 'untitled' }
    ],
    codeLensProvider
  );
  console.log('[Flixa] CodeLens provider registered');
  context.subscriptions.push(codeLensDisposable);

  chatViewProvider = new ChatViewProvider(
    context.extensionUri,
    context,
    storePendingDiff,
    usageService
  );

  usageService.onUsageChanged((data) => {
    if (chatViewProvider) {
      chatViewProvider.updateUsage(data);
    }
    usageStatusBarItem?.refresh();
  });

  const chatViewDisposable = vscode.window.registerWebviewViewProvider(
    ChatViewProvider.viewType,
    chatViewProvider
  );
  context.subscriptions.push(chatViewDisposable);

  const implementCommand = vscode.commands.registerCommand(
    'flixa.implementComment',
    async (uri: vscode.Uri, line: number, commentPayload: string) => {
      await handleImplement(uri, commentPayload);
    }
  );
  context.subscriptions.push(implementCommand);

  const openChatCommand = vscode.commands.registerCommand(
    'flixa.openChat',
    async () => {
      await vscode.commands.executeCommand('flixa.chatView.focus');
    }
  );
  context.subscriptions.push(openChatCommand);

  const applyDiffCommand = vscode.commands.registerCommand(
    'flixa.applyDiff',
    async () => {
      await applyPendingDiff(pendingDiff, clearPendingDiff);
    }
  );
  context.subscriptions.push(applyDiffCommand);

  const inlineEditCommand = vscode.commands.registerCommand(
    'flixa.inlineEdit',
    async () => {
      await handleInlineEdit();
    }
  );
  context.subscriptions.push(inlineEditCommand);

  const toggleAgentModeCommand = vscode.commands.registerCommand(
    'flixa.toggleAgentMode',
    async () => {
      if (chatViewProvider) {
        const current = chatViewProvider.getAgentMode();
        chatViewProvider.setAgentMode(!current);
        vscode.window.showInformationMessage(
          `Flixa: Agent mode ${!current ? 'enabled' : 'disabled'}`
        );
      }
    }
  );
  context.subscriptions.push(toggleAgentModeCommand);

  const setApprovalModeCommand = vscode.commands.registerCommand(
    'flixa.setApprovalMode',
    async () => {
      const modes: Array<{ label: string; value: ApprovalMode; description: string }> = [
        {
          label: 'Auto Approve (Recommended)',
          value: 'AUTO_APPROVE',
          description: 'AI checks if actions are safe before execution',
        },
        {
          label: 'All Approve',
          value: 'ALL_APPROVE',
          description: 'Execute all actions immediately without any checks (YOLO mode)',
        },
        {
          label: 'Safe Approve',
          value: 'SAFE_APPROVE',
          description: 'Read/write actions run automatically; shell commands need manual approval',
        },
        {
          label: 'Manual Approve',
          value: 'MANUAL_APPROVE',
          description: 'Review and approve each action individually',
        },
      ];

      const selected = await vscode.window.showQuickPick(modes, {
        placeHolder: 'Select approval mode for agent actions',
        ignoreFocusOut: true,
      });

      if (selected && chatViewProvider) {
        chatViewProvider.setApprovalMode(selected.value);
        vscode.window.showInformationMessage(
          `Flixa: Approval mode set to ${selected.label}`
        );
      }
    }
  );
  context.subscriptions.push(setApprovalModeCommand);

  const showUsageDetailCommand = vscode.commands.registerCommand(
    'flixa.showUsageDetail',
    async () => {
      if (usageService) {
        await showUsageDetailPanel(usageService);
      }
    }
  );
  context.subscriptions.push(showUsageDetailCommand);

  const loginCommand = vscode.commands.registerCommand(
    'flixa.login',
    async () => {
      if (!usageService) {
        return;
      }
      const loggedIn = await usageService.loginWithDeviceAuth();
      if (loggedIn && chatViewProvider) {
        await chatViewProvider.refreshState();
      }
    }
  );
  context.subscriptions.push(loginCommand);

  const logoutCommand = vscode.commands.registerCommand(
    'flixa.logout',
    async () => {
      if (usageService) {
        await usageService.logout();
        vscode.window.showInformationMessage('Deni AI: Logged out');
      }
    }
  );
  context.subscriptions.push(logoutCommand);

  const refreshUsageCommand = vscode.commands.registerCommand(
    'flixa.refreshUsage',
    async () => {
      if (usageService) {
        await usageService.fetchUsage(true);
      }
    }
  );
  context.subscriptions.push(refreshUsageCommand);
}

async function handleImplement(
  uri: vscode.Uri,
  commentPayload: string
): Promise<void> {
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'Flixa: Generating implementation...',
      cancellable: false
    },
    async () => {
      const document = await vscode.workspace.openTextDocument(uri);
      const fullFileText = document.getText();

      const request: ImplementRequest = {
        fullFileText,
        scopeRange: { startLine: 0, endLine: document.lineCount - 1 },
        scopeText: fullFileText,
        commentPayload,
        filePath: uri.fsPath,
        languageId: document.languageId,
      };

      const response = await callLLMForImplement(request);

      if (response.quotaExceeded) {
        await showQuotaExceededDialog(response.quotaExceeded, async () => {
          await usageService?.fetchUsage(true);
        });
        return;
      }

      if (response.type === 'message') {
        vscode.window.showErrorMessage(`Flixa: ${response.message}`);
        return;
      }

      if (response.type !== 'full' || !response.newContent) {
        vscode.window.showErrorMessage('Flixa: LLM did not return valid content.');
        return;
      }

      await showDiffPreview(uri, fullFileText, response.newContent, 'codelens', storePendingDiff);
      clearPendingDiff();
    }
  );
}

export function deactivate(): void {
  pendingDiff = null;
  chatViewProvider = null;
  usageService = null;
  usageStatusBarItem = null;
}

async function handleInlineEdit(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showErrorMessage('Flixa: No active editor.');
    return;
  }

  const input = await vscode.window.showInputBox({
    prompt: 'What do you want to do?',
    placeHolder: 'e.g., "add error handling", "refactor this function", "create a todo app"',
    ignoreFocusOut: true
  });

  if (!input) {
    return;
  }

  const document = editor.document;
  const selection = editor.selection;
  const uri = document.uri;
  const fullFileText = document.getText();
  const selectedText = document.getText(selection);

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'Flixa: Generating...',
      cancellable: false
    },
    async () => {
      const request: ImplementRequest = {
        fullFileText,
        scopeRange: {
          startLine: selection.start.line,
          endLine: selection.end.line,
        },
        scopeText: selectedText || fullFileText,
        commentPayload: input,
        filePath: uri.fsPath,
        languageId: document.languageId,
      };

      const response = await callLLMForImplement(request);

      if (response.quotaExceeded) {
        await showQuotaExceededDialog(response.quotaExceeded, async () => {
          await usageService?.fetchUsage(true);
        });
        return;
      }

      if (response.type === 'message') {
        vscode.window.showErrorMessage(`Flixa: ${response.message}`);
        return;
      }

      if (response.type !== 'full' || !response.newContent) {
        vscode.window.showErrorMessage('Flixa: LLM did not return valid content.');
        return;
      }

      await showDiffPreview(uri, fullFileText, response.newContent, 'codelens', storePendingDiff);
      clearPendingDiff();
    }
  );
}
