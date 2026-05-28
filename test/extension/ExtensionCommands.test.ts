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
  openKokoSftpWebSocket: vi.fn(),
  JumpServerClient: vi.fn()
}));

const sftpManagerMock = vi.hoisted(() => ({
  JumpServerSftpManager: vi.fn(),
  openAsset: vi.fn(),
  listDirectory: vi.fn(),
  getState: vi.fn(),
  changeToParentDirectory: vi.fn(),
  changeDirectory: vi.fn(),
  mkdir: vi.fn(),
  uploadFile: vi.fn(),
  downloadFile: vi.fn(),
  deleteEntry: vi.fn(),
  getActiveConnectionKey: vi.fn(),
  rename: vi.fn(),
  readFile: vi.fn(),
  stat: vi.fn(),
  selectTerminal: vi.fn(),
  removeTerminal: vi.fn(),
  dispose: vi.fn()
}));

vi.mock('../../src/jumpserver/JumpServerClient', () => ({
  JumpServerClient: jumpServerClientMock.JumpServerClient
}));

vi.mock('../../src/sftp/JumpServerSftpManager', () => ({
  JumpServerSftpManager: sftpManagerMock.JumpServerSftpManager
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
  terminalPanelMock.open.mockReturnValue({ getTerminalId: () => 'terminal-opened-1' });
  terminalPanelMock.getActive.mockReturnValue(undefined);
  terminalPanelMock.disconnectAll.mockClear();
  notificationsMock.showTimedNotification.mockResolvedValue(undefined);
  sftpManagerMock.openAsset.mockImplementation(async (asset) => {
    sftpManagerMock.getState.mockReturnValue({ kind: 'active', asset, rootPath: '/' });
  });
  sftpManagerMock.listDirectory.mockResolvedValue([]);
  sftpManagerMock.getState.mockReturnValue({ kind: 'none' });
  sftpManagerMock.changeToParentDirectory.mockResolvedValue('/');
  sftpManagerMock.changeDirectory.mockResolvedValue('/');
  sftpManagerMock.mkdir.mockResolvedValue(undefined);
  sftpManagerMock.uploadFile.mockResolvedValue(undefined);
  sftpManagerMock.downloadFile.mockResolvedValue(undefined);
  sftpManagerMock.deleteEntry.mockResolvedValue(undefined);
  sftpManagerMock.getActiveConnectionKey.mockReturnValue('terminal-1');
  sftpManagerMock.rename.mockResolvedValue(undefined);
  sftpManagerMock.readFile.mockResolvedValue(Buffer.from('hello'));
  sftpManagerMock.stat.mockResolvedValue({ size: 5, modifiedAt: 1 });
  sftpManagerMock.JumpServerSftpManager.mockImplementation(() => ({
    openAsset: sftpManagerMock.openAsset,
    listDirectory: sftpManagerMock.listDirectory,
    getState: sftpManagerMock.getState,
    changeToParentDirectory: sftpManagerMock.changeToParentDirectory,
    changeDirectory: sftpManagerMock.changeDirectory,
    mkdir: sftpManagerMock.mkdir,
    uploadFile: sftpManagerMock.uploadFile,
    downloadFile: sftpManagerMock.downloadFile,
    deleteEntry: sftpManagerMock.deleteEntry,
    getActiveConnectionKey: sftpManagerMock.getActiveConnectionKey,
    rename: sftpManagerMock.rename,
    readFile: sftpManagerMock.readFile,
    stat: sftpManagerMock.stat,
    selectTerminal: sftpManagerMock.selectTerminal,
    removeTerminal: sftpManagerMock.removeTerminal,
    dispose: sftpManagerMock.dispose
  }));
  jumpServerClientMock.JumpServerClient.mockImplementation(() => ({
    ensureAuthToken: jumpServerClientMock.ensureAuthToken,
    listAssetNodes: jumpServerClientMock.listAssetNodes,
    listAssets: jumpServerClientMock.listAssets,
    openKokoSftpWebSocket: jumpServerClientMock.openKokoSftpWebSocket
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
    expect(vscode.window.createTreeView).toHaveBeenCalledWith('jumpserverManager.sftpFiles', expect.any(Object));
    expect(vscode.commands.registerCommand).toHaveBeenCalledWith('jumpserverManager.configure', expect.any(Function));
    expect(vscode.commands.registerCommand).toHaveBeenCalledWith('jumpserverManager.validate', expect.any(Function));
    expect(vscode.commands.registerCommand).toHaveBeenCalledWith('jumpserverManager.refresh', expect.any(Function));
    expect(vscode.commands.registerCommand).toHaveBeenCalledWith('jumpserverManager.connect', expect.any(Function));
    expect(vscode.commands.registerCommand).not.toHaveBeenCalledWith('sshManager.connect', expect.any(Function));
  });

  it('registers JumpServer SFTP file commands', () => {
    const context = contextWithSettings();
    activate(context);

    expect(vscode.commands.registerCommand).toHaveBeenCalledWith('jumpserverManager.sftp.open', expect.any(Function));
    expect(vscode.commands.registerCommand).toHaveBeenCalledWith('jumpserverManager.sftp.refresh', expect.any(Function));
    expect(vscode.commands.registerCommand).toHaveBeenCalledWith('jumpserverManager.sftp.upload', expect.any(Function));
    expect(vscode.commands.registerCommand).toHaveBeenCalledWith('jumpserverManager.sftp.download', expect.any(Function));
    expect(vscode.commands.registerCommand).toHaveBeenCalledWith('jumpserverManager.sftp.preview', expect.any(Function));
    expect(vscode.commands.registerCommand).toHaveBeenCalledWith('jumpserverManager.sftp.edit', expect.any(Function));
    expect(vscode.commands.registerCommand).toHaveBeenCalledWith('jumpserverManager.sftp.delete', expect.any(Function));
    expect(vscode.commands.registerCommand).toHaveBeenCalledWith('jumpserverManager.sftp.rename', expect.any(Function));
    expect(vscode.commands.registerCommand).toHaveBeenCalledWith('jumpserverManager.sftp.newFolder', expect.any(Function));
    expect(vscode.commands.registerCommand).toHaveBeenCalledWith('jumpserverManager.sftp.copyPath', expect.any(Function));
  });

  it('shows a clear error when opening files for an asset without SFTP', async () => {
    const context = contextWithSettings();
    activate(context);
    const openFiles = registeredCommand('jumpserverManager.sftp.open');

    await openFiles({ asset: { id: 'redis-1', name: 'redis-1', protocolNames: ['redis'] } });

    expect(notificationsMock.showTimedNotification).toHaveBeenCalledWith('Asset does not support SFTP: redis-1', 'error');
  });

  it('opens files for SSH assets even when the cached protocol list only contains ssh', async () => {
    const context = contextWithSettings();
    activate(context);
    const openFiles = registeredCommand('jumpserverManager.sftp.open');
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
        protocolNames: ['ssh'],
        raw: {}
      }
    };

    await openFiles(item);

    expect(sftpManagerMock.openAsset).toHaveBeenCalledWith(item.asset, item.asset.id);
    expect(notificationsMock.showTimedNotification).not.toHaveBeenCalledWith('Asset does not support SFTP: uat-service', 'error');
  });

  it('automatically opens the SFTP file tree when connecting an SSH asset', async () => {
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
        protocolNames: ['ssh'],
        raw: {}
      }
    };

    await connectCommand(item);

    expect(terminalPanelMock.open).toHaveBeenCalledWith(context, item.asset, expect.any(Object), expect.any(Object));
    expect(sftpManagerMock.openAsset).toHaveBeenCalledWith(item.asset, expect.any(String));
  });

  it('switches the SFTP file tree when the active terminal changes', async () => {
    const context = contextWithSettings();
    activate(context);
    const connectCommand = registeredCommand('jumpserverManager.connect');
    await connectCommand({
      asset: {
        id: 'asset-1',
        name: 'asset-1',
        address: '',
        platform: 'Linux',
        category: 'host',
        type: 'server',
        zoneName: '',
        nodePath: [],
        protocolNames: ['ssh'],
        raw: {}
      }
    });
    const registry = terminalPanelMock.open.mock.calls[0]?.[3];

    registry.setActive({ terminalId: 'terminal-1', asset: { id: 'asset-1' }, connected: true, write: vi.fn() });
    registry.setActive({ terminalId: 'terminal-2', asset: { id: 'asset-2' }, connected: true, write: vi.fn() });
    registry.setActive({ terminalId: 'terminal-1', asset: { id: 'asset-1' }, connected: true, write: vi.fn() });

    expect(sftpManagerMock.selectTerminal).toHaveBeenNthCalledWith(1, 'terminal-1');
    expect(sftpManagerMock.selectTerminal).toHaveBeenNthCalledWith(2, 'terminal-2');
    expect(sftpManagerMock.selectTerminal).toHaveBeenNthCalledWith(3, 'terminal-1');
  });

  it('removes only the closed terminal SFTP connection', async () => {
    const context = contextWithSettings();
    activate(context);
    const connectCommand = registeredCommand('jumpserverManager.connect');
    await connectCommand({
      asset: {
        id: 'asset-1',
        name: 'asset-1',
        address: '',
        platform: 'Linux',
        category: 'host',
        type: 'server',
        zoneName: '',
        nodePath: [],
        protocolNames: ['ssh'],
        raw: {}
      }
    });
    const registry = terminalPanelMock.open.mock.calls[0]?.[3];

    registry.setActive({ terminalId: 'terminal-1', asset: { id: 'asset-1' }, connected: true, write: vi.fn() });
    registry.setActive({ terminalId: 'terminal-2', asset: { id: 'asset-2' }, connected: true, write: vi.fn() });
    registry.clearIfActive('terminal-2');

    expect(sftpManagerMock.removeTerminal).toHaveBeenCalledWith('terminal-2');
  });

  it('shows a clear prompt instead of an internal state error before an SFTP asset is open', async () => {
    const context = contextWithSettings();
    activate(context);
    const refreshFiles = registeredCommand('jumpserverManager.sftp.refresh');

    await refreshFiles();

    expect(notificationsMock.showTimedNotification).toHaveBeenCalledWith('Open files from a JumpServer asset first.', 'warning');
    expect(notificationsMock.showTimedNotification).not.toHaveBeenCalledWith('No active JumpServer SFTP asset.', 'error');
  });

  it('refreshes JumpServer nodes before syncing assets', async () => {
    const data = new Map<string, unknown>([
      ['jumpserverManager.settings', {
        baseUrl: 'https://jumpserver.example.com',
        orgId: '',
        username: 'alan',
        verifyTls: true,
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
