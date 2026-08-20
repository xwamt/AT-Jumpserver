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
  healthCheck: vi.fn(),
  getUserProfile: vi.fn(),
  listAccessibleOrgs: vi.fn(),
  getCurrentOrg: vi.fn(),
  setOrgId: vi.fn(),
  listAssetNodes: vi.fn(),
  listAssets: vi.fn(),
  listAllAssets: vi.fn(),
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

const bridgeServerMock = vi.hoisted(() => ({
  start: vi.fn(async () => undefined),
  dispose: vi.fn(async () => undefined)
}));

const mcpLifecycleMock = vi.hoisted(() => ({
  syncPackagedHub: vi.fn(async () => ({ updated: false, activeVersion: '0.1.0' })),
  ensureAtSeriesConfigForCurrentIde: vi.fn(async () => ({ updated: true })),
  uninstallAtSeriesConfigForCurrentIde: vi.fn(async () => ({ removed: true }))
}));

vi.mock('../../src/jumpserver/JumpServerClient', async (importOriginal) => ({
  // Keep the real pure helpers so the refresh command exercises the actual
  // node-tree-to-path derivation rather than a stub of it.
  ...await importOriginal<typeof import('../../src/jumpserver/JumpServerClient')>(),
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

vi.mock('../../src/mcp/BridgeServer', () => ({
  BridgeServer: vi.fn().mockImplementation(() => ({
    start: bridgeServerMock.start,
    dispose: bridgeServerMock.dispose
  }))
}));

vi.mock('../../src/mcp/hubSync', () => ({
  syncPackagedHub: mcpLifecycleMock.syncPackagedHub
}));

vi.mock('../../src/mcp/McpConfigInstaller', () => ({
  ensureAtSeriesConfigForCurrentIde: mcpLifecycleMock.ensureAtSeriesConfigForCurrentIde,
  uninstallAtSeriesConfigForCurrentIde: mcpLifecycleMock.uninstallAtSeriesConfigForCurrentIde
}));

import { activate, deactivate } from '../../src/extension';


function contextWithSettings(orgId = ''): vscode.ExtensionContext {
  const data = new Map<string, unknown>([
    ['jumpserverManager.settings', {
      baseUrl: 'https://jumpserver.example.com',
      orgId,
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
  jumpServerClientMock.healthCheck.mockResolvedValue({ skipped: true });
  jumpServerClientMock.getUserProfile.mockResolvedValue({ id: 'user-1', username: 'alan' });
  jumpServerClientMock.listAccessibleOrgs.mockResolvedValue([
    { id: '00000000-0000-0000-0000-000000000002', name: 'Default' }
  ]);
  jumpServerClientMock.getCurrentOrg.mockResolvedValue({
    id: '00000000-0000-0000-0000-000000000002',
    name: 'Default'
  });
  jumpServerClientMock.listAssetNodes.mockImplementation(async () => {
    jumpServerClientMock.calls.push('nodes');
    return [{ id: 'node-default', name: 'DEFAULT', path: ['DEFAULT'], assetIds: ['asset-1'], raw: {} }];
  });
  jumpServerClientMock.listAssets.mockImplementation(async () => {
    jumpServerClientMock.calls.push('assets');
    return [{ id: 'asset-1', name: 'gateway02', address: '11.0.139.162', platform: 'Linux', category: 'host', type: 'server', zoneName: 'DEFAULT', nodePath: ['DEFAULT'], protocolNames: ['ssh'], raw: {} }];
  });
  jumpServerClientMock.listAllAssets.mockImplementation(async () => {
    jumpServerClientMock.calls.push('assets');
    return {
      assets: [{ id: 'asset-1', name: 'gateway02', address: '11.0.139.162', platform: 'Linux', category: 'host', type: 'server', zoneName: 'DEFAULT', nodePath: ['DEFAULT'], protocolNames: ['ssh'], raw: {} }],
      total: 1,
      truncated: false
    };
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
    healthCheck: jumpServerClientMock.healthCheck,
    getUserProfile: jumpServerClientMock.getUserProfile,
    listAccessibleOrgs: jumpServerClientMock.listAccessibleOrgs,
    getCurrentOrg: jumpServerClientMock.getCurrentOrg,
    setOrgId: jumpServerClientMock.setOrgId,
    listAssetNodes: jumpServerClientMock.listAssetNodes,
    listAssets: jumpServerClientMock.listAssets,
    listAllAssets: jumpServerClientMock.listAllAssets,
    openKokoSftpWebSocket: jumpServerClientMock.openKokoSftpWebSocket
  }));
  mcpLifecycleMock.syncPackagedHub.mockClear();
  mcpLifecycleMock.ensureAtSeriesConfigForCurrentIde.mockClear();
  mcpLifecycleMock.uninstallAtSeriesConfigForCurrentIde.mockClear();
  bridgeServerMock.start.mockClear();
  bridgeServerMock.dispose.mockClear();
  delete (vscode.workspace as { workspaceFolders?: unknown }).workspaceFolders;

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
    expect(vscode.commands.registerCommand).toHaveBeenCalledWith('jumpserverManager.copyHostIp', expect.any(Function));
    expect(vscode.commands.registerCommand).not.toHaveBeenCalledWith('sshManager.connect', expect.any(Function));
  });

  it('copies the selected asset host IP', async () => {
    activate(contextWithSettings());
    const copyHostIp = registeredCommand('jumpserverManager.copyHostIp');

    await copyHostIp({ asset: { address: '10.0.0.11' } });

    expect(vscode.env.clipboard.writeText).toHaveBeenCalledWith('10.0.0.11');
    expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
  });

  it('warns without changing the clipboard when the asset host IP is empty', async () => {
    activate(contextWithSettings());
    const copyHostIp = registeredCommand('jumpserverManager.copyHostIp');

    await copyHostIp({ asset: { address: '' } });

    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith('Host IP is not available.');
    expect(vscode.env.clipboard.writeText).not.toHaveBeenCalled();
  });

  it('warns without changing the clipboard when the command argument is invalid', async () => {
    activate(contextWithSettings());
    const copyHostIp = registeredCommand('jumpserverManager.copyHostIp');

    await copyHostIp(undefined);

    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith('Host IP is not available.');
    expect(vscode.env.clipboard.writeText).not.toHaveBeenCalled();
  });

  it('registers JumpServer SFTP file commands', () => {
    const context = contextWithSettings();
    activate(context);

    expect(vscode.commands.registerCommand).not.toHaveBeenCalledWith('jumpserverManager.sftp.open', expect.any(Function));
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

  it('registers JumpServer MCP install and uninstall commands', () => {
    const context = contextWithSettings();
    activate(context);

    expect(vscode.commands.registerCommand).toHaveBeenCalledWith('jumpserverManager.installMcpConfig', expect.any(Function));
    expect(vscode.commands.registerCommand).toHaveBeenCalledWith('jumpserverManager.uninstallAtSeriesMcpConfig', expect.any(Function));
  });

  it('syncs packaged hub and ensures AT Series MCP config on activation', async () => {
    const context = contextWithSettings();
    activate(context);

    expect(mcpLifecycleMock.syncPackagedHub).toHaveBeenCalledOnce();
    await vi.waitFor(() => {
      expect(mcpLifecycleMock.ensureAtSeriesConfigForCurrentIde).toHaveBeenCalledWith({
        appName: vscode.env.appName,
        appRoot: vscode.env.appRoot,
        uriScheme: vscode.env.uriScheme,
        extensionPath: 'extension-root',
        workspaceFolder: undefined
      });
    });
  });

  it('dispose unpublishes bridge without uninstalling MCP config', async () => {
    const context = contextWithSettings();
    activate(context);

    mcpLifecycleMock.uninstallAtSeriesConfigForCurrentIde.mockClear();
    bridgeServerMock.dispose.mockClear();
    deactivate();

    expect(bridgeServerMock.dispose).toHaveBeenCalled();
    expect(mcpLifecycleMock.uninstallAtSeriesConfigForCurrentIde).not.toHaveBeenCalled();
  });

  it('does not register a standalone SFTP open command from the asset list', () => {
    const context = contextWithSettings();
    activate(context);

    expect(vscode.commands.registerCommand).not.toHaveBeenCalledWith('jumpserverManager.sftp.open', expect.any(Function));
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

  it('hands the already-fetched node tree to the asset sync instead of refetching it', async () => {
    activate(contextWithSettings());
    const refresh = registeredCommand('jumpserverManager.refresh');

    await refresh();

    expect(jumpServerClientMock.listAssetNodes).toHaveBeenCalledTimes(1);
    expect(jumpServerClientMock.listAllAssets).toHaveBeenCalledWith(
      expect.objectContaining({ treePaths: new Map([['asset-1', ['DEFAULT']]]) })
    );
  });

  it('caches every asset the bastion has instead of the first page', async () => {
    jumpServerClientMock.listAllAssets.mockResolvedValueOnce({
      assets: Array.from({ length: 640 }, (_unused, index) => ({
        id: `asset-${index}`,
        name: `host-${index}`,
        address: '10.0.0.1',
        platform: 'Linux',
        category: 'host',
        type: 'server',
        zoneName: 'DEFAULT',
        nodePath: ['DEFAULT'],
        protocolNames: ['ssh'],
        raw: {}
      })),
      total: 640,
      truncated: false
    });
    activate(contextWithSettings());

    await registeredCommand('jumpserverManager.refresh')();

    expect(notificationsMock.showTimedNotification).toHaveBeenCalledWith('JumpServer assets refreshed: 640');
  });

  it('says so out loud when the safety cap stopped the sync short', async () => {
    jumpServerClientMock.listAllAssets.mockResolvedValueOnce({ assets: [], total: 24_000, truncated: true });
    activate(contextWithSettings());

    await registeredCommand('jumpserverManager.refresh')();

    expect(notificationsMock.showTimedNotification).toHaveBeenCalledWith(
      'JumpServer assets refreshed: 0 of 24000 (cache cap reached).',
      'warning'
    );
  });

  it('verifies the account against the user profile without pulling the whole node tree', async () => {
    activate(contextWithSettings());
    const validate = registeredCommand('jumpserverManager.validate');

    await validate();

    expect(jumpServerClientMock.healthCheck).toHaveBeenCalledTimes(1);
    expect(jumpServerClientMock.getUserProfile).toHaveBeenCalledTimes(1);
    expect(jumpServerClientMock.listAccessibleOrgs).toHaveBeenCalledTimes(1);
    expect(jumpServerClientMock.listAssetNodes).not.toHaveBeenCalled();
    expect(jumpServerClientMock.listAssets).not.toHaveBeenCalled();
    expect(notificationsMock.showTimedNotification).toHaveBeenCalledWith(
      'JumpServer account verified. Organization: Default.'
    );
  });

  it('asks the user to pick an organization when several are visible and none is saved', async () => {
    const context = contextWithSettings();
    jumpServerClientMock.listAccessibleOrgs.mockResolvedValueOnce([
      { id: '00000000-0000-0000-0000-000000000002', name: 'Default' },
      { id: '11111111-1111-1111-1111-111111111111', name: 'Prod' }
    ]);
    vi.mocked(vscode.window.showQuickPick).mockResolvedValueOnce({
      label: 'Prod',
      description: '11111111-1111-1111-1111-111111111111',
      orgId: '11111111-1111-1111-1111-111111111111',
      name: 'Prod'
    } as never);

    activate(context);
    await registeredCommand('jumpserverManager.validate')();

    expect(vscode.window.showQuickPick).toHaveBeenCalled();
    expect(context.globalState.update).toHaveBeenCalledWith(
      'jumpserverManager.settings',
      expect.objectContaining({ orgId: '11111111-1111-1111-1111-111111111111' })
    );
    expect(jumpServerClientMock.setOrgId).toHaveBeenCalledWith('11111111-1111-1111-1111-111111111111');
  });

  it('stops validate when organization selection is cancelled', async () => {
    jumpServerClientMock.listAccessibleOrgs.mockResolvedValueOnce([
      { id: '00000000-0000-0000-0000-000000000002', name: 'Default' },
      { id: '11111111-1111-1111-1111-111111111111', name: 'Prod' }
    ]);
    vi.mocked(vscode.window.showQuickPick).mockResolvedValueOnce(undefined);

    activate(contextWithSettings());
    await registeredCommand('jumpserverManager.validate')();

    expect(notificationsMock.showTimedNotification).toHaveBeenCalledWith(
      'Organization selection was cancelled.',
      'error'
    );
    expect(jumpServerClientMock.listAssetNodes).not.toHaveBeenCalled();
  });

  it('does not list assets when organization selection is cancelled on refresh', async () => {
    jumpServerClientMock.listAccessibleOrgs.mockResolvedValueOnce([
      { id: '00000000-0000-0000-0000-000000000002', name: 'Default' },
      { id: '11111111-1111-1111-1111-111111111111', name: 'Prod' }
    ]);
    vi.mocked(vscode.window.showQuickPick).mockResolvedValueOnce(undefined);

    activate(contextWithSettings());
    await registeredCommand('jumpserverManager.refresh')();

    expect(notificationsMock.showTimedNotification).toHaveBeenCalledWith(
      'Organization selection was cancelled.',
      'error'
    );
    expect(jumpServerClientMock.listAssetNodes).not.toHaveBeenCalled();
    expect(jumpServerClientMock.listAllAssets).not.toHaveBeenCalled();
  });

  it('warns when the saved organization is no longer accessible then asks again', async () => {
    const context = contextWithSettings('gone-org');
    jumpServerClientMock.listAccessibleOrgs.mockResolvedValueOnce([
      { id: '00000000-0000-0000-0000-000000000002', name: 'Default' },
      { id: '11111111-1111-1111-1111-111111111111', name: 'Prod' }
    ]);
    vi.mocked(vscode.window.showQuickPick).mockResolvedValueOnce({
      label: 'Prod',
      description: '11111111-1111-1111-1111-111111111111',
      orgId: '11111111-1111-1111-1111-111111111111',
      name: 'Prod'
    } as never);

    activate(context);
    await registeredCommand('jumpserverManager.validate')();

    expect(notificationsMock.showTimedNotification).toHaveBeenCalledWith(
      'Saved JumpServer organization gone-org is no longer accessible.'
    );
    expect(jumpServerClientMock.setOrgId).toHaveBeenCalledWith('11111111-1111-1111-1111-111111111111');
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

  it('opens the unified terminal panel for Redis assets', async () => {
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
        protocolNames: ['redis'],
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
        id: 'pg-1',
        name: 'pg-1',
        address: 'pg.example.com',
        platform: 'PostgreSQL',
        category: 'database',
        type: 'postgresql',
        zoneName: '',
        nodePath: [],
        protocolNames: [],
        raw: {}
      }
    };

    await connectCommand(item);

    expect(terminalPanelMock.open).not.toHaveBeenCalled();
    expect(notificationsMock.showTimedNotification).toHaveBeenCalledWith('Asset type is not supported yet: pg-1', 'error');
  });
});
