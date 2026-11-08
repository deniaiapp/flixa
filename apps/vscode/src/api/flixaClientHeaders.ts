import * as vscode from "vscode";

const FLIXA_EXTENSION_ID = "deniai.flixa";
const X_CLIENT = "flixa-vscode";

export function getFlixaExtensionVersion(): string {
  return vscode.extensions.getExtension(FLIXA_EXTENSION_ID)?.packageJSON?.version ?? "0.0.0";
}

export function getFlixaClientHeaders(): Record<string, string> {
  const version = getFlixaExtensionVersion();
  const platform = process.platform;

  return {
    "User-Agent": `flixa-vscode/${version}`,
    "x-flixa-client": `vscode/${version} (${platform})`,
    "x-client": X_CLIENT,
  };
}

export function getFlixaClientHeaderNames(): string[] {
  return Object.keys(getFlixaClientHeaders());
}

export function getClientSignalUserMessage(code: string): string | null {
  if (code === "service_unavailable") {
    return "Please try updating the extension. If the issue persists, please contact contact@deniai.app.";
  }
  if (code === "client_update_required") {
    return "Please try updating the extension. If the issue persists, please contact contact@deniai.app.";
  }
  if (code === "invalid_key" || code === "expired_key") {
    return "API key is invalid or expired. Please log in again.";
  }
  return null;
}

export function extractApiErrorCode(error: unknown): string | null {
  if (!error || typeof error !== "object") {
    return null;
  }

  const record = error as Record<string, unknown>;

  if (typeof record.code === "string") {
    return record.code;
  }

  if (record.error && typeof record.error === "object") {
    const nested = record.error as Record<string, unknown>;
    if (typeof nested.code === "string") {
      return nested.code;
    }
  }

  if (typeof record.responseBody === "string") {
    try {
      const parsed = JSON.parse(record.responseBody) as unknown;
      const fromBody = extractApiErrorCode(parsed);
      if (fromBody) {
        return fromBody;
      }
    } catch {
      // ignore
    }
  }

  if (typeof record.message === "string") {
    try {
      const parsed = JSON.parse(record.message) as unknown;
      const fromMessage = extractApiErrorCode(parsed);
      if (fromMessage) {
        return fromMessage;
      }
    } catch {
      // ignore
    }
  }

  for (const key of ["data", "body", "response", "cause", "value"]) {
    const nested = extractApiErrorCode(record[key]);
    if (nested) {
      return nested;
    }
  }

  return null;
}

export function logMissingClientSignal(requestPath: string): void {
  console.log("[Flixa] missing_client_signal", {
    path: requestPath,
    clientHeaderNames: getFlixaClientHeaderNames(),
  });
}
