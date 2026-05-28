import { EventEmitter as NodeEventEmitter } from 'node:events';
import { vi } from 'vitest';

export enum TreeItemCollapsibleState {
  None = 0,
  Collapsed = 1,
  Expanded = 2
}

export enum ViewColumn {
  Active = -1
}

export class TreeItem {
  label?: string;
  id?: string;
  description?: string;
  tooltip?: string;
  contextValue?: string;
  command?: unknown;

  constructor(label?: string, public collapsibleState: TreeItemCollapsibleState = TreeItemCollapsibleState.None) {
    this.label = label;
  }
}

export class EventEmitter<T> {
  private readonly emitter = new NodeEventEmitter();
  readonly event = (listener: (event: T) => void) => {
    this.emitter.on('event', listener);
    return { dispose: () => this.emitter.off('event', listener) };
  };

  fire(event: T): void {
    this.emitter.emit('event', event);
  }
}

export class Uri {
  constructor(readonly fsPath: string) {}

  static file(path: string): Uri {
    return new Uri(path);
  }

  static joinPath(base: Uri, ...paths: string[]): Uri {
    return new Uri([base.fsPath, ...paths].join('/'));
  }
}

export const window = {
  createTreeView: vi.fn(),
  createWebviewPanel: vi.fn(),
  showInputBox: vi.fn(),
  showInformationMessage: vi.fn(),
  showOpenDialog: vi.fn(),
  showSaveDialog: vi.fn(),
  showWarningMessage: vi.fn(),
  withProgress: vi.fn()
};

export const workspace = {
  getConfiguration: vi.fn(() => ({
    get: <T>(_key: string, defaultValue: T): T => defaultValue
  }))
};

export const commands = {
  registerCommand: vi.fn()
};

export const env = {
  clipboard: {
    writeText: vi.fn()
  }
};

export const ProgressLocation = {
  Notification: 15
};
