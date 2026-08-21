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
  readonly scheme: string;
  readonly path: string;
  readonly query: string;

  constructor(readonly fsPath: string, scheme = 'file', path = fsPath, query = '') {
    this.scheme = scheme;
    this.path = path;
    this.query = query;
  }

  static file(path: string): Uri {
    return new Uri(path);
  }

  static joinPath(base: Uri, ...paths: string[]): Uri {
    return new Uri([base.fsPath, ...paths].join('/'));
  }

  static from(input: { scheme: string; path: string; query?: string }): Uri {
    return new Uri(input.path, input.scheme, input.path, input.query ?? '');
  }

  toString(): string {
    const query = this.query ? `?${this.query}` : '';
    return `${this.scheme}:${this.path}${query}`;
  }
}

export const window = {
  createTreeView: vi.fn(() => ({
    onDidChangeSelection: vi.fn(() => ({ dispose: vi.fn() })),
    dispose: vi.fn()
  })),
  createOutputChannel: vi.fn(() => ({
    name: 'AT JumpServer Terminal',
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    append: vi.fn(),
    appendLine: vi.fn(),
    clear: vi.fn(),
    show: vi.fn(),
    hide: vi.fn(),
    dispose: vi.fn()
  })),
  createStatusBarItem: vi.fn(() => ({ text: '', tooltip: '', show: vi.fn(), hide: vi.fn(), dispose: vi.fn() })),
  createWebviewPanel: vi.fn(),
  showInputBox: vi.fn(),
  showQuickPick: vi.fn(),
  showErrorMessage: vi.fn(),
  showInformationMessage: vi.fn(),
  showOpenDialog: vi.fn(),
  showSaveDialog: vi.fn(),
  showTextDocument: vi.fn(),
  showWarningMessage: vi.fn(),
  withProgress: vi.fn(),
  tabGroups: {
    onDidChangeTabs: vi.fn(() => ({ dispose: vi.fn() }))
  }
};

export const workspace = {
  getConfiguration: vi.fn(() => ({
    get: <T>(_key: string, defaultValue: T): T => defaultValue
  })),
  onDidCloseTextDocument: vi.fn(() => ({ dispose: vi.fn() })),
  onDidSaveTextDocument: vi.fn(() => ({ dispose: vi.fn() })),
  openTextDocument: vi.fn(async (uri) => ({ uri, languageId: 'plaintext' })),
  registerTextDocumentContentProvider: vi.fn(),
  workspaceFolders: undefined
};

export const commands = {
  executeCommand: vi.fn(),
  registerCommand: vi.fn()
};

export const env = {
  appName: 'Visual Studio Code',
  appRoot: '',
  uriScheme: 'vscode',
  clipboard: {
    writeText: vi.fn()
  }
};

export const lm = {
  registerTool: vi.fn(() => ({ dispose: vi.fn() }))
};

export const ProgressLocation = {
  Notification: 15
};

export enum StatusBarAlignment {
  Left = 1,
  Right = 2
}

export const languages = {
  setTextDocumentLanguage: vi.fn(async (document) => document)
};

export const l10n = {
  t(
    message: string,
    ...args: Array<string | number | boolean | Record<string, string | number | boolean>>
  ): string {
    const values: Record<string, unknown> =
      args.length === 1 && typeof args[0] === 'object' && args[0] !== null ? args[0] : { ...args };

    if (Object.keys(values).length === 0) {
      return message;
    }

    return message.replace(/{([^}]+)}/g, (match, key: string) => String(values[key] ?? match));
  }
};

