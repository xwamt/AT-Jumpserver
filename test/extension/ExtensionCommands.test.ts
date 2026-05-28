import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';

const terminalPanelMock = vi.hoisted(() => ({
  open: vi.fn(),
  getActive: vi.fn(),
  disconnectAll: vi.fn()
}));

const notificationsMock = vi.hoisted(() => ({
  showTimedNotification: vi.fn()
}));

const jumpServerClientMock = vi.hoisted(() => ({
  calls: [] as string[],
  ensureAuthToken: vi.fn(),
  listAssetNodes: vi.fn(),
  listAssets: vi.fn(),
  JumpServerClient: vi.fn()
}));

vi.mock('../../src/jumpserver/JumpServerClient', () => ({
  JumpServerClient: jumpServerClientMock.JumpServerClient
}));

vi.mock('../../src/webview/TerminalPanel', () => ({
  TerminalPanel: terminalPanelMock
}));

vi.mock('../../src/utils/notifications', () => ({
  showTimedNotification: notificationsMock.showTimedNotification
}));

import { activate, deactivate } from '../../src/extension';


function contextWithSettings(): vscode.ExtensionContext {
  const data = new Map<string, unknown>([
    ['jumpserverManager.settings', {
      baseUrl: 'https://jumpserver.example.com',
      orgId: '',
      username: 'alan',
      verifyTls: true,
      connectTimeout: 30,
      updatedAt: 1
    }]
  ]);
  return {
    globalState: {
      get: vi.fn((key, fallback) => data.has(key) ? data.get(key) : fallback),
      update: vi.fn(async (key, value) => {
        data.set(key, value);
      })
    },
    secrets: { get: vi.fn(async () => 'secret'), store: vi.fn(), delete: vi.fn() },
    subscriptions: [],
    extensionUri: vscode.Uri.file('extension-root')
  } as unknown as vscode.ExtensionContext;
}

function registeredCommand(commandId: string): (...args: any[]) => Promise<void> {
  return vi.mocked(vscode.commands.registerCommand).mock.calls.find(([command]) => command === commandId)?.[1] as (...args: any[]) => Promise<void>;
}

beforeEach(() => {
  deactivate();
  vi.clearAllMocks();
  jumpServerClientMock.calls.length = 0;
  jumpServerClientMock.ensureAuthToken.mockResolvedValue('token-1');
  jumpServerClientMock.listAssetNodes.mockImplementation(async () => {
    jumpServerClientMock.calls.push('nodes');
    return [{ id: 'node-default', name: 'DEFAULT', path: ['DEFAULT'], assetIds: [], raw: {} }];
  });
  jumpServerClientMock.listAssets.mockImplementation(async () => {
    jumpServerClientMock.calls.push('assets');
    return [{ id: 'asset-1', name: 'gateway02', address: '11.0.139.162', platform: 'Linux', category: 'host', type: 'server', zoneName: 'DEFAULT', nodePath: ['DEFAULT'], protocolNames: ['ssh'], raw: {} }];
  });
  terminalPanelMock.open.mockClear();
  terminalPanelMock.getActive.mockReturnValue(undefined);
  terminalPanelMock.disconnectAll.mockClear();
  notificationsMock.showTimedNotification.mockResolvedValue(undefined);
  jumpServerClientMock.JumpServerClient.mockImplementation(() => ({
    ensureAuthToken: jumpServerClientMock.ensureAuthToken,
    listAssetNodes: jumpServerClientMock.listAssetNodes,
    listAssets: jumpServerClientMock.listAssets
  }));

});

