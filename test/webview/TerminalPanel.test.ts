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
const sessionInputs: unknown[] = [];

vi.mock('../../src/jumpserver/JumpServerSession', () => ({
  JumpServerSession: vi.fn().mockImplementation((input) => {
    sessionInputs.push(input);
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
    raw: {},
    bastionId: 'b1'
  };
}

function mysqlAsset(id = 'mysql-asset'): CachedJumpServerAsset {
  return {
    id,
    name: id,
    address: `${id}.example.com`,
    platform: 'MySQL',
    category: 'database',
    type: 'mysql',
    zoneName: 'Production',
    nodePath: ['Production'],
    protocolNames: ['mysql'],
    raw: {},
    bastionId: 'b1'
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
    sendMessage(message: unknown) {
      for (const listener of messageListeners) {
        listener(message);
      }
    },
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

/** Outlasts the panel's output coalescing window. */
async function advanceOutputFlush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 30));
}

beforeEach(() => {
  deactivate();
  connect.mockResolvedValue(undefined);
  disposeSession.mockClear();
  write.mockClear();
  resize.mockClear();
  sessionEvents.length = 0;
  sessionInputs.length = 0;
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

  /**
   * These values come out of the user's settings.json, so their declared types
   * are a promise the settings file never made. A missing CSP `unsafe-inline`
   * keeps this out of script-execution territory, but an unescaped quote still
   * lets one setting invent attributes on the terminal element.
   */
  it('escapes every settings value it interpolates, not just the font family', () => {
    const body = renderTerminalBody({
      scrollback: '5000" data-injected-scrollback="yes' as unknown as number,
      fontSize: '16" data-injected-size="yes' as unknown as number,
      fontFamily: 'JetBrains Mono',
      semanticHighlight: 'true" data-injected-highlight="yes' as unknown as boolean,
      idleDisconnectMinutes: 60
    });

    expect(body).not.toContain('data-injected-scrollback="yes"');
    expect(body).not.toContain('data-injected-size="yes"');
    expect(body).not.toContain('data-injected-highlight="yes"');
    expect(body).toContain('data-scrollback="5000&quot; data-injected-scrollback=&quot;yes"');
  });

  /**
   * `rows <= 0` is false for the string "abc", so an unvalidated dimension used
   * to travel all the way into the JSON sent to KoKo.
   */
  it('rejects resize dimensions that are not positive integers', () => {
    const session = { write: vi.fn(), resize: vi.fn() };
    const rejected = [
      { rows: 'abc', cols: 80 },
      { rows: 24, cols: Number.NaN },
      { rows: 24, cols: Number.POSITIVE_INFINITY },
      { rows: 24.5, cols: 80 },
      { rows: 0, cols: 80 },
      { rows: 24 }
    ];

    for (const dimensions of rejected) {
      expect(handleTerminalMessage({ type: 'resize', ...dimensions } as never, session)).toBe(false);
    }

    expect(session.resize).not.toHaveBeenCalled();
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
      'JumpServer SSH: terminal-asset',
      vscode.ViewColumn.Active,
      expect.objectContaining({ enableScripts: true, retainContextWhenHidden: true })
    );
    expect(registry.getActive()?.asset.id).toBe('terminal-asset');
    expect(registry.getActive()?.connected).toBe(false);
    await flushPromises();
    expect(registry.getActive()?.connected).toBe(true);
  });


  it('uses a MySQL title and passes mysql connection kind into the session', async () => {
    const panelHost = createPanel();
    vi.mocked(vscode.window.createWebviewPanel).mockReturnValueOnce(panelHost.panel);

    TerminalPanel.open(extensionContext(), mysqlAsset(), jumpServerClient());

    expect(vscode.window.createWebviewPanel).toHaveBeenCalledWith(
      'jumpserverTerminal',
      'JumpServer MySQL: mysql-asset',
      vscode.ViewColumn.Active,
      expect.objectContaining({ enableScripts: true, retainContextWhenHidden: true })
    );
    expect(sessionInputs.at(-1)).toMatchObject({
      connectionKind: 'mysql',
      asset: expect.objectContaining({ id: 'mysql-asset' })
    });
  });

  it('posts upstream bytes to the terminal webview as base64', async () => {
    const panelHost = createPanel();
    const registry = new TerminalContextRegistry();
    vi.mocked(vscode.window.createWebviewPanel).mockReturnValueOnce(panelHost.panel);
    const rawOutput = Buffer.from('\x1b[31mred\x1b[0m', 'utf8');

    TerminalPanel.open(extensionContext(), asset(), jumpServerClient(), registry);
    await flushPromises();
    sessionEvents.at(-1)!.output(rawOutput);
    await advanceOutputFlush();

    expect(panelHost.panel.webview.postMessage).toHaveBeenCalledWith({
      type: 'outputBase64',
      payload: rawOutput.toString('base64')
    });
    expect(registry.getOutputBuffer(registry.getActive()!.terminalId)?.text()).toBe(rawOutput.toString('utf8'));
  });

  it('coalesces a burst of upstream frames into one webview message', async () => {
    const panelHost = createPanel();
    vi.mocked(vscode.window.createWebviewPanel).mockReturnValueOnce(panelHost.panel);

    TerminalPanel.open(extensionContext(), asset(), jumpServerClient());
    await flushPromises();
    vi.mocked(panelHost.panel.webview.postMessage).mockClear();
    const events = sessionEvents.at(-1)!;
    for (const frame of ['one', 'two', 'three']) {
      events.output(Buffer.from(frame, 'utf8'));
    }

    expect(panelHost.panel.webview.postMessage).not.toHaveBeenCalled();
    await advanceOutputFlush();

    expect(panelHost.panel.webview.postMessage).toHaveBeenCalledTimes(1);
    expect(panelHost.panel.webview.postMessage).toHaveBeenCalledWith({
      type: 'outputBase64',
      payload: Buffer.from('onetwothree', 'utf8').toString('base64')
    });
  });

  it('flushes without waiting once a burst reaches the byte threshold', async () => {
    const panelHost = createPanel();
    vi.mocked(vscode.window.createWebviewPanel).mockReturnValueOnce(panelHost.panel);

    TerminalPanel.open(extensionContext(), asset(), jumpServerClient());
    await flushPromises();
    vi.mocked(panelHost.panel.webview.postMessage).mockClear();
    const frame = Buffer.alloc(32 * 1024, 0x61);
    sessionEvents.at(-1)!.output(frame);
    sessionEvents.at(-1)!.output(frame);

    expect(panelHost.panel.webview.postMessage).toHaveBeenCalledTimes(1);
    expect(panelHost.panel.webview.postMessage).toHaveBeenCalledWith({
      type: 'outputBase64',
      payload: Buffer.concat([frame, frame]).toString('base64')
    });
  });

  it('collapses a 10 MB burst into far fewer webview messages than PTY frames', async () => {
    const panelHost = createPanel();
    vi.mocked(vscode.window.createWebviewPanel).mockReturnValueOnce(panelHost.panel);

    TerminalPanel.open(extensionContext(), asset(), jumpServerClient());
    await flushPromises();
    vi.mocked(panelHost.panel.webview.postMessage).mockClear();
    const frame = Buffer.alloc(4096, 0x61);
    const events = sessionEvents.at(-1)!;
    for (let index = 0; index < 2500; index += 1) {
      events.output(frame);
    }
    await advanceOutputFlush();

    const posted = vi.mocked(panelHost.panel.webview.postMessage).mock.calls
      .map(([message]) => message as { type: string; payload: string });
    // 10 MiB at a 64 KiB flush threshold, versus 2500 frames before batching.
    expect(posted.length).toBeLessThanOrEqual(200);
    const delivered = posted.reduce((total, message) => total + Buffer.from(message.payload, 'base64').byteLength, 0);
    expect(delivered).toBe(2500 * 4096);
  });

  it('flushes buffered output before a later status message so the terminal stays ordered', async () => {
    const panelHost = createPanel();
    vi.mocked(vscode.window.createWebviewPanel).mockReturnValueOnce(panelHost.panel);

    TerminalPanel.open(extensionContext(), asset(), jumpServerClient());
    await flushPromises();
    vi.mocked(panelHost.panel.webview.postMessage).mockClear();
    const events = sessionEvents.at(-1)!;
    events.output(Buffer.from('tail output', 'utf8'));
    events.status('Disconnected (code 1000)');

    const posted = vi.mocked(panelHost.panel.webview.postMessage).mock.calls.map(([message]) => message);
    expect(posted[0]).toEqual({
      type: 'outputBase64',
      payload: Buffer.from('tail output', 'utf8').toString('base64')
    });
    expect(posted[1]).toEqual({
      type: 'output',
      payload: formatTerminalNotice('Connection disconnected (code 1000)')
    });
  });

  it('prints detailed remote disconnect statuses into the terminal', async () => {
    const panelHost = createPanel();
    vi.mocked(vscode.window.createWebviewPanel).mockReturnValueOnce(panelHost.panel);

    TerminalPanel.open(extensionContext(), asset(), jumpServerClient());
    await flushPromises();
    sessionEvents.at(-1)!.status('Disconnected (code 1000)');

    expect(panelHost.panel.webview.postMessage).toHaveBeenCalledWith({
      type: 'output',
      payload: formatTerminalNotice('Connection disconnected (code 1000)')
    });
  });

  /**
   * A session that has lost its peer throws on write rather than swallowing the
   * bytes. That has to arrive as a status line, not as an exception thrown back
   * into VS Code's webview message dispatcher.
   */
  it('reports a rejected write as a status instead of throwing out of the message listener', async () => {
    const panelHost = createPanel();
    vi.mocked(vscode.window.createWebviewPanel).mockReturnValueOnce(panelHost.panel);
    TerminalPanel.open(extensionContext(), asset(), jumpServerClient());
    await flushPromises();
    vi.mocked(panelHost.panel.webview.postMessage).mockClear();
    write.mockImplementationOnce(() => {
      throw new Error('JumpServer terminal session for terminal-asset is unavailable: it stopped answering heartbeats.');
    });

    expect(() => panelHost.sendMessage({ type: 'input', payload: 'ls\r' })).not.toThrow();

    expect(panelHost.panel.webview.postMessage).toHaveBeenCalledWith({
      type: 'status',
      payload: expect.stringContaining('unavailable')
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
