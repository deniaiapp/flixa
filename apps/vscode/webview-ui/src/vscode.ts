declare function acquireVsCodeApi(): {
  postMessage: (message: unknown) => void;
  getState: () => unknown;
  setState: (state: unknown) => void;
};

export interface VSCodeAPI {
  postMessage: (message: unknown) => void;
  getState: () => unknown;
  setState: (state: unknown) => void;
}

class VSCodeWrapper {
  private readonly vscode: VSCodeAPI;

  constructor() {
    if (typeof acquireVsCodeApi === 'function') {
      this.vscode = acquireVsCodeApi();
    } else {
      // Mock for development
      this.vscode = {
        postMessage: (msg) => console.log('postMessage:', msg),
        getState: () => undefined,
        setState: () => {},
      };
    }
  }

  postMessage(message: unknown): void {
    this.vscode.postMessage(message);
  }

  getState(): unknown {
    return this.vscode.getState();
  }

  setState(state: unknown): void {
    this.vscode.setState(state);
  }
}

export const vscode = new VSCodeWrapper();