describe('extension command wiring', () => {
  it('registers JumpServer-only commands and asset tree view', () => {
    const context = {
      globalState: { get: vi.fn((_key, fallback) => fallback), update: vi.fn() },
      secrets: { get: vi.fn(), store: vi.fn(), delete: vi.fn() },
      subscriptions: [],
      extensionUri: vscode.Uri.file('extension-root')
    } as unknown as vscode.ExtensionContext;

    activate(context);

    expect(vscode.window.createTreeView).toHaveBeenCalledWith('jumpserverManager.assets', expect.any(Object));
    expect(vscode.commands.registerCommand).toHaveBeenCalledWith('jumpserverManager.configure', expect.any(Function));
    expect(vscode.commands.registerCommand).toHaveBeenCalledWith('jumpserverManager.validate', expect.any(Function));
    expect(vscode.commands.registerCommand).toHaveBeenCalledWith('jumpserverManager.refresh', expect.any(Function));
    expect(vscode.commands.registerCommand).toHaveBeenCalledWith('jumpserverManager.connect', expect.any(Function));
    expect(vscode.commands.registerCommand).not.toHaveBeenCalledWith('sshManager.connect', expect.any(Function));
  });

  it('refreshes JumpServer nodes before syncing assets', async () => {
    const data = new Map<string, unknown>([
      ['jumpserverManager.settings', {
        baseUrl: 'https://jumpserver.example.com',
        orgId: '',
        username: 'alan',
        verifyTls: true,
        connectTimeout: 30,
        updatedAt: 1
      }]
    ]);
    const context = {
      globalState: {
        get: vi.fn((key, fallback) => data.has(key) ? data.get(key) : fallback),
        update: vi.fn(async (key, value) => {
          data.set(key, value);
        })
      },
      secrets: { get: vi.fn(async () => 'secret'), store: vi.fn(), delete: vi.fn() },
      subscriptions: [],
      extensionUri: vscode.Uri.file('extension-root')
    } as unknown as vscode.ExtensionContext;

    activate(context);
    const refresh = vi.mocked(vscode.commands.registerCommand).mock.calls.find(([command]) => command === 'jumpserverManager.refresh')?.[1] as () => Promise<void>;
    await refresh();

    expect(jumpServerClientMock.calls).toEqual(['nodes', 'assets']);
    expect(context.globalState.update).toHaveBeenCalledWith('jumpserverManager.cachedAssetNodes', expect.any(Array));
    expect(context.globalState.update).toHaveBeenCalledWith('jumpserverManager.cachedAssets', expect.any(Array));
  });

  it('opens the unified terminal panel for MySQL assets', async () => {
    const context = contextWithSettings();
    activate(context);
    const connectCommand = registeredCommand('jumpserverManager.connect');
    const item = {
      asset: {
        id: 'mysql-1',
        name: 'mysql-1',
        address: 'db.example.com',
        platform: 'MySQL',
        category: 'database',
        type: 'mysql',
        zoneName: '',
        nodePath: [],
        protocolNames: ['mysql'],
        raw: {}
      }
    };

    await connectCommand(item);

    expect(terminalPanelMock.open).toHaveBeenCalledWith(context, item.asset, expect.any(Object), expect.any(Object));
    expect(notificationsMock.showTimedNotification).not.toHaveBeenCalledWith(expect.stringContaining('not supported'), 'error');
  });

  it('opens SSH server assets even when cached protocol names are missing', async () => {
    const context = contextWithSettings();
    activate(context);
    const connectCommand = registeredCommand('jumpserverManager.connect');
    const item = {
      asset: {
        id: 'server-1',
        name: 'uat-service',
        address: '10.0.0.11',
        platform: 'Linux',
        category: 'host',
        type: 'server',
        zoneName: '',
        nodePath: [],
        protocolNames: [],
        raw: {}
      }
    };

    await connectCommand(item);

    expect(terminalPanelMock.open).toHaveBeenCalledWith(context, item.asset, expect.any(Object), expect.any(Object));
    expect(notificationsMock.showTimedNotification).not.toHaveBeenCalledWith(expect.stringContaining('not supported'), 'error');
  });

  it('keeps unsupported assets visible but shows an unsupported message instead of opening a terminal', async () => {
    const context = contextWithSettings();
    activate(context);
    const connectCommand = registeredCommand('jumpserverManager.connect');
    const item = {
      asset: {
        id: 'redis-1',
        name: 'redis-1',
        address: 'redis.example.com',
        platform: 'Redis6+',
        category: 'database',
        type: 'redis',
        zoneName: '',
        nodePath: [],
        protocolNames: [],
        raw: {}
      }
    };

    await connectCommand(item);

    expect(terminalPanelMock.open).not.toHaveBeenCalled();
    expect(notificationsMock.showTimedNotification).toHaveBeenCalledWith('Asset type is not supported yet: redis-1', 'error');
  });
});
