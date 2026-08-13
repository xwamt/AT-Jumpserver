import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import type { CachedJumpServerAsset } from '../../src/config/schema';
import { deactivate } from '../../src/extension';
import { TerminalContextRegistry } from '../../src/terminal/TerminalContext';
import { formatTerminalNotice, TerminalPanel } from '../../src/webview/TerminalPanel';

const connect = vi.fn<() => Promise<void>>();
const disposeSession = vi.fn<() => void>();
const write = vi.fn<(data: string) => void>();
const resize = vi.fn<(rows: number, cols: number) => void>();
const sessionEvents: Array<{ output(data: Buffer): void; status(message: string): void }> = [];

vi.mock('../../src/jumpserver/JumpServerSession', () => ({
  JumpServerSession: vi.fn().mockImplementation((input) => {
    sessionEvents.push(input.events);
    return { connect, dispose: disposeSession, write, resize };
  })
}));

const MINUTE_MS = 60_000;

function asset(id = 'idle-asset'): CachedJumpServerAsset {
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

function extensionContext(): vscode.ExtensionContext {
  return { extensionUri: vscode.Uri.file('extension-root') } as vscode.ExtensionContext;
}

function createPanel() {
  const messageListeners: Array<(message: unknown) => void> = [];
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
    onDidChangeViewState: vi.fn(() => ({ dispose: vi.fn() })),
    onDidDispose: vi.fn(() => ({ dispose: vi.fn() }))
  } as unknown as vscode.WebviewPanel;

  return {
    panel,
    sendUserInput(payload: string) {
      for (const listener of messageListeners) {
        listener({ type: 'input', payload });
      }
    }
  };
}

/** Opens a connected panel with `idleDisconnectMinutes` set to `minutes`. */
async function openPanel(minutes: number) {
  const host = createPanel();
  const registry = new TerminalContextRegistry();
  vi.mocked(vscode.window.createWebviewPanel).mockReturnValueOnce(host.panel);
  vi.mocked(vscode.workspace.getConfiguration).mockReturnValueOnce({
    get: <T>(key: string, defaultValue: T): T =>
      key === 'idleDisconnectMinutes' ? (minutes as unknown as T) : defaultValue
  } as unknown as ReturnType<typeof vscode.workspace.getConfiguration>);

  TerminalPanel.open(extensionContext(), asset(), {} as never, registry);
  await vi.advanceTimersByTimeAsync(0);
  const terminalId = registry.getActive()!.terminalId;
  expect(registry.getContext(terminalId)?.connected).toBe(true);

  return {
    ...host,
    registry,
    terminalId,
    isConnected: () => registry.getContext(terminalId)?.connected === true,
    /** The MCP agent's only route into the session. */
    agentWrite: (data: string) => registry.getContext(terminalId)!.write(data),
    emitOutput: (data: string) => sessionEvents.at(-1)!.output(Buffer.from(data, 'utf8')),
    postedMessages: () =>
      vi.mocked(host.panel.webview.postMessage).mock.calls.map(([message]) => message)
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  deactivate();
  connect.mockResolvedValue(undefined);
  disposeSession.mockClear();
  write.mockClear();
  sessionEvents.length = 0;
  vi.spyOn(vscode.window, 'createWebviewPanel').mockReturnValue(createPanel().panel);
});

afterEach(() => {
  deactivate();
  vi.useRealTimers();
});

describe('terminal idle disconnect', () => {
  it('drops a session that has been idle for the configured window', async () => {
    const panel = await openPanel(5);

    await vi.advanceTimersByTimeAsync(5 * MINUTE_MS);

    expect(panel.isConnected()).toBe(false);
    expect(disposeSession).toHaveBeenCalled();
    expect(panel.postedMessages()).toContainEqual({
      type: 'output',
      payload: formatTerminalNotice('Disconnected after 5 minute(s) of inactivity.')
    });
  });

  it('keeps the session while it is still inside the window', async () => {
    const panel = await openPanel(5);

    await vi.advanceTimersByTimeAsync(5 * MINUTE_MS - 1000);

    expect(panel.isConnected()).toBe(true);
    expect(disposeSession).not.toHaveBeenCalled();
  });

  it('never disconnects when the setting is 0', async () => {
    const panel = await openPanel(0);

    await vi.advanceTimersByTimeAsync(24 * 60 * MINUTE_MS);

    expect(panel.isConnected()).toBe(true);
    expect(disposeSession).not.toHaveBeenCalled();
  });

  it('treats an MCP agent write as activity so long tool calls survive', async () => {
    const panel = await openPanel(5);

    await vi.advanceTimersByTimeAsync(4 * MINUTE_MS);
    panel.agentWrite('sleep 600\n');
    await vi.advanceTimersByTimeAsync(4 * MINUTE_MS);

    expect(panel.isConnected()).toBe(true);
    expect(write).toHaveBeenCalledWith('sleep 600\n');

    await vi.advanceTimersByTimeAsync(2 * MINUTE_MS);
    expect(panel.isConnected()).toBe(false);
  });

  it('treats terminal output as activity', async () => {
    const panel = await openPanel(5);

    await vi.advanceTimersByTimeAsync(4 * MINUTE_MS);
    panel.emitOutput('build step 42\r\n');
    await vi.advanceTimersByTimeAsync(4 * MINUTE_MS);

    expect(panel.isConnected()).toBe(true);
  });

  it('treats user input as activity', async () => {
    const panel = await openPanel(5);

    await vi.advanceTimersByTimeAsync(4 * MINUTE_MS);
    panel.sendUserInput('ls\n');
    await vi.advanceTimersByTimeAsync(4 * MINUTE_MS);

    expect(panel.isConnected()).toBe(true);
  });

  it('stops the countdown once the session is already gone', async () => {
    const panel = await openPanel(5);

    panel.registry.markDisconnected(panel.terminalId);
    sessionEvents.at(-1)!.status('Disconnected (code 1000)');
    disposeSession.mockClear();
    await vi.advanceTimersByTimeAsync(10 * MINUTE_MS);

    expect(disposeSession).not.toHaveBeenCalled();
  });
});
