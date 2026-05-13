import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import type { CachedJumpServerAsset } from '../../src/config/schema';
import { deactivate } from '../../src/extension';
import { TerminalContextRegistry } from '../../src/terminal/TerminalContext';
import {
  createTerminalAssets,
  createTerminalViewColumn,
  formatTerminalNotice,
  handleTerminalMessage,
  renderTerminalBody,
  resolveTerminalSettings,
  TerminalPanel
} from '../../src/webview/TerminalPanel';

const connect = vi.fn<() => Promise<void>>();
const disposeSession = vi.fn<() => void>();
const write = vi.fn<(data: string) => void>();
const resize = vi.fn<(rows: number, cols: number) => void>();
const sessionEvents: Array<{ output(data: Buffer): void; status(message: string): void }> = [];

vi.mock('../../src/jumpserver/JumpServerSession', () => ({
  JumpServerSession: vi.fn().mockImplementation((input) => {
    sessionEvents.push(input.events);
    return {
      connect,
      dispose: disposeSession,
      write,
      resize
    };
  })
}));

function asset(id = 'terminal-asset'): CachedJumpServerAsset {
  return {
    id,
    name: id,
    address: `${id}.example.com`,
    platform: 'Linux',
    category: 'host',
    type: 'server',
    zoneName: 'Production',
    nodePath: ['Production'],
    protocolNames: ['ssh'],
    raw: {}
  };
}

function jumpServerClient() {
  return {} as never;
}

function extensionContext(): vscode.ExtensionContext {
  return {
    extensionUri: vscode.Uri.file('extension-root')
  } as vscode.ExtensionContext;
}

function createPanel() {
  const messageListeners: Array<(message: unknown) => void> = [];
  const viewStateListeners: Array<(event: { webviewPanel: { active: boolean } }) => void> = [];
  const disposeListeners: Array<() => void> = [];
  const panel = {
    active: true,
    webview: {
      html: '',
      asWebviewUri: vi.fn((uri: vscode.Uri) => uri),
      onDidReceiveMessage: vi.fn((listener: (message: unknown) => void) => {
        messageListeners.push(listener);
        return { dispose: vi.fn() };
      }),
      postMessage: vi.fn()
    },
    onDidChangeViewState: vi.fn((listener: (event: { webviewPanel: { active: boolean } }) => void) => {
      viewStateListeners.push(listener);
      return { dispose: vi.fn() };
    }),
    onDidDispose: vi.fn((listener: () => void) => {
      disposeListeners.push(listener);
      return { dispose: vi.fn() };
    })
  } as unknown as vscode.WebviewPanel;

  return {
    panel,
    fireViewState(active: boolean) {
      for (const listener of viewStateListeners) {
        listener({ webviewPanel: { active } });
      }
    },
    fireDispose() {
      for (const listener of disposeListeners) {
        listener();
      }
    }
  };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  deactivate();
  connect.mockResolvedValue(undefined);
  disposeSession.mockClear();
  write.mockClear();
  resize.mockClear();
  sessionEvents.length = 0;
  vi.spyOn(vscode.window, 'createWebviewPanel').mockReturnValue(createPanel().panel);
});

describe('TerminalPanel rendering helpers', () => {
  it('links the bundled xterm stylesheet emitted by esbuild', () => {
    const assets = createTerminalAssets({ fsPath: 'extension-root' } as never);

    expect(assets.style).toBeDefined();
    expect(assets.style!.fsPath).toBe('extension-root/dist/webview/terminal.css');
  });

  it('opens new terminal panels as tabs in the active editor group', () => {
    expect(createTerminalViewColumn()).toBe(vscode.ViewColumn.Active);
  });

  it('renders terminal settings into the webview data attributes', () => {
    const body = renderTerminalBody({
      scrollback: 1234,
      fontSize: 16,
      fontFamily: 'JetBrains Mono',
      semanticHighlight: true,
      idleDisconnectMinutes: 60
    });

    expect(body).toContain('data-scrollback="1234"');
    expect(body).toContain('data-font-size="16"');
    expect(body).toContain('data-font-family="JetBrains Mono"');
    expect(body).toContain('data-semantic-highlight="true"');
  });

  it('reads contributed terminal settings from VS Code configuration', () => {
    const settings = resolveTerminalSettings({
      get: <T>(key: string, defaultValue: T): T => {
        const values: Record<string, unknown> = {
          scrollback: 9000,
          terminalFontSize: 18,
          terminalFontFamily: 'Fira Code',
          semanticHighlight: false
        };
        return (values[key] ?? defaultValue) as T;
      }
    });

    expect(settings).toEqual({
      scrollback: 9000,
      fontSize: 18,
      fontFamily: 'Fira Code',
      semanticHighlight: false,
      idleDisconnectMinutes: 60
    });
  });

  it('treats ready messages as resize messages so the remote PTY matches xterm', () => {
    const session = {
      write: vi.fn(),
      resize: vi.fn()
    };

    expect(handleTerminalMessage({ type: 'ready', rows: 42, cols: 132 }, session)).toBe(true);
    expect(session.resize).toHaveBeenCalledWith(42, 132);
  });

  it('formats terminal notices as red terminal output', () => {
    expect(formatTerminalNotice('Connection disconnected')).toBe(
      '\r\n\x1b[31mConnection disconnected\x1b[0m\r\n'
    );
  });

  it('creates a JumpServer terminal panel and publishes terminal context', async () => {
    const registry = new TerminalContextRegistry();
    const panelHost = createPanel();
    vi.mocked(vscode.window.createWebviewPanel).mockReturnValueOnce(panelHost.panel);

    TerminalPanel.open(extensionContext(), asset(), jumpServerClient(), registry);

    expect(vscode.window.createWebviewPanel).toHaveBeenCalledWith(
      'jumpserverTerminal',
      'JumpServer: terminal-asset',
      vscode.ViewColumn.Active,
      expect.objectContaining({ enableScripts: true, retainContextWhenHidden: true })
    );
    expect(registry.getActive()?.asset.id).toBe('terminal-asset');
    expect(registry.getActive()?.connected).toBe(false);
    await flushPromises();
    expect(registry.getActive()?.connected).toBe(true);
  });

  it('posts upstream bytes to the terminal webview', async () => {
    const panelHost = createPanel();
    vi.mocked(vscode.window.createWebviewPanel).mockReturnValueOnce(panelHost.panel);
    const rawOutput = Buffer.from('\x1b[31mred\x1b[0m', 'utf8');

    TerminalPanel.open(extensionContext(), asset(), jumpServerClient());
    await flushPromises();
    sessionEvents.at(-1)!.output(rawOutput);

    expect(panelHost.panel.webview.postMessage).toHaveBeenCalledWith({
      type: 'outputBytes',
      payload: [...rawOutput]
    });
  });

  it('disconnects all terminal sessions when the extension deactivates', async () => {
    TerminalPanel.open(extensionContext(), asset('first'), jumpServerClient());
    TerminalPanel.open(extensionContext(), asset('second'), jumpServerClient());
    await flushPromises();

    deactivate();

    expect(disposeSession).toHaveBeenCalledTimes(2);
    expect(TerminalPanel.getActive()).toBeUndefined();
  });
});
