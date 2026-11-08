import * as vscode from 'vscode';
import { createClientHeaders } from '@deniai/flixa-api-client';

const FLIXA_EXTENSION_ID = 'deniai.flixa';

export function getFlixaExtensionVersion(): string {
  return vscode.extensions.getExtension(FLIXA_EXTENSION_ID)?.packageJSON?.version ?? '0.0.0';
}

export function getFlixaClientHeaders(): Record<string, string> {
  return createClientHeaders({ kind: 'vscode', version: getFlixaExtensionVersion() });
}

export function getFlixaClientHeaderNames(): string[] {
  return Object.keys(getFlixaClientHeaders());
}

export function getClientSignalUserMessage(code: string): string | null {
  if (code === 'service_unavailable') {
    return 'Please try updating the extension. If the issue persists, please contact contact@deniai.app.';
  }
  if (code === 'client_update_required') {
    return 'Please try updating the extension. If the issue persists, please contact contact@deniai.app.';
  }
  if (code === 'invalid_key' || code === 'expired_key') {
    return 'API key is invalid or expired. Please log in again.';
  }
  return null;
}

export function logMissingClientSignal(requestPath: string): void {
  console.log('[Flixa] missing_client_signal', {
    path: requestPath,
    clientHeaderNames: getFlixaClientHeaderNames(),
  });
}
